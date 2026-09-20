/**
 * Build `docs/API.md` from the routes the server actually dispatches on.
 *
 * Chitraq is meant to be usable as memory by other programs, and a developer
 * asking "what can I call?" should not have to read `http.js` to find out.
 * A hand-written reference would answer that on the day it was written and
 * drift from then on, so this does not write one: it asks a live app for its
 * route table and describes what is there.
 *
 * The descriptions are the one part a program cannot supply, so they live in
 * DESCRIPTIONS below — and the generator refuses to run if a route has no
 * entry, or if an entry names a route that no longer exists. Adding a route
 * without documenting it fails CI rather than quietly shipping a gap.
 *
 *     node tools/api-reference.mjs           rewrite docs/API.md
 *     node tools/api-reference.mjs --check   fail if it is out of date
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { createApp } from '../src/server/http.js';
import { Chitraq } from '../src/chitraq.js';

const OUT = 'docs/API.md';

/** What each route is for. Keyed exactly as the server registers them. */
const DESCRIPTIONS = new Map(
  Object.entries({
    // system
    'GET /api/health': 'Is this memory up, and which workspace is it.',
    'GET /api/stats': 'Counts of everything held, plus operational health.',
    'GET /api/capabilities': 'Which intelligence capabilities have a provider, and which are on the deterministic floor.',
    'POST /api/policy': 'Change what Chitraq is allowed to use: local only, remote, paid.',
    'GET /api/intelligence-log': 'Every call made to a provider, with latency and cost.',
    'POST /api/reindex': 'Rebuild every derived index from the objects. Safe; slow.',
    'GET /api/export': 'The entire workspace as JSON. Everything, including what was archived.',
    'POST /api/import': 'Merge a Chitraq export into this memory.',

    // capture
    'POST /api/remember': 'Capture a note. Needs at least `title`.',
    'POST /api/ingest': 'Capture a document: text, PDF, HTML, CSV, JSON, image, audio.',

    // retrieval
    'GET /api/search': 'Search memory. Supports `kind:`, `after:`, quoted phrases and `-exclude`.',
    'POST /api/ask': 'Ask a question. Quotes your own words when it can, escalates only when it cannot.',
    'GET /api/answer-cache': 'How much the answer cache is holding and saving.',
    'DELETE /api/answer-cache': 'Empty the answer cache.',
    'GET /api/timeline': 'What happened, most recent first.',
    'GET /api/events': 'The audit log: what changed, when, and by what.',

    // knowledge objects
    'GET /api/objects': 'List Knowledge Objects, filterable by kind, origin and date.',
    'GET /api/objects/:id': 'One object with its history, links, evidence and provenance.',
    'PATCH /api/objects/:id': 'Correct an object. The previous version is kept, not overwritten.',
    'POST /api/objects/:id/confirm': 'Mark knowledge as checked by a person.',
    'POST /api/objects/:id/archive': 'Remove from retrieval, keeping the history.',
    'POST /api/objects/:id/supersede': 'Replace one object with another, recording which replaced which.',
    'POST /api/objects/:id/enrich': 'Ask intelligence for entities, keywords and attributes on this object.',
    'POST /api/objects/:id/relate': 'Ask intelligence to propose relationships from this object.',
    'DELETE /api/objects/:id': 'Irreversibly destroy an object and its history. Only the fact of erasure remains.',
    'GET /api/objects/:id/notices': 'Things worth knowing about this object without asking.',

    // graph
    'GET /api/graph': 'The relationship graph, from a starting point outwards.',
    'POST /api/relations': 'Assert a relationship between two objects.',
    'DELETE /api/relations/:id': 'Remove a relationship.',

    // the proposal gateway
    'GET /api/proposals': 'Everything intelligence has suggested and is waiting on a decision for.',
    'POST /api/proposals/:id/accept': 'Accept a proposal into memory.',
    'POST /api/proposals/:id/reject': 'Decline a proposal. It is kept, marked rejected.',
    'POST /api/proposals/bulk': 'Accept or reject many proposals at once, by filter or confidence.',
    'POST /api/proposals/expire': 'Expire proposals that have sat undecided too long.',

    // disagreement
    'GET /api/conflicts': 'Disagreements Chitraq has noticed between things it holds.',
    'POST /api/conflicts/:id/resolve': 'Record which side of a disagreement is right, and why.',

    // entities and concepts
    'GET /api/entities': 'People, places, products and projects found across your notes.',
    'GET /api/entities/:id': 'One entity, with everything that mentions it.',
    'GET /api/entities-duplicates': 'Entities that look like the same thing under two names.',
    'POST /api/entities/:id/merge': 'Merge two entities into one, keeping both names as aliases.',
    'POST /api/entities/:id/alias': 'Add another name for an entity.',
    'GET /api/concepts': 'Ideas that recur across your notes.',
    'POST /api/concepts/propose': 'Look for new recurring ideas and propose them.',

    // awareness and cost
    'GET /api/notices': 'Things worth knowing without having asked.',
    'GET /api/costs': 'What intelligence has cost, by provider and capability.',
    'POST /api/budget': 'Set what Chitraq may spend.',

    // sync
    'GET /api/sync/changes': 'Changes since a cursor, for another Chitraq to apply.',
    'POST /api/sync/apply': 'Apply changes sent by another Chitraq.',
    'GET /api/sync/peers': 'Machines this memory has exchanged changes with.',

    // retrieval index
    'POST /api/vector-index/build': 'Build the approximate vector index.',
    'POST /api/vector-index/benchmark': 'Measure what the approximate index costs in recall and saves in time.',

    // accounts
    'GET /api/auth/status': 'Whether authentication is on, and how many accounts exist. Public.',
    'POST /api/auth/login': 'Sign in and receive a session token. Public.',
    'POST /api/auth/logout': 'End a session.',
    'GET /api/auth/sessions': 'Sessions currently signed in.',

    // access tokens for other programs
    'GET /api/tokens': 'Tokens issued to other programs. The token itself is never shown again.',
    'POST /api/tokens': 'Mint a scoped token for another program.',
    'DELETE /api/tokens/:id': 'Stop a token working, keeping the record that it existed.',

    // provider keys
    'GET /api/keys': 'Which provider keys are stored, and whether they are readable. Never the keys.',
    'POST /api/keys': 'Store a provider API key, encrypted at rest.',
    'DELETE /api/keys/:provider': 'Forget a stored provider key.',
    'POST /api/keys/lock': 'Put a passphrase over stored keys.',
    'POST /api/keys/unlock': 'Unlock stored keys for this process.',
    'POST /api/keys/relock': 'Make stored keys unreadable again without restarting.',
  })
);

