/**
 * The HTTP API.
 *
 * A thin, honest translation layer over the Chitraq facade: it parses, routes,
 * and serialises. All decisions about what memory does live in the engine, not
 * here, so the CLI, the web UI and any other client get identical behaviour.
 *
 * Built on node:http with no framework, consistent with the rest of the
 * project's zero-dependency posture.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '../../web');

/**
 * @param {import('../chitraq.js').Chitraq} chitraq
 * @param {{webRoot?: string}} [opts]
 */
export function createApp(chitraq, opts = {}) {
  const webRoot = opts.webRoot ?? WEB_ROOT;

  /** @type {Array<{method: string, pattern: RegExp, handler: Function}>} */
  const routes = [];

  /**
   * @param {string} method
   * @param {string} path  e.g. '/api/objects/:id/history'
   * @param {(ctx: any) => Promise<any>|any} handler
   */
  const route = (method, path, handler) => {
    const pattern = new RegExp(
      `^${path.replace(/:[a-zA-Z]+/g, (m) => `(?<${m.slice(1)}>[^/]+)`)}/?$`
    );
    routes.push({ method, pattern, handler });
  };

  // ------------------------------------------------------------- system

  route('GET', '/api/health', () => ({ ok: true, workspace: chitraq.workspaceId }));

  route('GET', '/api/stats', () => ({ ...chitraq.stats(), health: health(chitraq) }));

  route('GET', '/api/capabilities', () => chitraq.capabilities());

  route('POST', '/api/policy', ({ body }) => chitraq.setPolicy(body));

  route('GET', '/api/intelligence-log', ({ query }) =>
    chitraq.intelligenceLog({
      limit: num(query.limit, 50),
      capability: query.capability,
      status: query.status,
    })
  );

  route('POST', '/api/reindex', async () => chitraq.reindex());

  route('GET', '/api/export', () => chitraq.export());

  // ------------------------------------------------------------ capture

  route('POST', '/api/remember', ({ body }) => chitraq.remember(body));

  route('POST', '/api/ingest', ({ body }) => chitraq.ingest(body));

  // ---------------------------------------------------------- retrieval

  route('GET', '/api/search', ({ query }) =>
    chitraq.search(query.q ?? '', {
      limit: num(query.limit, 20),
      anchorId: query.anchor,
      includeArchived: query.archived === 'true',
    })
  );

  route('POST', '/api/ask', ({ body }) =>
    chitraq.ask(body.question, { budget: body.budget, seeds: body.seeds })
  );

  route('GET', '/api/timeline', ({ query }) =>
    chitraq.timeline({
      limit: num(query.limit, 50),
      since: query.since,
      until: query.until,
      kinds: list(query.kinds),
    })
  );

  route('GET', '/api/events', ({ query }) =>
    chitraq.history({ limit: num(query.limit, 100), subjectId: query.subject, types: list(query.types) })
  );

  // ------------------------------------------------------------ objects

  route('GET', '/api/objects', ({ query }) => objectsList(chitraq, query));

  route('GET', '/api/objects/:id', ({ params }) => {
    const found = chitraq.recall(params.id);
    if (!found) throw notFound(`No knowledge object ${params.id}`);
    return found;
  });

  route('PATCH', '/api/objects/:id', ({ params, body }) =>
    chitraq.correct(params.id, body.patch ?? body, body.reason)
  );

  route('POST', '/api/objects/:id/confirm', ({ params, body }) =>
    chitraq.confirm(params.id, body?.note)
  );

  route('POST', '/api/objects/:id/archive', ({ params, body }) =>
    chitraq.archive(params.id, body?.reason)
  );

  route('POST', '/api/objects/:id/supersede', ({ params, body }) =>
    chitraq.supersede(params.id, body.replacement, body.reason)
  );

  route('POST', '/api/objects/:id/enrich', ({ params }) => chitraq.enrich(params.id));

  route('POST', '/api/objects/:id/relate', ({ params }) => chitraq.relate(params.id));

  route('DELETE', '/api/objects/:id', ({ params, query }) =>
    query.purge === 'true'
      ? chitraq.erase(params.id, query.reason ?? 'requested via API')
      : chitraq.forget(params.id, query.reason)
  );

  // ---------------------------------------------------------- relations

  route('GET', '/api/graph', ({ query }) => graph(chitraq, query));

  route('POST', '/api/relations', ({ body }) =>
    chitraq.connect(body.srcId, body.type, body.dstId, { note: body.note })
  );

  route('DELETE', '/api/relations/:id', ({ params, query }) =>
    chitraq.disconnect(params.id, query.reason)
  );

  // ---------------------------------------------------------- proposals

  route('GET', '/api/proposals', ({ query }) =>
    chitraq.pending({ status: query.status ?? 'pending', limit: num(query.limit, 50) })
  );

  route('POST', '/api/proposals/:id/accept', ({ params, body }) =>
    chitraq.accept(params.id, body?.note)
  );

  route('POST', '/api/proposals/:id/reject', ({ params, body }) =>
    chitraq.decline(params.id, body?.note)
  );

  // ---------------------------------------------------------- conflicts

  route('GET', '/api/conflicts', ({ query }) =>
    chitraq.conflicts({ status: query.status ?? 'open', limit: num(query.limit, 50) })
  );

  route('POST', '/api/conflicts/:id/resolve', ({ params, body }) =>
    chitraq.resolveConflict(params.id, body.status ?? 'resolved', body.resolution)
  );

  // ------------------------------------------------------------ handler

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Local-first means local-only by default: the API binds to loopback and
    // sends no permissive CORS header, so a random web page cannot read the
    // user's memory through their own browser.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const match = routes.find(
          (r) => r.method === req.method && r.pattern.test(url.pathname)
        );
        if (!match) return send(res, 404, { error: `No route ${req.method} ${url.pathname}` });

        const params = match.pattern.exec(url.pathname)?.groups ?? {};
        const query = Object.fromEntries(url.searchParams);
        const body = await readBody(req);

        const result = await match.handler({ params, query, body, req });
        return send(res, 200, result ?? { ok: true });
      } catch (err) {
        const status = err?.status ?? 500;
        if (status >= 500) console.error('[chitraq]', err);
        return send(res, status, {
          error: err?.message ?? 'Something went wrong.',
          kind: err?.name ?? 'Error',
        });
      }
    }

    return serveStatic(res, webRoot, url.pathname);
  });

  return server;
}

