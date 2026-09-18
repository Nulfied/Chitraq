#!/usr/bin/env node
/**
 * Build a demo memory.
 *
 *     node scripts/seed.js demo/memory.chitraq
 *
 * The scenario is a small engineering team over several months. It is chosen to
 * exercise the parts of Chitraq that a handful of disconnected notes never
 * would: knowledge that gets superseded, a decision that gets reversed, two
 * measurements that disagree, a document that yields proposals nobody has
 * reviewed yet, and links that make a distant answer reachable.
 */

import { rmSync } from 'node:fs';
import { Chitraq } from '../src/chitraq.js';

const path = process.argv[2] ?? 'demo/memory.chitraq';

for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${path}${suffix}`);
  } catch {
    // Nothing there yet; that is the normal case.
  }
}

const c = new Chitraq({ path });

/** Backdate so the timeline has shape rather than one clump of "today". */
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

console.log('Building a demo memory…\n');

// --- decisions ------------------------------------------------------------

const sqlite = await c.remember({
  title: 'Use SQLite for the memory store',
  body:
    'We are storing memory in SQLite rather than Postgres. Node 24 ships SQLite in core with ' +
    'FTS5 enabled, which means the engine has no dependencies, no service to run, and no ' +
    'install step beyond Node itself. Postgres would have given us better concurrency, but ' +
    'nobody wanted to make every user run a database server to keep notes.',
  kind: 'decision',
  occurredAt: daysAgo(96),
});

const redis = await c.remember({
  title: 'Drop the Redis cache from the read path',
  body:
    'We removed Redis from the read path. The hit rate never got above 12 percent because the ' +
    'access pattern is long-tail, and it added an operational dependency for no measurable win. ' +
    'Reads now go straight to SQLite.',
  kind: 'decision',
  occurredAt: daysAgo(74),
});

const vectors = await c.remember({
  title: 'Keep vector search brute force for now',
  body:
    'Cosine similarity is computed by scanning every stored vector. At our size this is a few ' +
    'milliseconds and it is exactly correct. An approximate index would add a dependency and ' +
    'approximation error to solve a problem we do not have yet. Revisit above a million chunks.',
  kind: 'decision',
  occurredAt: daysAgo(51),
});

// --- observations that will later disagree --------------------------------

const batchEarly = await c.remember({
  title: 'Nightly reconciliation batch runtime',
  body: 'Measured on the old hardware: the nightly reconciliation batch takes 95 minutes end to end.',
  kind: 'observation',
  occurredAt: daysAgo(60),
});

await c.remember({
  title: 'Nightly reconciliation batch runtime',
  body: 'Measured after the migration: the nightly reconciliation batch takes 40 minutes end to end.',
  kind: 'observation',
  occurredAt: daysAgo(22),
});

// --- knowledge that changes -----------------------------------------------

const pricingV1 = await c.remember({
  title: 'Pricing is 20 dollars per seat',
  body: 'Standard plan pricing is 20 dollars per seat per month, billed annually.',
  kind: 'fact',
  occurredAt: daysAgo(88),
  enrich: false,
});

await c.supersede(
  pricingV1.object.id,
  {
    title: 'Pricing is 28 dollars per seat',
    body: 'Standard plan pricing is 28 dollars per seat per month, billed annually.',
    kind: 'fact',
    occurredAt: daysAgo(14),
  },
  'price rise took effect in April'
);

// --- a correction ---------------------------------------------------------

const headcount = await c.remember({
  title: 'Engineering headcount',
  body: 'The engineering team is 12 people across three squads.',
  kind: 'fact',
  occurredAt: daysAgo(40),
  enrich: false,
});
await c.correct(
  headcount.object.id,
  { body: 'The engineering team is 15 people across three squads.' },
  'three hires started in March'
);

// --- an incident, connected so it is reachable from a distance ------------

const outage = await c.remember({
  title: 'Payment gateway outage on the 14th',
  body:
    'The payment gateway was unavailable for 41 minutes. Checkout kept retrying without backoff, ' +
    'which amplified load on our own API and delayed recovery after the gateway came back.',
  kind: 'event',
  occurredAt: daysAgo(30),
});

const retries = await c.remember({
  title: 'Add exponential backoff to checkout retries',
  body:
    'Checkout now backs off exponentially with jitter, capped at six attempts. Written directly ' +
    'in response to the outage on the 14th.',
  kind: 'decision',
  occurredAt: daysAgo(28),
});

const lesson = await c.remember({
  title: 'Retry storms turn a dependency outage into our outage',
  body:
    'A third-party outage should degrade us, not take us down. Any client we write against an ' +
    'external service needs backoff and a circuit breaker before it ships.',
  kind: 'lesson',
  occurredAt: daysAgo(27),
});

// --- explicit relationships (yours, and therefore authoritative) ----------

c.connect(retries.object.id, 'caused_by', outage.object.id, { note: 'direct response to the incident' });
c.connect(lesson.object.id, 'derived_from', outage.object.id);
c.connect(redis.object.id, 'depends_on', sqlite.object.id, { note: 'reads go straight to SQLite now' });
c.connect(vectors.object.id, 'elaborates', sqlite.object.id);

// --- an unreviewed document, to populate the review queue -----------------

await c.ingest({
  filename: 'architecture-review.md',
  uri: 'file://notes/architecture-review.md',
  text: `# Architecture review, week 12

We agreed to keep the memory engine dependency-free for as long as it is practical.

The team measured p99 search latency at 38ms across 14,000 chunks on a laptop.

It might not hold above ten million chunks, but nobody has tested that yet.

We decided to defer the approximate-nearest-neighbour work until someone hits a real limit.

Sanjay raised that the embedding model is the weak link, not the index.`,
});

const stats = c.stats();
console.log(`  ${stats.objects} objects`);
console.log(`  ${stats.relations} relationships`);
console.log(`  ${stats.versions} versions (nothing overwritten)`);
console.log(`  ${stats.pendingProposals} proposals waiting for review`);
console.log(`  ${stats.openConflicts} conflicts detected`);
console.log(`  ${stats.chunks} chunks, ${stats.embeddings} vectors`);
console.log(`\n  Written to ${path}`);
console.log(`  Run it with:  node src/server/serve.js --db ${path}\n`);

c.close();