/** The order sections appear in, and what belongs in each. */
const SECTIONS = [
  ['System', (p) => /^\/api\/(health|stats|capabilities|policy|intelligence-log|reindex|export|import)$/.test(p)],
  ['Capture', (p) => /^\/api\/(remember|ingest)$/.test(p)],
  ['Retrieval', (p) => /^\/api\/(search|ask|answer-cache|timeline|events)$/.test(p)],
  ['Knowledge objects', (p) => p.startsWith('/api/objects')],
  ['Relationships', (p) => p.startsWith('/api/graph') || p.startsWith('/api/relations')],
  ['Proposals', (p) => p.startsWith('/api/proposals')],
  ['Conflicts', (p) => p.startsWith('/api/conflicts')],
  ['Entities and concepts', (p) => p.startsWith('/api/entities') || p.startsWith('/api/concepts')],
  ['Awareness and cost', (p) => /^\/api\/(notices|costs|budget)$/.test(p)],
  ['Sync', (p) => p.startsWith('/api/sync')],
  ['Vector index', (p) => p.startsWith('/api/vector-index')],
  ['Accounts', (p) => p.startsWith('/api/auth')],
  ['Access tokens', (p) => p.startsWith('/api/tokens')],
  ['Provider keys', (p) => p.startsWith('/api/keys')],
];

const chitraq = new Chitraq({ path: ':memory:' });
const routes = createApp(chitraq).routes;
chitraq.close();

// Nothing undocumented ships, and nothing documented is imaginary.
const keys = routes.map((r) => `${r.method} ${r.path}`);
const undocumented = keys.filter((k) => !DESCRIPTIONS.has(k));
const imaginary = [...DESCRIPTIONS.keys()].filter((k) => !keys.includes(k));

if (undocumented.length || imaginary.length) {
  for (const k of undocumented) console.error(`  undocumented route: ${k}`);
  for (const k of imaginary) console.error(`  documented but gone: ${k}`);
  console.error('\n  Edit DESCRIPTIONS in tools/api-reference.mjs.');
  process.exit(1);
}

const markdown = render(routes);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing counts as out of date */
  }
  if (current !== markdown) {
    console.error(`  ${OUT} is out of date. Run: node tools/api-reference.mjs`);
    process.exit(1);
  }
  console.log(`  ${OUT} matches the ${routes.length} routes the server serves`);
} else {
  writeFileSync(OUT, markdown);
  console.log(`  wrote ${OUT} — ${routes.length} routes`);
}

