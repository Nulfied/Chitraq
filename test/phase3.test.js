/**
 * Budgets, proactive notices, and bulk review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { money, DOLLAR } from '../src/intelligence/budget.js';
import * as gateway from '../src/intelligence/gateway.js';

/** A paid provider that always answers, for budget arithmetic. */
function paidProvider(id, costMicros) {
  return {
    id,
    label: `Paid ${id}`,
    locality: 'remote',
    cost: 'paid',
    model: 'test-model',
    capabilities: {
      summarize: {
        quality: 0.99,
        latencyMs: 5,
        costMicros,
        run: async () => ({ summary: 'summarised', method: 'generated' }),
      },
    },
  };
}

// --------------------------------------------------------------- budgets

test('costs are formatted so a sub-cent call does not read as free', () => {
  assert.equal(money(0), 'free');
  assert.equal(money(3000), '$0.0030');
  assert.equal(money(2 * DOLLAR), '$2.00');
});

test('a daily budget stops paid providers once it is spent', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.addProvider(paidProvider('expensive', 40_000)); // 4 cents a call
  c.setPolicy({ allowRemote: true, allowPaid: true, maxCostMicros: 100_000 });
  c.setBudget({ dailyMicros: 100_000 }); // 10 cents

  for (let i = 0; i < 2; i++) {
    const run = await c.router.run('summarize', { text: 'some text to summarise' }, { workspaceId: c.workspaceId });
    assert.equal(run.provider, 'expensive');
  }

  // Two calls at 4c = 8c spent; a third would exceed 10c.
  const third = await c.router.run('summarize', { text: 'more text' }, { workspaceId: c.workspaceId });
  assert.equal(third.provider, 'builtin', 'it falls through to the free provider');

  const { rejected } = await c.router.candidates('summarize');
  assert.match(rejected.find((r) => r.id === 'expensive').why, /budget/);
  c.close();
});

test('running out of budget degrades intelligence, never memory', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.addProvider(paidProvider('expensive', 90_000));
  c.setPolicy({ allowRemote: true, allowPaid: true, maxCostMicros: 100_000 });
  c.setBudget({ dailyMicros: 100_000 });

  await c.router.run('summarize', { text: 'first call' }, { workspaceId: c.workspaceId });

  // Budget is now spent. Everything that matters must still work.
  const { object } = await c.remember({ title: 'Captured while broke', body: 'Still works.' });
  assert.ok(object.id);
  const found = await c.search('captured while broke');
  assert.ok(found.results.length > 0);
  const answered = await c.ask('what was captured while broke');
  assert.ok(answered.context.items.length > 0);
  c.close();
});

test('a per-call ceiling refuses an expensive provider outright', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.addProvider(paidProvider('pricey', 500_000));
  c.setPolicy({ allowRemote: true, allowPaid: true, maxCostMicros: 1_000_000 });
  c.setBudget({ perCallMicros: 100_000 });

  const { rejected } = await c.router.candidates('summarize');
  assert.match(rejected.find((r) => r.id === 'pricey').why, /per-call limit/);
  c.close();
});

test('free providers are never blocked by a spent budget', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.setBudget({ dailyMicros: 0 });

  const verdict = c.canAfford(0);
  assert.equal(verdict.allowed, true, 'a budget is about money, and the floor costs none');

  const { object } = await c.remember({ title: 'Free capture', body: 'No cost involved.' });
  assert.ok(object.id);
  c.close();
});

test('the bill breaks down by provider, capability and day', async () => {
  const c = new Chitraq({ path: ':memory:' });
  c.addProvider(paidProvider('metered', 25_000));
  c.setPolicy({ allowRemote: true, allowPaid: true, maxCostMicros: 100_000 });

  await c.router.run('summarize', { text: 'one' }, { workspaceId: c.workspaceId });
  await c.router.run('summarize', { text: 'two' }, { workspaceId: c.workspaceId });

  const report = c.costs();
  assert.equal(report.totals.micros, 50_000);
  assert.equal(report.totals.cost, '$0.05');

  const metered = report.byProvider.find((p) => p.provider === 'metered');
  assert.equal(metered.calls, 2);
  assert.equal(metered.model, 'test-model');
  assert.ok(report.byCapability.some((x) => x.capability === 'summarize'));
  assert.ok(report.daily.length >= 1);
  c.close();
});

// ------------------------------------------------------------- proactive

