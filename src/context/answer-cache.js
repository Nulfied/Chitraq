/**
 * Answer cache.
 *
 * The expensive part of answering is the model call. The cheap part — parsing
 * the question, retrieving, assembling context — is deterministic and runs in
 * milliseconds. So the cache key is computed *after* building the context, from
 * the material the answer would actually rest on.
 *
 * That makes invalidation automatic rather than something to remember:
 *
 *   - edit an object in the context  → its content hash changes → miss
 *   - capture something new that now retrieves for this question → the context
 *     contains different ids → miss
 *   - nothing relevant changed → hit, and no model is called
 *
 * There is no manual "clear the cache when X happens", because there is no X.
 * A stale answer cannot be served: if it could be stale, the key already moved.
 */

import { id, now, hashJson } from '../core/ids.js';
import { plain, plainAll } from '../core/db.js';
import { normalise, contentTerms } from '../core/text.js';

/** Answers older than this are re-asked even on an exact key match. */
export const DEFAULT_TTL_DAYS = 30;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_cache (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      question      TEXT NOT NULL,
      context_ids   TEXT NOT NULL,
      provider      TEXT NOT NULL,
      model         TEXT,
      answer        TEXT,
      grounded      INTEGER NOT NULL DEFAULT 0,
      citations     TEXT NOT NULL DEFAULT '[]',
      uncertainty   TEXT,
      created_at    TEXT NOT NULL,
      last_hit      TEXT,
      hits          INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_answer_cache_key ON answer_cache (workspace_id, key);
    CREATE INDEX IF NOT EXISTS ix_answer_cache_age ON answer_cache (workspace_id, created_at);
  `);
}

/**
 * The cache key.
 *
 * Built from the *meaning* of the question and the exact content of the context:
 *
 *   - question terms are sorted and stopword-stripped, so "why did we drop
 *     redis" and "redis — why did we drop it?" share a key
 *   - each context object contributes its id and content hash, so any edit to
 *     any of them moves the key
 *   - the set of ids matters, so newly-retrieved material moves it too
 *
 * @param {object} input
 * @param {string} input.question
 * @param {Array<{id: string, contentHash: string}>} input.context
 * @param {string} [input.provider] scope the key to who answered
 * @returns {string}
 */
export function keyFor(input) {
  const terms = [...new Set(contentTerms(input.question))].sort();
  const material = input.context
    .map((c) => `${c.id}:${c.contentHash}`)
    .sort();

  return hashJson({
    // The whole question is included as well as its content terms, because
    // "is the migration finished" and "is the migration not finished" share
    // every content term and are opposite questions. Punctuation and case are
    // stripped so that formatting alone never misses a cache entry.
    q: normalise(input.question).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim(),
    t: terms,
    m: material,
    p: input.provider ?? 'any',
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, key: string, ttlDays?: number}} q
 * @returns {any|null}
 */
export function get(db, q) {
  ensureSchema(db);

  const row = plain(
    db.prepare('SELECT * FROM answer_cache WHERE workspace_id = ? AND key = ?').get(q.workspaceId, q.key)
  );
  if (!row) return null;

  const ttl = (q.ttlDays ?? DEFAULT_TTL_DAYS) * 86400000;
  if (Date.now() - Date.parse(String(row.created_at)) > ttl) {
    db.prepare('DELETE FROM answer_cache WHERE id = ?').run(row.id);
    return null;
  }

  db.prepare('UPDATE answer_cache SET hits = hits + 1, last_hit = ? WHERE id = ?').run(now(), row.id);

  return {
    answer: row.answer,
    grounded: !!row.grounded,
    citations: JSON.parse(String(row.citations)),
    uncertainty: row.uncertainty,
    provider: row.provider,
    model: row.model,
    cachedAt: row.created_at,
    hits: Number(row.hits) + 1,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.workspaceId
 * @param {string} input.key
 * @param {string} input.question
 * @param {string[]} input.contextIds
 * @param {string} input.provider
 * @param {string} [input.model]
 * @param {string|null} input.answer
 * @param {boolean} input.grounded
 * @param {string[]} [input.citations]
 * @param {string|null} [input.uncertainty]
 */
export function put(db, input) {
  ensureSchema(db);

  db.prepare(
    `INSERT INTO answer_cache (id, workspace_id, key, question, context_ids, provider, model,
                               answer, grounded, citations, uncertainty, created_at, hits)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
     ON CONFLICT(workspace_id, key) DO UPDATE SET
       answer = excluded.answer, grounded = excluded.grounded,
       citations = excluded.citations, uncertainty = excluded.uncertainty,
       provider = excluded.provider, model = excluded.model,
       created_at = excluded.created_at`
  ).run(
    id('ans'),
    input.workspaceId,
    input.key,
    input.question,
    JSON.stringify(input.contextIds),
    input.provider,
    input.model ?? null,
    input.answer,
    input.grounded ? 1 : 0,
    JSON.stringify(input.citations ?? []),
    input.uncertainty ?? null,
    now()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 */
export function stats(db, workspaceId) {
  ensureSchema(db);
  const row = plain(
    db
      .prepare(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits,
                COUNT(CASE WHEN hits > 0 THEN 1 END) AS reused
         FROM answer_cache WHERE workspace_id = ?`
      )
      .get(workspaceId)
  );

  const entries = Number(row?.entries ?? 0);
  const hits = Number(row?.hits ?? 0);
  return {
    entries,
    hits,
    reused: Number(row?.reused ?? 0),
    // Every entry represents one model call made; every hit is one avoided.
    savedCalls: hits,
    hitRate: entries + hits > 0 ? round(hits / (entries + hits)) : 0,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{olderThanDays?: number}} [opts]
 */
export function clear(db, workspaceId, opts = {}) {
  ensureSchema(db);
  if (opts.olderThanDays == null) {
    const result = db.prepare('DELETE FROM answer_cache WHERE workspace_id = ?').run(workspaceId);
    return { cleared: Number(result.changes ?? 0) };
  }
  const cutoff = new Date(Date.now() - opts.olderThanDays * 86400000).toISOString();
  const result = db
    .prepare('DELETE FROM answer_cache WHERE workspace_id = ? AND created_at < ?')
    .run(workspaceId, cutoff);
  return { cleared: Number(result.changes ?? 0) };
}

/**
 * Most-reused answers, for seeing what people actually ask.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {number} [limit]
 */
export function popular(db, workspaceId, limit = 20) {
  ensureSchema(db);
  return plainAll(
    db
      .prepare(
        `SELECT question, provider, hits, created_at, last_hit FROM answer_cache
         WHERE workspace_id = ? AND hits > 0 ORDER BY hits DESC LIMIT ?`
      )
      .all(workspaceId, limit)
  );
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1000) / 1000;
}
