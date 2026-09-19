/**
 * Access tokens: letting your other programs into your memory.
 *
 * Distinct from two things it sits near. `auth.js` issues *sessions*, which
 * are for a person in a browser and expire in a week. `keys.js` stores keys
 * for *outbound* calls to a model vendor. This is the other direction — a
 * long-lived credential another program of yours presents to reach this
 * memory, named so you can tell which program it was and revoked without
 * touching anything else.
 *
 * ## The rule that makes these useful on a local install
 *
 * Chitraq is loopback-only and needs no login, so on one machine a token
 * cannot make access *harder* to obtain — anything on the machine could call
 * the API anyway. What it can do is make access **narrower**:
 *
 *   **Presenting a token constrains you. Presenting nothing changes nothing.**
 *
 * A token scoped to `read` is refused a write even where an anonymous caller
 * would be allowed one. So a script that only ever needs to ask questions can
 * hold a credential that cannot erase anything, and that guarantee holds
 * whether or not a login is configured. It costs nothing and it means a bug in
 * a small side project cannot damage the memory it reads from.
 *
 * ## What is stored
 *
 * The token itself, never. A SHA-256 of it, and a short prefix so a listing
 * can say *which* token without being able to reproduce it. Issuing returns
 * the plaintext exactly once, which is the only moment it exists outside the
 * caller's hands.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { id, now } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { ValidationError, NotFoundError } from './objects.js';

/**
 * What a token is allowed to do. Three levels, because a scope nobody
 * understands is a scope everybody grants.
 */
export const Scope = Object.freeze({
  /** Read anything: search, ask, recall, history, entities. */
  Read: 'read',
  /** Everything read can do, plus capture, relate and review. */
  Write: 'write',
  /** Everything, including erasure, policy, credentials and sync. */
  Admin: 'admin',
});

const ORDER = [Scope.Read, Scope.Write, Scope.Admin];

/** Tokens are recognisable on sight and greppable in a leaked log. */
const PREFIX = 'ctq_';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_token (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      principal_id  TEXT NOT NULL,
      -- SHA-256 of the token. The token itself is never stored: issuing is the
      -- only moment it exists anywhere but in the caller's hands.
      token_hash    TEXT NOT NULL UNIQUE,
      -- First few characters, so a listing can say which token this is.
      prefix        TEXT NOT NULL,
      scope         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT,
      last_used     TEXT,
      use_count     INTEGER NOT NULL DEFAULT 0,
      revoked_at    TEXT,
      note          TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS ix_access_token_hash ON access_token (token_hash);
  `);
}

/**
 * Mint a token. The plaintext is returned once and never again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.name          which program this is for
 * @param {string} input.principalId
 * @param {string} [input.scope]       default read
 * @param {number} [input.expiresInDays]
 * @param {string} [input.note]
 * @returns {{id: string, token: string, name: string, scope: string, prefix: string, expiresAt: string|null}}
 */
export function issue(db, input) {
  ensureSchema(db);

  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('Give the token a name, so you know what to revoke later.');

  const scope = String(input.scope ?? Scope.Read);
  if (!ORDER.includes(scope)) {
    throw new ValidationError(`Scope must be one of ${ORDER.join(', ')}.`);
  }

  // 32 bytes of randomness. base64url so it survives a shell, a header and an
  // .env file without quoting.
  const secret = randomBytes(32).toString('base64url');
  const token = `${PREFIX}${secret}`;

  const row = {
    id: id('tok'),
    prefix: token.slice(0, PREFIX.length + 6),
    expiresAt: input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
      : null,
  };

  tx(db, () => {
    db.prepare(
      `INSERT INTO access_token (id, name, principal_id, token_hash, prefix, scope,
                                 created_at, expires_at, note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      row.id, name, input.principalId, hashToken(token), row.prefix, scope,
      now(), row.expiresAt, input.note ?? null
    );
  });

  return { id: row.id, token, name, scope, prefix: row.prefix, expiresAt: row.expiresAt };
}

/**
 * Who is this, and what may they do?
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {{id: string, name: string, scope: string, principalId: string}|null}
 */
export function verify(db, token) {
  if (!token || !token.startsWith(PREFIX)) return null;
  ensureSchema(db);

  const row = plain(
    db.prepare('SELECT * FROM access_token WHERE token_hash = ?').get(hashToken(token))
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && String(row.expires_at) <= now()) return null;

  db.prepare('UPDATE access_token SET last_used = ?, use_count = use_count + 1 WHERE id = ?').run(
    now(),
    row.id
  );

  return {
    id: String(row.id),
    name: String(row.name),
    scope: String(row.scope),
    principalId: String(row.principal_id),
  };
}

/**
 * Does this scope cover what is being asked?
 *
 * Ordered rather than a set, because the three levels genuinely nest: nothing
 * an admin does is off-limits to an admin, and a set invites the mistake of
 * granting write without read.
 *
 * @param {string} held
 * @param {string} required
 */
export function permits(held, required) {
  const have = ORDER.indexOf(held);
  const need = ORDER.indexOf(required);
  if (have < 0 || need < 0) return false;
  return have >= need;
}

/**
 * Every token, without any of them.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function list(db) {
  ensureSchema(db);
  return plainAll(
    db.prepare('SELECT * FROM access_token ORDER BY created_at DESC').all()
  ).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    scope: String(row.scope),
    // Enough to recognise, never enough to use.
    masked: `${row.prefix}…`,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsed: row.last_used,
    useCount: Number(row.use_count ?? 0),
    revokedAt: row.revoked_at,
    note: row.note,
    active: !row.revoked_at && (!row.expires_at || String(row.expires_at) > now()),
  }));
}

/**
 * Stop a token working, keeping the record that it existed.
 *
 * Deleting the row would remove the evidence of what had access and when,
 * which is the thing you want most after deciding something should not.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{id?: string, name?: string}} q
 */
export function revoke(db, q) {
  ensureSchema(db);
  // Looked up including already-revoked ones. Excluding them makes revoking
  // twice report "no such token" about a token plainly sitting in the list,
  // which reads as a bug in the tool rather than a no-op.
  const row = plain(
    q.id
      ? db.prepare('SELECT * FROM access_token WHERE id = ?').get(q.id)
      : db
          .prepare(
            `SELECT * FROM access_token WHERE name = ?
             ORDER BY (revoked_at IS NULL) DESC, created_at DESC LIMIT 1`
          )
          .get(q.name)
  );
  if (!row) throw new NotFoundError('No such token.');
  if (row.revoked_at) return { id: String(row.id), name: String(row.name), alreadyRevoked: true };

  db.prepare('UPDATE access_token SET revoked_at = ? WHERE id = ?').run(now(), row.id);
  return { id: String(row.id), name: String(row.name), revoked: true };
}

/**
 * Is this string shaped like one of our tokens?
 *
 * Used to tell an access token apart from a session token in the same header,
 * so each is checked against the right table rather than both against both.
 *
 * @param {string} value
 */
export function looksLikeToken(value) {
  return typeof value === 'string' && value.startsWith(PREFIX) && value.length > PREFIX.length + 20;
}

/** @param {string} token */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison, for anywhere a caller wants to check a token
 * against one it already holds without leaking the position of the first
 * differing byte.
 *
 * @param {string} a
 * @param {string} b
 */
export function sameToken(a, b) {
  const left = Buffer.from(hashToken(String(a ?? '')));
  const right = Buffer.from(hashToken(String(b ?? '')));
  return timingSafeEqual(left, right);
}
