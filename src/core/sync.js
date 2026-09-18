/**
 * Workspace synchronisation.
 *
 * Two Chitraq installations holding the same workspace — a laptop and a
 * desktop, or two people sharing a team memory — exchange what has changed
 * since they last spoke.
 *
 * The design follows from the invariants rather than from a sync framework:
 *
 *   - **Append-only history makes this tractable.** Versions are immutable and
 *     numbered, so "what does the peer have that I do not" is answerable
 *     exactly, without vector clocks or CRDTs.
 *   - **Divergence is recorded, never silently resolved.** If the same object
 *     was edited on both sides, last-writer-wins would destroy one of them
 *     invisibly. Instead local state is kept, the remote version is stored as
 *     history, and a conflict is raised for a human. This is the same rule the
 *     rest of the system already applies to contradictory knowledge.
 *   - **Nothing is deleted by sync.** A peer that has not seen your object does
 *     not get to remove it.
 *
 * Transport is deliberately absent. `changesSince` produces a payload and
 * `apply` consumes one; moving it over HTTP, a file on a USB stick or a shared
 * folder is the caller's business.
 */

import { now, newConflictId, stableStringify } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';
import { ValidationError } from './objects.js';

export const SYNC_FORMAT = 'chitraq-sync/v1';

/**
 * Track where each peer left off.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_peer (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      label         TEXT,
      last_pulled   TEXT,
      last_pushed   TEXT,
      last_contact  TEXT,
      created_at    TEXT NOT NULL
    ) STRICT;
  `);
}

/**
 * Everything in this workspace that changed after `since`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, since?: string|null, limit?: number}} opts
 */
export function changesSince(db, opts) {
  const since = opts.since ?? '0000';
  const limit = Math.min(opts.limit ?? 5000, 20000);

  const q = (sql, ...extra) => plainAll(db.prepare(sql).all(opts.workspaceId, since, ...extra));

  const objects = q(
    `SELECT * FROM object WHERE workspace_id = ? AND updated_at > ? ORDER BY updated_at LIMIT ?`,
    limit
  );
  const objectIds = objects.map((o) => o.id);

  const versions = objectIds.length
    ? plainAll(
        db
          .prepare(
            `SELECT * FROM object_version WHERE object_id IN (${objectIds.map(() => '?').join(',')})
             ORDER BY object_id, version`
          )
          .all(...objectIds)
      )
    : [];

  const relations = q(
    `SELECT * FROM relation WHERE workspace_id = ? AND updated_at > ? ORDER BY updated_at LIMIT ?`,
    limit
  );

  return {
    format: SYNC_FORMAT,
    workspaceId: opts.workspaceId,
    since: opts.since ?? null,
    // The high-water mark the peer should send back next time. Taken from the
    // data rather than the clock, so a skewed clock cannot cause changes to be
    // skipped on the next exchange.
    cursor: highWaterMark([...objects, ...relations], opts.since ?? null),
    generatedAt: now(),
    objects,
    versions,
    relations,
    sources: q(
      `SELECT id, workspace_id, uri, media_type, title, byte_size, content_hash, text, meta, captured_at, origin
       FROM source WHERE workspace_id = ? AND captured_at > ? ORDER BY captured_at LIMIT ?`,
      limit
    ),
    evidence: q(
      `SELECT * FROM evidence WHERE workspace_id = ? AND created_at > ? ORDER BY created_at LIMIT ?`,
      limit
    ),
    derivations: q(
      `SELECT * FROM derivation WHERE workspace_id = ? AND created_at > ? ORDER BY created_at LIMIT ?`,
      limit
    ),
  };
}

/**
 * @param {any[]} rows
 * @param {string|null} fallback
 */
function highWaterMark(rows, fallback) {
  let max = fallback ?? '0000';
  for (const r of rows) {
    const stamp = r.updated_at ?? r.created_at;
    if (stamp && stamp > max) max = stamp;
  }
  return max;
}

/**
 * Apply a peer's changes.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} payload
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} [opts.peerId]
 * @param {boolean} [opts.dryRun]
 * @param {import('./events.js').Actor} [opts.actor]
 * @returns {{applied: Record<string, number>, conflicts: any[], skipped: Record<string, number>, cursor: string|null}}
 */
