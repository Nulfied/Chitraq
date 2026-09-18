/**
 * Sync over HTTP, between two real servers.
 *
 * Nothing is stubbed: two Chitraq instances, two `createServer` listeners, real
 * sockets. A transport test that mocks the transport tests nothing.
 *
 * The properties under test are the ones that make sync trustworthy rather than
 * merely functional — that a second sync sends nothing, that divergence is
 * raised instead of resolved, that a dry run writes on neither side, and that
 * pointing it at the wrong port fails loudly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createPlainServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { createApp } from '../src/server/http.js';
import { httpPeer, isRemoteHost, PeerError } from '../src/core/sync-http.js';

/** Start a Chitraq behind a real loopback server. */
async function node_(name) {
  const c = new Chitraq({ path: ':memory:' });
  const server = createApp(c);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());
  return {
    name,
    chitraq: c,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => server.close(r));
      c.close();
    },
  };
}

test('two machines converge, and the second sync sends nothing', async (t) => {
  const laptop = await node_('laptop');
  const desktop = await node_('desktop');
  t.after(async () => {
    await laptop.close();
    await desktop.close();
  });

  await laptop.chitraq.remember({ title: 'Chose SQLite', body: 'It needs no server.', kind: 'decision' });
  await desktop.chitraq.remember({ title: 'Pricing', body: 'Forty dollars per seat.', kind: 'fact' });

  const first = await laptop.chitraq.syncOverHttp(desktop.url);
  assert.equal(first.peer.id, desktop.chitraq.workspaceId);
  assert.equal(first.pushed.objects, 1, 'sent our one object');
  assert.equal(first.pulled.objects, 1, 'received their one object');

  // Both sides now hold both pieces of knowledge.
  for (const side of [laptop, desktop]) {
    const titles = side.chitraq.db
      .prepare('SELECT title FROM object ORDER BY title')
      .all()
      .map((r) => String(r.title));
    assert.deepEqual(titles, ['Chose SQLite', 'Pricing'], `${side.name} has both`);
  }

  // The cursor is the whole point: a second exchange with nothing new must be
  // empty, not merely idempotent. Resending the workspace every time converges
  // too, and is not sync.
  const second = await laptop.chitraq.syncOverHttp(desktop.url);
  assert.equal(second.pushed.objects, 0, 'nothing new to send');
  assert.equal(second.pulled.objects, 0, 'nothing new to receive');
});

test('a dry run moves nothing on either side', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  await a.chitraq.remember({ title: 'Only on A', body: 'Local knowledge.' });

  const report = await a.chitraq.syncOverHttp(b.url, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.pushed.objects, 1, 'reports what it would send');

  const onB = b.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get();
  assert.equal(Number(onB.n), 0, 'B wrote nothing');

  // And the cursor did not move, so the real sync still has work to do.
  const real = await a.chitraq.syncOverHttp(b.url);
  assert.equal(real.pushed.objects, 1, 'the dry run did not consume the change');
  assert.equal(Number(b.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get().n), 1);
});

test('push-only and pull-only move knowledge one way', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  await a.chitraq.remember({ title: 'From A', body: 'A knows this.' });
  await b.chitraq.remember({ title: 'From B', body: 'B knows this.' });

  const pushed = await a.chitraq.syncOverHttp(b.url, { direction: 'push' });
  assert.ok(pushed.pushed);
  assert.equal(pushed.pulled, undefined, 'nothing was pulled');
  assert.equal(Number(a.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get().n), 1, 'A unchanged');
  assert.equal(Number(b.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get().n), 2, 'B got it');

  const pulled = await a.chitraq.syncOverHttp(b.url, { direction: 'pull' });
  assert.equal(pulled.pushed, undefined);
  assert.ok(pulled.pulled.objects >= 1);
});

