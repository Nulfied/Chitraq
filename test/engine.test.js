import test from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { embed, detectConflict, summarize, keywords, entities, claims } from '../src/intelligence/providers/deterministic.js';
import { chunk, estimateTokens, sentences } from '../src/core/text.js';
import { parse, toFtsQuery } from '../src/retrieval/query.js';

/** @returns {Chitraq} */
function engine() {
  return new Chitraq({ path: ':memory:' });
}

// ------------------------------------------------------------ text layer

test('chunking never splits mid-sentence and overlaps by one sentence', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} carries some content here.`).join(' ');
  const chunks = chunk(text, { maxTokens: 60 });

  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(c.text.trim().length > 0);
    assert.match(c.text.trim(), /[.!?]$/, 'every chunk ends on a sentence boundary');
  }
  const firstEnd = sentences(chunks[0].text).at(-1);
  assert.ok(chunks[1].text.startsWith(firstEnd), 'consecutive chunks share a sentence');
});

test('an over-long sentence is split rather than dropped', () => {
  const long = `${'word '.repeat(800)}.`;
  const chunks = chunk(long, { maxTokens: 100 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.reduce((n, c) => n + c.text.length, 0) > long.length * 0.8, 'content is preserved');
});

test('sentence splitting survives abbreviations', () => {
  const s = sentences('Dr. Rao met the team at 3 p.m. The result was clear. We shipped.');
  assert.equal(s.length, 3);
  assert.ok(s[0].startsWith('Dr. Rao'));
});

// ----------------------------------------------------------- query parse

test('query operators are parsed deterministically', () => {
  const intent = parse('kind:decision origin:ai "exact phrase" -draft budget after:2025-01-01');
  assert.deepEqual(intent.kinds, ['decision']);
  assert.deepEqual(intent.origins, ['ai']);
  assert.deepEqual(intent.phrases, ['exact phrase']);
  assert.ok(intent.exclude.includes('draft'));
  assert.ok(intent.terms.includes('budget'));
  assert.equal(intent.after, '2025-01-01T00:00:00.000Z');
});

test('a bare year resolves to the whole year', () => {
  const intent = parse('during:2024 retrospective');
  assert.equal(intent.after, '2024-01-01T00:00:00.000Z');
  assert.equal(intent.before, '2024-12-31T23:59:59.999Z');
});

test('unparseable dates produce no filter rather than a wrong one', () => {
  const intent = parse('after:someday notes');
  assert.equal(intent.after, null);
});

test('questions and browse queries are distinguished from lookups', () => {
  assert.equal(parse('why did we drop postgres').shape, 'question');
  assert.equal(parse('postgres migration').shape, 'lookup');
  assert.equal(parse('kind:decision').shape, 'browse');
});

test('terms are OR-ed so a near-miss still returns something', () => {
  const q = toFtsQuery(parse('memory engine'));
  assert.match(q, /OR/);
});

// ------------------------------------------------- deterministic provider

test('the deterministic embedding is stable, normalised and similarity-bearing', () => {
  const a = embed('the memory engine stores knowledge objects');
  const b = embed('the memory engine stores knowledge objects');
  assert.deepEqual(a, b, 'same input always gives the same vector');

  const magnitude = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-6, 'vectors are L2 normalised');

  const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  const related = embed('memory engines store knowledge');
  const unrelated = embed('the weather in Chennai was humid');
  assert.ok(cos(a, related) > cos(a, unrelated), 'related text scores above unrelated text');
});

test('typos and word endings stay close, thanks to character n-grams', () => {
  const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
  const base = embed('knowledge retrieval');

  const plural = cos(base, embed('knowledge retrievals'));
  const typo = cos(base, embed('knowlege retrieval'));
  const unrelated = cos(base, embed('the ficus needs watering'));

  assert.ok(cos(base, embed('knowledge retrieval')) > 0.99, 'identical text is identical');
  // A two-word phrase with one word altered keeps roughly two thirds of its
  // signal. What matters is the gap to unrelated text, which is what ranking uses.
  assert.ok(plural > 0.5, `plural stays close (got ${plural.toFixed(3)})`);
  assert.ok(typo > 0.5, `a typo stays close (got ${typo.toFixed(3)})`);
  assert.ok(plural - unrelated > 0.4, 'variants separate clearly from unrelated text');
});

test('extractive summary uses only the original sentences', () => {
  const text =
    'The migration finished on Tuesday. Everyone was relieved. ' +
    'The migration removed the last Oracle dependency, which was the point. ' +
    'Lunch was fine. The migration cut the nightly batch from six hours to forty minutes.';
  const summary = summarize(text, 2);
  for (const s of sentences(summary)) {
    assert.ok(text.includes(s), `"${s}" must appear verbatim in the source`);
  }
});

test('entity extraction is confident about structure and hedged about names', () => {
  const found = entities('Email priya@example.com about the ₹45,000 invoice dated 2025-03-14, ticket OPS-412.');
  const byType = Object.fromEntries(found.map((e) => [e.type, e]));

  assert.equal(byType.email.text, 'priya@example.com');
  assert.equal(byType.date.text, '2025-03-14');
  assert.equal(byType.identifier.text, 'OPS-412');
  assert.ok(byType.email.confidence > 0.9);
  assert.ok(found.filter((e) => e.type === 'name').every((e) => e.confidence < 0.7), 'names are hedged');
});

test('claims carry a kind and epistemic status taken from surface cues', () => {
  const found = claims(
    'We decided to use SQLite for the store. It might be slow above ten million rows. The benchmark showed 40ms at p99.'
  );
  assert.equal(found.find((c) => /decided/.test(c.text)).kind, 'decision');
  assert.equal(found.find((c) => /might/.test(c.text)).epistemic, 'hypothesis');
  assert.equal(found.find((c) => /benchmark/.test(c.text)).epistemic, 'observation');
});

test('contradiction detection fires on conflicting numbers, not on unrelated text', () => {
  const same = detectConflict(
    { title: 'Nightly batch runtime', body: 'The nightly batch takes 40 minutes to complete.' },
    { title: 'Nightly batch runtime', body: 'The nightly batch takes 95 minutes to complete.' }
  );
  assert.equal(same.contradicts, true);
  assert.ok(same.confidence > 0 && same.confidence <= 1);

  const different = detectConflict(
    { title: 'Batch runtime', body: 'The nightly batch takes 40 minutes.' },
    { title: 'Office plants', body: 'The ficus needs watering twice a week.' }
  );
  assert.equal(different.contradicts, false);
});

test('negation contradiction requires high overlap', () => {
  const hit = detectConflict(
    { title: 'Postgres', body: 'The service depends on the postgres cluster for session storage.' },
    { title: 'Postgres', body: 'The service does not depend on the postgres cluster for session storage.' }
  );
  assert.equal(hit.contradicts, true);
});

// --------------------------------------------------------- the full loop

test('remember -> search -> recall works with no AI configured', async () => {
  const c = engine();
  const { object } = await c.remember({
    title: 'Chose SQLite for the memory store',
    body: 'We chose SQLite because it needs no server and ships inside Node. The alternative was Postgres.',
    kind: 'decision',
  });

  const found = await c.search('sqlite memory store');
  assert.ok(found.results.some((r) => r.id === object.id));
  assert.ok(found.signals.includes('lexical'));
  assert.ok(found.signals.includes('semantic'), 'the deterministic embedder provides a semantic signal');

  const recalled = c.recall(object.id);
  assert.equal(recalled.object.title, 'Chose SQLite for the memory store');

  // Two versions, not one: the capture, then the keywords and entities that
  // enrichment derived from its own text. Writing those is a mutation, so it
  // appends a version like any other — the alternative was leaving them
  // queued, which put 920 review items in front of a person on a corpus of
  // 460 and buried the proposals that actually needed a decision.
  assert.equal(recalled.history.length, 2);
  assert.equal(recalled.provenance[0].method, 'user', 'the capture is still yours');
  assert.ok(recalled.object.attrs?.keywords?.length, 'and the derived attributes landed');
  c.close();
});

test('search results explain why they ranked where they did', async () => {
  const c = engine();
  await c.remember({ title: 'Deployment runbook', body: 'Deploy with the blue-green script.' });
  const found = await c.search('deployment');

  const hit = found.results[0];
  assert.ok(hit.why.lexical, 'lexical contribution is reported');
  assert.ok(hit.why.quality.because.length, 'quality adjustments are explained');
  assert.ok(typeof hit.why.recency.ageDays === 'number');
  c.close();
});

test('confirmed knowledge outranks unreviewed AI-derived knowledge', async () => {
  const c = engine();
  const mine = await c.remember({
    title: 'Renewal date is 14 March',
    body: 'The contract renewal date is 14 March.',
    enrich: false,
  });
  const guess = await c.remember({
    title: 'Renewal date is 14 March',
    body: 'The contract renewal date is 14 March.',
    origin: 'ai',
    epistemic: 'inference',
    confidence: 0.5,
    enrich: false,
  });
  c.confirm(mine.object.id);

  const found = await c.search('contract renewal date');
  const rank = found.results.map((r) => r.id);
  assert.ok(rank.indexOf(mine.object.id) < rank.indexOf(guess.object.id));
  c.close();
});

test('ask answers from memory with citations, and admits when it cannot', async () => {
  const c = engine();
  await c.remember({
    title: 'Why we dropped the Redis cache',
    body: 'We dropped the Redis cache because the hit rate never exceeded 12 percent and it added an operational dependency.',
    kind: 'decision',
  });

  const answered = await c.ask('why did we drop the redis cache');
  assert.equal(answered.grounded, true);
  assert.ok(answered.citations.length > 0, 'a grounded answer cites its sources');
  assert.match(answered.answer, /hit rate/);
  assert.ok(answered.uncertainty, 'the method and its limits are always stated');

  const blank = await c.ask('what is the capital of Peru');
  assert.equal(blank.grounded, false);
  assert.equal(blank.answer, null, 'no invented recall');
  c.close();
});

test('context construction stays inside its budget and justifies every item', async () => {
  const c = engine();
  for (let i = 0; i < 12; i++) {
    await c.remember({
      title: `Sprint ${i} retrospective`,
      body: `In sprint ${i} the team discussed deployment friction and testing gaps. `.repeat(20),
      enrich: false,
    });
  }

  const ctx = c.constructor === Chitraq ? await c.ask('deployment friction', { budget: 900 }) : null;
  assert.ok(ctx.context.usedTokens <= 900, 'the budget is respected');
  assert.ok(ctx.context.items.length > 0);
  for (const item of ctx.context.items) {
    assert.ok(item.reason && item.reason.length > 0, 'every item states why it is present');
  }
  assert.ok(ctx.context.coverage.droppedForBudget >= 0);
  c.close();
});

test('related material is pulled into context with the relationship named', async () => {
  const c = engine();
  const a = await c.remember({ title: 'Payment gateway outage', body: 'The payment gateway went down for 40 minutes.', enrich: false });
  const b = await c.remember({ title: 'Retry storm in checkout', body: 'Checkout retried aggressively and amplified load.', enrich: false });
  c.connect(b.object.id, 'caused_by', a.object.id);

  const answered = await c.ask('payment gateway outage');
  const pulled = answered.context.items.find((i) => i.id === b.object.id);
  assert.ok(pulled, 'the connected object is included');
  assert.match(
    pulled.reason,
    /caused by/i,
    'the reason reads from the included object\'s point of view, not the seed\'s'
  );
  c.close();
});

// ------------------------------------------------------- the AI boundary

test('ingestion produces proposals, not silent writes', async () => {
  const c = engine();
  const result = await c.ingest({
    text:
      '# Architecture review\n\nWe decided to keep the memory engine dependency-free. ' +
      'The team measured 40ms at p99 for search. It might not hold above ten million chunks.',
    filename: 'review.md',
  });

  assert.ok(result.source.id);
  assert.ok(result.proposals.length >= 2);
  assert.ok(result.proposals.every((p) => p.status === 'pending'), 'nothing was written without review');
  assert.equal(c.stats().objects, 0, 'memory is untouched until a human accepts');

  const first = c.pending()[0];
  const accepted = await c.accept(first.id, 'looks right');
  assert.equal(accepted.applied.kind, 'object');
  assert.equal(c.stats().objects, 1);
  c.close();
});

test('an accepted proposal carries its full provenance forever', async () => {
  const c = engine();
  await c.ingest({ text: 'We decided to ship the beta on Friday after the load test passed.', filename: 'n.md' });
  const proposal = c.pending()[0];
  const { applied } = await c.accept(proposal.id);

  const recalled = c.recall(applied.id);
  const prov = recalled.provenance[0];
  assert.match(prov.method, /^capability:/);
  assert.equal(prov.provider, 'builtin');
  assert.ok(prov.run_id, 'the exact capability run is recorded');
  assert.equal(recalled.object.origin, 'source', 'the object knows it came from a document');
  assert.ok(recalled.evidence.length > 0, 'the supporting excerpt is attached');
  c.close();
});

test('a proposal cannot rewrite knowledge a human wrote and confirmed', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Launch is 1 May', enrich: false });
  c.confirm(object.id);

  const gateway = await import('../src/intelligence/gateway.js');
  const { proposal } = gateway.propose(c.db, {
    workspaceId: c.workspaceId,
    op: 'update_object',
    confidence: 0.95,
    payload: { objectId: object.id, patch: { title: 'Launch is 1 June' } },
  });

  assert.equal(proposal.status, 'invalid');
  assert.match(proposal.invalid_why, /confirmed by a human/);
  assert.equal(c.recall(object.id).object.title, 'Launch is 1 May');
  c.close();
});

test('a proposal cannot touch fields that are not its business', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'A note', enrich: false });
  const gateway = await import('../src/intelligence/gateway.js');

  for (const field of ['origin', 'review', 'state', 'confidence']) {
    const { proposal } = gateway.propose(c.db, {
      workspaceId: c.workspaceId,
      op: 'update_object',
      confidence: 0.9,
      payload: { objectId: object.id, patch: { [field]: 'user' } },
    });
    assert.equal(proposal.status, 'invalid', `${field} must not be proposable`);
    assert.match(proposal.invalid_why, /cannot be changed/);
  }
  c.close();
});

test('a proposal may not claim to be human-authored', async () => {
  const c = engine();
  const gateway = await import('../src/intelligence/gateway.js');
  const { proposal } = gateway.propose(c.db, {
    workspaceId: c.workspaceId,
    op: 'create_object',
    confidence: 0.9,
    payload: { title: 'Pretending to be you', origin: 'user' },
  });
  assert.equal(proposal.status, 'invalid');
  assert.match(proposal.invalid_why, /may not claim user origin/);
  c.close();
});

test('a proposal that went stale is refused at accept time', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Target', enrich: false });
  const gateway = await import('../src/intelligence/gateway.js');

  const { proposal } = gateway.propose(c.db, {
    workspaceId: c.workspaceId,
    op: 'update_object',
    confidence: 0.8,
    payload: { objectId: object.id, patch: { body: 'new text' } },
  });
  assert.equal(proposal.status, 'pending');

  c.confirm(object.id); // memory changed underneath the proposal

  await assert.rejects(() => c.accept(proposal.id), /no longer valid/);
  assert.equal(gateway.get(c.db, proposal.id).status, 'invalid');
  c.close();
});

test('declining a proposal keeps it and records the correction', async () => {
  const c = engine();
  await c.ingest({ text: 'The build takes nine minutes on the new runners.', filename: 'n.txt' });
  const proposal = c.pending()[0];
  c.decline(proposal.id, 'wrong, that was the old runners');

  const declined = c.pending({ status: 'rejected' });
  assert.equal(declined.length, 1);
  assert.equal(declined[0].review_note, 'wrong, that was the old runners');

  const corrections = c.history({ types: ['UserCorrectionRecorded'] });
  assert.equal(corrections.length, 1);
  c.close();
});

// -------------------------------------------------- evolution over time

test('correcting knowledge preserves what it used to say', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Headcount is 40', body: 'We have 40 people.', enrich: false });
  await c.correct(object.id, { body: 'We have 46 people.' }, 'hired six in March');

  const recalled = c.recall(object.id);
  assert.equal(recalled.object.body, 'We have 46 people.');
  assert.equal(recalled.history.length, 2);
  assert.equal(recalled.history[0].body, 'We have 40 people.');
  assert.equal(recalled.history[1].change_reason, 'hired six in March');
  c.close();
});

test('superseding keeps both versions findable and ranks the current one higher', async () => {
  const c = engine();
  const first = await c.remember({
    title: 'Pricing is 20 dollars per seat',
    body: 'Pricing is 20 dollars per seat per month.',
    enrich: false,
  });
  await c.supersede(
    first.object.id,
    { title: 'Pricing is 28 dollars per seat', body: 'Pricing is 28 dollars per seat per month.' },
    'price rise in April'
  );

  const found = await c.search('pricing per seat', { includeArchived: true });
  const ids = found.results.map((r) => r.id);
  assert.ok(ids.includes(first.object.id), 'the old price is still findable');
  assert.ok(ids.indexOf(first.object.id) > 0, 'but the current one ranks above it');

  const old = c.recall(first.object.id);
  assert.equal(old.object.state, 'superseded');
  assert.ok(old.object.superseded_by);
  c.close();
});

test('contradictions between similar statements are detected and surfaced', async () => {
  const c = engine();
  await c.remember({
    title: 'Nightly batch runtime',
    body: 'The nightly batch job takes 40 minutes to finish on the new hardware.',
  });
  await c.remember({
    title: 'Nightly batch runtime',
    body: 'The nightly batch job takes 95 minutes to finish on the new hardware.',
  });

  const open = c.conflicts({ status: 'open' });
  assert.ok(open.length >= 1, 'the disagreement is recorded');
  assert.equal(open[0].kind, 'contradiction');
  assert.ok(open[0].detail.reason);

  const answered = await c.ask('how long does the nightly batch take');
  assert.ok(answered.conflicts.length > 0, 'the answer cannot hide the disagreement');
  c.close();
});

test('an answer never silently drops the other side of a conflict', async () => {
  const c = engine();
  const a = await c.remember({ title: 'Churn rate', body: 'Monthly churn is 3 percent across all plans.' });
  const b = await c.remember({ title: 'Churn rate', body: 'Monthly churn is 7 percent across all plans.' });

  const answered = await c.ask('what is monthly churn');
  const ids = answered.context.items.map((i) => i.id);
  assert.ok(ids.includes(a.object.id) && ids.includes(b.object.id), 'both figures reach the context');
  c.close();
});

// ------------------------------------------------------------ resilience

test('memory survives a total intelligence failure', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Durable knowledge', body: 'This must survive.' });

  // Remove every provider: no embeddings, no extraction, no answers.
  c.registry.unregister('builtin');
  c.registry.resetHealth();

  assert.equal(c.recall(object.id).object.title, 'Durable knowledge');
  const found = await c.search('durable knowledge');
  assert.ok(found.results.some((r) => r.id === object.id), 'lexical search still answers');
  assert.ok(!found.signals.includes('semantic'), 'the semantic signal is simply absent');

  const stillWorks = await c.remember({ title: 'Captured with nothing available', enrich: false });
  assert.ok(stillWorks.object.id, 'capture still succeeds');

  const answered = await c.ask('durable knowledge');
  assert.equal(answered.answer, null);
  assert.ok(answered.context.items.length > 0, 'context is still assembled deterministically');
  c.close();
});

test('a failing provider is skipped and the fallback answers', async () => {
  const c = engine();
  c.addProvider({
    id: 'flaky',
    label: 'Flaky test provider',
    locality: 'local',
    cost: 'free',
    capabilities: {
      'embed.text': {
        quality: 0.99,
        latencyMs: 1,
        run: async () => {
          throw new Error('provider exploded');
        },
      },
    },
  });

  const { object } = await c.remember({ title: 'Still indexed', body: 'Despite the flaky provider.' });
  const found = await c.search('flaky provider');
  assert.ok(found.results.some((r) => r.id === object.id));

  const failures = c.intelligenceLog({ status: 'error' });
  assert.ok(failures.some((f) => f.provider === 'flaky'), 'the failure is recorded, not hidden');
  c.close();
});

test('remote and paid providers are off unless switched on', async () => {
  const c = engine();
  c.addProvider({
    id: 'cloud',
    label: 'Cloud model',
    locality: 'remote',
    cost: 'paid',
    capabilities: { answer: { quality: 0.95, latencyMs: 800, costMicros: 500, run: async () => ({ answer: 'x' }) } },
  });

  const { eligible, rejected } = await c.router.candidates('answer');
  assert.ok(!eligible.some((p) => p.id === 'cloud'));
  assert.match(rejected.find((r) => r.id === 'cloud').why, /remote calls are switched off/);

  c.setPolicy({ allowRemote: true, allowPaid: true, maxCostMicros: 1000 });
  const after = await c.router.candidates('answer');
  assert.ok(after.eligible.some((p) => p.id === 'cloud'), 'it becomes available once permitted');
  c.close();
});

test('every intelligence call is recorded with its provider and outcome', async () => {
  const c = engine();
  await c.remember({ title: 'Audited', body: 'Some text to enrich.' });

  const log = c.intelligenceLog({ limit: 100 });
  assert.ok(log.length > 0);
  assert.ok(log.every((r) => r.provider && r.capability && r.status));
  assert.ok(log.some((r) => r.capability === 'embed.text'));
  c.close();
});

// ------------------------------------------------------------- integrity

test('the index is fully rebuildable from the objects', async () => {
  const c = engine();
  for (let i = 0; i < 5; i++) {
    await c.remember({ title: `Note ${i}`, body: `Content about topic ${i} and shared vocabulary.`, enrich: false });
  }
  const before = c.stats();

  c.db.exec('DELETE FROM chunk_fts; DELETE FROM embedding; DELETE FROM chunk; DELETE FROM term_stat;');
  assert.equal(c.stats().chunks, 0);

  await c.reindex();
  const after = c.stats();
  assert.equal(after.chunks, before.chunks);
  assert.equal(after.embeddings, before.embeddings);

  const found = await c.search('shared vocabulary');
  assert.ok(found.results.length > 0, 'retrieval is restored');
  c.close();
});

test('export carries the knowledge, its history and its provenance', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Portable', body: 'Memory you can take with you.', enrich: false });
  await c.correct(object.id, { body: 'Memory you can take anywhere.' }, 'clearer wording');

  const dump = c.export();
  assert.equal(dump.format, 'chitraq/v1');
  assert.equal(dump.objects.length, 1);
  assert.equal(dump.versions.length, 2, 'history travels with the export');
  assert.ok(dump.derivations.length > 0, 'so does provenance');
  assert.ok(dump.events.length > 0);
  c.close();
});

test('erasing requires a reason and leaves an auditable trace', async () => {
  const c = engine();
  const { object } = await c.remember({ title: 'Delete me', enrich: false });

  assert.throws(() => c.erase(object.id, ''), /requires a stated reason/);
  c.erase(object.id, 'user requested erasure');

  assert.equal(c.recall(object.id), null);
  const trace = c.history({ types: ['KnowledgeDeleted'] });
  assert.equal(trace[0].payload.purged, true);
  assert.equal(trace[0].payload.reason, 'user requested erasure');
  c.close();
});

test('capability coverage reports honestly when only the floor is answering', async () => {
  const c = engine();
  const { coverage } = await c.capabilities();

  assert.equal(coverage['embed.text'].best, 'builtin');
  assert.equal(coverage['embed.text'].degraded, true, 'running on the deterministic floor is reported as degraded');
  assert.ok(coverage['answer'].providers.includes('builtin'));
  c.close();
});
