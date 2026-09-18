/**
 * Entity resolution.
 *
 * Extraction gives you the string "Priya Rao" in nine different notes.
 * Resolution turns those nine strings into one Entity object that all nine
 * notes point at — which is the difference between a pile of text and a graph
 * you can ask questions of.
 *
 * The hard part is not finding candidates, it is knowing when *not* to merge.
 * Two people share a surname; two projects share an acronym. Merging them is
 * worse than leaving them apart, because a wrong merge silently fuses two
 * histories and is tedious to unpick. So:
 *
 *   - an exact match on a normalised name or a recorded alias resolves silently
 *   - anything weaker becomes a *proposal*, never a write
 *   - merging is explicit, reversible in effect (the merged entity is kept and
 *     superseded, not deleted), and re-points every edge that referenced it
 */

import { now } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { emit, EventType, SYSTEM_ACTOR } from './events.js';
import * as objects from './objects.js';
import * as relations from './relations.js';
import { normalise } from './text.js';
import { ValidationError, NotFoundError } from './objects.js';

/** Entity types Chitraq resolves. Open set; these are the ones it handles well. */
export const EntityType = Object.freeze({
  Person: 'person',
  Organisation: 'organisation',
  Project: 'project',
  Place: 'place',
  Product: 'product',
  Concept: 'concept',
  Identifier: 'identifier',
  Other: 'other',
});

/**
 * Map an extractor's type onto an entity type. Structured extractions (dates,
 * money, percentages) are deliberately *not* entities — they are values, and
 * making every "40%" a node would swamp the graph with noise.
 * @param {string} extractedType
 * @returns {string|null} null means "do not make this an entity"
 */
export function entityTypeFor(extractedType) {
  return {
    name: EntityType.Person,
    organisation: EntityType.Organisation,
    identifier: EntityType.Identifier,
    place: EntityType.Place,
    product: EntityType.Product,
    project: EntityType.Project,
    concept: EntityType.Concept,
    url: null,
    email: null,
    date: null,
    time: null,
    money: null,
    percent: null,
    version: null,
  }[extractedType] ?? null;
}

/**
 * Canonical form used for exact matching.
 *
 * Case, accents, punctuation and honorifics are stripped; word order is not
 * touched, because "Rao Priya" and "Priya Rao" are not reliably the same
 * person and guessing costs more than it saves.
 * @param {string} name
 * @returns {string}
 */
