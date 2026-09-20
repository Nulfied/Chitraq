/**
 * Not serving a whole memory to the network by accident.
 *
 * Authentication switches on when an account exists, and not before. On
 * 127.0.0.1 that is right: the only caller is the person sitting at the
 * machine, and demanding a login from them would be theatre.
 *
 * The moment `CHITRAQ_HOST` changes it is wrong, and it changes for a good
 * reason — sync between two machines needs a reachable address, and the
 * README shows exactly that. Nothing warned. A memory served on 0.0.0.0 with
 * no account answered `GET /api/export` with the entire workspace, `GET
 * /api/keys` with the stored API keys and `GET /api/tokens` with the
 * credentials issued to other programs, to anybody on the network.
 *
 * Holding an access token does not help. A token narrows what its holder may
 * do; it is never demanded. An anonymous request is not a request with an
 * empty scope, it is a request that skipped the check.
 *
 * So the refusal happens before the socket opens. These tests are about the
 * decision rather than the server, because the decision is the part that has
 * to be right in every combination.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLoopbackHost, refuseToServe, loadConfig } from '../src/config.js';

test('loopback is recognised across the forms people actually write', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.1.2.3']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  // 127.0.0.0/8 is all loopback, which is why the test is not `=== '127.0.0.1'`.
  assert.equal(isLoopbackHost('127.255.255.254'), true);
});

test('the addresses people reach for to make sync work are not loopback', () => {
  // These two are the whole point. Somebody wanting sync sets one of them.
  for (const host of ['0.0.0.0', '::', '192.168.1.6', '10.0.0.5', 'chitraq.local']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('an open address with no account is refused, and the refusal says why', () => {
  const refusal = refuseToServe({ host: '0.0.0.0', authEnabled: false });
  assert.ok(refusal, 'refused');

  // The message has to name the stakes, or it reads as a configuration nag
  // and the next thing anybody does is look for the flag that silences it.
  assert.match(refusal, /export/i);
  assert.match(refusal, /API keys/i);
  assert.match(refusal, /0\.0\.0\.0/);
  // And it has to say what to do, both ways.
  assert.match(refusal, /create an account/i);
  assert.match(refusal, /127\.0\.0\.1/);
  assert.match(refusal, /CHITRAQ_ALLOW_OPEN/);
});

test('loopback with no account is fine, which is the ordinary case', () => {
  assert.equal(refuseToServe({ host: '127.0.0.1', authEnabled: false }), null);
  assert.equal(refuseToServe({ host: 'localhost', authEnabled: false }), null);
});

test('an account makes any address servable, because credentials are then required', () => {
  assert.equal(refuseToServe({ host: '0.0.0.0', authEnabled: true }), null);
  assert.equal(refuseToServe({ host: '192.168.1.6', authEnabled: true }), null);
});

test('the override works, and only when set to exactly true', () => {
  assert.equal(refuseToServe({ host: '0.0.0.0', authEnabled: false, allowOpen: true }), null);

  // A half-set variable must not half-open the door.
  for (const value of ['1', 'yes', 'TRUE', '']) {
    const config = loadConfig({ CHITRAQ_ALLOW_OPEN: value });
    assert.equal(config.allowOpen, false, `CHITRAQ_ALLOW_OPEN=${value}`);
  }
  assert.equal(loadConfig({ CHITRAQ_ALLOW_OPEN: 'true' }).allowOpen, true);
});

test('the default configuration is the safe one', () => {
  // If this ever changes, an install that never set anything starts serving
  // to the network, which is the failure this whole file is about.
  const config = loadConfig({});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.allowOpen, false);
  assert.equal(refuseToServe({ host: config.host, authEnabled: false }), null);
});
