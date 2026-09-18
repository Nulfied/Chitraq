/**
 * Per-person API keys, encrypted at rest.
 *
 * This is what lets Chitraq stay free and still reach a frontier model: the
 * person brings their own key, Chitraq never pays for their tokens and never
 * holds their bill. It is also the honest way round — a key is a payment
 * instrument, and the fewer copies of it exist the better.
 *
 * Keys are stored per principal, so on a shared install your key routes your
 * requests and nobody else's. With authentication off — the local single-user
 * default — that principal is simply you.
 *
 * ## What the encryption is for, and what it is not for
 *
 * The threat this defends against is a leaked database: a backup on a USB
 * stick, a synced file, a `.chitraq` attached to a bug report. Those happen,
 * and a plaintext key in a `source` table would be gone the moment one did.
 * Keys are sealed with AES-256-GCM under a secret kept outside the database.
 *
 * It does **not** defend against someone with read access to the whole
 * machine. The secret sits in a file next to the store, and anything that can
 * read one can usually read the other. Deriving the key from the person's
 * password would fix that, and would mean keys only work while they are logged
 * in — a real trade that has not been made yet. Until it is, this file should
 * not be read as claiming more than it does.
 *
 * Nothing here ever returns a stored key to an interface. Keys go in, a
 * fingerprint and a masked hint come out, and the plaintext is only ever handed
 * to the provider that is about to make a call.
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { id, now } from './ids.js';
import { tx, plain, plainAll } from './db.js';
import { ValidationError, NotFoundError } from './objects.js';

/** Providers a key can be stored for. Adding one here is the only step needed. */
export const KEYED_PROVIDERS = Object.freeze(['anthropic', 'openai', 'openrouter', 'whisper']);

