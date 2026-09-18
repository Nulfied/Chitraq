/**
 * Export/import round trips, and deduplication on capture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';

/** Build a workspace with history, links, evidence and provenance. */
async function populated() {
  const c = new Chitraq({ path: ':memory:' });
  const a = await c.remember({
    title: 'Chose SQLite for the store',
    body: 'We chose SQLite because it needs no server.',
    kind: 'decision',
    enrich: false,
  });
  const b = await c.remember({
    title: 'Dropped the Redis cache',
    body: 'The hit rate never exceeded 12 percent.',
    kind: 'decision',
    enrich: false,
  });
  c.connect(b.object.id, 'depends_on', a.object.id, { note: 'reads go straight to SQLite' });
  await c.correct(a.object.id, { body: 'We chose SQLite because it ships inside Node.' }, 'clearer');
  await c.ingest({ text: 'The team measured p99 latency at 38ms.', filename: 'note.md' });
  return { c, aId: a.object.id, bId: b.object.id };
}

test('an export carries every layer of memory', async () => {
  const { c } = await populated();
  const dump = c.export();

  assert.equal(dump.format, 'chitraq/v1');
  assert.ok(dump.checksum, 'an export is checksummed');
  for (const key of ['objects', 'versions', 'relations', 'sources', 'derivations', 'events', 'proposals']) {
    assert.ok(dump[key].length > 0, `${key} should not be empty`);
  }
  c.close();
});

