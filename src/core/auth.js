/**
 * Authentication.
 *
 * Chitraq is local-first and single-user by default: bound to loopback, no
 * account step, nothing between you and your own memory. Authentication exists
 * for the moment that stops being true — putting it on a machine you reach from
 * elsewhere, or sharing a workspace with someone.
 *
 * Deliberately small, and deliberately built on primitives Node already has:
 *
 *   - passwords hashed with scrypt, per-user salt, constant-time comparison
 *   - opaque random session tokens, stored hashed, so a leaked database does
 *     not hand over live sessions
 *   - no JWTs, no refresh dance, no third-party identity provider
 *
 * Authorisation remains where it was: the deterministic grants in
 * workspace.js. This module only answers "who is this?".
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { id, now, hash } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { ValidationError } from './objects.js';

/** scrypt parameters. N=16384 is ~100ms per hash here: slow for an attacker, fine for a login. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Sessions last a week unless renewed. */
export const DEFAULT_SESSION_DAYS = 7;

/**
 * Add the tables. Separate from the main schema because authentication is
 * optional: a local single-user install never creates them.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential (
      principal_id TEXT PRIMARY KEY REFERENCES principal(id),
      username     TEXT NOT NULL UNIQUE,
      salt         TEXT NOT NULL,
      hash         TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      disabled     INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS session (
      id           TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principal(id),
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      last_seen    TEXT,
      user_agent   TEXT,
      revoked_at   TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS ix_session_principal ON session (principal_id);
    CREATE INDEX IF NOT EXISTS ix_session_expiry ON session (expires_at);
  `);
}

/**
 * Is authentication switched on for this store?
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function isEnabled(db) {
  const table = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'`)
    .get();
  if (!table) return false;
  return Number(db.prepare('SELECT COUNT(*) AS n FROM credential').get()?.n ?? 0) > 0;
}

/**
 * Give a principal a password.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, username: string, password: string}} input
 */
export function setPassword(db, input) {
  ensureSchema(db);

  const username = String(input.username ?? '').trim().toLowerCase();
  if (!username) throw new ValidationError('A username is required.');
  if (!/^[a-z0-9._-]{2,64}$/.test(username)) {
    throw new ValidationError('A username may use letters, digits, dot, underscore and hyphen.');
  }
  // Length is the only requirement that reliably helps. Composition rules push
  // people towards predictable substitutions and longer is strictly better.
  if (String(input.password ?? '').length < 10) {
    throw new ValidationError('A password must be at least 10 characters.');
  }

  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM principal WHERE id = ?').get(input.principalId)) {
      throw new ValidationError(`No principal ${input.principalId}`);
    }
    const taken = plain(
      db.prepare('SELECT principal_id FROM credential WHERE username = ?').get(username)
    );
    if (taken && taken.principal_id !== input.principalId) {
      throw new ValidationError(`The username "${username}" is taken.`);
    }

    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(input.password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
    const ts = now();

    db.prepare(
      `INSERT INTO credential (principal_id, username, salt, hash, created_at, updated_at, disabled)
       VALUES (?,?,?,?,?,?,0)
       ON CONFLICT(principal_id) DO UPDATE SET
         username = excluded.username, salt = excluded.salt,
         hash = excluded.hash, updated_at = excluded.updated_at`
    ).run(input.principalId, username, salt, derived, ts, ts);

    // Changing a password ends every existing session. If the change was
    // prompted by a compromise, leaving old sessions alive defeats the point.
    db.prepare('UPDATE session SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL').run(
      ts,
      input.principalId
    );

    return { principalId: input.principalId, username };
  });
}

/**
 * Verify a username and password, and open a session.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{username: string, password: string, userAgent?: string, days?: number}} input
 * @returns {{token: string, sessionId: string, principalId: string, expiresAt: string}}
 */
