#!/usr/bin/env node
/**
 * Serve `docs/` locally, the way GitHub Pages will.
 *
 * The landing page is the first thing most people see, and "it looked fine in
 * the editor" is not the same as looking fine in a browser at phone width with
 * dark mode on. This exists so that can be checked before it is published
 * rather than after.
 *
 *     node scripts/serve-docs.js          # http://127.0.0.1:4318
 *
 * Deliberately tiny and deliberately not a dependency: it serves static files
 * from one directory and refuses to leave it.
 */

import { createServer } from 'node:http';
import { readFile, stat, realpath } from 'node:fs/promises';
import { join, resolve, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../docs', import.meta.url)));
const PORT = Number(process.env.PORT ?? 4318);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Normalise before joining, then confirm the result is still inside ROOT.
  // Checking the request string for ".." is the version of this that gets
  // bypassed by an encoded separator.
  const target = resolve(join(ROOT, normalize(pathname)));
  if (!within(ROOT, target)) {
    res.writeHead(403).end('Outside the docs folder.');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;

    // Again after following links, because `resolve` does not follow them.
    if (!within(await realpath(ROOT), await realpath(file))) {
      res.writeHead(403).end('Outside the docs folder.');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // Always fresh: the whole point is seeing the edit you just made.
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${pathname}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  docs  ${ROOT}`);
  console.log(`  at    http://127.0.0.1:${PORT}\n`);
});

/**
 * Is `target` the directory `root`, or inside it?
 *
 * `startsWith` alone accepts a sibling whose name begins with the root's —
 * `docs` and `docs-drafts` are different directories. The separator is what
 * turns a prefix test into a containment test. Same fix as `serveStatic` in
 * `src/server/http.js`, deliberately duplicated: a four-line guard is not
 * worth a development script importing from the shipped code.
 *
 * @param {string} root    already resolved
 * @param {string} target  already resolved
 */
function within(root, target) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}
