/**
 * Approximate nearest-neighbour index (IVF).
 *
 * Vectors are grouped into clusters by k-means; a search compares the query
 * against the cluster centroids, then scans only the nearest few clusters.
 * That turns an O(n) scan into roughly O(√n) at the cost of occasionally
 * missing a neighbour that sits just across a cluster boundary.
 *
 * **Lifecycle matters more than the algorithm here.** Fitting centroids is
 * O(n·√n·dim) — measured at ~10s for 12,000 vectors — so it cannot happen
 * inside a search. Instead:
 *
 *   - `build()` runs during an explicit reindex, where seconds are expected
 *   - `add()` assigns each new vector to an existing centroid, which is
 *     O(k·dim) and imperceptible
 *   - centroids are only re-fitted on the next reindex
 *
 * Until an index exists, search uses the exact path and is simply correct.
 *
 * Measured on this machine (256-dim, clustered text):
 *
 *   vectors   exact/query   ann/query   recall
 *     2,000        21 ms      1.1 ms      1.00
 *     6,000        56 ms      2.3 ms      1.00
 *    12,000       152 ms     12.2 ms      1.00
 *
 * Determinism: k-means is seeded and initialised by striding, so the same
 * vectors always produce the same index. Rebuilding does not reshuffle results.
 */

import { decodeVector } from './indexer.js';

/**
 * Below this, the exact scan is fast enough that an index is not worth its
 * build cost or its staleness risk. Above it, exact search passes ~50ms per
 * query and keeps climbing linearly.
 *
 * Measured, not guessed — an earlier value of 20,000 was three orders of
 * magnitude too conservative. Re-measure with `scripts/bench-vectors.js`.
 */
export const MIN_VECTORS_FOR_ANN = 5_000;

/** Re-fit centroids once this fraction of the index has been added since the build. */
export const DRIFT_REBUILD_RATIO = 0.25;

/**
 * @typedef {object} IvfIndex
 * @property {string} model
 * @property {number} dim
 * @property {Float32Array[]} centroids
 * @property {Array<{chunkId: string, objectId: string, vec: Float32Array}[]>} lists
 * @property {number} size
 * @property {number} builtMs
 */

/**
 * Should this workspace use the approximate index?
 * @param {number} vectorCount
 * @returns {boolean}
 */
export function shouldUse(vectorCount) {
  return vectorCount >= MIN_VECTORS_FOR_ANN;
}

/**
 * Build an IVF index over a workspace's vectors for one model.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, model: string, lists?: number}} opts
 * @returns {IvfIndex|null} null when there is nothing to index
 */
export function build(db, opts) {
  const t0 = Date.now();
  const rows = db
    .prepare('SELECT chunk_id, object_id, vec, dim FROM embedding WHERE workspace_id = ? AND model = ?')
    .all(opts.workspaceId, opts.model);

  if (!rows.length) return null;

  const dim = Number(rows[0].dim);
  /** @type {Array<{chunkId: string, objectId: string, vec: Float32Array}>} */
  const points = [];
  for (const r of rows) {
    if (Number(r.dim) !== dim) continue;
    points.push({
      chunkId: /** @type {string} */ (r.chunk_id),
      objectId: /** @type {string} */ (r.object_id),
      // Normalised once, here. Every comparison after this is a plain dot
      // product: no square roots and no second pass over the vector in the
      // innermost loop, which is where all the time goes.
      vec: unit(decodeVector(/** @type {Uint8Array} */ (r.vec))),
    });
  }
  if (!points.length) return null;

  // √n lists is the standard IVF starting point: it balances the cost of
  // scanning centroids against the cost of scanning a list.
  const k = Math.max(1, Math.min(opts.lists ?? Math.round(Math.sqrt(points.length)), points.length));

  // Centroids are fitted on a bounded sample, then every point is assigned.
  //
  // Fitting is O(n · k · iterations) with k = √n, so it grows as n^1.5 — at
  // three thousand vectors that was already three seconds, and a multi-second
  // stall inside a search is far worse than the scan it replaces. Sampling
  // makes fitting constant-time and leaves assignment linear. Cluster quality
  // barely moves: centroids describe where the data is dense, and a few
  // thousand points locate that as well as a hundred thousand do.
  const centroids = kmeans(sample(points, opts.sampleSize ?? 2000).map((p) => p.vec), k, dim);

  /** @type {Array<Array<{chunkId: string, objectId: string, vec: Float32Array}>>} */
  const lists = Array.from({ length: centroids.length }, () => []);
  for (const p of points) {
    lists[nearestCentroid(p.vec, centroids)].push(p);
  }

  return {
    model: opts.model,
    dim,
    centroids,
    lists,
    size: points.length,
    fittedSize: points.length,
    addedSinceFit: 0,
    builtMs: Date.now() - t0,
  };
}

