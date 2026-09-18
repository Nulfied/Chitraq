/**
 * Export and import.
 *
 * Memory you cannot take with you is not yours. Export writes the whole
 * workspace — objects, every version, relations, sources, evidence,
 * provenance, proposals, conflicts and the event log — and import puts it
 * back, into this installation or another one.
 *
 * Import is the harder half and has one rule above the others: **it must not
 * be a way around the invariants.** It preserves ids so that provenance and
 * links survive the round trip, but it refuses to overwrite existing memory,
 * refuses rows that would dangle, and records what it did as events like any
 * other change.
 */

import { now, stableStringify, hashJson } from './ids.js';
import { tx, plain } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';
import { ValidationError } from './objects.js';

export const FORMAT = 'chitraq/v1';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{includeBlobs?: boolean}} [opts]
 */
export function exportWorkspace(db, workspaceId, opts = {}) {
  const all = (sql) => db.prepare(sql).all(workspaceId).map((r) => ({ ...r }));

  const sourceCols = opts.includeBlobs
    ? '*'
    : 'id, workspace_id, uri, media_type, title, byte_size, content_hash, text, meta, captured_at, origin';

  const payload = {
    format: FORMAT,
    exportedAt: now(),
    workspace: plain(db.prepare('SELECT * FROM workspace WHERE id = ?').get(workspaceId)),
    principals: db
      .prepare('SELECT DISTINCT p.* FROM principal p JOIN workspace w ON w.owner_id = p.id WHERE w.id = ?')
      .all(workspaceId)
      .map((r) => ({ ...r })),
    objects: all('SELECT * FROM object WHERE workspace_id = ?'),
    versions: all(
      'SELECT ov.* FROM object_version ov JOIN object o ON o.id = ov.object_id WHERE o.workspace_id = ?'
    ),
    relations: all('SELECT * FROM relation WHERE workspace_id = ?'),
    relationVersions: all(
      'SELECT rv.* FROM relation_version rv JOIN relation r ON r.id = rv.relation_id WHERE r.workspace_id = ?'
    ),
    sources: all(`SELECT ${sourceCols} FROM source WHERE workspace_id = ?`),
    evidence: all('SELECT * FROM evidence WHERE workspace_id = ?'),
    derivations: all('SELECT * FROM derivation WHERE workspace_id = ?'),
    proposals: all('SELECT * FROM proposal WHERE workspace_id = ?'),
    conflicts: all('SELECT * FROM conflict WHERE workspace_id = ?'),
    runs: all('SELECT * FROM capability_run WHERE workspace_id = ?'),
    events: all('SELECT * FROM event WHERE workspace_id = ?'),
  };

  // A checksum over the content, so an import can tell a truncated or edited
  // file from a whole one before it writes anything.
  payload.checksum = checksum(payload);
  return payload;
}

/**
 * @param {any} payload
 * @returns {string}
 */
function checksum(payload) {
  const { checksum: _ignored, exportedAt: _also, ...rest } = payload;
  return hashJson(rest);
}

/**
 * Import a workspace export.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} payload
 * @param {object} opts
 * @param {string} opts.workspaceId  the workspace to import into
 * @param {'skip'|'fail'} [opts.onConflict]  what to do when an id already exists
 * @param {boolean} [opts.dryRun]    validate and report, write nothing
 * @param {import('./events.js').Actor} [opts.actor]
 * @returns {{imported: Record<string, number>, skipped: Record<string, number>, warnings: string[], dryRun: boolean}}
 */
