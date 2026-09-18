/**
 * A passphrase over stored API keys.
 *
 * `keys.js` seals keys under a file beside the store, which protects a leaked
 * database and not a machine somebody else can read — and says so. This closes
 * that gap, and these tests are mostly about the closing being real: that the
 * database on its own yields nothing, that a wrong passphrase yields nothing,
 * and that locking and unlocking never leave keys belonging to neither secret.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

import { Chitraq } from '../src/chitraq.js';
import * as vault from '../src/core/vault.js';
import * as keys from '../src/core/keys.js';

const KEY = 'sk-ant-api03-not-a-real-key-a1b2c3d4';
const PASSPHRASE = 'correct horse battery staple';
const FILE_SECRET = 'the-secret-in-a-file';

let counter = 0;
/** A real file, because the point is what survives a restart. */
function store() {
  return `demo/.vault-${process.pid}-${counter++}.chitraq`;
}

/** @param {string} path */
async function cleanup(path) {
  for (const suffix of ['', '-wal', '-shm']) await rm(`${path}${suffix}`, { force: true });
}

test('locking re-seals what is already stored, and it stays usable', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  assert.equal(c.keyLockState().exists, false);

  const locked = c.lockKeys({ passphrase: PASSPHRASE, hint: 'the usual' });
  assert.equal(locked.resealed, 1, 'the existing key came with it');

  // Still working in this process, which already holds the opened vault.
  assert.ok(c.registry.get('anthropic:key'), 'usable without re-entering anything');
  assert.equal(c.apiKeys()[0].readable, true);
});

test('without the passphrase the database yields nothing', async (t) => {
  const path = store();
  const first = new Chitraq({ path, keySecret: FILE_SECRET });
  first.setApiKey({ provider: 'anthropic', key: KEY });
  first.lockKeys({ passphrase: PASSPHRASE });
  first.close();

  // A new process with the store and the file secret — the exact position
  // somebody with the laptop is in.
  const second = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    second.close();
    await cleanup(path);
  });

  const state = second.keyLockState();
  assert.equal(state.exists, true);
  assert.equal(state.unlocked, false);

  assert.equal(second.registry.get('anthropic:key'), undefined, 'nothing is registered');
  assert.equal(second.apiKeys()[0].readable, false, 'and it says so rather than looking absent');

  assert.throws(
    () =>
      keys.getKey(second.db, {
        principalId: second.principal.id,
        provider: 'anthropic',
        secret: { key: Buffer.alloc(32), id: 'guess' },
      }),
    /different secret|could not be decrypted/
  );
});

test('the right passphrase opens it, the wrong one says so', async (t) => {
  const path = store();
  const first = new Chitraq({ path, keySecret: FILE_SECRET });
  first.setApiKey({ provider: 'anthropic', key: KEY });
  first.lockKeys({ passphrase: PASSPHRASE });
  first.close();

  const second = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    second.close();
    await cleanup(path);
  });

  assert.throws(() => second.unlockKeys('not the passphrase'), /does not open this memory/);
  assert.equal(second.registry.get('anthropic:key'), undefined, 'and nothing leaked trying');

  const opened = second.unlockKeys(PASSPHRASE);
  assert.deepEqual(opened.providers, ['anthropic:key']);
  assert.equal(second.apiKeys()[0].readable, true);
});

test('relocking forgets the passphrase without touching the vault', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  c.lockKeys({ passphrase: PASSPHRASE });

  c.relockKeys();
  assert.equal(c.keyLockState().unlocked, false);
  assert.equal(c.registry.get('anthropic:key'), undefined);

  // And it opens again, so this really was forgetting rather than destroying.
  c.unlockKeys(PASSPHRASE);
  assert.ok(c.registry.get('anthropic:key'));
});