test('capturing something you already wrote says so', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({
    title: 'Redis cache hit rate',
    body: 'The Redis cache hit rate never exceeded twelve percent across the read path.',
  });
  const second = await c.remember({
    title: 'Cache hit rate was poor',
    body: 'The Redis cache hit rate never got above twelve percent on the read path.',
  });

  const notices = second.enrichment.notices;
  assert.ok(notices.some((n) => n.kind === 'seen-before'), 'overlap with existing memory is surfaced');
  assert.ok(notices.every((n) => n.because), 'every notice explains itself');
  assert.ok(notices.every((n) => n.message), 'and is written for a person');
  c.close();
});

test('a contradiction is surfaced at capture, pointing at the other side', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({
    title: 'Nightly batch runtime',
    body: 'The nightly reconciliation batch takes 40 minutes to complete.',
  });
  const second = await c.remember({
    title: 'Nightly batch runtime',
    body: 'The nightly reconciliation batch takes 95 minutes to complete.',
  });

  const contradiction = second.enrichment.notices.find((n) => n.kind === 'contradiction');
  assert.ok(contradiction, 'the disagreement is raised immediately, not left to be discovered');
  assert.ok(contradiction.objectIds.includes(first.object.id), 'and points at what it disagrees with');
  c.close();
});

test('unrelated material produces no notices at all', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Office plants', body: 'The ficus needs watering weekly.' });
  const second = await c.remember({
    title: 'Deployment schedule',
    body: 'Releases go out on Tuesday afternoons after the smoke tests pass.',
  });

  assert.equal(second.enrichment.notices.length, 0, 'silence is the default');
  c.close();
});

test('workspace notices surface a review backlog and open conflicts', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.remember({ title: 'Batch runtime', body: 'The batch takes 40 minutes.' });
  await c.remember({ title: 'Batch runtime', body: 'The batch takes 95 minutes.' });
  // The backlog notice deliberately stays quiet below ten pending items, so
  // it takes a real document to trigger it.
  await c.ingest({
    text: [
      'We decided to defer the index work until the third quarter.',
      'The team measured p99 search latency at 38 milliseconds.',
      'It might not hold above ten million chunks in production.',
      'We agreed to revisit the decision after the migration lands.',
      'Sanjay raised that the embedding model is the weak link here.',
      'The load test passed at two thousand requests per second.',
      'We observed that the cache hit rate fell to eleven percent.',
      'The rollout was approved by the platform group on Tuesday.',
      'We learned that retry storms amplify a dependency outage.',
      'The team decided to add exponential backoff to every client.',
      'It could be that the regression came from the tokeniser change.',
      'We measured a thirty percent reduction in nightly batch time.',
    ].join(' '),
    filename: 'review.md',
  });

  const notices = c.notices();
  assert.ok(notices.some((n) => n.kind === 'open-conflicts'));
  assert.ok(
    notices.some((n) => n.kind === 'review-backlog'),
    `expected a backlog notice with ${c.pending().length} pending`
  );
  assert.ok(notices.every((n) => n.strength > 0 && n.strength <= 1));
  c.close();
});

test('an answer drawing on replaced material says so', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const first = await c.remember({
    title: 'Pricing is 20 dollars per seat',
    body: 'Standard pricing is 20 dollars per seat per month.',
    enrich: false,
  });
  await c.supersede(
    first.object.id,
    { title: 'Pricing is 28 dollars per seat', body: 'Standard pricing is 28 dollars per seat per month.' },
    'price rise'
  );

  const answered = await c.ask('what did pricing used to be');
  assert.ok(
    answered.notices.some((n) => n.kind === 'superseded-source'),
    'the answer flags that it is quoting replaced material'
  );
  c.close();
});

test('proactive surfacing never modifies memory', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const { object } = await c.remember({ title: 'Untouched', body: 'Some content.' });
  const before = c.recall(object.id);

  await c.noticesFor(object.id);
  c.notices();

  const after = c.recall(object.id);
  assert.equal(after.object.head_version, before.object.head_version);
  assert.equal(after.history.length, before.history.length);
  c.close();
});

// ----------------------------------------------------------- bulk review