/** @param {Array<{method: string, path: string, scope: string}>} routes */
function render(routes) {
  const used = new Set();
  const out = [];

  out.push('# HTTP API');
  out.push('');
  out.push('<!-- Generated by tools/api-reference.mjs from the server\'s own route');
  out.push('     table. Do not edit by hand: run `node tools/api-reference.mjs`. -->');
  out.push('');
  out.push(`Chitraq serves ${routes.length} routes over HTTP, on \`127.0.0.1:4317\` by default.`);
  out.push('This file is generated from the table the server dispatches on, so it');
  out.push('cannot describe a route that does not exist or miss one that does.');
  out.push('');
  out.push('```bash');
  out.push('node src/server/serve.js          # or: npm start');
  out.push('```');
  out.push('');
  out.push('## Authentication');
  out.push('');
  out.push('Credentials are required once an account exists, and not before — a');
  out.push('fresh install reached from the machine it runs on answers everything.');
  out.push('Serving a non-loopback address with no account is refused at startup;');
  out.push('see [SECURITY.md](../SECURITY.md).');
  out.push('');
  out.push('Two kinds of credential, both as `Authorization: Bearer <value>`:');
  out.push('');
  out.push('- **A session token** from `POST /api/auth/login`, which is a person.');
  out.push('- **An access token** from `chitraq tokens --new <name>`, which is a');
  out.push('  program. It starts `ctq_` and is shown once.');
  out.push('');
  out.push('An access token *narrows*: presenting one restricts the caller to its');
  out.push('scope even where an anonymous caller would be allowed more. So a side');
  out.push('project can hold something that genuinely cannot erase anything.');
  out.push('');
  out.push('| Scope | Can reach |');
  out.push('|---|---|');
  out.push('| `read` | read routes |');
  out.push('| `write` | read and write routes |');
  out.push('| `admin` | everything, including keys, tokens, export and erasure |');
  out.push('');
  out.push('Three routes need no credential at all, so that signing in is possible:');
  out.push('`GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login`.');
  out.push('');
  out.push('## Client library');
  out.push('');
  out.push('`src/client.js` is a dependency-free class for calling all of this from');
  out.push('another project, and is the recommended way in.');
  out.push('');
  out.push('```js');
  out.push("import { ChitraqClient } from 'chitraq/client';");
  out.push('');
  out.push('const memory = new ChitraqClient({');
  out.push("  url: 'http://127.0.0.1:4317',");
  out.push('  token: process.env.CHITRAQ_TOKEN,');
  out.push('});');
  out.push('');
  out.push("await memory.remember({ title: 'Chose SQLite because it needs no server' });");
  out.push("const hits = await memory.search('sqlite');");
  out.push("const answer = await memory.ask('why did we drop the redis cache');");
  out.push('```');
  out.push('');
  out.push('It throws `ChitraqUnreachable` when the memory cannot be reached and');
  out.push('`ChitraqError` when it answers with a refusal — a distinction worth');
  out.push('having, because one is worth retrying and the other never is.');
  out.push('');
  out.push('## Routes');
  out.push('');

  for (const [title, belongs] of SECTIONS) {
    const inSection = routes.filter((r) => !used.has(r) && belongs(r.path));
    if (!inSection.length) continue;
    for (const r of inSection) used.add(r);

    out.push(`### ${title}`);
    out.push('');
    out.push('| Route | Scope | |');
    out.push('|---|---|---|');
    for (const r of inSection) {
      const key = `${r.method} ${r.path}`;
      out.push(`| \`${key}\` | ${r.scope} | ${DESCRIPTIONS.get(key)} |`);
    }
    out.push('');
  }

  const orphans = routes.filter((r) => !used.has(r));
  if (orphans.length) {
    out.push('### Other');
    out.push('');
    out.push('| Route | Scope | |');
    out.push('|---|---|---|');
    for (const r of orphans) {
      const key = `${r.method} ${r.path}`;
      out.push(`| \`${key}\` | ${r.scope} | ${DESCRIPTIONS.get(key)} |`);
    }
    out.push('');
  }

  out.push('## Errors');
  out.push('');
  out.push('Every failure is JSON with `error` and `kind`:');
  out.push('');
  out.push('| Status | Means |');
  out.push('|---|---|');
  out.push('| 401 | No credential, and this memory has accounts. |');
  out.push('| 403 | The token is real but scoped below what this route needs. The body says which scope it holds and which it needed. |');
  out.push('| 404 | No such route, or no such object. |');
  out.push('| 400 | The request was understood and refused. The message says why. |');
  out.push('');

  return out.join('\n') + '\n';
}