test('a workspace round-trips into a fresh installation', async () => {
  const { c, aId, bId } = await populated();
  const dump = c.export();
  const before = c.stats();

  const fresh = new Chitraq({ path: ':memory:' });
  const result = await fresh.import(dump);

  assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join('; ')}`);
  assert.equal(result.imported.objects, before.objects);

  // Identity survives, which is what makes provenance and links meaningful.
  const recalled = fresh.recall(aId);
  assert.ok(recalled, 'ids are preserved across the round trip');
  assert.equal(recalled.object.title, 'Chose SQLite for the store');
  assert.equal(recalled.history.length, 2, 'version history travels too');
  assert.equal(recalled.history[0].body, 'We chose SQLite because it needs no server.');
  assert.ok(recalled.provenance.length > 0);

  assert.equal(fresh.recall(bId).relations.outgoing[0].other_id, aId, 'relationships survive');

  const found = await fresh.search('sqlite');
  assert.ok(found.results.length > 0, 'the index is rebuilt on import');
  c.close();
  fresh.close();
});

test('importing twice is idempotent', async () => {
  const { c } = await populated();
  const dump = c.export();

  const fresh = new Chitraq({ path: ':memory:' });
  const first = await fresh.import(dump);
  const second = await fresh.import(dump);

  assert.ok(first.imported.objects > 0);
  assert.equal(second.imported.objects ?? 0, 0, 'nothing new the second time');
  assert.equal(second.skipped.objects, first.imported.objects);
  assert.equal(fresh.stats().objects, c.stats().objects, 'no duplicates were created');
  c.close();
  fresh.close();
});

test('an import never overwrites knowledge already here', async () => {
  const { c, aId } = await populated();
  const dump = c.export();

  const other = new Chitraq({ path: ':memory:' });
  await other.import(dump);
  await other.correct(aId, { body: 'Locally corrected.' }, 'my own edit');

  await other.import(dump); // the stale export again

  assert.equal(other.recall(aId).object.body, 'Locally corrected.', 'the local edit stands');
  other.close();
  c.close();
});

test('onConflict:fail refuses rather than silently skipping', async () => {
  const { c } = await populated();
  const dump = c.export();
  const fresh = new Chitraq({ path: ':memory:' });
  await fresh.import(dump);

  await assert.rejects(() => fresh.import(dump, { onConflict: 'fail' }), /already exists/);
  fresh.close();
  c.close();
});

test('a dry run reports exactly what it would do, and writes nothing', async () => {
  const { c } = await populated();
  const dump = c.export();
  const fresh = new Chitraq({ path: ':memory:' });

  const dry = await fresh.import(dump, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.imported.objects > 0);
  assert.equal(fresh.stats().objects, 0, 'nothing was actually written');

  const real = await fresh.import(dump);
  assert.equal(real.imported.objects, dry.imported.objects, 'the dry run predicted the real one');
  fresh.close();
  c.close();
});

test('a tampered export is flagged but still importable', async () => {
  const { c } = await populated();
  const dump = c.export();
  dump.objects[0].title = 'Edited outside Chitraq';

  const fresh = new Chitraq({ path: ':memory:' });
  const result = await fresh.import(dump);

  assert.ok(
    result.warnings.some((w) => /checksum/i.test(w)),
    'the mismatch is reported rather than ignored'
  );
  assert.ok(result.imported.objects > 0, 'but the user is not locked out of their own data');
  fresh.close();
  c.close();
});

test('rows that would dangle are dropped with a warning, not written broken', async () => {
  const { c } = await populated();
  const dump = c.export();
  dump.objects = dump.objects.slice(0, 1); // strip the far end of a relation

  const fresh = new Chitraq({ path: ':memory:' });
  const result = await fresh.import(dump);

  assert.ok(result.warnings.some((w) => /one end is not in this export/.test(w)));
  assert.equal(result.imported.relations ?? 0, 0);
  fresh.close();
  c.close();
});

test('an unknown format is refused', async () => {
  const fresh = new Chitraq({ path: ':memory:' });
  await assert.rejects(() => fresh.import({ format: 'someone-elses/v9' }), /Unrecognised export format/);
  fresh.close();
});

// ------------------------------------------------------------- dedup

test('capturing identical content twice returns the original', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({ title: 'Renewal is 14 March', body: 'Contract renews 14 March.', enrich: false });
  const again = await c.remember({ title: 'Renewal is 14 March', body: 'Contract renews 14 March.', enrich: false });

  assert.equal(again.deduplicated, true);
  assert.equal(again.object.id, first.object.id);
  assert.equal(c.stats().objects, 1, 'memory does not accumulate duplicates');
  c.close();
});

test('a duplicate keeps the original history rather than splitting it', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({ title: 'Headcount', body: 'We are 12 people.', enrich: false });
  await c.correct(first.object.id, { body: 'We are 15 people.' }, 'three hires');

  // The original wording, captured again — it is no longer the current content,
  // so it is genuinely new rather than a duplicate of the head.
  const again = await c.remember({ title: 'Headcount', body: 'We are 12 people.', enrich: false });
  assert.notEqual(again.object.id, first.object.id);
  c.close();
});

test('near-duplicates are left alone; only identical content dedupes', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Batch runtime', body: 'The batch takes 40 minutes.', enrich: false });
  const near = await c.remember({ title: 'Batch runtime', body: 'The batch takes 41 minutes.', enrich: false });

  assert.ok(!near.deduplicated, 'a different figure is different knowledge');
  assert.equal(c.stats().objects, 2);
  c.close();
});

test('deduplication can be overridden', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Standup note', body: 'Same text each day.', enrich: false });
  const forced = await c.remember({
    title: 'Standup note',
    body: 'Same text each day.',
    enrich: false,
    allowDuplicate: true,
  });

  assert.ok(!forced.deduplicated);
  assert.equal(c.stats().objects, 2);
  c.close();
});

test('re-capturing something deliberately deleted makes a fresh object', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({ title: 'Throwaway', body: 'Not wanted.', enrich: false });
  c.forget(first.object.id, 'not useful');

  const again = await c.remember({ title: 'Throwaway', body: 'Not wanted.', enrich: false });
  assert.notEqual(again.object.id, first.object.id, 'deletion is not silently undone');
  c.close();
});
