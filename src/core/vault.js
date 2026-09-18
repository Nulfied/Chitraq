/**
 * A passphrase over your API keys.
 *
 * `keys.js` seals keys under a secret kept in a file beside the store, and says
 * plainly what that does and does not protect: a leaked database, yes; a
 * machine somebody else can read, no, because anything that can read one file
 * can usually read the other. This closes that gap for anyone who wants it
 * closed.
 *
 * With a vault, keys are sealed under something that exists nowhere on disk. A
 * stolen laptop, a synced folder, a backup and the database itself all yield
 * the same thing: ciphertext nobody can open. The cost is exactly what you
 * would expect — Chitraq cannot use your API key until you have told it the
 * passphrase this session, and nobody can recover it for you if you forget.
 *
 * ## How it is built
 *
 * A random data key seals the API keys. The passphrase seals the data key. That
 * indirection is what makes changing your passphrase instant: the wrapping is
 * redone and nothing else is touched. It also means the passphrase is never
 * what any ciphertext was actually encrypted with.
 *
 * The passphrase itself is never stored, not even hashed. Verification is a
 * side effect of AES-GCM: the wrong passphrase produces a key that fails the
 * authentication tag, so "wrong passphrase" and "corrupted vault" are the same
 * answer — which is correct, because from the outside they are the same thing.
 *
 * ## What this is still not
 *
 * The unlocked data key lives in process memory for as long as the process
 * does. Something that can read this process's memory can read it. Defending
 * against that is a different order of problem and is not attempted.
 */

import { randomBytes, createCipheriv, createDecipheriv, scryptSync, createHash } from 'node:crypto';
import { now } from './ids.js';
import { tx, plain } from './db.js';
import { ValidationError } from './objects.js';

const ALGORITHM = 'aes-256-gcm';

/**
 * Deliberately slower than the password hashing in `auth.js`.
 *
 * A login happens constantly and a vault is unlocked once a session, so this
 * can afford roughly half a second — which multiplies the cost of guessing by
 * the same amount. `maxmem` has to be set explicitly: N=65536 with r=8 needs
 * 64 MB, and Node's default ceiling is 32 MB.
 */
const KDF = { N: 65536, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

/** Shortest passphrase worth calling one. */
const MIN_LENGTH = 10;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      salt        BLOB NOT NULL,
      -- The data key, sealed under the passphrase. The passphrase itself is
      -- nowhere: not here, not hashed, not anywhere else in this file.
      wrapped     BLOB NOT NULL,
      iv          BLOB NOT NULL,
      tag         BLOB NOT NULL,
      key_id      TEXT NOT NULL,
      hint        TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    ) STRICT;
  `);
}

/**
 * Is a passphrase required to use stored keys here?
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function exists(db) {
  ensureSchema(db);
  return Boolean(plain(db.prepare('SELECT 1 FROM vault WHERE id = 1').get()));
}

/**
 * What can be said about the vault without opening it.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function describe(db) {
  ensureSchema(db);
  const row = plain(
    db.prepare('SELECT hint, key_id, created_at, updated_at FROM vault WHERE id = 1').get()
  );
  if (!row) return { exists: false };
  return {
    exists: true,
    hint: row.hint ?? null,
    // Which secret the vault protects. Holding *a* secret is not the same as
    // holding *this* one, and only this id can tell the two apart.
    keyId: String(row.key_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create the vault and return the data key it protects.
 *
 * The caller is responsible for re-sealing anything already stored under the
 * old secret — this only makes the new one. Doing both here would mean this
 * module knowing about `api_key`, and the point of the indirection is that it
 * does not.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{passphrase: string, hint?: string}} input
 * @returns {{key: Buffer, id: string}}
 */
export function create(db, input) {
  ensureSchema(db);
  if (exists(db)) throw new ValidationError('This memory already has a passphrase. Change it instead.');

  const passphrase = check(input.passphrase);
  const dataKey = randomBytes(32);
  const salt = randomBytes(16);
  const sealed = wrap(dataKey, passphrase, salt);

  // The id identifies *which* secret sealed a key, so a row encrypted under the
  // old file secret can be told apart from one encrypted under this.
  const keyId = createHash('sha256').update(dataKey).digest('hex').slice(0, 16);

  tx(db, () => {
    db.prepare(
      `INSERT INTO vault (id, salt, wrapped, iv, tag, key_id, hint, created_at, updated_at)
       VALUES (1,?,?,?,?,?,?,?,?)`
    ).run(salt, sealed.ciphertext, sealed.iv, sealed.tag, keyId, input.hint ?? null, now(), now());
  });

  return { key: dataKey, id: keyId };
}

/**
 * Open the vault.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} passphrase
 * @returns {{key: Buffer, id: string}}
 */
export function open(db, passphrase) {
  ensureSchema(db);
  const row = plain(db.prepare('SELECT * FROM vault WHERE id = 1').get());
  if (!row) throw new ValidationError('This memory has no passphrase set.');

  const salt = Buffer.from(row.salt);
  const kek = scryptSync(String(passphrase ?? ''), salt, KDF.keylen, KDF);

  try {
    const decipher = createDecipheriv(ALGORITHM, kek, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.tag));
    const key = Buffer.concat([decipher.update(Buffer.from(row.wrapped)), decipher.final()]);
    return { key, id: String(row.key_id) };
  } catch {
    // A wrong passphrase and a damaged vault fail identically, which is the
    // honest answer: from out here they are the same event.
    throw new ValidationError('That passphrase does not open this memory.');
  }
}

/**
 * Change the passphrase.
 *
 * Re-wraps the data key and touches nothing else, so this is instant no matter
 * how many keys are stored — the point of sealing keys under a data key rather
 * than under the passphrase directly.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{current: string, next: string, hint?: string}} input
 */
export function changePassphrase(db, input) {
  const { key, id } = open(db, input.current);
  const passphrase = check(input.next);

  const salt = randomBytes(16);
  const sealed = wrap(key, passphrase, salt);

  db.prepare(
    `UPDATE vault SET salt = ?, wrapped = ?, iv = ?, tag = ?, hint = ?, updated_at = ?
     WHERE id = 1`
  ).run(salt, sealed.ciphertext, sealed.iv, sealed.tag, input.hint ?? null, now());

  return { id, changed: true };
}

/**
 * Remove the vault, having proved you could open it.
 *
 * The caller re-seals the keys afterwards. Until it does, they are unreadable —
 * which is why this returns the data key rather than just destroying it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} passphrase
 */
export function destroy(db, passphrase) {
  const opened = open(db, passphrase);
  db.prepare('DELETE FROM vault WHERE id = 1').run();
  return opened;
}

/**
 * @param {Buffer} dataKey
 * @param {string} passphrase
 * @param {Buffer} salt
 */
function wrap(dataKey, passphrase, salt) {
  const kek = scryptSync(passphrase, salt, KDF.keylen, KDF);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/**
 * A passphrase nobody can recover for you deserves one check that it is not
 * trivially weak, and no more than that. Refusing anything beyond the obvious
 * pushes people towards a note on the desk.
 *
 * @param {string} value
 */
function check(value) {
  const passphrase = String(value ?? '');
  if (passphrase.length < MIN_LENGTH) {
    throw new ValidationError(
      `A passphrase needs at least ${MIN_LENGTH} characters. Nobody can recover it for you, ` +
        'so make it something you will not lose.'
    );
  }
  return passphrase;
}