export function apply(db, payload, opts) {
  ensureSchema(db);
  const actor = opts.actor ?? SYSTEM_ACTOR;

  if (payload?.format !== SYNC_FORMAT) {
    throw new ValidationError(`Unrecognised sync format "${payload?.format}".`);
  }

  /** @type {Record<string, number>} */
  const applied = {};
  /** @type {Record<string, number>} */
  const skipped = {};
  /** @type {any[]} */
  const conflicts = [];

  const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };

  const run = () => {
    // --- objects ---------------------------------------------------------
    for (const remote of payload.objects ?? []) {
      const local = plain(db.prepare('SELECT * FROM object WHERE id = ?').get(remote.id));

      if (!local) {
        insertRow(db, 'object', { ...remote, workspace_id: opts.workspaceId, superseded_by: null });
        bump(applied, 'objects');
        continue;
      }

      if (local.content_hash === remote.content_hash && local.head_version === remote.head_version) {
        bump(skipped, 'objects');
        continue;
      }

      // The peer is strictly ahead: it has versions built on top of ours.
      if (remote.head_version > local.head_version && sharesHistory(db, remote, local)) {
        updateRow(db, 'object', remote.id, { ...remote, workspace_id: opts.workspaceId });
        bump(applied, 'objects');
        continue;
      }

      // We are ahead, or the same version diverged on both sides.
      if (remote.head_version < local.head_version) {
        bump(skipped, 'objects');
        continue;
      }

      // Genuine divergence. Keep local, keep the remote version as history,
      // and raise it — silently picking one would destroy the other.
      const conflict = recordDivergence(db, {
        workspaceId: opts.workspaceId,
        objectId: remote.id,
        local,
        remote,
        peerId: opts.peerId,
      });
      conflicts.push(conflict);
      bump(skipped, 'objects');
    }

    // --- versions (append-only, so always safe to add) --------------------
    const versionExists = db.prepare('SELECT 1 FROM object_version WHERE object_id = ? AND version = ?');
    const objectExists = db.prepare('SELECT 1 FROM object WHERE id = ?');
    for (const v of payload.versions ?? []) {
      if (!objectExists.get(v.object_id)) continue;
      if (versionExists.get(v.object_id, v.version)) continue;
      insertRow(db, 'object_version', v);
      bump(applied, 'versions');
    }

    // resolve supersession now that every object is present
    for (const remote of payload.objects ?? []) {
      if (!remote.superseded_by) continue;
      if (!objectExists.get(remote.superseded_by)) continue;
      db.prepare('UPDATE object SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(
        remote.superseded_by,
        remote.id
      );
    }

    // --- sources ---------------------------------------------------------
    const sourceExists = db.prepare('SELECT 1 FROM source WHERE id = ?');
    for (const s of payload.sources ?? []) {
      if (sourceExists.get(s.id)) { bump(skipped, 'sources'); continue; }
      insertRow(db, 'source', { blob: null, ...s, workspace_id: opts.workspaceId });
      bump(applied, 'sources');
    }

    // --- relations -------------------------------------------------------
    for (const remote of payload.relations ?? []) {
      if (!objectExists.get(remote.src_id) || !objectExists.get(remote.dst_id)) continue;

      const local = plain(db.prepare('SELECT * FROM relation WHERE id = ?').get(remote.id));
      if (!local) {
        const clash = plain(
          db
            .prepare(`SELECT id, origin FROM relation WHERE src_id = ? AND type = ? AND dst_id = ? AND state = 'active'`)
            .get(remote.src_id, remote.type, remote.dst_id)
        );
        // The same edge asserted independently on both sides is agreement, not
        // conflict — but a user-asserted edge is never displaced by a remote
        // one of lower authority.
        if (clash && remote.state === 'active') {
          if (clash.origin === 'user' || remote.origin !== 'user') {
            bump(skipped, 'relations');
            continue;
          }
        }
        insertRow(db, 'relation', { ...remote, workspace_id: opts.workspaceId });
        bump(applied, 'relations');
        continue;
      }

      if (remote.head_version > local.head_version) {
        updateRow(db, 'relation', remote.id, { ...remote, workspace_id: opts.workspaceId });
        bump(applied, 'relations');
      } else {
        bump(skipped, 'relations');
      }
    }

    // --- evidence and provenance -----------------------------------------
    const evidenceExists = db.prepare('SELECT 1 FROM evidence WHERE id = ?');
    for (const e of payload.evidence ?? []) {
      if (evidenceExists.get(e.id)) continue;
      if (e.target_kind === 'object' && !objectExists.get(e.target_id)) continue;
      if (e.source_id && !sourceExists.get(e.source_id)) continue;
      insertRow(db, 'evidence', { ...e, workspace_id: opts.workspaceId });
      bump(applied, 'evidence');
    }

    const derivationExists = db.prepare('SELECT 1 FROM derivation WHERE id = ?');
    for (const d of payload.derivations ?? []) {
      if (derivationExists.get(d.id)) continue;
      if (d.target_kind === 'object' && !objectExists.get(d.target_id)) continue;
      insertRow(db, 'derivation', { ...d, workspace_id: opts.workspaceId, run_id: null });
      bump(applied, 'derivations');
    }

    if (opts.peerId) {
      db.prepare(
        `INSERT INTO sync_peer (id, workspace_id, label, last_pulled, last_contact, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_pulled = excluded.last_pulled, last_contact = excluded.last_contact`
      ).run(opts.peerId, opts.workspaceId, opts.peerId, payload.cursor ?? null, now(), now());
    }

    emit(db, {
      workspaceId: opts.workspaceId,
      type: EventType.KnowledgeUpdated,
      subjectKind: 'sync',
      subjectId: opts.peerId ?? null,
      actor,
      payload: { applied, skipped, conflicts: conflicts.length, cursor: payload.cursor ?? null },
    });
  };

  if (opts.dryRun) {
    let snapshot;
    try {
      tx(db, () => {
        run();
        snapshot = { applied, skipped, conflicts, cursor: payload.cursor ?? null, dryRun: true };
        throw new DryRun();
      });
    } catch (err) {
      if (!(err instanceof DryRun)) throw err;
    }
    return /** @type {any} */ (snapshot);
  }

  tx(db, run);
  return { applied, skipped, conflicts, cursor: payload.cursor ?? null };
}

