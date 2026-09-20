/**
 * Bring-your-own API keys.
 *
 * The property this file exists to defend is narrow and absolute: **a stored
 * key is never handed back out.** Not by the list, not by the HTTP API, not by
 * the event log. It goes in, it is sealed, and the only thing that ever sees it
 * again is the provider about to make a call.
 *
 * Everything else here — rotation, a missing secret, a key for a vendor nobody
 * can use — is about failing in a way that says what happened, because a key
 * that looks configured and silently is not is worse than no key at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { createApp } from '../src/server/http.js';
import * as keys from '../src/core/keys.js';
import { providerFromKey, keyedIdFor } from '../src/intelligence/providers/from-key.js';

const SECRET = 'a-test-secret-nobody-would-guess';
const KEY = 'sk-ant-api03-not-a-real-key-a1b2c3d4';

/** @param {object} [opts] */
function memory(opts = {}) {
  return new Chitraq({ path: ':memory:', keySecret: SECRET, ...opts });
}

test('a stored key never comes back out', async (t) => {
  const c = memory();
  t.after(() => c.close());

  c.setApiKey({ provider: 'anthropic', key: KEY, label: 'personal' });

  const listed = c.apiKeys();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].masked, '…c3d4', 'enough to recognise');

  // The whole surface, serialised, must not contain the key anywhere in it.
  const everything = JSON.stringify(listed);
  assert.ok(!everything.includes(KEY), 'not in the listing');
  assert.ok(!everything.includes('sk-ant-api03'), 'not even the prefix');

  // Nor in the audit trail, which is the place it would be easiest to leak by
  // accident — logging the input alongside the action.
  const log = JSON.stringify(c.history({ limit: 50 }));
  assert.ok(!log.includes(KEY), 'not in the event log');
  assert.match(log, /CredentialChanged/, 'but the change itself is recorded');
});

test('the raw bytes in the database are not the key', async (t) => {
  const c = memory();
  t.after(() => c.close());
  c.setApiKey({ provider: 'anthropic', key: KEY });

  const row = c.db.prepare('SELECT ciphertext, hint FROM api_key').get();
  const stored = Buffer.from(row.ciphertext).toString('utf8');
  assert.ok(!stored.includes('sk-ant'), 'sealed, not encoded');
  assert.notEqual(stored, KEY);
  assert.equal(row.hint, 'c3d4', 'only the tail is in the clear');
});

test('storing a key registers a provider, removing it takes it away', async (t) => {
  const c = memory();
  t.after(() => c.close());

  assert.equal(c.registry.get(keyedIdFor('anthropic')), undefined);

  const set = c.setApiKey({ provider: 'anthropic', key: KEY });
  assert.equal(set.active, true);
  assert.ok(c.registry.get('anthropic:key'), 'usable immediately, no restart');

  c.removeApiKey({ provider: 'anthropic' });
  assert.equal(c.registry.get('anthropic:key'), undefined);
  assert.deepEqual(c.apiKeys(), []);
});

test('a personal key does not overwrite an installation key', async (t) => {
  // Two arrangements with two different bills. Collapsing them into one
  // provider id would make whose key paid for a call unanswerable.
  const installation = {
    id: 'anthropic',
    label: 'Anthropic (installation key)',
    locality: 'remote',
    cost: 'paid',
    capabilities: { answer: { quality: 0.9, latencyMs: 2000, run: async () => ({}) } },
  };
  const c = memory({ providers: [installation] });
  t.after(() => c.close());

  c.setApiKey({ provider: 'anthropic', key: KEY });

  assert.ok(c.registry.get('anthropic'), 'the installation one survives');
  assert.ok(c.registry.get('anthropic:key'), 'and yours exists beside it');
  assert.equal(c.registry.get('anthropic:key').keyed, true);
});

test('a key survives a restart, and is loaded without being asked', async (t) => {
  const path = `file:mem-keys-${Date.now()}?mode=memory&cache=shared`;
  const first = new Chitraq({ path: 'demo/.keytest.chitraq', keySecret: SECRET });
  first.setApiKey({ provider: 'anthropic', key: KEY });
  first.close();

  const second = new Chitraq({ path: 'demo/.keytest.chitraq', keySecret: SECRET });
  t.after(async () => {
    second.close();
    const { rm } = await import('node:fs/promises');
    for (const suffix of ['', '-wal', '-shm']) {
      await rm(`demo/.keytest.chitraq${suffix}`, { force: true });
    }
  });

  assert.ok(second.registry.get('anthropic:key'), 'live at construction');
  assert.equal(second.apiKeys()[0].masked, '…c3d4');
});

