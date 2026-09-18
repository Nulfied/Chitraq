/**
 * Index maintenance.
 *
 * INVARIANT 20: search indexing and deterministic ranking are system
 * responsibilities, not a model's. The index is rebuildable from the objects
 * at any time — it is derived state, never the source of truth. Losing it
 * costs time, not memory.
 */

import { newChunkId, now } from '../core/ids.js';
import { tx } from '../core/db.js';
import { chunk as splitChunks, chunkHash, contentTerms, estimateTokens } from '../core/text.js';

/**
 * Re-index one object: chunks, full-text rows, corpus term statistics and
 * (when an embedder is supplied) vectors.
 *
 * Safe to call repeatedly. Chunks whose text is unchanged keep their ids and
 * their embeddings, so editing a long note does not throw away vectors for
 * the paragraphs that did not move.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} object hydrated object row
 * @param {{embed?: (texts: string[]) => Promise<{model: string, vectors: number[][]}>}} [opts]
 * @returns {Promise<{chunks: number, reused: number, embedded: number}>}
 */
export async function indexObject(db, object, opts = {}) {
  const indexable = object.state === 'active' || object.state === 'superseded';
  if (!indexable) {
    removeFromIndex(db, object.id);
    return { chunks: 0, reused: 0, embedded: 0 };
  }

  const text = [object.title, object.body].filter(Boolean).join('\n\n');
  const pieces = splitChunks(text);
  if (!pieces.length) pieces.push({ seq: 0, text: object.title, tokens: estimateTokens(object.title), offset: 0 });

  const existing = db.prepare('SELECT * FROM chunk WHERE object_id = ? ORDER BY seq').all(object.id);
  const byHash = new Map(existing.map((c) => [c.hash, c]));

  /** @type {Array<{id: string, seq: number, text: string, tokens: number, hash: string, isNew: boolean}>} */
  const rows = pieces.map((p) => {
    const h = chunkHash(p.text);
    const reusable = byHash.get(h);
    return {
      id: reusable ? /** @type {string} */ (reusable.id) : newChunkId(),
      seq: p.seq,
      text: p.text,
      tokens: p.tokens,
      hash: h,
      isNew: !reusable,
    };
  });

  const keepIds = new Set(rows.map((r) => r.id));
  const ts = now();

  tx(db, () => {
    // Drop chunks that no longer correspond to any current text.
    for (const old of existing) {
      if (!keepIds.has(old.id)) {
        db.prepare('DELETE FROM embedding WHERE chunk_id = ?').run(old.id);
        db.prepare('DELETE FROM chunk_fts WHERE chunk_id = ?').run(old.id);
        db.prepare('DELETE FROM chunk WHERE id = ?').run(old.id);
      }
    }

    updateTermStats(db, object.workspace_id, existing.map((c) => c.text), rows.map((r) => r.text));

    const insertChunk = db.prepare(
      `INSERT INTO chunk (id, object_id, workspace_id, seq, text, tokens, hash, created_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq`
    );
    const insertFts = db.prepare(
      `INSERT INTO chunk_fts (title, text, chunk_id, object_id, workspace_id) VALUES (?,?,?,?,?)`
    );

    for (const r of rows) {
      insertChunk.run(r.id, object.id, object.workspace_id, r.seq, r.text, r.tokens, r.hash, ts);
      // FTS rows carry the title on every chunk so a title match scores on any
      // chunk of the object, not only the first.
      db.prepare('DELETE FROM chunk_fts WHERE chunk_id = ?').run(r.id);
      insertFts.run(object.title, r.text, r.id, object.id, object.workspace_id);
    }
  });

  let embedded = 0;
  let embedError = null;
  if (opts.embed) {
    const needing = rows.filter((r) => r.isNew || !hasEmbedding(db, r.id));
    if (needing.length) {
      try {
        const { model, vectors } = await opts.embed(needing.map((r) => r.text));
        tx(db, () => {
          for (let i = 0; i < needing.length; i++) {
            storeEmbedding(db, {
              chunkId: needing[i].id,
              objectId: object.id,
              workspaceId: object.workspace_id,
              model,
              vector: vectors[i],
            });
          }
        });
        embedded = needing.length;
      } catch (err) {
        // INVARIANT 42: an embedding failure costs the semantic signal, never
        // the memory. The chunks and the full-text index are already committed
        // above, so the object stays fully searchable lexically. Vectors are
        // derived state and can be filled in later by reindexing.
        embedError = String(err?.message ?? err);
      }
    }
  }

  return {
    chunks: rows.length,
    reused: rows.filter((r) => !r.isNew).length,
    embedded,
    embedError,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 */
export function removeFromIndex(db, objectId) {
  tx(db, () => {
    const chunks = db.prepare('SELECT id, text, workspace_id FROM chunk WHERE object_id = ?').all(objectId);
    if (chunks.length) {
      updateTermStats(db, /** @type {string} */ (chunks[0].workspace_id), chunks.map((c) => /** @type {string} */ (c.text)), []);
    }
    db.prepare('DELETE FROM embedding WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM chunk_fts WHERE object_id = ?').run(objectId);
    db.prepare('DELETE FROM chunk WHERE object_id = ?').run(objectId);
  });
}

/**
 * Document-frequency statistics, maintained incrementally.
 *
 * These power deterministic TF-IDF keyword extraction: a term is distinctive
 * in *this* memory, judged against what this memory actually contains, not
 * against a generic corpus the user never saw.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {string[]} removedTexts
 * @param {string[]} addedTexts
 */
function updateTermStats(db, workspaceId, removedTexts, addedTexts) {
  /** @type {Map<string, number>} */
  const delta = new Map();
  for (const text of removedTexts) {
    for (const term of new Set(contentTerms(text))) delta.set(term, (delta.get(term) ?? 0) - 1);
  }
  for (const text of addedTexts) {
    for (const term of new Set(contentTerms(text))) delta.set(term, (delta.get(term) ?? 0) + 1);
  }

  const up = db.prepare(
    `INSERT INTO term_stat (workspace_id, term, doc_freq) VALUES (?,?,?)
     ON CONFLICT(workspace_id, term) DO UPDATE SET doc_freq = MAX(0, doc_freq + excluded.doc_freq)`
  );
  for (const [term, d] of delta) {
    if (d !== 0) up.run(workspaceId, term, d);
  }
  db.prepare('DELETE FROM term_stat WHERE workspace_id = ? AND doc_freq <= 0').run(workspaceId);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} chunkId
 */
function hasEmbedding(db, chunkId) {
  return !!db.prepare('SELECT 1 FROM embedding WHERE chunk_id = ? LIMIT 1').get(chunkId);
}

/**
 * Vectors are stored as raw little-endian float32. A 256-dim vector is 1 KB;
 * a 100k-chunk memory is ~100 MB, which is fine on a laptop and needs no
 * external vector service.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{chunkId: string, objectId: string, workspaceId: string, model: string, vector: number[]}} e
 */
export function storeEmbedding(db, e) {
  const f32 = Float32Array.from(e.vector);
  db.prepare(
    `INSERT INTO embedding (chunk_id, model, dim, vec, object_id, workspace_id, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(chunk_id, model) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`
  ).run(
    e.chunkId, e.model, f32.length, Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
    e.objectId, e.workspaceId, now()
  );
}

/**
 * @param {Uint8Array} blob
 * @returns {Float32Array}
 */
export function decodeVector(blob) {
  const buf = Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Rebuild the whole index from the objects.
 *
 * INVARIANT 50: derived results are regenerable. If the index is corrupted,
 * deleted or the embedding model changes, this restores full retrieval from
 * memory that was never at risk.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{embed?: (texts: string[]) => Promise<{model: string, vectors: number[][]}>, onProgress?: (n: number, total: number) => void}} [opts]
 */
export async function rebuild(db, workspaceId, opts = {}) {
  tx(db, () => {
    db.prepare('DELETE FROM embedding WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM chunk_fts WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM chunk WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM term_stat WHERE workspace_id = ?').run(workspaceId);
  });

  const rows = db
    .prepare(`SELECT * FROM object WHERE workspace_id = ? AND state != 'deleted' ORDER BY created_at`)
    .all(workspaceId);

  let done = 0;
  let chunks = 0;
  for (const row of rows) {
    const res = await indexObject(db, { ...row }, opts);
    chunks += res.chunks;
    opts.onProgress?.(++done, rows.length);
  }
  return { objects: rows.length, chunks };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 */
export function stats(db, workspaceId) {
  const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n ?? 0);
  return {
    objects: one(`SELECT COUNT(*) n FROM object WHERE workspace_id = ? AND state = 'active'`, workspaceId),
    chunks: one('SELECT COUNT(*) n FROM chunk WHERE workspace_id = ?', workspaceId),
    embeddings: one('SELECT COUNT(*) n FROM embedding WHERE workspace_id = ?', workspaceId),
    terms: one('SELECT COUNT(*) n FROM term_stat WHERE workspace_id = ?', workspaceId),
    relations: one(`SELECT COUNT(*) n FROM relation WHERE workspace_id = ? AND state = 'active'`, workspaceId),
    sources: one('SELECT COUNT(*) n FROM source WHERE workspace_id = ?', workspaceId),
    models: db
      .prepare('SELECT model, COUNT(*) AS n FROM embedding WHERE workspace_id = ? GROUP BY model')
      .all(workspaceId)
      .map((r) => ({ ...r })),
  };
}