export function importWorkspace(db, payload, opts) {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const onConflict = opts.onConflict ?? 'skip';

  if (!payload || typeof payload !== 'object') {
    throw new ValidationError('Import needs a Chitraq export object.');
  }
  if (payload.format !== FORMAT) {
    throw new ValidationError(
      `Unrecognised export format "${payload.format}". This build reads ${FORMAT}.`
    );
  }
  if (!db.prepare('SELECT 1 FROM workspace WHERE id = ?').get(opts.workspaceId)) {
    throw new ValidationError(`No workspace ${opts.workspaceId} to import into.`);
  }

  /** @type {string[]} */
  const warnings = [];

  if (payload.checksum && payload.checksum !== checksum(payload)) {
    warnings.push(
      'The export checksum does not match its contents — the file was edited or truncated after export. ' +
        'Importing anyway; check the result.'
    );
  }

  /** @type {Record<string, number>} */
  const imported = {};
  /** @type {Record<string, number>} */
  const skipped = {};

  const bump = (/** @type {Record<string, number>} */ m, /** @type {string} */ k) => {
    m[k] = (m[k] ?? 0) + 1;
  };

  const run = () => {
    // Order matters: objects before the things that reference them, and
    // relations before the evidence and conflicts that point at relations.
    const existingObject = db.prepare('SELECT 1 FROM object WHERE id = ?');
    const knownObjects = new Set();

    // --- objects ---------------------------------------------------------
    for (const o of payload.objects ?? []) {
      if (existingObject.get(o.id)) {
        if (onConflict === 'fail') throw new ValidationError(`Object ${o.id} already exists here.`);
        bump(skipped, 'objects');
        knownObjects.add(o.id);
        continue;
      }
      // superseded_by is resolved in a second pass: the target may come later
      // in the file, and a forward reference would fail the foreign key.
      insert(db, 'object', { ...o, workspace_id: opts.workspaceId, superseded_by: null });
      knownObjects.add(o.id);
      bump(imported, 'objects');
    }

    for (const o of payload.objects ?? []) {
      if (!o.superseded_by) continue;
      if (!knownObjects.has(o.superseded_by)) {
        warnings.push(`Object ${o.id} points at a replacement (${o.superseded_by}) that is not in this export.`);
        continue;
      }
      db.prepare('UPDATE object SET superseded_by = ? WHERE id = ?').run(o.superseded_by, o.id);
    }

    // --- versions --------------------------------------------------------
    const versionExists = db.prepare('SELECT 1 FROM object_version WHERE object_id = ? AND version = ?');
    for (const v of payload.versions ?? []) {
      if (!knownObjects.has(v.object_id)) {
        warnings.push(`Dropped a version for unknown object ${v.object_id}.`);
        continue;
      }
      if (versionExists.get(v.object_id, v.version)) {
        bump(skipped, 'versions');
        continue;
      }
      insert(db, 'object_version', v);
      bump(imported, 'versions');
    }

    // --- sources ---------------------------------------------------------
    const knownSources = new Set();
    const sourceExists = db.prepare('SELECT 1 FROM source WHERE id = ?');
    for (const s of payload.sources ?? []) {
      knownSources.add(s.id);
      if (sourceExists.get(s.id)) {
        bump(skipped, 'sources');
        continue;
      }
      insert(db, 'source', { blob: null, ...s, workspace_id: opts.workspaceId });
      bump(imported, 'sources');
    }

    // --- relations -------------------------------------------------------
    const knownRelations = new Set();
    const relationExists = db.prepare('SELECT 1 FROM relation WHERE id = ?');
    const activeEdge = db.prepare(
      `SELECT id FROM relation WHERE src_id = ? AND type = ? AND dst_id = ? AND state = 'active'`
    );

    for (const r of payload.relations ?? []) {
      if (!knownObjects.has(r.src_id) || !knownObjects.has(r.dst_id)) {
        warnings.push(`Dropped relation ${r.id}: one end is not in this export.`);
        continue;
      }
      if (relationExists.get(r.id)) {
        knownRelations.add(r.id);
        bump(skipped, 'relations');
        continue;
      }
      // The active-edge uniqueness index is a real constraint, not a detail:
      // an import must not create a second active edge for the same triple.
      if (r.state === 'active' && activeEdge.get(r.src_id, r.type, r.dst_id)) {
        warnings.push(`Relation ${r.id} duplicates an edge that already exists here; kept the existing one.`);
        bump(skipped, 'relations');
        continue;
      }
      insert(db, 'relation', { ...r, workspace_id: opts.workspaceId });
      knownRelations.add(r.id);
      bump(imported, 'relations');
    }

    const relVersionExists = db.prepare(
      'SELECT 1 FROM relation_version WHERE relation_id = ? AND version = ?'
    );
    for (const rv of payload.relationVersions ?? []) {
      if (!knownRelations.has(rv.relation_id)) continue;
      if (relVersionExists.get(rv.relation_id, rv.version)) continue;
      insert(db, 'relation_version', rv);
      bump(imported, 'relationVersions');
    }

    // --- evidence, provenance, runs --------------------------------------
    const evidenceExists = db.prepare('SELECT 1 FROM evidence WHERE id = ?');
    for (const e of payload.evidence ?? []) {
      const targetKnown =
        e.target_kind === 'object' ? knownObjects.has(e.target_id) : knownRelations.has(e.target_id);
      if (!targetKnown) continue;
      if (e.source_id && !knownSources.has(e.source_id)) continue;
      if (e.object_id && !knownObjects.has(e.object_id)) continue;
      if (evidenceExists.get(e.id)) {
        bump(skipped, 'evidence');
        continue;
      }
      insert(db, 'evidence', { ...e, workspace_id: opts.workspaceId });
      bump(imported, 'evidence');
    }

    const runExists = db.prepare('SELECT 1 FROM capability_run WHERE id = ?');
    const knownRuns = new Set();
    for (const r of payload.runs ?? []) {
      knownRuns.add(r.id);
      if (runExists.get(r.id)) continue;
      insert(db, 'capability_run', { ...r, workspace_id: opts.workspaceId });
      bump(imported, 'runs');
    }

    const derivationExists = db.prepare('SELECT 1 FROM derivation WHERE id = ?');
    for (const d of payload.derivations ?? []) {
      const targetKnown =
        d.target_kind === 'object' ? knownObjects.has(d.target_id) : knownRelations.has(d.target_id);
      if (!targetKnown) continue;
      if (derivationExists.get(d.id)) continue;
      // A derivation may cite a run that was not exported; keep the derivation
      // (provenance matters more) but drop the dangling pointer.
      insert(db, 'derivation', {
        ...d,
        workspace_id: opts.workspaceId,
        run_id: d.run_id && knownRuns.has(d.run_id) ? d.run_id : null,
      });
      bump(imported, 'derivations');
    }

    // --- proposals and conflicts -----------------------------------------
    const proposalExists = db.prepare('SELECT 1 FROM proposal WHERE id = ?');
    for (const p of payload.proposals ?? []) {
      if (proposalExists.get(p.id)) continue;
      insert(db, 'proposal', {
        ...p,
        workspace_id: opts.workspaceId,
        run_id: p.run_id && knownRuns.has(p.run_id) ? p.run_id : null,
      });
      bump(imported, 'proposals');
    }

    const conflictExists = db.prepare('SELECT 1 FROM conflict WHERE id = ?');
    for (const c of payload.conflicts ?? []) {
      if (!knownObjects.has(c.a_id)) continue;
      if (c.b_id && !knownObjects.has(c.b_id)) continue;
      if (conflictExists.get(c.id)) continue;
      insert(db, 'conflict', { ...c, workspace_id: opts.workspaceId });
      bump(imported, 'conflicts');
    }

    // --- the event log ---------------------------------------------------
    const eventExists = db.prepare('SELECT 1 FROM event WHERE id = ?');
    for (const e of payload.events ?? []) {
      if (eventExists.get(e.id)) continue;
      insert(db, 'event', { ...e, workspace_id: opts.workspaceId });
      bump(imported, 'events');
    }

    emit(db, {
      workspaceId: opts.workspaceId,
      type: EventType.KnowledgeCaptured,
      subjectKind: 'import',
      subjectId: null,
      actor,
      payload: {
        imported,
        skipped,
        warnings: warnings.length,
        exportedAt: payload.exportedAt ?? null,
        sourceWorkspace: payload.workspace?.id ?? null,
      },
    });
  };

  if (opts.dryRun) {
    // Run the whole thing and throw it away, so a dry run reports exactly what
    // a real one would do rather than a separate, drifting estimate.
    let result;
    try {
      tx(db, () => {
        run();
        result = { imported, skipped, warnings, dryRun: true };
        throw new DryRunComplete();
      });
    } catch (err) {
      if (!(err instanceof DryRunComplete)) throw err;
    }
    return /** @type {any} */ (result);
  }

  tx(db, run);
  return { imported, skipped, warnings, dryRun: false };
}