/**
 * Operational health. Surfaces the one failure mode that is otherwise silent:
 * the active embedding model no longer matching what is stored, which makes
 * semantic search quietly return nothing until a reindex.
 * @param {import('../chitraq.js').Chitraq} chitraq
 */
export function health(chitraq) {
  const stored = chitraq.db
    .prepare('SELECT DISTINCT model FROM embedding WHERE workspace_id = ?')
    .all(chitraq.workspaceId)
    .map((r) => String(r.model));

  /** @type {string[]} */
  const warnings = [];
  if (stored.length > 1) {
    warnings.push(
      `Embeddings exist under ${stored.length} different models (${stored.join(', ')}). ` +
        `Semantic search only compares vectors from the same model — run a reindex to unify them.`
    );
  }
  return { embeddingModels: stored, warnings, ok: warnings.length === 0 };
}

/**
 * @param {import('../chitraq.js').Chitraq} chitraq
 * @param {any} query
 */
function objectsList(chitraq, query) {
  return chitraq.timeline({
    limit: num(query.limit, 50),
    kinds: list(query.kinds),
    since: query.since,
    until: query.until,
  });
}

/**
 * A graph view: the most connected material plus its edges, ready to draw.
 * @param {import('../chitraq.js').Chitraq} chitraq
 * @param {any} query
 */
function graph(chitraq, query) {
  const limit = num(query.limit, 120);
  const nodes = chitraq.db
    .prepare(
      `SELECT o.id, o.title, o.kind, o.epistemic, o.origin, o.review, o.state,
              (SELECT COUNT(*) FROM relation r
               WHERE (r.src_id = o.id OR r.dst_id = o.id) AND r.state = 'active') AS degree
       FROM object o
       WHERE o.workspace_id = ? AND o.state IN ('active','superseded')
       ORDER BY degree DESC, o.updated_at DESC LIMIT ?`
    )
    .all(chitraq.workspaceId, limit)
    .map((r) => ({ ...r }));

  if (!nodes.length) return { nodes: [], edges: [] };

  const ids = nodes.map((n) => n.id);
  const edges = chitraq.db
    .prepare(
      `SELECT id, src_id, dst_id, type, origin, confidence, review
       FROM relation
       WHERE workspace_id = ? AND state = 'active'
         AND src_id IN (${ids.map(() => '?').join(',')})
         AND dst_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(chitraq.workspaceId, ...ids, ...ids)
    .map((r) => ({ ...r }));

  return { nodes, edges };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {string} pathname
 */
async function serveStatic(res, root, pathname) {
  // Resolve inside the web root and verify: a request for ../../.ssh/id_rsa
  // must not be able to read it.
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const target = resolve(root, rel === '' ? 'index.html' : rel);

  if (!target.startsWith(resolve(root))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    try {
      // Single-page app: unknown paths fall back to the shell.
      const data = await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(data);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readBody(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return Promise.resolve({});
  return new Promise((resolvePromise, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 32 MB: large enough for a book, small enough that a runaway upload
      // cannot exhaust memory.
      if (size > 32 * 1024 * 1024) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Request body was not valid JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload, replacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** BLOBs and BigInts are not JSON; keep the API from crashing on them. */
function replacer(_key, value) {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  return value;
}

/** @param {string} message */
function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

/** @param {unknown} v @param {number} fallback */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {unknown} v */
function list(v) {
  return typeof v === 'string' && v ? v.split(',').filter(Boolean) : undefined;
}