const ALGORITHM = 'aes-256-gcm';
/** scrypt over the master secret. Done once per process, not per call. */
const KDF = { N: 16384, r: 8, p: 1, keylen: 32 };

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key (
      id            TEXT PRIMARY KEY,
      principal_id  TEXT NOT NULL,
      provider      TEXT NOT NULL,
      label         TEXT,
      -- The sealed key. Nothing in here is readable without the master secret.
      ciphertext    BLOB NOT NULL,
      iv            BLOB NOT NULL,
      tag           BLOB NOT NULL,
      -- Which secret sealed it. A rotated or missing secret is then a clear
      -- "this key cannot be opened" rather than a corrupt-looking failure.
      secret_id     TEXT NOT NULL,
      -- Last four characters, for recognising a key without revealing it.
      hint          TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_used     TEXT,
      disabled      INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS ux_api_key_owner
      ON api_key (principal_id, provider);
    CREATE INDEX IF NOT EXISTS ix_api_key_principal ON api_key (principal_id);
  `);
}

// ------------------------------------------------------------ the secret

/** @type {Map<string, {key: Buffer, id: string}>} */
const secretCache = new Map();

/**
 * The master secret, from the environment or from a file beside the store.
 *
 * `CHITRAQ_SECRET` wins, so a hosted deployment can hold it in a real secret
 * manager and never write it to disk at all. Otherwise one is generated once,
 * written with owner-only permissions, and reused.
 *
 * @param {object} [opts]
 * @param {string} [opts.secret]     supplied directly, for tests
 * @param {string} [opts.dir]        where to keep a generated one
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{key: Buffer, id: string, source: string}}
 */
export function masterSecret(opts = {}) {
  const env = opts.env ?? process.env;
  const supplied = opts.secret ?? env.CHITRAQ_SECRET;
  const raw = supplied
    ? { value: String(supplied), source: opts.secret ? 'supplied' : 'CHITRAQ_SECRET' }
    : fromFile(opts.dir, env);

  const cached = secretCache.get(raw.value);
  if (cached) return { ...cached, source: raw.source };

  const derived = {
    // Salted with a constant rather than a random: the secret is already
    // high-entropy, and a per-install salt would have to be stored next to it
    // anyway. The KDF here is about length and shape, not about stretching a
    // weak password.
    key: scryptSync(raw.value, 'chitraq/api-key/v1', KDF.keylen, KDF),
    id: createHash('sha256').update(raw.value).digest('hex').slice(0, 16),
  };
  secretCache.set(raw.value, derived);
  return { ...derived, source: raw.source };
}

/**
 * @param {string} [dir]
 * @param {NodeJS.ProcessEnv} [env]
 */
function fromFile(dir, env = process.env) {
  const home = dir ?? dirname(env.CHITRAQ_DB || join(homedir(), '.chitraq', 'memory.chitraq'));
  const path = join(home, 'secret.key');

  if (existsSync(path)) {
    return { value: readFileSync(path, 'utf8').trim(), source: path };
  }

  mkdirSync(home, { recursive: true });
  const generated = randomBytes(32).toString('base64');
  writeFileSync(path, generated, { mode: 0o600 });
  try {
    // A no-op on Windows, where the file inherits the user profile's ACL. Worth
    // attempting rather than assuming.
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return { value: generated, source: path };
}

// ------------------------------------------------------------ storing

/**
 * Store a key for a principal, replacing any it already had for that provider.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.principalId
 * @param {string} input.provider
 * @param {string} input.key
 * @param {string} [input.label]
 * @param {{key: Buffer, id: string}} [input.secret]
 * @returns {{id: string, provider: string, hint: string, fingerprint: string, replaced: boolean}}
 */
export function setKey(db, input) {
  ensureSchema(db);

  const key = String(input.key ?? '').trim();
  if (!key) throw new ValidationError('An API key cannot be empty.');
  if (key.length < 8) throw new ValidationError('That does not look like an API key.');
  if (!input.provider) throw new ValidationError('Say which provider this key is for.');

  const secret = input.secret ?? masterSecret();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, secret.key, iv);
  const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return tx(db, () => {
    const existing = plain(
      db
        .prepare('SELECT id FROM api_key WHERE principal_id = ? AND provider = ?')
        .get(input.principalId, input.provider)
    );

    const row = {
      id: existing?.id ?? id('key'),
      hint: key.slice(-4),
      // Identifies the key without storing it — enough to notice you pasted
      // the same key twice, or that it changed, never enough to use it.
      fingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
    };

    if (existing) {
      db.prepare(
        `UPDATE api_key SET ciphertext = ?, iv = ?, tag = ?, secret_id = ?, hint = ?,
                            fingerprint = ?, label = ?, disabled = 0, created_at = ?
         WHERE id = ?`
      ).run(
        ciphertext, iv, tag, secret.id, row.hint, row.fingerprint,
        input.label ?? null, now(), row.id
      );
    } else {
      db.prepare(
        `INSERT INTO api_key (id, principal_id, provider, label, ciphertext, iv, tag,
                              secret_id, hint, fingerprint, created_at, disabled)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`
      ).run(
        row.id, input.principalId, input.provider, input.label ?? null,
        ciphertext, iv, tag, secret.id, row.hint, row.fingerprint, now()
      );
    }

    return {
      id: row.id,
      provider: input.provider,
      hint: row.hint,
      fingerprint: row.fingerprint,
      replaced: !!existing,
    };
  });
}

/**
 * The plaintext key, for handing straight to a provider.
 *
 * The only function here that returns one. Everything an interface touches goes
 * through `list`, which cannot.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, provider: string, secret?: {key: Buffer, id: string}}} q
 * @returns {string|null}
 */
export function getKey(db, q) {
  ensureSchema(db);
  const row = plain(
    db
      .prepare(
        `SELECT * FROM api_key WHERE principal_id = ? AND provider = ? AND disabled = 0`
      )
      .get(q.principalId, q.provider)
  );
  if (!row) return null;

  const secret = q.secret ?? masterSecret();
  if (row.secret_id !== secret.id) {
    // The secret changed or is missing. Silently returning null would look
    // like "no key configured" and send the request somewhere cheaper without
    // anyone noticing the key they set is now unreadable.
    throw new ValidationError(
      `The key for ${q.provider} was sealed with a different secret and cannot be opened. ` +
        'Set it again, or restore the secret it was stored with.'
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, secret.key, toBuffer(row.iv));
    decipher.setAuthTag(toBuffer(row.tag));
    const plaintext = Buffer.concat([
      decipher.update(toBuffer(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8');

    db.prepare('UPDATE api_key SET last_used = ? WHERE id = ?').run(now(), row.id);
    return plaintext;
  } catch {
    // GCM caught tampering, or the row is damaged. Either way this is not a
    // usable key and pretending otherwise sends a corrupt string to a vendor.
    throw new ValidationError(
      `The stored ${q.provider} key could not be decrypted. Set it again.`
    );
  }
}

/**
 * Everything known about a principal's keys, minus the keys.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 * @param {{key: Buffer, id: string}} [secret]  the one this install actually uses
 */
export function list(db, principalId, secret) {
  ensureSchema(db);
  const activeSecret = secret?.id ?? safeSecretId();
  return plainAll(
    db
      .prepare('SELECT * FROM api_key WHERE principal_id = ? ORDER BY provider')
      .all(principalId)
  ).map((row) => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    // Never the key. `sk-…a1b2` is enough to recognise which one it is.
    masked: `…${row.hint}`,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    disabled: !!row.disabled,
    // False means the key is sealed under a secret this install no longer has.
    // Worth surfacing: it looks configured and is not usable.
    readable: row.secret_id === activeSecret,
  }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, provider?: string, id?: string}} q
 */
export function removeKey(db, q) {
  ensureSchema(db);
  const row = plain(
    q.id
      ? db.prepare('SELECT * FROM api_key WHERE id = ? AND principal_id = ?').get(q.id, q.principalId)
      : db
          .prepare('SELECT * FROM api_key WHERE principal_id = ? AND provider = ?')
          .get(q.principalId, q.provider)
  );
  if (!row) throw new NotFoundError('No such key.');

  db.prepare('DELETE FROM api_key WHERE id = ?').run(row.id);
  return { id: row.id, provider: row.provider, removed: true };
}

/**
 * Which providers this principal has a usable key for.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} principalId
 * @returns {string[]}
 */
export function providersWithKeys(db, principalId) {
  ensureSchema(db);
  return plainAll(
    db
      .prepare(
        'SELECT provider FROM api_key WHERE principal_id = ? AND disabled = 0 ORDER BY provider'
      )
      .all(principalId)
  ).map((r) => String(r.provider));
}

/**
 * Does this key match the one already stored? Used to answer "did I paste the
 * same thing again" without ever decrypting anything.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{principalId: string, provider: string, key: string}} q
 */
export function matchesStored(db, q) {
  ensureSchema(db);
  const row = plain(
    db
      .prepare('SELECT fingerprint FROM api_key WHERE principal_id = ? AND provider = ?')
      .get(q.principalId, q.provider)
  );
  if (!row) return false;
  const given = createHash('sha256').update(q.key).digest('hex').slice(0, 16);
  const a = Buffer.from(String(row.fingerprint));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeSecretId() {
  try {
    return masterSecret().id;
  } catch {
    return null;
  }
}

/** @param {any} v */
function toBuffer(v) {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}
