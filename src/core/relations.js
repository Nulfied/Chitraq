/**
 * Relationships between Knowledge Objects.
 *
 * INVARIANT 4: relationships are part of meaning, not decoration. They are
 * first-class, versioned and provenance-carrying, exactly like objects.
 *
 * INVARIANT 16/17 (enforced in `create`): an explicit user relationship is
 * never silently overwritten, retracted or contradicted by model output. When
 * a model disagrees with a human, the disagreement is recorded as a conflict —
 * the human's edge stands.
 */

import { newRelationId, now, stableStringify, toInstant } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';
import { Origin, ValidationError, NotFoundError, recordDerivation, getRaw } from './objects.js';

/**
 * Relationship vocabulary. `type` is open — these are the types Chitraq
 * understands well enough to reason and traverse over.
 */
export const RelType = Object.freeze({
  Supports: 'supports',
  Contradicts: 'contradicts',
  Causes: 'causes',
  CausedBy: 'caused_by',
  DependsOn: 'depends_on',
  PartOf: 'part_of',
  Contains: 'contains',
  RelatedTo: 'related_to',
  SimilarTo: 'similar_to',
  DerivedFrom: 'derived_from',
  Supersedes: 'supersedes',
  Elaborates: 'elaborates',
  Precedes: 'precedes',
  Follows: 'follows',
  Concerns: 'concerns',
  Mentions: 'mentions',
  AnswersQuestion: 'answers_question',
  DecidedBy: 'decided_by',
});

/**
 * Inverse pairs, used to traverse the graph in both directions without
 * storing two edges. If a type has no inverse it is treated as symmetric
 * when it appears in SYMMETRIC, and one-directional otherwise.
 */
export const INVERSE = Object.freeze({
  causes: 'caused_by',
  caused_by: 'causes',
  part_of: 'contains',
  contains: 'part_of',
  precedes: 'follows',
  follows: 'precedes',
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  derived_from: 'derives',
  derives: 'derived_from',
});

export const SYMMETRIC = new Set(['related_to', 'similar_to', 'contradicts']);

/**
 * How much authority each origin carries. Used to decide whether an incoming
 * edge may modify an existing one.
 * @type {Record<string, number>}
 */
const AUTHORITY = { user: 3, source: 2, algorithm: 1, ai: 1 };

/**
 * Create (or reinforce) a relationship.
 *
 * If an active edge already exists for (src, type, dst):
 *   - equal or higher authority  → the existing edge is updated
 *   - lower authority (AI vs user) → the existing edge is left completely
 *     untouched and the call reports `blocked: true`. The caller may record a
 *     conflict; it may not force the write.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.srcId
 * @param {string} input.type
 * @param {string} input.dstId
 * @param {string} [input.origin]
 * @param {number|null} [input.confidence]
 * @param {string} [input.note]
 * @param {string} [input.validFrom]
 * @param {string} [input.validUntil]
 * @param {object} [input.derivation]
 * @param {import('./events.js').Actor} [actor]
 * @returns {{relation: any, created: boolean, blocked: boolean, reason?: string}}
 */
