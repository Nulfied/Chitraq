/**
 * Database access. The only module that talks to node:sqlite directly.
 *
 * Chitraq has zero runtime dependencies: Node 22.5+ ships SQLite (with FTS5)
 * in core. That keeps INVARIANT "works offline, no recurring bill" honest —
 * nothing here needs a network, an API key or a native build toolchain.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, 'schema.sql');

export const SCHEMA_VERSION = 1;

/**
 * Open (and if needed create) a Chitraq memory store.
 * @param {string} path filesystem path, or ':memory:' for an ephemeral store
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function open(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);

  // WAL keeps readers (search, UI) from blocking writers (capture).
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

/**
 * Apply the schema. Every statement is CREATE ... IF NOT EXISTS, so this is
 * idempotent and safe to run on every open.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrate(db) {
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  const current = getMeta(db, 'schema_version');
  if (current === null) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  } else if (Number(current) > SCHEMA_VERSION) {
    throw new Error(
      `Memory store was written by a newer Chitraq (schema ${current}, this build understands ${SCHEMA_VERSION}). ` +
        `Refusing to open it rather than risk corrupting your memory.`
    );
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {string|null}
 */
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? /** @type {string} */ (row.value) : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/**
 * Run `fn` inside a transaction. Nested calls join the outer transaction so
 * that a multi-step memory mutation commits or rolls back as one unit.
 *
 * INVARIANT 49: consistency is deterministic. A half-applied change — a head
 * row without its version row, an object without its derivation — must never
 * become visible.
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function tx(db, fn) {
  if (db[IN_TX]) return fn();

  db.exec('BEGIN IMMEDIATE');
  db[IN_TX] = true;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback failure means the transaction was already aborted; the
      // original error is the one worth reporting.
    }
    throw err;
  } finally {
    db[IN_TX] = false;
  }
}

const IN_TX = Symbol.for('chitraq.inTransaction');

/**
 * SQLite returns null-prototype row objects. Copy them into ordinary objects
 * so callers can spread, JSON-stringify and compare them without surprises.
 * @template T
 * @param {T} row
 * @returns {T}
 */
export function plain(row) {
  return row == null ? row : /** @type {T} */ ({ .../** @type {object} */ (row) });
}

/**
 * @param {unknown[]} rows
 * @returns {any[]}
 */
export function plainAll(rows) {
  return rows.map((r) => plain(r));
}
