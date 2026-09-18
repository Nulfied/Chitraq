/**
 * Knowledge Objects: the persistent unit of meaning in Chitraq.
 *
 * A Knowledge Object is not a document. A document is a Source; the objects
 * are the meaningful claims, notes, decisions and observations that the
 * document (or the user) gave rise to.
 *
 * Every mutation here does two things atomically:
 *   1. updates the head row in `object`
 *   2. appends an immutable row to `object_version`
 * Nothing in this module ever rewrites or deletes history.
 */

import { newObjectId, newDerivationId, now, hash, stableStringify, toInstant } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';

/** Object kinds Chitraq understands out of the box. `kind` is open — these are the defaults. */
export const Kind = Object.freeze({
  Note: 'note',
  Fact: 'fact',
  Concept: 'concept',
  Decision: 'decision',
  Observation: 'observation',
  Question: 'question',
  Hypothesis: 'hypothesis',
  Lesson: 'lesson',
  Event: 'event',
  Entity: 'entity',
  Artifact: 'artifact',
  Task: 'task',
});

/** Where a piece of knowledge came from. INVARIANT 9: never collapse these. */
export const Origin = Object.freeze({
  User: 'user',
  Source: 'source',
  Algorithm: 'algorithm',
  AI: 'ai',
});

/** What kind of claim this is. INVARIANT 20: a hypothesis is not a fact. */
export const Epistemic = Object.freeze({
  Fact: 'fact',
  Observation: 'observation',
  Belief: 'belief',
  Hypothesis: 'hypothesis',
  Inference: 'inference',
  Conclusion: 'conclusion',
  Speculation: 'speculation',
});

export const State = Object.freeze({
  Active: 'active',
  Archived: 'archived',
  Superseded: 'superseded',
  Deleted: 'deleted',
});

/**
 * @typedef {object} KnowledgeObject
 * @property {string} id
 * @property {string} workspace_id
 * @property {string} kind
 * @property {string} title
 * @property {string} body
 * @property {object} attrs
 * @property {string} epistemic
 * @property {string} origin
 * @property {number|null} confidence
 * @property {string} review
 * @property {string} state
 * @property {string|null} superseded_by
 * @property {number} head_version
 * @property {string} content_hash
 * @property {string|null} valid_from
 * @property {string|null} valid_until
 * @property {string|null} occurred_at
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Compute the content hash used for dedup and integrity checks.
 * Deliberately excludes timestamps and provenance: two captures of the same
 * text are the same content even though they are different events.
 * @param {{kind: string, title: string, body: string, attrs: object}} o
 * @returns {string}
 */
export function contentHash(o) {
  return hash(o.kind, o.title.trim(), o.body.trim(), stableStringify(o.attrs ?? {}));
}

/**
 * Create a Knowledge Object.
 *
 * `origin` is required and meaningful: it records whether a human asserted
 * this, a source stated it, an algorithm derived it, or a model produced it.
 * AI-origin objects should normally arrive via the proposal gateway rather
 * than by calling this directly.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} [input.kind]
 * @param {string} input.title
 * @param {string} [input.body]
 * @param {object} [input.attrs]
 * @param {string} [input.epistemic]
 * @param {string} [input.origin]
 * @param {number|null} [input.confidence]
 * @param {string} [input.occurredAt]
 * @param {string} [input.validFrom]
 * @param {string} [input.validUntil]
 * @param {string} [input.reason]
 * @param {object} [input.derivation] provenance of a derived object
 * @param {import('./events.js').Actor} [actor]
 * @returns {KnowledgeObject}
 */