class DryRunComplete extends Error {}

/**
 * Insert a row by its own keys, so the schema stays the single source of
 * truth for column lists.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {Record<string, any>} row
 */
function insert(db, table, row) {
  const cols = TABLE_COLUMNS[table];
  if (!cols) throw new ValidationError(`Refusing to import into unknown table "${table}".`);

  const present = cols.filter((c) => row[c] !== undefined);
  const values = present.map((c) => normalise(row[c]));

  db.prepare(
    `INSERT INTO ${table} (${present.join(',')}) VALUES (${present.map(() => '?').join(',')})`
  ).run(...values);
}

/**
 * SQLite's STRICT tables reject JavaScript booleans, undefined and objects.
 * @param {any} v
 */
function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return stableStringify(v);
  return v;
}

/**
 * Explicit column allowlists. An import is the one place untrusted structure
 * reaches the database, so the set of writable columns is stated here rather
 * than taken from whatever keys happen to be in the file.
 */
const TABLE_COLUMNS = {
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
  relation_version: [
    'relation_id', 'version', 'type', 'origin', 'confidence', 'review', 'state', 'note',
    'valid_from', 'valid_until', 'change_kind', 'change_reason', 'actor', 'actor_kind', 'recorded_at',
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
  capability_run: [
    'id', 'workspace_id', 'capability', 'provider', 'model', 'model_version', 'task', 'context_ids',
    'context_hash', 'result', 'uncertainty', 'status', 'error', 'latency_ms', 'cost_micros',
    'started_at', 'finished_at',
  ],
  proposal: [
    'id', 'workspace_id', 'run_id', 'op', 'payload', 'rationale', 'confidence', 'status',
    'invalid_why', 'applied_kind', 'applied_id', 'reviewed_by', 'reviewed_at', 'review_note', 'created_at',
  ],
  conflict: [
    'id', 'workspace_id', 'kind', 'a_kind', 'a_id', 'b_kind', 'b_id', 'detail', 'detected_by',
    'confidence', 'status', 'resolution', 'created_at', 'resolved_at',
  ],
  event: [
    'id', 'workspace_id', 'type', 'subject_kind', 'subject_id', 'actor', 'actor_kind', 'payload', 'at', 'seq',
  ],
};
