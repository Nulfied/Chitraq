/**
 * Retrieval.
 *
 * Chitraq combines several signals rather than trusting one:
 *
 *   lexical    BM25 over the full-text index — exact words, names, ids
 *   semantic   cosine over embeddings — paraphrase and synonym
 *   structural relationship proximity to an anchor object
 *   temporal   explicit ranges, plus gentle recency preference
 *   quality    epistemic status, human review, evidence, origin
 *
 * INVARIANT 25: no single retrieval technology is universally correct.
 * Lexical search finds the invoice number that embeddings smear away; vectors
 * find the note that never used your words. Ranked lists are fused with
 * Reciprocal Rank Fusion, which needs no score calibration between signals.
 *
 * Every result carries a `why` breakdown, so a ranking is always explainable.
 */

import { plainAll } from '../core/db.js';
import { excerpt, contentTerms } from '../core/text.js';
import { decodeVector } from './indexer.js';
import { traverse } from '../core/relations.js';
import { parse, toFtsQuery } from './query.js';

/** RRF damping constant. 60 is the value from the original TREC work. */
const RRF_K = 60;

/**
 * @typedef {object} SearchResult
 * @property {string} id
 * @property {string} title
 * @property {string} kind
 * @property {string} epistemic
 * @property {string} origin
 * @property {string} review
 * @property {string} state
 * @property {number|null} confidence
 * @property {string} excerpt
 * @property {number} score
 * @property {object} why   per-signal contributions
 */

/**
 * Search memory.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} [opts.q]                     raw query string
 * @param {import('./query.js').Intent} [opts.intent]  pre-parsed intent
 * @param {number[]} [opts.queryVector]         embedding of the query, if available
 * @param {string} [opts.vectorModel]
 * @param {number} [opts.limit]
 * @param {string} [opts.anchorId]              boost things near this object
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.recencyHalfLifeDays]   0 disables recency preference
 * @returns {{results: SearchResult[], intent: any, signals: string[], total: number}}
 */