export function create(db, input, actor = SYSTEM_ACTOR) {
  const origin = input.origin ?? Origin.User;
  if (!AUTHORITY[origin]) throw new ValidationError(`Unknown origin "${origin}"`);
  if (input.srcId === input.dstId) {
    throw new ValidationError('An object cannot be related to itself.');
  }
  if (!input.type) throw new ValidationError('A relationship needs a type.');

  return tx(db, () => {
    for (const [label, oid] of [['srcId', input.srcId], ['dstId', input.dstId]]) {
      if (!getRaw(db, oid)) throw new NotFoundError(`${label} ${oid} does not exist`);
    }

    const existing = plain(
      db
        .prepare(
          `SELECT * FROM relation
           WHERE src_id = ? AND type = ? AND dst_id = ? AND state = 'active'`
        )
        .get(input.srcId, input.type, input.dstId)
    );

    if (existing) {
      if (AUTHORITY[origin] < AUTHORITY[existing.origin]) {
        return {
          relation: existing,
          created: false,
          blocked: true,
          reason:
            `A ${existing.origin}-asserted "${input.type}" edge already exists here. ` +
            `${origin} output cannot overwrite it.`,
        };
      }
      const updated = update(
        db,
        existing.id,
        {
          origin,
          confidence: input.confidence ?? existing.confidence,
          note: input.note ?? existing.note,
          validUntil: input.validUntil,
        },
        actor,
        { changeKind: 'reinforce' }
      );
      return { relation: updated, created: false, blocked: false };
    }

    const ts = now();
    const row = {
      id: newRelationId(),
      workspace_id: input.workspaceId,
      src_id: input.srcId,
      type: input.type,
      dst_id: input.dstId,
      origin,
      confidence: input.confidence ?? null,
      review: 'unreviewed',
      state: 'active',
      note: input.note ?? null,
      valid_from: toInstant(input.validFrom) ?? ts,
      valid_until: toInstant(input.validUntil),
      head_version: 1,
      created_at: ts,
      updated_at: ts,
    };

    db.prepare(
      `INSERT INTO relation (id, workspace_id, src_id, type, dst_id, origin, confidence, review,
                             state, note, valid_from, valid_until, head_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, row.workspace_id, row.src_id, row.type, row.dst_id, row.origin, row.confidence,
      row.review, row.state, row.note, row.valid_from, row.valid_until, row.head_version,
      row.created_at, row.updated_at
    );

    writeVersion(db, row, 'create', null, actor);
    if (input.derivation) {
      recordDerivation(db, row.workspace_id, 'relation', row.id, 1, input.derivation);
    }

    emit(db, {
      workspaceId: row.workspace_id,
      type: EventType.RelationCreated,
      subjectKind: 'relation',
      subjectId: row.id,
      actor,
      payload: { srcId: row.src_id, type: row.type, dstId: row.dst_id, origin },
    });

    return { relation: row, created: true, blocked: false };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relationId
 * @param {object} patch
 * @param {import('./events.js').Actor} [actor]
 * @param {{changeKind?: string, reason?: string}} [opts]
 */
export function update(db, relationId, patch, actor = SYSTEM_ACTOR, opts = {}) {
  return tx(db, () => {
    const current = plain(db.prepare('SELECT * FROM relation WHERE id = ?').get(relationId));
    if (!current) throw new NotFoundError(`No relation ${relationId}`);

    const next = {
      ...current,
      type: patch.type ?? current.type,
      origin: patch.origin ?? current.origin,
      confidence: patch.confidence !== undefined ? patch.confidence : current.confidence,
      review: patch.review ?? current.review,
      state: patch.state ?? current.state,
      note: patch.note !== undefined ? patch.note : current.note,
      valid_from: patch.validFrom !== undefined ? toInstant(patch.validFrom) : current.valid_from,
      valid_until: patch.validUntil !== undefined ? toInstant(patch.validUntil) : current.valid_until,
    };

    const watched = ['type', 'origin', 'confidence', 'review', 'state', 'note', 'valid_from', 'valid_until'];
    const changed = watched.filter((k) => (current[k] ?? null) !== (next[k] ?? null));
    if (!changed.length) return current;

    next.head_version = current.head_version + 1;
    next.updated_at = now();

    db.prepare(
      `UPDATE relation SET type=?, origin=?, confidence=?, review=?, state=?, note=?,
                           valid_from=?, valid_until=?, head_version=?, updated_at=?
       WHERE id = ?`
    ).run(
      next.type, next.origin, next.confidence, next.review, next.state, next.note,
      next.valid_from, next.valid_until, next.head_version, next.updated_at, relationId
    );

    const changeKind = opts.changeKind ?? 'edit';
    writeVersion(db, next, changeKind, opts.reason ?? null, actor);

    emit(db, {
      workspaceId: next.workspace_id,
      type: next.state === 'retracted' ? EventType.RelationRetracted : EventType.RelationUpdated,
      subjectKind: 'relation',
      subjectId: relationId,
      actor,
      payload: { changed, changeKind, reason: opts.reason ?? null },
    });

    return next;
  });
}

/**
 * Retract a relationship. The edge stays in the table marked `retracted`, so
 * "we used to think these were connected" remains answerable.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relationId
 * @param {import('./events.js').Actor} [actor]
 * @param {string} [reason]
 */
export function retract(db, relationId, actor = SYSTEM_ACTOR, reason) {
  return update(db, relationId, { state: 'retracted', validUntil: now() }, actor, {
    changeKind: 'retract',
    reason,
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relationId
 * @param {import('./events.js').Actor} actor
 */
export function confirm(db, relationId, actor) {
  return update(db, relationId, { review: 'confirmed' }, actor, { changeKind: 'confirm' });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relationId
 */
export function get(db, relationId) {
  return plain(db.prepare('SELECT * FROM relation WHERE id = ?').get(relationId));
}

/**
 * Every edge touching an object, in both directions.
 *
 * Incoming edges are returned with their inverse label where one exists, so
 * the caller sees "contains X" rather than "X part_of me" — the graph reads
 * naturally from wherever you stand in it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 * @param {{types?: string[], includeRetracted?: boolean, minConfidence?: number, origins?: string[]}} [opts]
 * @returns {{outgoing: any[], incoming: any[]}}
 */
export function neighbours(db, objectId, opts = {}) {
  const stateClause = opts.includeRetracted ? '' : " AND r.state = 'active'";
  const typeClause = opts.types?.length ? ` AND r.type IN (${opts.types.map(() => '?').join(',')})` : '';
  const originClause = opts.origins?.length
    ? ` AND r.origin IN (${opts.origins.map(() => '?').join(',')})`
    : '';
  const confClause =
    typeof opts.minConfidence === 'number' ? ' AND (r.confidence IS NULL OR r.confidence >= ?)' : '';

  /** @param {'src_id'|'dst_id'} col @param {'dst_id'|'src_id'} other */
  const run = (col, other) => {
    const args = [objectId];
    if (opts.types?.length) args.push(...opts.types);
    if (opts.origins?.length) args.push(...opts.origins);
    if (typeof opts.minConfidence === 'number') args.push(opts.minConfidence);
    return plainAll(
      db
        .prepare(
          `SELECT r.*, o.title AS other_title, o.kind AS other_kind, o.state AS other_state,
                  o.epistemic AS other_epistemic, o.id AS other_id
           FROM relation r JOIN object o ON o.id = r.${other}
           WHERE r.${col} = ?${stateClause}${typeClause}${originClause}${confClause}
             AND o.state != 'deleted'
           ORDER BY r.created_at DESC`
        )
        .all(...args)
    );
  };

  // Two labels, because an edge reads differently from each end:
  //   display_type   — how it reads standing on `objectId`
  //   other_perspective — how it reads standing on the object at the far end
  // Getting these the wrong way round turns "B was caused by A" into the claim
  // that B caused A, so they are computed once, here, rather than at each call site.
  return {
    outgoing: run('src_id', 'dst_id').map((r) => ({
      ...r,
      display_type: r.type,
      other_perspective: inverseLabel(r.type),
    })),
    incoming: run('dst_id', 'src_id').map((r) => ({
      ...r,
      display_type: inverseLabel(r.type),
      other_perspective: r.type,
    })),
  };
}

/**
 * How an edge of this type reads from the opposite end.
 * @param {string} type
 * @returns {string}
 */
export function inverseLabel(type) {
  return INVERSE[type] ?? (SYMMETRIC.has(type) ? type : `${type} (inbound)`);
}

/**
 * Breadth-first traversal from a starting object.
 *
 * Returns nodes with the depth at which they were reached and the path taken,
 * so context construction can explain *why* a distant object was included
 * rather than presenting it as unexplained relevance.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} startId
 * @param {object} [opts]
 * @param {number} [opts.depth]     default 2
 * @param {number} [opts.limit]     max nodes visited, default 200
 * @param {string[]} [opts.types]
 * @param {string[]} [opts.origins]
 * @returns {Array<{id: string, depth: number, via: string[], path: string[]}>}
 */
export function traverse(db, startId, opts = {}) {
  const maxDepth = opts.depth ?? 2;
  const limit = opts.limit ?? 200;

  /** @type {Map<string, {id: string, depth: number, via: string[], path: string[]}>} */
  const seen = new Map([[startId, { id: startId, depth: 0, via: [], path: [startId] }]]);
  let frontier = [startId];

  for (let d = 1; d <= maxDepth && frontier.length && seen.size < limit; d++) {
    /** @type {string[]} */
    const next = [];
    for (const nodeId of frontier) {
      const { outgoing, incoming } = neighbours(db, nodeId, {
        types: opts.types,
        origins: opts.origins,
      });
      const here = seen.get(nodeId);
      for (const edge of [...outgoing, ...incoming]) {
        const otherId = edge.other_id;
        if (seen.has(otherId) || seen.size >= limit) continue;
        seen.set(otherId, {
          id: otherId,
          depth: d,
          via: [...(here?.via ?? []), edge.display_type ?? edge.type],
          path: [...(here?.path ?? []), otherId],
        });
        next.push(otherId);
      }
    }
    frontier = next;
  }

  seen.delete(startId);
  return [...seen.values()];
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} f
 * @param {string} f.workspaceId
 * @param {string[]} [f.types]
 * @param {string[]} [f.origins]
 * @param {boolean} [f.includeRetracted]
 * @param {number} [f.limit]
 */
export function list(db, f) {
  const where = ['r.workspace_id = ?'];
  const args = [f.workspaceId];
  if (!f.includeRetracted) where.push("r.state = 'active'");
  if (f.types?.length) {
    where.push(`r.type IN (${f.types.map(() => '?').join(',')})`);
    args.push(...f.types);
  }
  if (f.origins?.length) {
    where.push(`r.origin IN (${f.origins.map(() => '?').join(',')})`);
    args.push(...f.origins);
  }
  return plainAll(
    db
      .prepare(
        `SELECT r.*, s.title AS src_title, s.kind AS src_kind,
                d.title AS dst_title, d.kind AS dst_kind
         FROM relation r
         JOIN object s ON s.id = r.src_id
         JOIN object d ON d.id = r.dst_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC LIMIT ?`
      )
      .all(...args, Math.min(f.limit ?? 200, 2000))
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relationId
 */
export function history(db, relationId) {
  return plainAll(
    db
      .prepare('SELECT * FROM relation_version WHERE relation_id = ? ORDER BY version ASC')
      .all(relationId)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} row
 * @param {string} changeKind
 * @param {string|null} reason
 * @param {import('./events.js').Actor} actor
 */
function writeVersion(db, row, changeKind, reason, actor) {
  db.prepare(
    `INSERT INTO relation_version (relation_id, version, type, origin, confidence, review, state,
                                   note, valid_from, valid_until, change_kind, change_reason,
                                   actor, actor_kind, recorded_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.id, row.head_version, row.type, row.origin, row.confidence, row.review, row.state,
    row.note, row.valid_from, row.valid_until, changeKind, reason, actor.id, actor.kind, now()
  );
}
