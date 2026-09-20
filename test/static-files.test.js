/**
 * The web root is a boundary, and it has to hold against paths, not strings.
 *
 * `serveStatic` reads files off disk for whoever asks over HTTP. CodeQL
 * flagged it for a stat-then-read race, which is the least of it. Looking
 * properly turned up two weaknesses in how the boundary was decided:
 *
 *   - Containment was `target.startsWith(root)`, so a sibling directory
 *     whose name merely begins with the root's name satisfied it.
 *   - The check ran on the path as written, and `resolve` does not follow
 *     symbolic links, so a link inside the root could point anywhere.
 *
 * One honest note about the first. Through HTTP it was probably not
 * reachable: `normalize()` collapses `..` before `resolve()` runs, so a
 * crafted URL lands back inside the root rather than beside it. It was a
 * loaded gun pointing at the floor — wrong, and one refactor away from
 * mattering. So it is tested where it is actually wrong, as a unit, rather
 * than through a request that cannot reach it. Claiming an HTTP exploit here
 * would be overstating what was found.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { createApp, within } from '../src/server/http.js';
import { Chitraq } from '../src/chitraq.js';

test('containment is about path segments, not shared letters', () => {
  const root = join(sep, 'srv', 'web');

  assert.equal(within(root, root), true, 'the root itself');
  assert.equal(within(root, join(root, 'app.js')), true, 'a file inside');
  assert.equal(within(root, join(root, 'a', 'b', 'c.css')), true, 'nested');

  // The bug. Every one of these satisfies startsWith and none is inside.
  assert.equal(within(root, join(sep, 'srv', 'web-secret', 'private.txt')), false);
  assert.equal(within(root, join(sep, 'srv', 'website', 'index.html')), false);
  assert.equal(within(root, join(sep, 'srv', 'webhooks')), false);

  assert.equal(within(root, join(sep, 'etc', 'passwd')), false, 'somewhere else entirely');
  assert.equal(within(root, join(sep, 'srv')), false, 'the parent is not inside the child');
});

test('a root with a trailing separator behaves the same', () => {
  // `resolve()` strips it, but the helper is called with whatever it is
  // given and must not produce `/srv/web//app.js` as its comparison.
  const withSlash = join(sep, 'srv', 'web') + sep;
  assert.equal(within(withSlash, join(sep, 'srv', 'web', 'app.js')), true);
  assert.equal(within(withSlash, join(sep, 'srv', 'web-secret', 'x')), false);
});

/** A web root sitting beside a directory that must never be served. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'chitraq-static-'));
  const root = join(base, 'web');
  const sibling = join(base, 'web-secret');

  mkdirSync(root, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html>the app</html>');
  writeFileSync(join(sibling, 'private.txt'), 'NOT-FOR-THE-WEB');
  writeFileSync(join(base, 'outside.txt'), 'NOT-FOR-THE-WEB');

  const chitraq = new Chitraq({ path: ':memory:' });
  return { base, root, chitraq, server: createApp(chitraq, { webRoot: root }) };
}

/** @param {any} server @param {string} path */
async function get(server, path) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('nothing outside the web root is ever served', async (t) => {
  const f = fixture();
  t.after(() => {
    f.chitraq.close();
    rmSync(f.base, { recursive: true, force: true });
  });

  // A 200 is acceptable here: unknown paths fall back to the single-page
  // shell by design. What is never acceptable is the file's contents. The
  // assertion is on the bytes, not the status, because the status is a
  // routing decision and the bytes are the security property.
  for (const path of [
    '/../outside.txt',
    '/../../etc/passwd',
    '/%2e%2e/outside.txt',
    '/../web-secret/private.txt',
    '/..%2fweb-secret%2fprivate.txt',
  ]) {
    const res = await get(f.server, path);
    assert.ok(!res.body.includes('NOT-FOR-THE-WEB'), `${path} leaked a file outside the root`);
  }
});

test('the app itself is still served', async (t) => {
  // A boundary that rejects everything is not a fix.
  const f = fixture();
  t.after(() => {
    f.chitraq.close();
    rmSync(f.base, { recursive: true, force: true });
  });

  const res = await get(f.server, '/index.html');
  assert.equal(res.status, 200);
  assert.match(res.body, /the app/);
});

test('a symbolic link out of the web root does not escape it', async (t) => {
  const f = fixture();
  t.after(() => {
    f.chitraq.close();
    rmSync(f.base, { recursive: true, force: true });
  });

  try {
    symlinkSync(join(f.base, 'outside.txt'), join(f.root, 'escape.txt'));
  } catch (err) {
    // Windows needs Developer Mode or elevation for this, and the CI matrix
    // runs Linux and macOS where it works. Skipping is honest; asserting a
    // pass on a case that never ran is not.
    t.skip(`symlinks unavailable here (${/** @type {any} */ (err).code})`);
    return;
  }

  const res = await get(f.server, '/escape.txt');
  assert.ok(!res.body.includes('NOT-FOR-THE-WEB'), 'the link must not be followed out of the root');
});