export function search(db, opts) {
  const intent = opts.intent ?? parse(opts.q ?? '');
  const limit = Math.min(opts.limit ?? 20, 200);
  const pool = Math.max(limit * 5, 100);

  /** @type {string[]} */
  const signals = [];

  const lexical = lexicalSearch(db, intent, opts.workspaceId, pool);
  if (lexical.length) signals.push('lexical');

  const semantic = opts.queryVector
    ? vectorSearch(db, {
        workspaceId: opts.workspaceId,
        vector: opts.queryVector,
        model: opts.vectorModel ?? 'unknown',
        limit: pool,
      })
    : [];
  if (semantic.length) signals.push('semantic');

  const structural = opts.anchorId ? structuralNeighbours(db, opts.anchorId) : new Map();
  if (structural.size) signals.push('structural');

  // Browse-shaped queries (filters only, no text) are answered purely by the
  // deterministic structured path: no ranking model is needed or wanted.
  const browse =
    !lexical.length && !semantic.length ? structuredCandidates(db, intent, opts.workspaceId, pool) : [];
  if (browse.length) signals.push('structured');

  /** @type {Map<string, {objectId: string, ranks: Record<string, number>, best: Record<string, any>}>} */
  const fused = new Map();

  const addList = (list, name) => {
    list.forEach((row, i) => {
      const entry = fused.get(row.object_id) ?? { objectId: row.object_id, ranks: {}, best: {} };
      entry.ranks[name] = i + 1;
      entry.best[name] = row;
      fused.set(row.object_id, entry);
    });
  };

  addList(lexical, 'lexical');
  addList(semantic, 'semantic');
  addList(browse, 'structured');

  if (!fused.size) return { results: [], intent, signals, total: 0 };

  const ids = [...fused.keys()];
  const objectRows = new Map(
    plainAll(
      db
        .prepare(`SELECT * FROM object WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)
    ).map((r) => [r.id, r])
  );

  const evidenceCounts = countEvidence(db, ids);
  const now = Date.now();
  const halfLife = opts.recencyHalfLifeDays ?? 180;

  /** @type {SearchResult[]} */
  const scored = [];

  for (const [objectId, entry] of fused) {
    const obj = objectRows.get(objectId);
    if (!obj) continue;
    if (!passesFilters(obj, intent, opts.includeArchived)) continue;

    const why = {};
    let score = 0;

    for (const [name, rank] of Object.entries(entry.ranks)) {
      const weight = name === 'lexical' ? 1.0 : name === 'semantic' ? 0.9 : 0.6;
      const contribution = weight * (1 / (RRF_K + rank));
      why[name] = { rank, contribution: round(contribution) };
      score += contribution;
    }

    const structuralHit = structural.get(objectId);
    if (structuralHit) {
      const contribution = 0.5 / (RRF_K + structuralHit.depth * 10);
      why.structural = { depth: structuralHit.depth, via: structuralHit.via, contribution: round(contribution) };
      score += contribution;
    }

    const q = qualityMultiplier(obj, evidenceCounts.get(objectId) ?? 0);
    why.quality = { multiplier: round(q.value), because: q.because };
    score *= q.value;

    if (halfLife > 0) {
      const ageDays = (now - Date.parse(obj.updated_at)) / 86400000;
      const recency = Math.pow(0.5, ageDays / halfLife);
      const factor = 0.85 + 0.15 * recency;
      why.recency = { ageDays: Math.round(ageDays), multiplier: round(factor) };
      score *= factor;
    }

    const snippetSource = entry.best.lexical?.text ?? entry.best.semantic?.text ?? obj.body ?? obj.title;

    scored.push({
      id: obj.id,
      title: obj.title,
      kind: obj.kind,
      epistemic: obj.epistemic,
      origin: obj.origin,
      review: obj.review,
      state: obj.state,
      confidence: obj.confidence,
      occurred_at: obj.occurred_at,
      created_at: obj.created_at,
      updated_at: obj.updated_at,
      excerpt: excerpt(snippetSource, intent.terms),
      score: round(score),
      why,
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  return { results: scored.slice(0, limit), intent, signals, total: scored.length };
}

/**
 * BM25 over the FTS index, with the title weighted above the body.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./query.js').Intent} intent
 * @param {string} workspaceId
 * @param {number} limit
 */
export function lexicalSearch(db, intent, workspaceId, limit) {
  const match = toFtsQuery(intent);
  if (!match) return [];

  try {
    return plainAll(
      db
        .prepare(
          `SELECT chunk_id, object_id, text, bm25(chunk_fts, 3.0, 1.0) AS bm25
           FROM chunk_fts
           WHERE chunk_fts MATCH ? AND workspace_id = ?
           ORDER BY bm25 LIMIT ?`
        )
        .all(match, workspaceId, limit)
    );
  } catch {
    // A malformed MATCH expression is a query problem, not a memory problem:
    // degrade to no lexical signal rather than failing the whole search.
    return [];
  }
}

/**
 * Exhaustive cosine scan over stored vectors.
 *
 * Deliberately brute force. At personal and team scale (tens to hundreds of
 * thousands of chunks) a linear scan of float32 vectors is a few milliseconds
 * and is exactly correct; an ANN index would add a dependency, a build step
 * and approximation error to solve a problem nobody here has yet. Replace it
 * when measurement — not fashion — says to.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, vector: number[], model: string, limit: number, minScore?: number, relativeCutoff?: number}} opts
 */
export function vectorSearch(db, opts) {
  const rows = db
    .prepare('SELECT chunk_id, object_id, vec, dim FROM embedding WHERE workspace_id = ? AND model = ?')
    .all(opts.workspaceId, opts.model);
  if (!rows.length) return [];

  const query = Float32Array.from(opts.vector);
  const qNorm = norm(query);
  if (qNorm === 0) return [];

  const minScore = opts.minScore ?? 0.05;
  /** @type {Array<{chunk_id: string, object_id: string, similarity: number}>} */
  const scored = [];

  for (const row of rows) {
    if (Number(row.dim) !== query.length) continue; // different model generation
    const vec = decodeVector(/** @type {Uint8Array} */ (row.vec));
    const sim = cosine(query, vec, qNorm);
    if (sim >= minScore) {
      scored.push({
        chunk_id: /** @type {string} */ (row.chunk_id),
        object_id: /** @type {string} */ (row.object_id),
        similarity: sim,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);

  // Drop the long tail relative to the best match, not against a fixed number.
  //
  // Absolute thresholds do not survive changing the embedding model: the
  // built-in hashing embedder scores unrelated text near 0.07, while a trained
  // embedder can put unrelated text above 0.5. Either way the *gap* between a
  // real match and noise is large, so cutting at a fraction of the top score
  // keeps this correct when the provider is swapped — which the architecture
  // assumes will happen.
  if (scored.length > 1) {
    const cutoff = scored[0].similarity * (opts.relativeCutoff ?? 0.4);
    const lastKeep = scored.findIndex((s) => s.similarity < cutoff);
    if (lastKeep > 0) scored.length = lastKeep;
  }

  // Keep the best chunk per object so one long note cannot flood the results.
  /** @type {Map<string, any>} */
  const best = new Map();
  for (const s of scored) {
    if (!best.has(s.object_id)) best.set(s.object_id, s);
  }
  return [...best.values()].slice(0, opts.limit);
}

/**
 * Structured-only retrieval: filters, no text ranking.
 * This is the path that keeps working when the index is empty or rebuilding.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('./query.js').Intent} intent
 * @param {string} workspaceId
 * @param {number} limit
 */
function structuredCandidates(db, intent, workspaceId, limit) {
  const where = ['workspace_id = ?', "state != 'deleted'"];
  const args = [workspaceId];

  if (intent.kinds.length) {
    where.push(`kind IN (${intent.kinds.map(() => '?').join(',')})`);
    args.push(...intent.kinds);
  }
  if (intent.origins.length) {
    where.push(`origin IN (${intent.origins.map(() => '?').join(',')})`);
    args.push(...intent.origins);
  }
  if (intent.after) { where.push('COALESCE(occurred_at, created_at) >= ?'); args.push(intent.after); }
  if (intent.before) { where.push('COALESCE(occurred_at, created_at) <= ?'); args.push(intent.before); }

  return plainAll(
    db
      .prepare(
        `SELECT id AS object_id, body AS text FROM object
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?`
      )
      .all(...args, limit)
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} anchorId
 * @returns {Map<string, {depth: number, via: string[]}>}
 */
function structuralNeighbours(db, anchorId) {
  const reached = traverse(db, anchorId, { depth: 2, limit: 150 });
  return new Map(reached.map((r) => [r.id, { depth: r.depth, via: r.via }]));
}

/**
 * Filters that apply after fusion, so they constrain every signal identically.
 * @param {any} obj
 * @param {import('./query.js').Intent} intent
 * @param {boolean} [includeArchived]
 */
function passesFilters(obj, intent, includeArchived) {
  if (obj.state === 'deleted') return false;
  if (intent.states.length) {
    if (!intent.states.includes(obj.state)) return false;
  } else if (!includeArchived && (obj.state === 'archived' || obj.state === 'superseded')) {
    // Superseded knowledge is kept and stays reachable — but not from an
    // ordinary question. Asking "what is our pricing" must not return last
    // year's price alongside this year's as though both were current.
    // It comes back for `is:superseded`, for time-shaped questions, and as a
    // predecessor of whatever replaced it.
    return false;
  }
  if (intent.kinds.length && !intent.kinds.includes(obj.kind)) return false;
  if (intent.origins.length && !intent.origins.includes(obj.origin)) return false;
  if (intent.epistemics.length && !intent.epistemics.includes(obj.epistemic)) return false;
  if (intent.review && obj.review !== intent.review) return false;

  const when = obj.occurred_at ?? obj.created_at;
  if (intent.after && when < intent.after) return false;
  if (intent.before && when > intent.before) return false;

  if (intent.tags.length) {
    const tags = (safeAttrs(obj.attrs).tags ?? []).map((t) => String(t).toLowerCase());
    if (!intent.tags.every((t) => tags.includes(t))) return false;
  }

  if (intent.exclude.length) {
    const hay = contentTerms(`${obj.title} ${obj.body}`);
    if (intent.exclude.some((t) => hay.includes(t))) return false;
  }

  return true;
}

/**
 * Quality weighting.
 *
 * INVARIANT 53: this adjusts *ranking*, never truth. A speculative note is not
 * made false by ranking below a confirmed one, and nothing here rewrites the
 * object — the reasons are returned so the user can see why order came out
 * as it did.
 *
 * @param {any} obj
 * @param {number} evidenceCount
 * @returns {{value: number, because: string[]}}
 */
function qualityMultiplier(obj, evidenceCount) {
  const because = [];
  let m = 1.0;

  if (obj.review === 'confirmed') { m *= 1.25; because.push('confirmed by a human'); }
  if (obj.review === 'rejected') { m *= 0.4; because.push('previously rejected'); }

  const epistemicWeight = {
    fact: 1.15, observation: 1.05, conclusion: 1.05, belief: 1.0,
    inference: 0.95, hypothesis: 0.9, speculation: 0.75,
  }[obj.epistemic] ?? 1.0;
  if (epistemicWeight !== 1.0) {
    m *= epistemicWeight;
    because.push(`${obj.epistemic}`);
  }

  if (obj.origin === 'user') { m *= 1.1; because.push('you wrote it'); }
  if (obj.origin === 'ai' && obj.review === 'unreviewed') {
    m *= 0.85;
    because.push('AI-derived, not yet reviewed');
  }

  if (typeof obj.confidence === 'number') {
    m *= 0.7 + 0.3 * obj.confidence;
    because.push(`confidence ${obj.confidence.toFixed(2)}`);
  }

  if (evidenceCount > 0) {
    m *= 1 + Math.min(0.2, evidenceCount * 0.05);
    because.push(`${evidenceCount} piece${evidenceCount === 1 ? '' : 's'} of evidence`);
  }

  if (obj.state === 'superseded') { m *= 0.5; because.push('superseded'); }
  if (obj.state === 'archived') { m *= 0.7; because.push('archived'); }

  return { value: m, because };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @returns {Map<string, number>}
 */
function countEvidence(db, ids) {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT target_id, COUNT(*) AS n FROM evidence
       WHERE target_kind = 'object' AND target_id IN (${ids.map(() => '?').join(',')})
       GROUP BY target_id`
    )
    .all(...ids);
  return new Map(rows.map((r) => [/** @type {string} */ (r.target_id), Number(r.n)]));
}

/**
 * Objects similar to a given one, by vector when available and by shared
 * vocabulary otherwise. Used for "you may already know this" and for
 * proposing `similar_to` edges.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.objectId
 * @param {number[]} [opts.vector]
 * @param {string} [opts.model]
 * @param {number} [opts.limit]
 * @param {number} [opts.minScore]
 */
export function similarTo(db, opts) {
  const limit = opts.limit ?? 10;

  if (opts.vector && opts.model) {
    const hits = vectorSearch(db, {
      workspaceId: opts.workspaceId,
      vector: opts.vector,
      model: opts.model,
      limit: limit + 5,
      minScore: opts.minScore ?? 0.35,
    });
    return hits
      .filter((h) => h.object_id !== opts.objectId)
      .slice(0, limit)
      .map((h) => ({ objectId: h.object_id, score: round(h.similarity), by: 'vector' }));
  }

  const self = db.prepare('SELECT title, body FROM object WHERE id = ?').get(opts.objectId);
  if (!self) return [];
  const intent = parse(contentTerms(`${self.title} ${self.body}`).slice(0, 25).join(' '));
  return lexicalSearch(db, intent, opts.workspaceId, limit + 5)
    .filter((h) => h.object_id !== opts.objectId)
    .slice(0, limit)
    .map((h, i) => ({ objectId: h.object_id, score: round(1 / (1 + i)), by: 'lexical' }));
}

/** @param {Float32Array} a @param {Float32Array} b @param {number} aNorm */
function cosine(a, b, aNorm) {
  let dot = 0;
  let bSq = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bSq += b[i] * b[i];
  }
  const denom = aNorm * Math.sqrt(bSq);
  return denom === 0 ? 0 : dot / denom;
}

/** @param {Float32Array} v */
function norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1e6) / 1e6;
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