test('an edit on both sides raises a conflict instead of picking a winner', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  const { object } = await a.chitraq.remember({ title: 'Launch date', body: 'We ship in March.' });
  await a.chitraq.syncOverHttp(b.url);

  // Both machines change the same thing while apart.
  await a.chitraq.correct(object.id, { body: 'We ship in April.' }, 'slipped');
  await b.chitraq.correct(object.id, { body: 'We ship in May.' }, 'slipped further');

  const report = await a.chitraq.syncOverHttp(b.url);
  assert.ok(report.pulled.conflicts.length > 0, 'divergence was raised');

  // Local text survives. Losing one of two real edits silently is the failure
  // this whole design exists to prevent.
  const local = a.chitraq.db.prepare('SELECT body FROM object WHERE id = ?').get(object.id);
  assert.match(String(local.body), /April/);

  const conflicts = a.chitraq.conflicts();
  assert.ok(conflicts.length > 0, 'and it is visible without going looking for it');
});

test('sync never deletes: a peer that has not seen your object cannot remove it', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  await a.chitraq.remember({ title: 'Kept', body: 'A has this and B does not.' });
  await b.chitraq.remember({ title: 'Also kept', body: 'B has this and A does not.' });

  await a.chitraq.syncOverHttp(b.url, { direction: 'pull' });
  assert.equal(Number(a.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get().n), 2, 'A kept its own');
});

test('pointing sync at itself is refused in words', async (t) => {
  const a = await node_('a');
  t.after(() => a.close());

  await assert.rejects(() => a.chitraq.syncOverHttp(a.url), /same workspace/);
});

test('a peer that is not a Chitraq fails loudly, not silently', async (t) => {
  const imposter = createPlainServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'fine' }));
  });
  await new Promise((r) => imposter.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (imposter.address());

  const a = await node_('a');
  t.after(async () => {
    await new Promise((r) => imposter.close(r));
    await a.close();
  });

  await assert.rejects(
    () => a.chitraq.syncOverHttp(`http://127.0.0.1:${port}`),
    /did not identify itself as a Chitraq/
  );
});

test('an unreachable peer says so without a stack trace', async () => {
  const peer = httpPeer('http://127.0.0.1:1', { timeoutMs: 1500 });
  await assert.rejects(() => peer.identify(), (err) => {
    assert.ok(err instanceof PeerError);
    assert.match(err.message, /Could not reach/);
    return true;
  });
});

test('peer URLs are normalised, and locality is reported honestly', () => {
  assert.equal(httpPeer('192.168.1.20:4317').url, 'http://192.168.1.20:4317');
  assert.equal(httpPeer('http://host:4317/').url, 'http://host:4317');
  assert.equal(httpPeer('https://memory.example.com/').url, 'https://memory.example.com');

  assert.equal(isRemoteHost('http://127.0.0.1:4317'), false);
  assert.equal(isRemoteHost('localhost:4317'), false);
  assert.equal(isRemoteHost('192.168.1.20:4317'), true);

  assert.throws(() => httpPeer('http://['), /not a URL/);
});

test('a peer is remembered by workspace id, so its address can change', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  await a.chitraq.remember({ title: 'One', body: 'First thing.' });
  await a.chitraq.syncOverHttp(b.url);

  const peers = a.chitraq.peers();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].id, b.chitraq.workspaceId, 'identified by workspace, not URL');
  assert.ok(peers[0].last_pushed, 'and the push cursor was recorded');
});

test('a batched sync says there is more, and loses nothing across rounds', async (t) => {
  const a = await node_('a');
  const b = await node_('b');
  t.after(async () => {
    await a.close();
    await b.close();
  });

  for (let i = 0; i < 12; i++) {
    await a.chitraq.remember({ title: `Note ${i}`, body: `Body number ${i}.` });
  }

  // A small limit stands in for a large workspace. The failure it guards
  // against is the cursor jumping past rows the peer never received, which
  // would drop them silently and for good.
  const first = await a.chitraq.syncOverHttp(b.url, { limit: 5 });
  assert.equal(first.pushed.objects, 5);
  assert.equal(first.pushed.complete, false);
  assert.equal(first.more, true, 'and it says so');

  let rounds = 1;
  while ((await a.chitraq.syncOverHttp(b.url, { limit: 5 })).more) {
    if (++rounds > 10) throw new Error('sync did not converge');
  }

  const onB = Number(b.chitraq.db.prepare('SELECT COUNT(*) n FROM object').get().n);
  assert.equal(onB, 12, 'every note arrived across the rounds');
});
