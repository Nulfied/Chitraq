/**
 * Regression tests for retrieval and conflict-detection quality.
 *
 * Each of these covers a defect that shipped once: a wrong answer that looked
 * plausible. They are the cases most worth locking down, because none of them
 * throws — they just quietly make memory less trustworthy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { detectConflict, embed } from '../src/intelligence/providers/deterministic.js';
import { vectorSearch } from '../src/retrieval/search.js';
import { keywords } from '../src/intelligence/providers/deterministic.js';

test('a unit suffix is not mistaken for a magnitude suffix', () => {
  // "40 minutes" once parsed as 40 × 10^6 because the `m` branch matched the
  // first letter of "minutes".
  const result = detectConflict(
    { title: 'Batch runtime', body: 'The nightly batch takes 40 minutes.' },
    { title: 'Batch runtime', body: 'The nightly batch takes 95 minutes.' }
  );
  assert.equal(result.contradicts, true);
  assert.match(result.reason, /40 minutes/);
  assert.match(result.reason, /95 minutes/);
  assert.doesNotMatch(result.reason, /000000/, 'minutes must not be scaled to millions');
});

test('genuine magnitude suffixes still scale', () => {
  const result = detectConflict(
    { title: 'Revenue', body: 'Annual revenue reached 5 million this year.' },
    { title: 'Revenue', body: 'Annual revenue reached 9 million this year.' }
  );
  assert.equal(result.contradicts, true);
});

test('a figure repeated in title and body is reported once', () => {
  const result = detectConflict(
    { title: 'Churn is 3 percent', body: 'Churn is 3 percent across all plans.' },
    { title: 'Churn is 8 percent', body: 'Churn is 8 percent across all plans.' }
  );
  assert.equal(result.contradicts, true);
  const threes = (result.reason.match(/3 percent/g) ?? []).length;
  assert.equal(threes, 1, 'the same figure is not listed twice');
});

test('differing units are not treated as disagreement', () => {
  const result = detectConflict(
    { title: 'Batch job', body: 'The batch reads 40 files each run.' },
    { title: 'Batch job', body: 'The batch runs for 40 minutes each run.' }
  );
  assert.equal(result.contradicts, false, 'a count and a duration are different measurements');
});

test('vector search cuts the tail relative to the best match', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'SQLite decision', body: 'We chose SQLite for the memory store.', enrich: false });
  await c.remember({ title: 'Batch runtime', body: 'The nightly reconciliation batch takes 40 minutes.', enrich: false });
  await c.remember({ title: 'Office plants', body: 'The ficus by the window needs watering weekly.', enrich: false });

  const run = await c.router.run('embed.text', { texts: ['why did we choose sqlite'] }, { workspaceId: c.workspaceId });
  const hits = vectorSearch(c.db, {
    workspaceId: c.workspaceId,
    vector: run.result.vectors[0],
    model: run.result.model,
    limit: 10,
  });

  assert.equal(hits.length, 1, 'only the genuine match survives the cutoff');
  assert.equal(c.recall(hits[0].object_id).object.title, 'SQLite decision');
  c.close();
});

test('the cutoff is relative, so it survives a different embedding scale', () => {
  // A trained embedder can score unrelated text at 0.6 and a real match at 0.9.
  // A fixed absolute floor would keep everything; a relative one still separates.
  const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  const query = embed('memory engine architecture');
  const near = cos(query, embed('the memory engine architecture document'));
  const far = cos(query, embed('the ficus needs watering weekly'));
  assert.ok(near > far * 2.5, 'the gap between match and noise is wide enough for a ratio cutoff');
});

test('an unrelated disagreement does not surface in an answer', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({
    title: 'Chose SQLite for the memory store',
    body: 'We chose SQLite because it needs no server and ships inside Node.',
    kind: 'decision',
  });
  await c.remember({ title: 'Nightly batch runtime', body: 'The nightly batch takes 40 minutes.' });
  await c.remember({ title: 'Nightly batch runtime', body: 'The nightly batch takes 95 minutes.' });

  assert.ok(c.conflicts({ status: 'open' }).length >= 1, 'the batch disagreement is on record');

  const sqlite = await c.ask('why did we choose sqlite');
  assert.equal(sqlite.conflicts.length, 0, 'an unrelated conflict must not be raised here');

  const batch = await c.ask('how long does the nightly batch take');
  assert.ok(batch.conflicts.length > 0, 'but the relevant one must still be raised');
  c.close();
});

test('common words are stripped from the query, not sent to the index', async () => {
  const { parse, toFtsQuery } = await import('../src/retrieval/query.js');

  const intent = parse('why did we drop the redis cache');
  assert.deepEqual(intent.terms, ['drop', 'redis', 'cache']);

  const fts = toFtsQuery(intent);
  assert.doesNotMatch(fts, /"the"/, '"the" as an OR-term makes every document a match');
  assert.doesNotMatch(fts, /"did"/);
  assert.match(fts, /redis/);
});

test('a query made only of common words still searches for them', async () => {
  const { parse } = await import('../src/retrieval/query.js');
  const intent = parse('the who');
  assert.ok(intent.terms.length > 0, 'falling through to zero terms would return nothing at all');
});

test('a question does not drag in every document that contains "the"', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Drop the Redis cache', body: 'We removed the Redis cache from the read path.', enrich: false });
  await c.remember({ title: 'Nightly batch runtime', body: 'The nightly batch takes 40 minutes to finish.', enrich: false });
  await c.remember({ title: 'Engineering headcount', body: 'The team is 15 people across three squads.', enrich: false });
  await c.remember({ title: 'Office plants', body: 'The ficus by the window needs watering.', enrich: false });

  const found = await c.search('why did we drop the redis cache');
  assert.ok(found.results.length <= 2, `expected a focused result set, got ${found.results.length}`);
  assert.match(found.results[0].title, /Redis/);
  c.close();
});

test('discourse connectives do not crowd out real keywords', () => {
  const found = keywords(
    'We chose SQLite because it needs no server. Therefore the engine has zero dependencies, ' +
      'although Postgres was considered and rejected since it requires a running service.',
    { limit: 6 }
  ).map((k) => k.term);

  for (const noise of ['because', 'therefore', 'although', 'since']) {
    assert.ok(!found.includes(noise), `"${noise}" should not rank as a keyword`);
  }
  assert.ok(found.includes('sqlite'));
});