test('proposals can be accepted in bulk above a confidence threshold', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.ingest({
    text:
      'We decided to keep the engine dependency-free. The team measured p99 latency at 38ms. ' +
      'It might not hold above ten million chunks. We agreed to defer the index work.',
    filename: 'notes.md',
  });

  const before = c.pending();
  assert.ok(before.length >= 3);

  const result = await c.reviewAll({ action: 'accept', minConfidence: 0.6 });
  assert.ok(result.succeeded.length > 0);
  assert.equal(result.failed.length, 0);

  // Not a count: accepting now enriches, and enrichment proposes keywords and
  // entities of its own, so the queue can legitimately be longer afterwards.
  // What must be true is that the ones taken are gone.
  const stillPending = new Set(c.pending().map((p) => p.id));
  const accepted = before.filter((p) => (p.confidence ?? 0) >= 0.6);
  assert.ok(accepted.length > 0, 'something met the threshold');
  for (const p of accepted) {
    assert.ok(!stillPending.has(p.id), `${p.id} was accepted and should be gone`);
  }
  c.close();
});

test('one stale proposal does not block the rest of a batch', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.ingest({
    text: 'We decided to ship on Friday. The load test passed at 2000 rps. The team agreed to freeze the branch.',
    filename: 'n.md',
  });

  const pending = c.pending();
  assert.ok(pending.length >= 2);

  // Invalidate one by hand, leaving the others fine.
  c.db.prepare(`UPDATE proposal SET payload = ? WHERE id = ?`).run(
    JSON.stringify({ title: '' }),
    pending[0].id
  );

  const result = await c.reviewAll({ action: 'accept', ids: pending.map((p) => p.id) });
  assert.equal(result.failed.length, 1, 'the broken one is reported');
  assert.ok(result.succeeded.length >= 1, 'the rest still go through');
  c.close();
});

test('bulk decline records each as a correction', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.ingest({
    text: 'We decided to ship on Friday. The load test passed at 2000 rps. The team agreed to freeze.',
    filename: 'n.md',
  });

  const result = await c.reviewAll({ action: 'reject', note: 'all wrong' });
  assert.ok(result.succeeded.length > 0);
  assert.equal(c.pending().length, 0);

  const corrections = c.history({ types: ['UserCorrectionRecorded'] });
  assert.ok(corrections.length >= result.succeeded.length);
  c.close();
});

test('stale proposals expire without being marked rejected', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await c.ingest({ text: 'We decided to defer the work until Q3 after review.', filename: 'n.md' });

  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  c.db.prepare(`UPDATE proposal SET created_at = ? WHERE status = 'pending'`).run(old);

  const { expired } = c.expireProposals({ olderThanDays: 90 });
  assert.ok(expired > 0);
  assert.equal(c.pending().length, 0);
  assert.equal(c.pending({ status: 'rejected' }).length, 0, 'expiring is not rejecting');
  assert.ok(c.pending({ status: 'expired' }).length > 0, 'and the distinction is kept');
  c.close();
});

test('accepting a proposal connects the object, not just indexes it', async (t) => {
  // Found by loading 460 real objects through a folder import and getting zero
  // entities out. `accept` indexed but never enriched, so everything arriving
  // by that route was searchable and joined to nothing — no entities, no
  // proposed relations, no contradictions noticed.
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const { proposal } = gateway.propose(
    c.db,
    {
      workspaceId: c.workspaceId,
      op: gateway.Op.CreateObject,
      confidence: 0.9,
      payload: {
        title: 'Priya Sharma approved the Atlas migration in Pune',
        kind: 'note',
        origin: 'source',
      },
    },
    { autoAccept: {} },
    c.actor
  );

  await c.accept(proposal.id);

  const entities = c.entities().map((e) => e.title).sort();
  assert.ok(entities.includes('Priya Sharma'), `person resolved, got ${entities.join(', ')}`);
  assert.ok(entities.includes('Atlas'), 'project resolved');
});

test('bulk accept can skip enrichment, because it is the slow half', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  for (const title of ['Priya Sharma in Pune', 'Ravi Kumar in Chennai']) {
    gateway.propose(
      c.db,
      {
        workspaceId: c.workspaceId,
        op: gateway.Op.CreateObject,
        confidence: 0.9,
        payload: { title, kind: 'note', origin: 'source' },
      },
      { autoAccept: {} },
      c.actor
    );
  }

  await c.reviewAll({ action: 'accept', enrich: false });
  assert.equal(c.entities().length, 0, 'opted out');

  // And the objects are still there and findable — skipping enrichment must
  // not skip the accept itself.
  const objects = c.db.prepare("SELECT COUNT(*) n FROM object WHERE kind != 'entity'").get();
  assert.equal(Number(objects.n), 2);
});