export function canonicalise(name) {
  return normalise(name)
    .replace(/\b(mr|mrs|ms|dr|prof|sir|madam)\.?\s+/g, '')
    .replace(/[.,'"()\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find an existing entity by exact name or alias match.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, name: string, entityType?: string}} q
 * @returns {any|null}
 */
export function find(db, q) {
  const key = canonicalise(q.name);
  if (!key) return null;

  const candidates = plainAll(
    db
      .prepare(
        `SELECT * FROM object
         WHERE workspace_id = ? AND kind = 'entity' AND state IN ('active','archived')
         ORDER BY created_at ASC`
      )
      .all(q.workspaceId)
  );

  for (const row of candidates) {
    const attrs = safeAttrs(row.attrs);
    if (q.entityType && attrs.entityType && attrs.entityType !== q.entityType) continue;

    const names = [attrs.canonicalName ?? canonicalise(row.title), ...(attrs.aliases ?? []).map(canonicalise)];
    if (names.includes(key)) return { ...row, attrs };
  }
  return null;
}

/**
 * Resolve a name to an entity, creating one if there is no exact match.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.name
 * @param {string} [input.entityType]
 * @param {string} [input.origin]      provenance of the *entity*, not the mention
 * @param {number} [input.confidence]
 * @param {import('./events.js').Actor} [actor]
 * @returns {{entity: any, created: boolean}}
 */
export function resolve(db, input, actor = SYSTEM_ACTOR) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('An entity needs a name.');

  return tx(db, () => {
    const existing = find(db, {
      workspaceId: input.workspaceId,
      name,
      entityType: input.entityType,
    });
    if (existing) return { entity: existing, created: false };

    const entity = objects.create(
      db,
      {
        workspaceId: input.workspaceId,
        kind: objects.Kind.Entity,
        title: name,
        body: '',
        attrs: {
          entityType: input.entityType ?? EntityType.Other,
          canonicalName: canonicalise(name),
          aliases: [],
          mentionCount: 0,
        },
        // An entity is a structural artefact the system derived from text, not
        // a claim anyone made. Saying it is `algorithm`-origin keeps that honest.
        origin: input.origin ?? objects.Origin.Algorithm,
        epistemic: objects.Epistemic.Observation,
        confidence: input.confidence ?? null,
        derivation: { method: 'entity-resolution' },
      },
      actor
    );

    return { entity: { ...entity }, created: true };
  });
}

/**
 * Link a knowledge object to the entities it mentions.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.objectId
 * @param {Array<{text: string, type: string, confidence: number}>} input.entities
 * @param {number} [input.minConfidence]
 * @param {import('./events.js').Actor} [actor]
 * @returns {{linked: any[], created: any[], skipped: number}}
 */
export function linkMentions(db, input, actor = SYSTEM_ACTOR) {
  const minConfidence = input.minConfidence ?? 0.5;

  return tx(db, () => {
    /** @type {any[]} */
    const linked = [];
    /** @type {any[]} */
    const created = [];
    let skipped = 0;
    const seen = new Set();

    for (const candidate of input.entities ?? []) {
      const entityType = entityTypeFor(candidate.type);
      if (!entityType || candidate.confidence < minConfidence) {
        skipped++;
        continue;
      }

      const key = `${entityType}:${canonicalise(candidate.text)}`;
      if (!key.endsWith(':') && seen.has(key)) continue;
      seen.add(key);

      const { entity, created: isNew } = resolve(
        db,
        {
          workspaceId: input.workspaceId,
          name: candidate.text,
          entityType,
          confidence: candidate.confidence,
        },
        actor
      );
      if (isNew) created.push(entity);
      if (entity.id === input.objectId) continue;

      const edge = relations.create(
        db,
        {
          workspaceId: input.workspaceId,
          srcId: input.objectId,
          type: relations.RelType.Mentions,
          dstId: entity.id,
          origin: objects.Origin.Algorithm,
          confidence: candidate.confidence,
          derivation: { method: 'entity-resolution' },
        },
        actor
      );

      if (!edge.blocked) {
        linked.push({ entityId: entity.id, name: entity.title, type: entityType });
        bumpMentionCount(db, entity.id, actor);
      }
    }

    return { linked, created, skipped };
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {import('./events.js').Actor} actor
 */
function bumpMentionCount(db, entityId, actor) {
  const row = objects.get(db, entityId);
  if (!row) return;
  // Written straight to attrs rather than through update(), so that counting
  // mentions does not fill the version history with bookkeeping noise.
  const attrs = { ...row.attrs, mentionCount: (row.attrs.mentionCount ?? 0) + 1 };
  db.prepare('UPDATE object SET attrs = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(attrs),
    now(),
    entityId
  );
}

/**
 * Candidates that look like the same entity but are not an exact match.
 *
 * Returned for review, never merged automatically. The scoring is deliberately
 * conservative and explains itself, because the reviewer needs a reason, not a
 * number.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{minScore?: number, limit?: number}} [opts]
 * @returns {Array<{a: any, b: any, score: number, because: string}>}
 */
export function duplicateCandidates(db, workspaceId, opts = {}) {
  const minScore = opts.minScore ?? 0.7;
  const entities = plainAll(
    db
      .prepare(
        `SELECT * FROM object WHERE workspace_id = ? AND kind = 'entity' AND state = 'active'`
      )
      .all(workspaceId)
  ).map((r) => ({ ...r, attrs: safeAttrs(r.attrs) }));

  /** @type {Array<{a: any, b: any, score: number, because: string}>} */
  const out = [];

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];
      if (a.attrs.entityType !== b.attrs.entityType) continue;

      const match = compareNames(a.title, b.title);
      if (match.score >= minScore) {
        out.push({ a, b, score: match.score, because: match.because });
      }
    }
  }

  return out.sort((x, y) => y.score - x.score).slice(0, opts.limit ?? 50);
}

/**
 * @param {string} nameA
 * @param {string} nameB
 * @returns {{score: number, because: string}}
 */
export function compareNames(nameA, nameB) {
  const a = canonicalise(nameA);
  const b = canonicalise(nameB);
  if (!a || !b) return { score: 0, because: 'empty name' };
  if (a === b) return { score: 1, because: 'identical once normalised' };

  const wordsA = a.split(' ');
  const wordsB = b.split(' ');

  // "Priya" vs "Priya Rao" — one name is a prefix of the other. Common and
  // usually right, but only when the shorter one is a whole word boundary.
  if (b.startsWith(`${a} `) || a.startsWith(`${b} `)) {
    return { score: 0.8, because: 'one name is the start of the other' };
  }

  // "P. Rao" vs "Priya Rao" — same surname, compatible initial.
  if (wordsA.length > 1 && wordsB.length > 1 && wordsA.at(-1) === wordsB.at(-1)) {
    const firstA = wordsA[0];
    const firstB = wordsB[0];
    if (firstA[0] === firstB[0]) {
      const initialled = firstA.length === 1 || firstB.length === 1;
      return {
        score: initialled ? 0.85 : 0.72,
        because: initialled
          ? 'same last name, and one first name is an initial of the other'
          : 'same last name and same first initial',
      };
    }
  }

  const distance = editDistance(a, b);
  const similarity = 1 - distance / Math.max(a.length, b.length);
  if (distance <= 2 && similarity >= 0.85) {
    return { score: similarity * 0.9, because: `differs by ${distance} character(s)` };
  }

  return { score: 0, because: 'not similar enough to suggest' };
}

/**
 * Levenshtein distance, two-row variant.
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Merge one entity into another.
 *
 * Everything that pointed at the merged entity now points at the kept one; its
 * names become aliases so future extractions resolve correctly; and it is
 * superseded rather than deleted, so the merge is visible in history and the
 * old id still resolves.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.keepId
 * @param {string} input.mergeId
 * @param {string} [input.reason]
 * @param {import('./events.js').Actor} [actor]
 * @returns {{entity: any, movedRelations: number, aliases: string[]}}
 */
export function merge(db, input, actor = SYSTEM_ACTOR) {
  if (input.keepId === input.mergeId) {
    throw new ValidationError('An entity cannot be merged into itself.');
  }

  return tx(db, () => {
    const keep = objects.get(db, input.keepId);
    const drop = objects.get(db, input.mergeId);
    if (!keep) throw new NotFoundError(`No entity ${input.keepId}`);
    if (!drop) throw new NotFoundError(`No entity ${input.mergeId}`);
    if (keep.kind !== 'entity' || drop.kind !== 'entity') {
      throw new ValidationError('Merging is only defined for entities.');
    }

    const aliases = [
      ...new Set([
        ...(keep.attrs.aliases ?? []),
        drop.title,
        ...(drop.attrs.aliases ?? []),
      ].filter((a) => canonicalise(a) !== canonicalise(keep.title))),
    ];

    let moved = 0;
    const edges = plainAll(
      db.prepare(`SELECT * FROM relation WHERE (src_id = ? OR dst_id = ?)`).all(input.mergeId, input.mergeId)
    );

    for (const edge of edges) {
      const src = edge.src_id === input.mergeId ? input.keepId : edge.src_id;
      const dst = edge.dst_id === input.mergeId ? input.keepId : edge.dst_id;

      // Re-pointing can create a self-edge or collide with an edge that
      // already exists; in both cases the merged edge is simply retracted.
      const collides =
        src === dst ||
        db
          .prepare(
            `SELECT 1 FROM relation WHERE src_id = ? AND type = ? AND dst_id = ? AND state = 'active' AND id != ?`
          )
          .get(src, edge.type, dst, edge.id);

      if (collides) {
        if (edge.state === 'active') relations.retract(db, edge.id, actor, 'merged into another entity');
        continue;
      }

      db.prepare('UPDATE relation SET src_id = ?, dst_id = ?, updated_at = ? WHERE id = ?').run(
        src, dst, now(), edge.id
      );
      moved++;
    }

    db.prepare(`UPDATE evidence SET object_id = ? WHERE object_id = ?`).run(input.keepId, input.mergeId);

    const updated = objects.update(
      db,
      input.keepId,
      {
        attrs: {
          ...keep.attrs,
          aliases,
          mentionCount: (keep.attrs.mentionCount ?? 0) + (drop.attrs.mentionCount ?? 0),
        },
      },
      actor,
      { changeKind: 'merge', reason: input.reason ?? `merged ${drop.title}` }
    );

    objects.supersede(db, input.mergeId, input.keepId, actor, input.reason ?? 'merged duplicate entity');

    emit(db, {
      workspaceId: keep.workspace_id,
      type: EventType.KnowledgeUpdated,
      subjectKind: 'object',
      subjectId: input.keepId,
      actor,
      payload: { merged: input.mergeId, movedRelations: moved, aliases },
    });

    return { entity: updated, movedRelations: moved, aliases };
  });
}

/**
 * Add an alias by hand, so future extractions resolve to the right entity.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {string} alias
 * @param {import('./events.js').Actor} [actor]
 */
export function addAlias(db, entityId, alias, actor = SYSTEM_ACTOR) {
  const entity = objects.get(db, entityId);
  if (!entity) throw new NotFoundError(`No entity ${entityId}`);

  const aliases = [...new Set([...(entity.attrs.aliases ?? []), alias.trim()])];
  return objects.update(db, entityId, { attrs: { ...entity.attrs, aliases } }, actor, {
    changeKind: 'edit',
    reason: `alias "${alias}" added`,
  });
}

/**
 * List entities, most-mentioned first.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, entityType?: string, limit?: number}} q
 */
export function list(db, q) {
  const rows = plainAll(
    db
      .prepare(
        `SELECT o.*, (SELECT COUNT(*) FROM relation r
                      WHERE r.dst_id = o.id AND r.type = 'mentions' AND r.state = 'active') AS mentions
         FROM object o
         WHERE o.workspace_id = ? AND o.kind = 'entity' AND o.state = 'active'
         ORDER BY mentions DESC, o.title ASC LIMIT ?`
      )
      .all(q.workspaceId, Math.min(q.limit ?? 100, 1000))
  ).map((r) => ({ ...r, attrs: safeAttrs(r.attrs) }));

  return q.entityType ? rows.filter((r) => r.attrs.entityType === q.entityType) : rows;
}

/**
 * Everything that mentions this entity.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityId
 * @param {number} [limit]
 */
export function mentionedIn(db, entityId, limit = 100) {
  return plainAll(
    db
      .prepare(
        `SELECT o.id, o.title, o.kind, o.occurred_at, o.created_at, r.confidence
         FROM relation r JOIN object o ON o.id = r.src_id
         WHERE r.dst_id = ? AND r.type = 'mentions' AND r.state = 'active' AND o.state != 'deleted'
         ORDER BY COALESCE(o.occurred_at, o.created_at) DESC LIMIT ?`
      )
      .all(entityId, limit)
  );
}

/** @param {any} attrs */
function safeAttrs(attrs) {
  if (typeof attrs !== 'string') return attrs ?? {};
  try {
    return JSON.parse(attrs);
  } catch {
    return {};
  }
}
