#!/usr/bin/env node
/**
 * Measure the approximate vector index against the exact scan.
 *
 *     node scripts/bench-vectors.js [vectorCount]
 *
 * The threshold in retrieval/ann.js is a default chosen from this benchmark,
 * not a law. Run it on your own hardware and data before trusting it — an
 * approximate index that is slower *and* less accurate than brute force is
 * strictly worse, and that is the usual case at small sizes.
 */

import { Chitraq } from '../src/chitraq.js';

const target = Number(process.argv[2] ?? 5000);

console.log(`\n  Building a workspace with roughly ${target} chunks…\n`);

const c = new Chitraq({ path: ':memory:' });

// Text with real cluster structure: an index over uniformly random vectors
// flatters itself, because every list is equally bad.
const TOPICS = [
  ['database', 'sqlite', 'postgres', 'index', 'query', 'transaction', 'schema', 'migration'],
  ['deployment', 'kubernetes', 'rollout', 'canary', 'container', 'registry', 'cluster'],
  ['payment', 'invoice', 'refund', 'gateway', 'settlement', 'chargeback', 'currency'],
  ['hiring', 'candidate', 'interview', 'offer', 'onboarding', 'headcount', 'review'],
  ['latency', 'throughput', 'benchmark', 'profiling', 'cache', 'percentile', 'regression'],
  ['security', 'credential', 'rotation', 'audit', 'permission', 'encryption', 'token'],
];

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const t0 = Date.now();
for (let i = 0; i < target; i++) {
  const topic = TOPICS[i % TOPICS.length];
  const body = Array.from({ length: 24 }, () => pick(topic)).join(' ');
  await c.remember({
    title: `${pick(topic)} note ${i}`,
    body,
    enrich: false,
    allowDuplicate: true,
  });
  if (i % 500 === 0 && i) process.stdout.write(`    ${i}…\n`);
}

const stats = c.stats();
console.log(`\n  ${stats.objects} objects, ${stats.embeddings} vectors, built in ${Math.round((Date.now() - t0) / 1000)}s\n`);

for (const probes of [4, 8, 16]) {
  const result = await c.benchmarkVectorIndex({ probes });
  if (!result.usable) {
    console.log(`  ${result.reason}`);
    break;
  }
  console.log(
    `  probes=${String(probes).padStart(2)}  ` +
      `exact ${String(result.exactMsPerQuery).padStart(7)}ms  ` +
      `ann ${String(result.annMsPerQuery).padStart(7)}ms  ` +
      `speedup ${String(result.speedup).padStart(6)}×  ` +
      `recall ${result.recall}  ` +
      `— ${result.verdict}`
  );
}

console.log(`\n  lists: √${stats.embeddings} ≈ ${Math.round(Math.sqrt(stats.embeddings))}`);
console.log(`  current threshold: ${(await import('../src/retrieval/ann.js')).MIN_VECTORS_FOR_ANN} vectors\n`);

c.close();