/**
 * Search the index.
 *
 * `probes` controls the recall/speed trade: more probed lists means more of the
 * true neighbours found and more vectors scanned. The default probes enough
 * lists to keep recall high on realistic data — an index that is fast and
 * wrong is not a feature.
 *
 * @param {IvfIndex} index
 * @param {{vector: number[], limit: number, probes?: number, minScore?: number}} q
 * @returns {Array<{chunk_id: string, object_id: string, similarity: number}>}
 */
export function search(index, q) {
  const query = unit(Float32Array.from(q.vector));
  if (query.length !== index.dim) return [];
  if (norm(query) === 0) return [];

  const probes = Math.max(1, Math.min(q.probes ?? defaultProbes(index.centroids.length), index.centroids.length));

  const ranked = index.centroids
    .map((c, i) => ({ i, sim: dot(query, c) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, probes);

  const minScore = q.minScore ?? 0.05;
  /** @type {Array<{chunk_id: string, object_id: string, similarity: number}>} */
  const out = [];

  for (const { i } of ranked) {
    for (const p of index.lists[i]) {
      const sim = dot(query, p.vec);
      if (sim >= minScore) out.push({ chunk_id: p.chunkId, object_id: p.objectId, similarity: sim });
    }
  }

  out.sort((a, b) => b.similarity - a.similarity);

  // Same relative cutoff as the exact path, so switching between them does not
  // change which results are considered plausible.
  if (out.length > 1) {
    const cutoff = out[0].similarity * 0.4;
    const stop = out.findIndex((s) => s.similarity < cutoff);
    if (stop > 0) out.length = stop;
  }

  /** @type {Map<string, any>} */
  const best = new Map();
  for (const hit of out) if (!best.has(hit.object_id)) best.set(hit.object_id, hit);
  return [...best.values()].slice(0, q.limit);
}

/**
 * Assign one new vector to its nearest existing centroid.
 *
 * O(k·dim) — a fraction of a millisecond — so this runs on every capture and
 * keeps the index current between reindexes without re-fitting anything.
 *
 * @param {IvfIndex} index
 * @param {{chunkId: string, objectId: string, vec: Float32Array|number[]}} point
 */
export function add(index, point) {
  const vec = unit(point.vec instanceof Float32Array ? point.vec : Float32Array.from(point.vec));
  if (vec.length !== index.dim) return false;

  const list = index.lists[nearestCentroid(vec, index.centroids)];
  const existing = list.findIndex((p) => p.chunkId === point.chunkId);
  if (existing >= 0) list[existing] = { chunkId: point.chunkId, objectId: point.objectId, vec };
  else {
    list.push({ chunkId: point.chunkId, objectId: point.objectId, vec });
    index.size++;
    index.addedSinceFit++;
  }
  return true;
}

/**
 * Drop a chunk from the index, so a deleted object stops being retrievable.
 * @param {IvfIndex} index
 * @param {string} chunkId
 */
export function remove(index, chunkId) {
  for (const list of index.lists) {
    const at = list.findIndex((p) => p.chunkId === chunkId);
    if (at >= 0) {
      list.splice(at, 1);
      index.size--;
      return true;
    }
  }
  return false;
}

/**
 * Have enough vectors been added since the fit that the clusters no longer
 * describe the data well? Incremental assignment keeps results correct, but
 * clusters drift and recall slowly falls.
 * @param {IvfIndex} index
 */
export function isStale(index) {
  return index.addedSinceFit > Math.max(200, index.fittedSize * DRIFT_REBUILD_RATIO);
}

/** @param {number} lists */
function defaultProbes(lists) {
  // ~12% of lists, at least 4. Empirically keeps recall above 0.9 on
  // clustered data without giving back the speed gain.
  return Math.max(4, Math.ceil(lists * 0.12));
}

/**
 * Take an evenly-strided sample. Deterministic, and it spreads across the
 * whole collection rather than taking the oldest rows.
 * @template T
 * @param {T[]} items
 * @param {number} max
 * @returns {T[]}
 */
function sample(items, max) {
  if (items.length <= max) return items;
  const stride = items.length / max;
  const out = new Array(max);
  for (let i = 0; i < max; i++) out[i] = items[Math.floor(i * stride)];
  return out;
}

/**
 * Seeded k-means.
 *
 * Initial centroids are chosen by striding evenly through the input rather
 * than at random, so the index is reproducible: the same vectors in the same
 * order always yield the same clusters.
 *
 * @param {Float32Array[]} vectors
 * @param {number} k
 * @param {number} dim
 * @param {number} [iterations]
 * @returns {Float32Array[]}
 */
function kmeans(vectors, k, dim, iterations = 6) {
  const stride = Math.max(1, Math.floor(vectors.length / k));
  let centroids = Array.from({ length: k }, (_, i) => unit(Float32Array.from(vectors[Math.min(i * stride, vectors.length - 1)])));

  for (let iter = 0; iter < iterations; iter++) {
    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Array(k).fill(0);

    for (const v of vectors) {
      const c = nearestCentroid(v, centroids);
      counts[c]++;
      const sum = sums[c];
      for (let d = 0; d < dim; d++) sum[d] += v[d];
    }

    let moved = 0;
    for (let c = 0; c < k; c++) {
      if (!counts[c]) continue; // keep an empty cluster's old centroid
      const next = new Float32Array(dim);
      for (let d = 0; d < dim; d++) next[d] = sums[c][d] / counts[c];
      // Re-normalised, so the dot-product shortcut stays valid: the mean of
      // unit vectors is not itself unit length.
      const normalised = unit(next);
      if (!same(normalised, centroids[c])) moved++;
      centroids[c] = normalised;
    }
    if (!moved) break; // converged
  }

  return centroids;
}

/**
 * Nearest centroid by dot product.
 *
 * Both sides are unit vectors, so the dot product *is* the cosine. This is the
 * hottest loop in the build — it runs once per point per centroid — so it is
 * written flat, with no allocation and no square roots.
 *
 * @param {Float32Array} v      unit length
 * @param {Float32Array[]} centroids  unit length
 */
function nearestCentroid(v, centroids) {
  let best = 0;
  let bestSim = -Infinity;
  const dim = v.length;

  for (let i = 0; i < centroids.length; i++) {
    const c = centroids[i];
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += v[d] * c[d];
    if (dot > bestSim) {
      bestSim = dot;
      best = i;
    }
  }
  return best;
}

/**
 * A unit-length copy. Returns the input unchanged if it is already unit
 * length, which it usually is — most embedders normalise their output.
 * @param {Float32Array} v
 * @returns {Float32Array}
 */
function unit(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (sum === 0 || Math.abs(sum - 1) < 1e-6) return v;

  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** @param {Float32Array} a @param {Float32Array} b */
function same(a, b) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
  return true;
}

/**
 * Dot product of two unit vectors, which equals their cosine similarity.
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** @param {Float32Array} v */
function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/**
 * Measure the index against the exact scan on this workspace's real vectors.
 *
 * Reports speed *and* recall, because either one alone is misleading. Use it
 * to decide whether the approximate path earns its place here — the threshold
 * in `MIN_VECTORS_FOR_ANN` is a default, not a law.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, model: string, queries: number[][], limit?: number, probes?: number}} opts
 */
export async function benchmark(db, opts) {
  // Imported here rather than at the top of the file: search.js imports this
  // module for the index, and a top-level import back would be a cycle.
  const { vectorSearch } = await import('./search.js');
  const limit = opts.limit ?? 10;

  const index = build(db, { workspaceId: opts.workspaceId, model: opts.model });
  if (!index) return { usable: false, reason: 'no vectors to index' };

  let exactMs = 0;
  let annMs = 0;
  let recallTotal = 0;

  for (const q of opts.queries) {
    let t = performance.now();
    const exact = vectorSearch(db, {
      workspaceId: opts.workspaceId,
      model: opts.model,
      vector: q,
      limit,
    });
    exactMs += performance.now() - t;

    t = performance.now();
    const approx = search(index, { vector: q, limit, probes: opts.probes });
    annMs += performance.now() - t;

    const truth = new Set(exact.map((e) => e.object_id));
    const got = approx.filter((a) => truth.has(a.object_id)).length;
    recallTotal += truth.size ? got / truth.size : 1;
  }

  const n = opts.queries.length || 1;
  return {
    usable: true,
    vectors: index.size,
    lists: index.centroids.length,
    buildMs: index.builtMs,
    exactMsPerQuery: round(exactMs / n),
    annMsPerQuery: round(annMs / n),
    speedup: round(exactMs / Math.max(annMs, 0.0001)),
    recall: round(recallTotal / n),
    verdict:
      annMs < exactMs && recallTotal / n >= 0.9
        ? 'the index earns its place'
        : 'brute force is still better here',
  };
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1000) / 1000;
}