test('changing the passphrase is instant and does not re-encrypt the keys', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  c.lockKeys({ passphrase: PASSPHRASE });

  const before = c.db.prepare('SELECT ciphertext FROM api_key').get().ciphertext;
  c.changeKeyPassphrase({ current: PASSPHRASE, next: 'a different long passphrase' });
  const after = c.db.prepare('SELECT ciphertext FROM api_key').get().ciphertext;

  // The point of sealing keys under a data key rather than the passphrase: the
  // wrapping changes and the keys themselves are untouched.
  assert.deepEqual(Buffer.from(before), Buffer.from(after));

  assert.throws(() => vault.open(c.db, PASSPHRASE), /does not open/);
  assert.ok(vault.open(c.db, 'a different long passphrase'));
});

test('a wrong current passphrase cannot change it', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  c.lockKeys({ passphrase: PASSPHRASE });

  assert.throws(
    () => c.changeKeyPassphrase({ current: 'guessing', next: 'something else entirely' }),
    /does not open/
  );
  assert.ok(vault.open(c.db, PASSPHRASE), 'the original still works');
});

test('removing the passphrase leaves the keys usable, not stranded', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  c.lockKeys({ passphrase: PASSPHRASE });

  const result = c.unlockKeysPermanently(PASSPHRASE);
  assert.equal(result.resealed, 1);
  assert.equal(c.keyLockState().exists, false);

  // Re-sealed under the file secret rather than left belonging to a vault that
  // no longer exists.
  assert.ok(c.registry.get('anthropic:key'));
  assert.equal(c.apiKeys()[0].readable, true);
});

test('the passphrase is nowhere in the database', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.setApiKey({ provider: 'anthropic', key: KEY });
  c.lockKeys({ passphrase: PASSPHRASE, hint: 'the usual one' });

  const row = c.db.prepare('SELECT * FROM vault WHERE id = 1').get();
  const serialised = Object.values(row)
    .map((v) => (Buffer.isBuffer(v) ? Buffer.from(v).toString('latin1') : String(v)))
    .join('|');

  assert.ok(!serialised.includes(PASSPHRASE), 'not stored');
  assert.ok(!serialised.includes('correct horse'), 'not partially stored');
  assert.equal(row.hint, 'the usual one', 'only the hint, which you wrote');

  // Nor in the audit trail, which records that it happened and nothing more.
  const log = JSON.stringify(c.history({ limit: 50 }));
  assert.ok(!log.includes(PASSPHRASE));
  assert.match(log, /vault-created/);
});

test('a trivially short passphrase is refused', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  assert.throws(() => c.lockKeys({ passphrase: 'short' }), /at least 10 characters/);
  assert.equal(c.keyLockState().exists, false, 'and nothing was created');
});

test('locking twice is refused rather than replacing the vault', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.lockKeys({ passphrase: PASSPHRASE });
  // Silently replacing it would strand every key sealed under the first one.
  assert.throws(() => c.lockKeys({ passphrase: 'another long passphrase' }), /already has a passphrase/);
});

test('the hint is shown while locked, and is never the passphrase', async (t) => {
  const path = store();
  const first = new Chitraq({ path, keySecret: FILE_SECRET });
  first.lockKeys({ passphrase: PASSPHRASE, hint: 'the one from the notebook' });
  first.close();

  const second = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    second.close();
    await cleanup(path);
  });

  const state = second.keyLockState();
  assert.equal(state.hint, 'the one from the notebook');
  assert.equal(state.unlocked, false);
});

test('a key stored while unlocked is sealed under the vault, not the file', async (t) => {
  const path = store();
  const c = new Chitraq({ path, keySecret: FILE_SECRET });
  t.after(async () => {
    c.close();
    await cleanup(path);
  });

  c.lockKeys({ passphrase: PASSPHRASE });
  c.setApiKey({ provider: 'anthropic', key: KEY });

  const stored = c.db.prepare('SELECT secret_id FROM api_key').get();
  const vaultKey = vault.open(c.db, PASSPHRASE);
  assert.equal(String(stored.secret_id), vaultKey.id, 'sealed under the vault');

  // And a fresh process without the passphrase cannot open it.
  c.relockKeys();
  assert.equal(c.apiKeys()[0].readable, false);
});