export function login(db, input) {
  ensureSchema(db);
  const username = String(input.username ?? '').trim().toLowerCase();

  const cred = plain(db.prepare('SELECT * FROM credential WHERE username = ?').get(username));

  // A hash is computed even when the user does not exist, so the response time
  // does not reveal which usernames are real.
  const salt = cred?.salt ?? 'absent-user-placeholder-salt';
  const expected = cred?.hash ?? scryptSync('never-matches', salt, SCRYPT.keylen, SCRYPT).toString('hex');
  const derived = scryptSync(String(input.password ?? ''), salt, SCRYPT.keylen, SCRYPT).toString('hex');

  const matches = timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(expected, 'hex'));

  if (!cred || !matches || cred.disabled) {
    // One message for every failure: which of the three it was is not the
    // caller's business.
    const err = new ValidationError('That username and password do not match.');
    err.status = 401;
    throw err;
  }

  return openSession(db, {
    principalId: String(cred.principal_id),
    userAgent: input.userAgent,
    days: input.days,
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, userAgent?: string, days?: number}} input
 */
export function openSession(db, input) {
  ensureSchema(db);

  // 256 bits of randomness, stored only as a hash. A database dump therefore
  // yields no usable session tokens.
  const token = randomBytes(32).toString('base64url');
  const sessionId = id('ses');
  const expiresAt = new Date(Date.now() + (input.days ?? DEFAULT_SESSION_DAYS) * 86400000).toISOString();

  db.prepare(
    `INSERT INTO session (id, principal_id, token_hash, created_at, expires_at, last_seen, user_agent)
     VALUES (?,?,?,?,?,?,?)`
  ).run(sessionId, input.principalId, tokenHash(token), now(), expiresAt, now(), input.userAgent ?? null);

  return { token, sessionId, principalId: input.principalId, expiresAt };
}

/**
 * Resolve a token to a principal, or null.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null|undefined} token
 * @returns {{principalId: string, sessionId: string, username: string|null}|null}
 */
export function authenticate(db, token) {
  if (!token) return null;
  if (!isEnabled(db)) return null;

  const row = plain(
    db
      .prepare(
        `SELECT s.*, c.username FROM session s
         LEFT JOIN credential c ON c.principal_id = s.principal_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash(token))
  );
  if (!row || row.revoked_at) return null;
  if (row.expires_at <= now()) return null;

  db.prepare('UPDATE session SET last_seen = ? WHERE id = ?').run(now(), row.id);
  return {
    principalId: String(row.principal_id),
    sessionId: String(row.id),
    username: row.username ? String(row.username) : null,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 */
export function logout(db, token) {
  if (!token) return { revoked: 0 };
  const result = db
    .prepare('UPDATE session SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now(), tokenHash(token));
  return { revoked: Number(result.changes ?? 0) };
}

/**
 * End every session for a principal.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 */
export function revokeAll(db, principalId) {
  const result = db
    .prepare('UPDATE session SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL')
    .run(now(), principalId);
  return { revoked: Number(result.changes ?? 0) };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 */
export function sessions(db, principalId) {
  ensureSchema(db);
  return plainAll(
    db
      .prepare(
        `SELECT id, created_at, expires_at, last_seen, user_agent, revoked_at
         FROM session WHERE principal_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(principalId)
  );
}

/**
 * Delete sessions that expired or were revoked more than a month ago.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function prune(db) {
  ensureSchema(db);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const result = db
    .prepare('DELETE FROM session WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
    .run(cutoff, cutoff);
  return { pruned: Number(result.changes ?? 0) };
}

/** @param {string} token */
function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * List accounts.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function accounts(db) {
  ensureSchema(db);
  return plainAll(
    db
      .prepare(
        `SELECT c.principal_id, c.username, c.created_at, c.disabled, p.name, p.kind
         FROM credential c JOIN principal p ON p.id = c.principal_id
         ORDER BY c.created_at ASC`
      )
      .all()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 * @param {boolean} disabled
 */
export function setDisabled(db, principalId, disabled) {
  ensureSchema(db);
  db.prepare('UPDATE credential SET disabled = ?, updated_at = ? WHERE principal_id = ?').run(
    disabled ? 1 : 0,
    now(),
    principalId
  );
  if (disabled) revokeAll(db, principalId);
  return { principalId, disabled };
}