export function create(db, input, actor = SYSTEM_ACTOR) {
  const title = (input.title ?? '').trim();
  if (!title) throw new ValidationError('A knowledge object needs a title.');
  if (!input.workspaceId) throw new ValidationError('workspaceId is required.');

  const origin = input.origin ?? Origin.User;
  assertEnum(origin, Object.values(Origin), 'origin');

  const epistemic = input.epistemic ?? defaultEpistemic(origin);
  assertEnum(epistemic, Object.values(Epistemic), 'epistemic');

  const confidence = normaliseConfidence(input.confidence, origin);
  const attrs = input.attrs ?? {};
  const kind = input.kind ?? Kind.Note;
  const body = input.body ?? '';
  const ts = now();

  const row = {
    id: newObjectId(),
    workspace_id: input.workspaceId,
    kind,
    title,
    body,
    attrs: stableStringify(attrs),
    epistemic,
    origin,
    confidence,
    review: 'unreviewed',
    state: State.Active,
    superseded_by: null,
    head_version: 1,
    content_hash: contentHash({ kind, title, body, attrs }),
    valid_from: toInstant(input.validFrom) ?? ts,
    valid_until: toInstant(input.validUntil),
    occurred_at: toInstant(input.occurredAt),
    created_at: ts,
    updated_at: ts,
  };

  return tx(db, () => {
    db.prepare(
      `INSERT INTO object (id, workspace_id, kind, title, body, attrs, epistemic, origin,
                           confidence, review, state, superseded_by, head_version, content_hash,
                           valid_from, valid_until, occurred_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.workspace_id, row.kind, row.title, row.body, row.attrs, row.epistemic,
      row.origin, row.confidence, row.review, row.state, row.superseded_by, row.head_version,
      row.content_hash, row.valid_from, row.valid_until, row.occurred_at, row.created_at,
      row.updated_at
    );

    writeVersion(db, row, 'create', input.reason ?? null, actor);
    if (input.derivation) recordDerivation(db, row.workspace_id, 'object', row.id, 1, input.derivation);

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.KnowledgeCaptured,
      subjectKind: 'object',
      subjectId: row.id,
      actor,
      payload: { kind: row.kind, title: row.title, origin: row.origin, epistemic: row.epistemic },
    });

    return hydrate(row);
  });
}

/**
 * Apply an edit, producing a new version.
 *
 * Only the fields present in `patch` change. Passing a patch that changes
 * nothing is a no-op: Chitraq does not create empty versions, because a
 * history full of non-changes is a history nobody can read.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {object} patch
 * @param {import('./events.js').Actor} [actor]
 * @param {{reason?: string, changeKind?: string, derivation?: object}} [opts]
 * @returns {KnowledgeObject}
 */
export function update(db, objectId, patch, actor = SYSTEM_ACTOR, opts = {}) {
  return tx(db, () => {
    const current = getRaw(db, objectId);
    if (!current) throw new NotFoundError(`No knowledge object ${objectId}`);
    if (current.state === State.Deleted && opts.changeKind !== 'restore') {
      throw new ValidationError(`Object ${objectId} is deleted; restore it before editing.`);
    }

    const next = {
      ...current,
      kind: patch.kind ?? current.kind,
      title: patch.title !== undefined ? String(patch.title).trim() : current.title,
      body: patch.body !== undefined ? String(patch.body) : current.body,
      attrs: patch.attrs !== undefined ? stableStringify(patch.attrs) : current.attrs,
      epistemic: patch.epistemic ?? current.epistemic,
      confidence:
        patch.confidence !== undefined ? normaliseConfidence(patch.confidence, current.origin) : current.confidence,
      review: patch.review ?? current.review,
      state: patch.state ?? current.state,
      superseded_by: patch.supersededBy !== undefined ? patch.supersededBy : current.superseded_by,
      valid_from: patch.validFrom !== undefined ? toInstant(patch.validFrom) : current.valid_from,
      valid_until: patch.validUntil !== undefined ? toInstant(patch.validUntil) : current.valid_until,
      occurred_at: patch.occurredAt !== undefined ? toInstant(patch.occurredAt) : current.occurred_at,
    };

    if (!next.title) throw new ValidationError('A knowledge object needs a title.');
    assertEnum(next.epistemic, Object.values(Epistemic), 'epistemic');
    assertEnum(next.state, Object.values(State), 'state');

    next.content_hash = contentHash({
      kind: next.kind,
      title: next.title,
      body: next.body,
      attrs: JSON.parse(next.attrs),
    });

    if (!differs(current, next)) return hydrate(current);

    next.head_version = current.head_version + 1;
    next.updated_at = now();
    if (next.state === State.Deleted && !current.deleted_at) next.deleted_at = next.updated_at;
    if (next.state !== State.Deleted) next.deleted_at = null;

    db.prepare(
      `UPDATE object SET kind=?, title=?, body=?, attrs=?, epistemic=?, confidence=?, review=?,
                         state=?, superseded_by=?, head_version=?, content_hash=?, valid_from=?,
                         valid_until=?, occurred_at=?, updated_at=?, deleted_at=?
       WHERE id = ?`
    ).run(
      next.kind, next.title, next.body, next.attrs, next.epistemic, next.confidence, next.review,
      next.state, next.superseded_by, next.head_version, next.content_hash, next.valid_from,
      next.valid_until, next.occurred_at, next.updated_at, next.deleted_at ?? null, objectId
    );

    const changeKind = opts.changeKind ?? 'edit';
    writeVersion(db, next, changeKind, opts.reason ?? null, actor);
    if (opts.derivation) {
      recordDerivation(db, next.workspace_id, 'object', objectId, next.head_version, opts.derivation);
    }

    emit(db, {
      workspaceId: next.workspace_id,
      type: eventForChange(changeKind),
      subjectKind: 'object',
      subjectId: objectId,
      actor,
      payload: {
        version: next.head_version,
        changed: changedFields(current, next),
        changeKind,
        reason: opts.reason ?? null,
      },
    });

    return hydrate(next);
  });
}

/**
 * Record that `oldId` has been replaced by `newId`.
 *
 * INVARIANT 7/29: the old object is not deleted and not rewritten. It stays
 * readable, marked superseded, linked forward. "What we used to believe" and
 * "what we believe now" remain separately answerable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} oldId
 * @param {string} newId
 * @param {import('./events.js').Actor} [actor]
 * @param {string} [reason]
 */
export function supersede(db, oldId, newId, actor = SYSTEM_ACTOR, reason) {
  return tx(db, () => {
    const older = getRaw(db, oldId);
    const newer = getRaw(db, newId);
    if (!older) throw new NotFoundError(`No knowledge object ${oldId}`);
    if (!newer) throw new NotFoundError(`No knowledge object ${newId}`);
    if (oldId === newId) throw new ValidationError('An object cannot supersede itself.');

    const result = update(
      db,
      oldId,
      { state: State.Superseded, supersededBy: newId, validUntil: now() },
      actor,
      { changeKind: 'supersede', reason }
    );

    emit(db, {
      workspaceId: older.workspace_id,
      type: EventType.KnowledgeSuperseded,
      subjectKind: 'object',
      subjectId: oldId,
      actor,
      payload: { supersededBy: newId, reason: reason ?? null },
    });

    return result;
  });
}

/**
 * Mark a derived or proposed object as confirmed by a human.
 *
 * This does not change its origin — an AI-derived fact a human confirmed is
 * still AI-derived, and Chitraq keeps saying so. What changes is `review`,
 * which is what ranking and answer-grounding actually key on.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} actor
 * @param {string} [note]
 */
export function confirm(db, objectId, actor, note) {
  return update(db, objectId, { review: 'confirmed' }, actor, {
    changeKind: 'confirm',
    reason: note,
  });
}

/**
 * Mark knowledge as rejected by a human. It stays in memory, visible as
 * rejected, because "we considered this and decided it was wrong" is itself
 * knowledge worth keeping.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} actor
 * @param {string} [note]
 */
export function reject(db, objectId, actor, note) {
  return update(db, objectId, { review: 'rejected', state: State.Archived }, actor, {
    changeKind: 'reject',
    reason: note,
  });
}

/**
 * Archive: make something less prominent without destroying it.
 * INVARIANT 22: material may fade without being erased.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} [actor]
 * @param {string} [reason]
 */
export function archive(db, objectId, actor = SYSTEM_ACTOR, reason) {
  return update(db, objectId, { state: State.Archived }, actor, { changeKind: 'archive', reason });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} [actor]
 */
export function restore(db, objectId, actor = SYSTEM_ACTOR) {
  return update(db, objectId, { state: State.Active }, actor, { changeKind: 'restore' });
}

/**
 * Soft delete. The head row is tombstoned and drops out of retrieval, but the
 * version history survives so the deletion itself is auditable.
 * Hard erasure is a separate, explicit operation — see `purge`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} [actor]
 * @param {string} [reason]
 */
export function remove(db, objectId, actor = SYSTEM_ACTOR, reason) {
  return update(db, objectId, { state: State.Deleted }, actor, { changeKind: 'delete', reason });
}

/**
 * Irreversibly erase an object and everything derived from it.
 *
 * This is the only operation in Chitraq that destroys history, and it exists
 * because "delete my data and mean it" is a legitimate requirement. It is
 * never triggered by inference, cleanup or a model — only by an explicit call.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {import('./events.js').Actor} actor
 * @param {string} reason
 */
export function purge(db, objectId, actor, reason) {
  return tx(db, () => {
    const row = getRaw(db, objectId);
    if (!row) throw new NotFoundError(`No knowledge object ${objectId}`);

    db.prepare('DELETE FROM embedding WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM chunk_fts WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM chunk WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM evidence WHERE target_kind = ? AND target_id = ?').run('object', objectId);
    db.prepare('DELETE FROM evidence WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM derivation WHERE target_kind = ? AND target_id = ?').run('object', objectId);
    db.prepare('DELETE FROM relation_version WHERE relation_id IN (SELECT id FROM relation WHERE src_id = ? OR dst_id = ?)').run(objectId, objectId);
    db.prepare('DELETE FROM relation WHERE src_id = ? OR dst_id = ?').run(objectId, objectId);
    db.prepare('DELETE FROM conflict WHERE a_id = ? OR b_id = ?').run(objectId, objectId);
    db.prepare('UPDATE object SET superseded_by = NULL WHERE superseded_by = ?').run(objectId);
    db.prepare('DELETE FROM object_version WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM object WHERE id = ?').run(objectId);

    // The tombstone event is kept: that something was purged, and why, is
    // itself auditable even though the content is gone.
    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.KnowledgeDeleted,
      subjectKind: 'object',
      subjectId: objectId,
      actor,
      payload: { purged: true, reason, title: row.title },
    });

    return { id: objectId, purged: true };
  });
}

// ------------------------------------------------------------------ reads

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @returns {KnowledgeObject|null}
 */
export function get(db, objectId) {
  const row = getRaw(db, objectId);
  return row ? hydrate(row) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @returns {any|null}
 */
export function getRaw(db, objectId) {
  return plain(db.prepare('SELECT * FROM object WHERE id = ?').get(objectId));
}

/**
 * Find an existing object with identical content *from the same origin*.
 *
 * Matching on origin as well as content is deliberate. "You wrote this" and "a
 * model produced this" are different knowledge even when the words are
 * identical — INVARIANT 9 — and collapsing them would quietly destroy the
 * provenance distinction the whole system is built to keep. Two sources
 * independently stating the same thing is corroboration, not duplication.
 *
 * Deleted and rejected objects are excluded: re-capturing something you
 * deliberately removed should give you a fresh object, not silently resurrect
 * the one you threw away.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, kind: string, title: string, body: string, attrs: object, origin?: string}} candidate
 * @returns {KnowledgeObject|null}
 */
export function findByContent(db, candidate) {
  if (!candidate.title?.trim()) return null;
  const hash = contentHash({
    kind: candidate.kind,
    title: candidate.title,
    body: candidate.body ?? '',
    attrs: candidate.attrs ?? {},
  });

  const row = plain(
    db
      .prepare(
        `SELECT * FROM object
         WHERE workspace_id = ? AND content_hash = ? AND origin = ?
           AND state IN ('active','archived') AND review != 'rejected'
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(candidate.workspaceId, hash, candidate.origin ?? Origin.User)
  );
  return row ? hydrate(row) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @returns {KnowledgeObject[]}
 */
export function getMany(db, ids) {
  if (!ids.length) return [];
  const rows = db
    .prepare(`SELECT * FROM object WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const byId = new Map(plainAll(rows).map((r) => [r.id, hydrate(r)]));
  return ids.map((i) => byId.get(i)).filter(Boolean);
}

/**
 * Read a specific historical version.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {number} version
 */
export function getVersion(db, objectId, version) {
  const row = plain(
    db.prepare('SELECT * FROM object_version WHERE object_id = ? AND version = ?').get(objectId, version)
  );
  return row ? { ...row, attrs: JSON.parse(row.attrs) } : null;
}

/**
 * Full version history, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 */
export function history(db, objectId) {
  const rows = plainAll(
    db.prepare('SELECT * FROM object_version WHERE object_id = ? ORDER BY version ASC').all(objectId)
  );
  return rows.map((r) => ({ ...r, attrs: JSON.parse(r.attrs) }));
}

/**
 * What did this object look like at a past moment?
 * Answers "what did we believe on 3 March?" without guessing.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {string} instant ISO timestamp
 */
export function asOf(db, objectId, instant) {
  const row = plain(
    db
      .prepare(
        `SELECT * FROM object_version
         WHERE object_id = ? AND recorded_at <= ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(objectId, instant)
  );
  return row ? { ...row, attrs: JSON.parse(row.attrs) } : null;
}

/**
 * Structured listing. This is deterministic retrieval — no ranking model, no
 * embeddings, just filters. It must keep working when every AI is unavailable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} f
 * @param {string} f.workspaceId
 * @param {string[]} [f.kinds]
 * @param {string[]} [f.states]
 * @param {string[]} [f.origins]
 * @param {string[]} [f.epistemics]
 * @param {string} [f.review]
 * @param {string} [f.createdAfter]
 * @param {string} [f.createdBefore]
 * @param {string} [f.occurredAfter]
 * @param {string} [f.occurredBefore]
 * @param {number} [f.minConfidence]
 * @param {string} [f.contentHash]
 * @param {'created'|'updated'|'occurred'|'salience'|'title'} [f.orderBy]
 * @param {'asc'|'desc'} [f.direction]
 * @param {number} [f.limit]
 * @param {number} [f.offset]
 * @returns {KnowledgeObject[]}
 */
export function list(db, f) {
  const { sql, args } = listWhere(f);
  const orderCol = {
    created: 'created_at',
    updated: 'updated_at',
    occurred: 'COALESCE(occurred_at, created_at)',
    salience: 'salience',
    title: 'title',
  }[f.orderBy ?? 'created'];
  const dir = f.direction === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(f.limit ?? 50, 1000);
  const offset = f.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM object WHERE ${sql} ORDER BY ${orderCol} ${dir}, id ${dir} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  return plainAll(rows).map(hydrate);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} f
 * @returns {number}
 */
export function count(db, f) {
  const { sql, args } = listWhere(f);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM object WHERE ${sql}`).get(...args);
  return Number(row.n);
}

/**
 * @param {any} f
 * @returns {{sql: string, args: any[]}}
 */
function listWhere(f) {
  const where = ['workspace_id = ?'];
  const args = [f.workspaceId];

  // Deleted objects are excluded unless explicitly requested.
  const states = f.states ?? [State.Active];
  if (!states.includes('*')) {
    where.push(`state IN (${states.map(() => '?').join(',')})`);
    args.push(...states);
  } else {
    where.push(`state != ?`);
    args.push(State.Deleted);
  }

  for (const [col, vals] of [
    ['kind', f.kinds],
    ['origin', f.origins],
    ['epistemic', f.epistemics],
  ]) {
    if (vals?.length) {
      where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
      args.push(...vals);
    }
  }

  if (f.review) { where.push('review = ?'); args.push(f.review); }
  if (f.contentHash) { where.push('content_hash = ?'); args.push(f.contentHash); }
  if (f.createdAfter) { where.push('created_at >= ?'); args.push(f.createdAfter); }
  if (f.createdBefore) { where.push('created_at <= ?'); args.push(f.createdBefore); }
  if (f.occurredAfter) { where.push('COALESCE(occurred_at, created_at) >= ?'); args.push(f.occurredAfter); }
  if (f.occurredBefore) { where.push('COALESCE(occurred_at, created_at) <= ?'); args.push(f.occurredBefore); }
  if (typeof f.minConfidence === 'number') {
    where.push('(confidence IS NULL OR confidence >= ?)');
    args.push(f.minConfidence);
  }

  return { sql: where.join(' AND '), args };
}

/**
 * Record that an object was read. Feeds salience — deterministic prominence,
 * not a learned ranking model.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} objectIds
 */
export function touch(db, objectIds) {
  if (!objectIds.length) return;
  const ts = now();
  const stmt = db.prepare(
    'UPDATE object SET access_count = access_count + 1, last_access = ? WHERE id = ?'
  );
  for (const oid of objectIds) stmt.run(ts, oid);
}

// ------------------------------------------------------------- internals

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} row
 * @param {string} changeKind
 * @param {string|null} reason
 * @param {import('./events.js').Actor} actor
 */
function writeVersion(db, row, changeKind, reason, actor) {
  db.prepare(
    `INSERT INTO object_version (object_id, version, kind, title, body, attrs, epistemic, origin,
                                 confidence, review, state, valid_from, valid_until, occurred_at,
                                 content_hash, change_kind, change_reason, actor, actor_kind, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.head_version, row.kind, row.title, row.body, row.attrs, row.epistemic, row.origin,
    row.confidence, row.review, row.state, row.valid_from, row.valid_until, row.occurred_at,
    row.content_hash, changeKind, reason, actor.id, actor.kind, now()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {'object'|'relation'} targetKind
 * @param {string} targetId
 * @param {number} version
 * @param {any} d
 */
export function recordDerivation(db, workspaceId, targetKind, targetId, version, d) {
  db.prepare(
    `INSERT INTO derivation (id, workspace_id, target_kind, target_id, target_version, method,
                             capability, provider, model, model_version, run_id, inputs, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    newDerivationId(), workspaceId, targetKind, targetId, version, d.method ?? 'user',
    d.capability ?? null, d.provider ?? null, d.model ?? null, d.modelVersion ?? null,
    d.runId ?? null, stableStringify(d.inputs ?? []), now()
  );
}

/**
 * Full provenance chain for an object: how each version came to exist.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} targetId
 * @param {'object'|'relation'} [targetKind]
 */
export function derivations(db, targetId, targetKind = 'object') {
  const rows = plainAll(
    db
      .prepare(
        'SELECT * FROM derivation WHERE target_kind = ? AND target_id = ? ORDER BY target_version ASC'
      )
      .all(targetKind, targetId)
  );
  return rows.map((r) => ({ ...r, inputs: JSON.parse(r.inputs) }));
}

/** @param {any} row */
function hydrate(row) {
  return { ...row, attrs: typeof row.attrs === 'string' ? JSON.parse(row.attrs) : row.attrs };
}

/** @param {any} a @param {any} b */
function differs(a, b) {
  return changedFields(a, b).length > 0;
}

/** @param {any} a @param {any} b @returns {string[]} */
function changedFields(a, b) {
  const watched = [
    'kind', 'title', 'body', 'attrs', 'epistemic', 'confidence', 'review',
    'state', 'superseded_by', 'valid_from', 'valid_until', 'occurred_at',
  ];
  return watched.filter((k) => (a[k] ?? null) !== (b[k] ?? null));
}

/** @param {string} changeKind */
function eventForChange(changeKind) {
  return {
    archive: EventType.KnowledgeArchived,
    delete: EventType.KnowledgeDeleted,
    restore: EventType.KnowledgeRestored,
    supersede: EventType.KnowledgeSuperseded,
    confirm: EventType.KnowledgeConfirmed,
    reject: EventType.KnowledgeRejected,
  }[changeKind] ?? EventType.KnowledgeUpdated;
}

/**
 * A user assertion carries no confidence score: it is not a probabilistic
 * claim, and giving it one would blur the line the system exists to hold.
 * @param {number|null|undefined} value
 * @param {string} origin
 * @returns {number|null}
 */
function normaliseConfidence(value, origin) {
  if (value === null || value === undefined) return origin === Origin.User ? null : null;
  const n = Number(value);
  if (Number.isNaN(n)) throw new ValidationError('confidence must be a number between 0 and 1.');
  if (n < 0 || n > 1) throw new ValidationError('confidence must be between 0 and 1.');
  return n;
}

/** @param {string} origin */
function defaultEpistemic(origin) {
  return origin === Origin.AI || origin === Origin.Algorithm
    ? Epistemic.Inference
    : Epistemic.Observation;
}

/** @param {string} value @param {string[]} allowed @param {string} field */
function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(', ')} (got "${value}")`);
  }
}

export class ValidationError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

export class NotFoundError extends Error {
  constructor(/** @type {string} */ message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}
