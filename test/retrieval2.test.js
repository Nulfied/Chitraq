/**
 * Reranking, salience and the approximate vector index.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import * as ann from '../src/retrieval/ann.js';
import { compute, multiplier, refresh } from '../src/retrieval/salience.js';

// ------------------------------------------------------------- salience

test('salience rewards attention, connection, evidence and confirmation', () => {
  const bare = compute({ access_count: 0, degree: 0, evidence: 0 }).value;
  const busy = compute({
    access_count: 20,
    last_access: new Date().toISOString(),
    degree: 8,
    evidence: 4,
    review: 'confirmed',
  }).value;

  assert.ok(bare < 0.05);
  assert.ok(busy > 0.9);
  assert.ok(compute({ degree: 6 }).value > compute({ degree: 0 }).value);
});

test('salience explains itself', () => {
  const { because } = compute({ access_count: 5, degree: 4, evidence: 2, review: 'confirmed' });
  assert.ok(because.some((b) => /opened 5/.test(b)));
  assert.ok(because.some((b) => /4 connections/.test(b)));
  assert.ok(because.includes('confirmed'));
});

test('salience can never outweigh relevance', () => {
  // The whole range is ±15%. A more relevant result cannot be displaced by a
  // merely more popular one.
  const lowest = multiplier({ access_count: 0, degree: 0 }).multiplier;
  const highest = multiplier({
    access_count: 500,
    last_access: new Date().toISOString(),
    degree: 50,
    evidence: 20,
    review: 'confirmed',
  }).multiplier;

  assert.ok(lowest >= 0.85);
  assert.ok(highest <= 1.15);
  assert.ok(highest / lowest < 1.4, 'the spread is a nudge, not a lever');
});

test('old attention counts for less than recent attention', () => {
  const recent = compute({ access_count: 10, last_access: new Date().toISOString() }).value;
  const old = compute({
    access_count: 10,
    last_access: new Date(Date.now() - 400 * 86400000).toISOString(),
  }).value;
  assert.ok(recent > old);
});

test('nothing is ever hidden by low salience', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const obscure = await c.remember({
    title: 'A thing nobody has looked at since',
    body: 'An obscure detail about the widget calibration procedure.',
    enrich: false,
  });
  for (let i = 0; i < 5; i++) {
    await c.remember({ title: `Popular note ${i}`, body: 'Widget calibration is discussed here.', enrich: false });
  }
  // Give the popular notes attention.
  for (let i = 0; i < 20; i++) await c.search('widget calibration');

  const found = await c.search('obscure detail calibration procedure');
  assert.ok(
    found.results.some((r) => r.id === obscure.object.id),
    'the thing you looked at once, long ago, is exactly what you need memory for'
  );
  c.close();
});

test('refresh materialises salience for browsing', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const a = await c.remember({ title: 'Linked note', body: 'Body A', enrich: false });
  const b = await c.remember({ title: 'Isolated note', body: 'Body B', enrich: false });
  c.connect(b.object.id, 'related_to', a.object.id);

  const { updated } = refresh(c.db, c.workspaceId);
  assert.equal(updated, 2);

  const salienceOf = (id) => c.db.prepare('SELECT salience FROM object WHERE id = ?').get(id).salience;
  assert.ok(salienceOf(a.object.id) > 0, 'a connected note has salience');
  c.close();
});

// ------------------------------------------------------------- reranking

test('reranking runs and is reported in the signals', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Deploy runbook', body: 'The deploy script runs blue-green rollouts.', enrich: false });
  await c.remember({ title: 'Deploy incident', body: 'A deploy failed because the script timed out.', enrich: false });
  await c.remember({ title: 'Deploy schedule', body: 'Deploys happen on Tuesday and Thursday.', enrich: false });
  await c.remember({ title: 'Unrelated', body: 'The ficus needs watering.', enrich: false });

  const found = await c.search('deploy script rollout');
  assert.ok(found.signals.includes('reranked'));
  assert.ok(found.results[0].why.rerank, 'each result records its rerank contribution');
  c.close();
});

test('reranking is skipped where it has nothing to weigh', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 4; i++) {
    await c.remember({ title: `Note ${i}`, body: `Deployment topic ${i}`, enrich: false });
  }
  const single = await c.search('deployment');
  assert.ok(!single.signals.includes('reranked'), 'a one-word query gives a reranker nothing to do');
  c.close();
});

test('reranking can be turned off', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Deploy runbook', body: 'Blue-green rollouts run here.', enrich: false });
  await c.remember({ title: 'Deploy incident', body: 'A rollout failed midway.', enrich: false });
  await c.remember({ title: 'Deploy schedule', body: 'Rollouts happen on Tuesday.', enrich: false });

  const off = await c.search('deploy rollout schedule', { rerank: false });
  assert.ok(!off.signals.includes('reranked'));
  c.close();
});

test('a failing reranker leaves the results intact', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.addProvider({
    id: 'broken-reranker',
    label: 'Broken',
    locality: 'local',
    cost: 'free',
    capabilities: {
      rerank: { quality: 0.99, latencyMs: 1, run: async () => { throw new Error('nope'); } },
    },
  });
  await c.remember({ title: 'Deploy runbook', body: 'Blue-green rollouts run here.', enrich: false });
  await c.remember({ title: 'Deploy incident', body: 'A rollout failed midway.', enrich: false });
  await c.remember({ title: 'Deploy schedule', body: 'Rollouts happen on Tuesday.', enrich: false });

  const found = await c.search('deploy rollout schedule');
  assert.ok(found.results.length > 0, 'search still answers');
  c.close();
});

// ----------------------------------------------------- approximate index

test('small workspaces never build an index', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'One', body: 'Some text here.', enrich: false });

  const result = c.buildVectorIndex();
  assert.equal(result.built.length, 0, 'below the threshold an index is not worth its build cost');

  const found = await c.search('some text');
  assert.ok(found.signals.includes('semantic'), 'and search stays exact');
  assert.ok(!found.signals.includes('semantic~'));
  c.close();
});

test('an index can be forced, and then serves search', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 40; i++) {
    await c.remember({
      title: `Note ${i}`,
      body: `${i % 2 ? 'database schema migration query' : 'deployment rollout cluster registry'} ${i}`,
      enrich: false,
      allowDuplicate: true,
    });
  }

  const result = c.buildVectorIndex({ force: true });
  assert.equal(result.built.length, 1);
  assert.ok(result.built[0].vectors >= 40);

  const found = await c.search('database schema migration');
  assert.ok(found.signals.includes('semantic~'), 'the approximate path is reported honestly');
  assert.ok(found.results.length > 0);
  c.close();
});

test('vectors captured after the build are still findable', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 30; i++) {
    await c.remember({ title: `Filler ${i}`, body: `deployment rollout cluster ${i}`, enrich: false, allowDuplicate: true });
  }
  c.buildVectorIndex({ force: true });

  await c.remember({
    title: 'Added after the index was built',
    body: 'A distinctive marmalade telescope observation.',
    enrich: false,
  });

  const found = await c.search('marmalade telescope observation');
  assert.ok(
    found.results.some((r) => r.title === 'Added after the index was built'),
    'incremental assignment keeps the index current between reindexes'
  );
  c.close();
});

test('the index is deterministic', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 30; i++) {
    await c.remember({ title: `Note ${i}`, body: `topic ${i % 3} content ${i}`, enrich: false, allowDuplicate: true });
  }
  const model = c.db.prepare('SELECT model FROM embedding LIMIT 1').get().model;

  const first = ann.build(c.db, { workspaceId: c.workspaceId, model: String(model) });
  const second = ann.build(c.db, { workspaceId: c.workspaceId, model: String(model) });

  assert.deepEqual(
    first.lists.map((l) => l.map((p) => p.chunkId).sort()),
    second.lists.map((l) => l.map((p) => p.chunkId).sort()),
    'the same vectors always cluster the same way'
  );
  c.close();
});

test('the index reports when it has drifted far from its fit', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 20; i++) {
    await c.remember({ title: `Base ${i}`, body: `topic content ${i}`, enrich: false, allowDuplicate: true });
  }
  const model = String(c.db.prepare('SELECT model FROM embedding LIMIT 1').get().model);
  const index = ann.build(c.db, { workspaceId: c.workspaceId, model });

  assert.equal(ann.isStale(index), false);
  for (let i = 0; i < 400; i++) {
    ann.add(index, { chunkId: `fake_${i}`, objectId: `obj_${i}`, vec: new Float32Array(index.dim).fill(0.05) });
  }
  assert.equal(ann.isStale(index), true, 'drift is surfaced rather than silently degrading recall');
  c.close();
});

test('reindex rebuilds vectors, salience and the index together', async () => {
  const c = new Chitraq({ path: ':memory:' });
  for (let i = 0; i < 30; i++) {
    await c.remember({ title: `Note ${i}`, body: `deployment topic ${i}`, enrich: false, allowDuplicate: true });
  }
  const result = await c.reindex();
  assert.ok(result.chunks > 0);
  assert.ok(result.vectorIndex, 'the index lifecycle is part of reindex, not an afterthought');
  c.close();
});