class DryRun extends Error {}

/**
 * Do the two sides share a common ancestor at the local head?
 *
 * If the peer's version history contains our exact current content at our
 * version number, their newer versions are built on ours and can be taken
 * safely. If not, the histories forked and this is a divergence.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} remote
 * @param {any} local
 */
function sharesHistory(db, remote, local) {
  const ancestor = plain(
    db
      .prepare('SELECT content_hash FROM object_version WHERE object_id = ? AND version = ?')
      .get(local.id, local.head_version)
  );
  return !!ancestor && ancestor.content_hash === local.content_hash;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, objectId: string, local: any, remote: any, peerId?: string}} input
 */
function recordDivergence(db, input) {
  const existing = plain(
    db
      .prepare(
        `SELECT * FROM conflict WHERE workspace_id = ? AND kind = 'sync-divergence' AND a_id = ? AND status = 'open'`
      )
      .get(input.workspaceId, input.objectId)
  );
  if (existing) return existing;

  const row = {
    id: newConflictId(),
    workspace_id: input.workspaceId,
    kind: 'sync-divergence',
    a_kind: 'object',
    a_id: input.objectId,
    b_kind: null,
    b_id: null,
    detail: stableStringify({
      reason:
        `This was edited here and on ${input.peerId ?? 'another device'} independently. ` +
        `Your version is kept; theirs is recorded below.`,
      localVersion: input.local.head_version,
      localTitle: input.local.title,
      remoteVersion: input.remote.head_version,
      remoteTitle: input.remote.title,
      remoteBody: String(input.remote.body ?? '').slice(0, 2000),
      remoteUpdatedAt: input.remote.updated_at,
      peer: input.peerId ?? null,
    }),
    detected_by: 'sync',
    confidence: 1.0,
    status: 'open',
    resolution: null,
    created_at: now(),
    resolved_at: null,
  };

  db.prepare(
    `INSERT INTO conflict (id, workspace_id, kind, a_kind, a_id, b_kind, b_id, detail,
                           detected_by, confidence, status, resolution, created_at, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.workspace_id, row.kind, row.a_kind, row.a_id, null, null, row.detail,
    row.detected_by, row.confidence, row.status, null, row.created_at, null
  );

  emit(db, {
    workspaceId: input.workspaceId,
    type: EventType.ConflictDetected,
    subjectKind: 'conflict',
    subjectId: row.id,
    payload: { kind: 'sync-divergence', objectId: input.objectId, peer: input.peerId ?? null },
  });

  return row;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 */
export function peers(db, workspaceId) {
  ensureSchema(db);
  return plainAll(
    db.prepare('SELECT * FROM sync_peer WHERE workspace_id = ? ORDER BY last_contact DESC').all(workspaceId)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, peerId: string, cursor: string}} input
 */
export function recordPush(db, input) {
  ensureSchema(db);
  db.prepare(
    `INSERT INTO sync_peer (id, workspace_id, label, last_pushed, last_contact, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET last_pushed = excluded.last_pushed, last_contact = excluded.last_contact`
  ).run(input.peerId, input.workspaceId, input.peerId, input.cursor, now(), now());
}

/**
 * Where we left off with a peer, in one direction.
 *
 * The two directions are separate marks and must not be conflated:
 *   push — the newest change we have *sent* to this peer
 *   pull — the newest change we have *received* from it
 *
 * Reading the pull mark when deciding what to send resends the entire
 * workspace on every exchange, which still converges but is not sync.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, peerId: string, direction?: 'push'|'pull'}} input
 * @returns {string|null}
 */
export function cursorFor(db, input) {
  ensureSchema(db);
  const column = input.direction === 'pull' ? 'last_pulled' : 'last_pushed';
  const row = plain(
    db
      .prepare(`SELECT ${column} AS cursor FROM sync_peer WHERE id = ? AND workspace_id = ?`)
      .get(input.peerId, input.workspaceId)
  );
  return row?.cursor ?? null;
}

const COLUMNS = {
  object: [
    'id', 'workspace_id', 'kind', 'title', 'body', 'attrs', 'epistemic', 'origin', 'confidence',
    'review', 'state', 'superseded_by', 'head_version', 'content_hash', 'valid_from', 'valid_until',
    'occurred_at', 'created_at', 'updated_at', 'deleted_at', 'salience', 'access_count', 'last_access',
  ],
  object_version: [
    'object_id', 'version', 'kind', 'title', 'body', 'attrs', 'epistemic', 'origin', 'confidence',
    'review', 'state', 'valid_from', 'valid_until', 'occurred_at', 'content_hash', 'change_kind',
    'change_reason', 'actor', 'actor_kind', 'recorded_at',
  ],
  relation: [
    'id', 'workspace_id', 'src_id', 'type', 'dst_id', 'origin', 'confidence', 'review', 'state',
    'note', 'valid_from', 'valid_until', 'head_version', 'created_at', 'updated_at',
  ],
  source: [
    'id', 'workspace_id', 'uri', 'media_type', 'title', 'byte_size', 'content_hash', 'text', 'blob',
    'meta', 'captured_at', 'origin',
  ],
  evidence: [
    'id', 'workspace_id', 'target_kind', 'target_id', 'source_id', 'object_id', 'stance', 'excerpt',
    'locator', 'weight', 'created_at',
  ],
  derivation: [
    'id', 'workspace_id', 'target_kind', 'target_id', 'target_version', 'method', 'capability',
    'provider', 'model', 'model_version', 'run_id', 'inputs', 'created_at',
  ],
};

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {Record<string, any>} row
 */
function insertRow(db, table, row) {
  const cols = COLUMNS[table].filter((c) => row[c] !== undefined);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => normalise(row[c])));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} id
 * @param {Record<string, any>} row
 */
function updateRow(db, table, id, row) {
  const cols = COLUMNS[table].filter((c) => c !== 'id' && row[c] !== undefined);
  db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => normalise(row[c])),
    id
  );
}

/** @param {any} v */
function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return stableStringify(v);
  return v;
}
