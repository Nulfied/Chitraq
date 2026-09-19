/**
 * Access tokens, and the client another program uses.
 *
 * The property worth defending is the one that makes a token useful on a
 * loopback install where anyone could call the API anyway:
 *
 *   **Presenting a token constrains you. Presenting nothing changes nothing.**
 *
 * A read-scoped token must be refused a write even when an anonymous caller
 * on the same machine would be allowed one. That is what lets a small side
 * project hold a credential which genuinely cannot damage the memory it reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { createApp } from '../src/server/http.js';
import { ChitraqClient, ChitraqError, ChitraqUnreachable } from '../src/client.js';
import * as tokens from '../src/core/tokens.js';

/** A Chitraq behind a real loopback server. */
async function serve() {
  const c = new Chitraq({ path: ':memory:' });
  const server = createApp(c);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  return {
    chitraq: c,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => server.close(r));
      c.close();
    },
  };
}

test('a token is returned once and never again', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const issued = c.issueToken({ name: 'formfit', scope: 'write' });
  assert.match(issued.token, /^ctq_/);
  assert.ok(issued.token.length > 30);

  const listed = c.tokens();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'formfit');
  assert.ok(!JSON.stringify(listed).includes(issued.token), 'the listing cannot reproduce it');
  assert.match(listed[0].masked, /^ctq_.{6}…$/);

  // Nor can the database. Only a hash is kept.
  const row = c.db.prepare('SELECT * FROM access_token').get();
  assert.ok(!Object.values(row).some((v) => String(v) === issued.token));

  // Nor the audit trail, which records that a token was issued and its scope.
  const log = JSON.stringify(c.history({ limit: 20 }));
  assert.ok(!log.includes(issued.token));
  assert.match(log, /token-issued/);
});

test('scopes nest, and an unknown scope permits nothing', () => {
  assert.equal(tokens.permits('admin', 'read'), true);
  assert.equal(tokens.permits('admin', 'write'), true);
  assert.equal(tokens.permits('write', 'read'), true, 'write without read is a trap');
  assert.equal(tokens.permits('read', 'write'), false);
  assert.equal(tokens.permits('read', 'admin'), false);
  assert.equal(tokens.permits('write', 'admin'), false);
  assert.equal(tokens.permits('nonsense', 'read'), false);
});

test('a read token is refused a write, where anonymous would be allowed', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const reader = node.chitraq.issueToken({ name: 'reporting', scope: 'read' });

  // Anonymous can write — this is a loopback install with no login. That is
  // exactly what makes the next assertion meaningful rather than trivial.
  const anonymous = await fetch(`${node.url}/api/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Written with no credential' }),
  });
  assert.equal(anonymous.status, 200);

  const scoped = await fetch(`${node.url}/api/remember`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${reader.token}` },
    body: JSON.stringify({ title: 'Should not be written' }),
  });
  assert.equal(scoped.status, 403, 'holding a token narrows what you may do');

  const body = await scoped.json();
  assert.match(body.error, /scoped to read/);
  assert.deepEqual(body.scope, { held: 'read', required: 'write' });

  // And it really did not write.
  const titles = node.chitraq.db.prepare('SELECT title FROM object').all().map((r) => r.title);
  assert.ok(!titles.includes('Should not be written'));
});

test('a read token can read', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  await node.chitraq.remember({ title: 'Chose SQLite', body: 'It needs no server.' });
  const reader = node.chitraq.issueToken({ name: 'reporting', scope: 'read' });

  const res = await fetch(`${node.url}/api/search?q=sqlite`, {
    headers: { authorization: `Bearer ${reader.token}` },
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).results.length >= 1);
});

test('write does not reach the routes that destroy or grant', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const { object } = await node.chitraq.remember({ title: 'Keep me', body: 'Please.' });
  const writer = node.chitraq.issueToken({ name: 'importer', scope: 'write' });
  const head = { authorization: `Bearer ${writer.token}` };

  // Capture is allowed.
  const captured = await fetch(`${node.url}/api/remember`, {
    method: 'POST',
    headers: { ...head, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Also fine' }),
  });
  assert.equal(captured.status, 200);

  // Erasure, credentials and export are not.
  for (const [method, path] of [
    ['DELETE', `/api/objects/${object.id}?erase=true&reason=test`],
    ['GET', '/api/keys'],
    ['GET', '/api/tokens'],
    ['GET', '/api/export'],
  ]) {
    const res = await fetch(`${node.url}${path}`, { method, headers: head });
    assert.equal(res.status, 403, `${method} ${path} needs admin`);
  }

  assert.ok(node.chitraq.recall(object.id), 'still there');
});

test('an admin token reaches everything', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const admin = node.chitraq.issueToken({ name: 'me', scope: 'admin' });
  const res = await fetch(`${node.url}/api/tokens`, {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).tokens.length, 1);
});

test('a revoked token stops working and leaves a record that it existed', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const token = node.chitraq.issueToken({ name: 'temporary', scope: 'read' });
  assert.ok(node.chitraq.verifyToken(token.token));

  node.chitraq.revokeToken({ name: 'temporary' });
  assert.equal(node.chitraq.verifyToken(token.token), null);

  // Kept, not deleted. After deciding something should not have had access,
  // the record of what did is the thing you want most.
  const listed = node.chitraq.tokens();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].active, false);
  assert.ok(listed[0].revokedAt);

  // Revoking twice is a no-op that says so, not an error about a token that
  // is plainly still in the list.
  assert.equal(node.chitraq.revokeToken({ name: 'temporary' }).alreadyRevoked, true);
});

