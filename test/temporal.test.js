/**
 * Temporal correctness.
 *
 * INVARIANT 7: history stays distinguishable from current understanding.
 * These tests exist because the failure they guard against is silent and
 * expensive — an answer that quotes last year's price beside this year's, with
 * nothing to tell them apart, is worse than no answer at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { parse } from '../src/retrieval/query.js';

/** @returns {Promise<{c: Chitraq, oldId: string, newId: string}>} */
async function pricingMemory() {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({
    title: 'Pricing is 20 dollars per seat',
    body: 'Standard plan pricing is 20 dollars per seat per month.',
    kind: 'fact',
    enrich: false,
  });
  const { new: replacement } = await c.supersede(
    first.object.id,
    {
      title: 'Pricing is 28 dollars per seat',
      body: 'Standard plan pricing is 28 dollars per seat per month.',
      kind: 'fact',
    },
    'price rise in April'
  );
  return { c, oldId: first.object.id, newId: replacement.id };
}

test('a question about the past is told apart from one about now', () => {
  assert.equal(parse('what is our pricing').retrospective, false);
  assert.equal(parse('what did pricing used to be').retrospective, true);
  assert.equal(parse('what was the original plan').retrospective, true);
  assert.equal(parse('how much do we charge').retrospective, false);
});

test('a current question never quotes superseded knowledge as fact', async () => {
  const { c, oldId } = await pricingMemory();
  const answered = await c.ask('what is our pricing per seat');

  assert.match(answered.answer, /28 dollars/);
  assert.doesNotMatch(answered.answer, /20 dollars/, 'the replaced price must not appear as current');
  assert.ok(!answered.citations.includes(oldId));
  c.close();
});

test('a retrospective question answers with what was replaced, and labels it', async () => {
  const { c, oldId } = await pricingMemory();
  const answered = await c.ask('what did pricing used to be');

  assert.match(answered.answer, /20 dollars/);
  assert.ok(answered.citations.includes(oldId));
  assert.match(answered.uncertainty, /superseded/i, 'the answer must say it is quoting old material');
  c.close();
});

test('ordinary search does not return superseded material', async () => {
  const { c, oldId, newId } = await pricingMemory();
  const found = await c.search('pricing per seat');
  const ids = found.results.map((r) => r.id);

  assert.ok(ids.includes(newId));
  assert.ok(!ids.includes(oldId), 'superseded knowledge stays out of an ordinary search');
  c.close();
});

test('superseded material is still reachable when explicitly asked for', async () => {
  const { c, oldId } = await pricingMemory();

  const byState = await c.search('is:superseded pricing');
  assert.ok(byState.results.some((r) => r.id === oldId), 'is:superseded reaches it');

  const byFlag = await c.search('pricing per seat', { includeArchived: true });
  assert.ok(byFlag.results.some((r) => r.id === oldId), 'so does an explicit include');

  assert.ok(c.recall(oldId), 'and it is always reachable directly by id');
  c.close();
});

test('the replaced version is offered as history alongside its replacement', async () => {
  const { c, oldId, newId } = await pricingMemory();
  const recalled = c.recall(newId);
  assert.ok(
    recalled.supersedes.some((s) => s.id === oldId),
    'the current object knows what it replaced'
  );
  assert.equal(c.recall(oldId).object.superseded_by, newId);
  c.close();
});

test('archived material is likewise kept out of ordinary answers', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const keep = await c.remember({ title: 'Deploy with blue-green', body: 'Deploys use the blue-green script.', enrich: false });
  const old = await c.remember({ title: 'Deploy with the rsync script', body: 'Deploys use the old rsync script.', enrich: false });
  c.archive(old.object.id, 'replaced by blue-green');

  const found = await c.search('deploy script');
  assert.ok(found.results.some((r) => r.id === keep.object.id));
  assert.ok(!found.results.some((r) => r.id === old.object.id));
  c.close();
});