test('a key sealed under a different secret says so instead of looking absent', async (t) => {
  const path = 'demo/.keyrotate.chitraq';
  const before = new Chitraq({ path, keySecret: 'the-old-secret' });
  before.setApiKey({ provider: 'anthropic', key: KEY });
  before.close();

  const after = new Chitraq({ path, keySecret: 'a-completely-different-secret' });
  t.after(async () => {
    after.close();
    const { rm } = await import('node:fs/promises');
    for (const suffix of ['', '-wal', '-shm']) await rm(`${path}${suffix}`, { force: true });
  });

  // The key is still listed — it exists — but plainly marked unusable. Silently
  // reporting "no key configured" would route the request somewhere cheaper
  // while the person believes their key is in use.
  const listed = after.apiKeys();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].readable, false);
  assert.equal(listed[0].active, false);
  assert.equal(after.registry.get('anthropic:key'), undefined, 'and not registered');

  assert.throws(
    () => keys.getKey(after.db, { principalId: after.principal.id, provider: 'anthropic', secret: after.keySecret }),
    /different secret/
  );
});

test('a tampered row fails closed rather than handing over a corrupt key', async (t) => {
  const c = memory();
  t.after(() => c.close());
  c.setApiKey({ provider: 'anthropic', key: KEY });

  const row = c.db.prepare('SELECT id, ciphertext FROM api_key').get();
  const bytes = Buffer.from(row.ciphertext);
  bytes[0] ^= 0xff;
  c.db.prepare('UPDATE api_key SET ciphertext = ? WHERE id = ?').run(bytes, row.id);

  // GCM catches this. Sending a mangled key to a vendor would be worse than
  // refusing, because the vendor's error would be about authentication.
  assert.throws(
    () => keys.getKey(c.db, { principalId: c.principal.id, provider: 'anthropic', secret: c.keySecret }),
    /could not be decrypted/
  );
});

test('rubbish is refused before anything is written', async (t) => {
  const c = memory();
  t.after(() => c.close());

  assert.throws(() => c.setApiKey({ provider: 'anthropic', key: '' }), /cannot be empty/);
  assert.throws(() => c.setApiKey({ provider: 'anthropic', key: 'abc' }), /does not look like/);
  assert.throws(() => c.setApiKey({ provider: '', key: KEY }), /which provider/);
  assert.equal(c.apiKeys().length, 0);
});

test('replacing a key keeps one row and reports the replacement', async (t) => {
  const c = memory();
  t.after(() => c.close());

  const first = c.setApiKey({ provider: 'anthropic', key: KEY });
  assert.equal(first.replaced, false);

  const second = c.setApiKey({ provider: 'anthropic', key: 'sk-ant-api03-a-different-one-9999' });
  assert.equal(second.replaced, true);
  assert.equal(second.id, first.id, 'same slot');
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(c.apiKeys().length, 1);
});

test('a fingerprint answers "is this the same key" without decrypting', async (t) => {
  const c = memory();
  t.after(() => c.close());
  c.setApiKey({ provider: 'anthropic', key: KEY });

  assert.equal(
    keys.matchesStored(c.db, { principalId: c.principal.id, provider: 'anthropic', key: KEY }),
    true
  );
  assert.equal(
    keys.matchesStored(c.db, { principalId: c.principal.id, provider: 'anthropic', key: `${KEY}x` }),
    false
  );
});

test('a key for a provider nothing can build is stored but honestly inactive', async (t) => {
  const c = memory();
  t.after(() => c.close());

  // This used to say `openai`, which stopped being true the moment the
  // OpenAI-compatible adapter arrived and made eleven providers buildable.
  // The behaviour under test is unchanged — a key for something unknown is
  // kept rather than dropped — so only the example needed replacing.
  const result = c.setApiKey({ provider: 'cohere', key: 'sk-proj-something-0000' });
  assert.equal(result.active, false, 'no adapter exists for it');
  assert.equal(c.apiKeys()[0].provider, 'cohere', 'but it is kept, not silently dropped');
});

test('providerFromKey returns nothing for a vendor it does not know', () => {
  assert.equal(providerFromKey('some-startup', 'sk-x'), null);
  const built = providerFromKey('anthropic', KEY);
  assert.equal(built.id, 'anthropic:key');
  assert.equal(built.keyed, true);
});

test('keys are per person: yours does not become someone else\'s', async (t) => {
  const c = memory();
  t.after(() => c.close());

  c.setApiKey({ provider: 'anthropic', key: KEY });

  const otherPrincipal = 'prn_someone_else';
  assert.deepEqual(keys.list(c.db, otherPrincipal, c.keySecret), []);
  assert.deepEqual(keys.providersWithKeys(c.db, otherPrincipal), []);
  assert.equal(
    keys.getKey(c.db, { principalId: otherPrincipal, provider: 'anthropic', secret: c.keySecret }),
    null
  );
});

test('the HTTP API can store and remove a key, and cannot read one', async (t) => {
  const c = memory();
  const server = createApp(c);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    c.close();
  });

  const post = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'anthropic', key: KEY, label: 'laptop' }),
  });
  assert.equal(post.status, 200);

  const listed = await (await fetch(`${base}/api/keys`)).text();
  assert.ok(!listed.includes(KEY), 'the API cannot hand the key back');
  assert.match(listed, /c3d4/, 'only the hint');

  const del = await fetch(`${base}/api/keys/anthropic`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(c.apiKeys(), []);
});