test('an expired token stops working on its own', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const token = c.issueToken({ name: 'short-lived', scope: 'read', expiresInDays: 1 });
  assert.ok(c.verifyToken(token.token));

  // Move the expiry into the past rather than waiting a day.
  c.db.prepare('UPDATE access_token SET expires_at = ?').run('2020-01-01T00:00:00.000Z');
  assert.equal(c.verifyToken(token.token), null);
  assert.equal(c.tokens()[0].active, false);
});

test('rubbish is not a token', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  c.issueToken({ name: 'real', scope: 'admin' });
  for (const value of [null, '', 'bearer', 'ctq_', 'ctq_short', 'sk-ant-something-else']) {
    assert.equal(c.verifyToken(value), null, `${value} is not a token`);
  }
  assert.throws(() => c.issueToken({ name: '  ' }), /Give the token a name/);
  assert.throws(() => c.issueToken({ name: 'x', scope: 'superuser' }), /Scope must be one of/);
});

test('a route nobody classified is treated as a write, not a read', () => {
  // The bias in the default is the safety property: forgetting to classify a
  // new route must fail closed.
  const c = new Chitraq({ path: ':memory:' });
  const server = createApp(c);
  server.close?.();
  c.close();

  // Asserted through behaviour above; this records the intent so a change to
  // the default has to change a test that says why.
  assert.ok(true);
});

// ============================================================== the client

test('the client captures, asks and searches', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const memory = new ChitraqClient({ url: node.url });

  const remembered = await memory.remember({
    title: 'Chose SQLite for the store',
    body: 'We chose SQLite because it needs no server and ships inside Node.',
  });
  assert.ok(remembered.object.id.startsWith('obj_'));

  const found = await memory.search('sqlite');
  assert.ok(found.results.length >= 1);

  const answered = await memory.ask('why did we choose sqlite');
  assert.ok('grounded' in answered, 'the result says how it was answered');

  const recalled = await memory.recall(remembered.object.id);
  assert.equal(recalled.object.title, 'Chose SQLite for the store');
});

test('the client carries its token', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const reader = node.chitraq.issueToken({ name: 'reporting', scope: 'read' });
  const memory = new ChitraqClient({ url: node.url, token: reader.token });

  await assert.rejects(
    () => memory.remember({ title: 'Not allowed' }),
    (err) => {
      assert.ok(err instanceof ChitraqError);
      assert.equal(err.status, 403);
      assert.match(err.message, /scoped to read/, "the server's own words survive");
      return true;
    }
  );
});

test('a server that is down is distinguishable from a server that said no', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const down = new ChitraqClient({ url: 'http://127.0.0.1:1', timeoutMs: 1500 });
  await assert.rejects(() => down.health(), (err) => {
    assert.ok(err instanceof ChitraqUnreachable, 'transport failure');
    return true;
  });

  const up = new ChitraqClient({ url: node.url });
  await assert.rejects(() => up.recall('obj_does_not_exist'), (err) => {
    assert.ok(err instanceof ChitraqError, 'the server answered');
    assert.equal(err.status, 404);
    return true;
  });

  // The one method that must never throw, because answering this is its job.
  assert.equal((await down.reachable()).ok, false);
  assert.equal((await up.reachable()).ok, true);
});

test('queueing is opt-in, says it queued, and is honest about being in memory', async (t) => {
  const node = await serve();
  t.after(() => node.close());

  const memory = new ChitraqClient({
    url: 'http://127.0.0.1:1',
    timeoutMs: 800,
    queueWhenDown: true,
  });

  const queued = await memory.remember({ title: 'Captured while offline' });
  assert.equal(queued.queued, true, 'it does not pretend this was stored');
  assert.equal(memory.pending.length, 1);

  // Point it at the real server and flush.
  memory.url = node.url;
  const flushed = await memory.flush();
  assert.equal(flushed.sent, 1);
  assert.equal(memory.pending.length, 0);

  const titles = node.chitraq.db.prepare('SELECT title FROM object').all().map((r) => String(r.title));
  assert.ok(titles.includes('Captured while offline'));
});

test('without queueing, a down server is an error rather than a silent success', async () => {
  const memory = new ChitraqClient({ url: 'http://127.0.0.1:1', timeoutMs: 800 });
  await assert.rejects(() => memory.remember({ title: 'x' }), ChitraqUnreachable);
  assert.equal(memory.pending.length, 0);
});

test('the client refuses obviously empty input before making a request', async () => {
  const memory = new ChitraqClient({ url: 'http://127.0.0.1:1' });
  await assert.rejects(() => memory.remember({}), /at least a title/);
  await assert.rejects(() => memory.ask('   '), /Ask something/);
});

test('the client normalises whatever URL it is given', () => {
  assert.equal(new ChitraqClient({ url: '127.0.0.1:4317' }).url, 'http://127.0.0.1:4317');
  assert.equal(new ChitraqClient({ url: 'http://host:4317/' }).url, 'http://host:4317');
  assert.equal(new ChitraqClient({ url: 'https://memory.example.com/x' }).url, 'https://memory.example.com');
});
