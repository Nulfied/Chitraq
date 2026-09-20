/**
 * Concepts.
 *
 * The last entity kind, and the one with no surface to find it by. A person is
 * a capitalised run and a place is in a gazetteer, but "idempotency" and
 * "technical debt" look exactly like ordinary words, because they are.
 *
 * So the definition here is corpus-level: a concept is a phrase running through
 * several *separate* pieces of knowledge. What follows mostly tests that this
 * cannot be fooled — by one repetitive document, by grammar, by a name already
 * resolved as something else, or by the same idea stated at two lengths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { candidates, MIN_DOCUMENTS } from '../src/core/concepts.js';

/**
 * @param {Chitraq} c
 * @param {Array<[string, string]>} notes
 */
async function fill(c, notes) {
  for (const [title, body] of notes) await c.remember({ title, body, enrich: false });
}

test('a phrase running through several notes is a concept', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['Ladder', 'The answer ladder tries quoting first.'],
    ['Costs', 'Because of the answer ladder our spend dropped.'],
    ['Design', 'We chose an answer ladder over a cache alone.'],
    ['Unrelated', 'The office moved to a new floor.'],
  ]);

  const found = c.concepts();
  assert.equal(found[0].phrase, 'answer ladder');
  assert.equal(found[0].documents, 3);
  assert.match(found[0].because, /3 separate pieces of knowledge/);
});

test('one repetitive document is not a pattern', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  // Frequency is counted in documents, never occurrences. A transcript saying
  // "action item" forty times is one person talking, not an idea recurring.
  await fill(c, [
    ['Transcript', Array(40).fill('The action item was noted as an action item.').join(' ')],
    ['Other', 'Something entirely different happened.'],
    ['Another', 'And another unrelated thing.'],
    ['More', 'Nothing in common here either.'],
  ]);

  assert.deepEqual(c.concepts(), []);
});

test('too few notes to have a pattern says nothing rather than lowering the bar', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['One', 'The answer ladder is good.'],
    ['Two', 'The answer ladder is still good.'],
  ]);

  assert.equal(c.concepts().length, 0, `fewer than ${MIN_DOCUMENTS} documents`);
});

test('grammar is not a concept', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'We decided that it was going to be fine in the end.'],
    ['B', 'We decided that it was going to be fine again.'],
    ['C', 'We decided that it was going to be fine once more.'],
    ['D', 'We decided that it was going to be fine after all.'],
  ]);

  const phrases = c.concepts().map((k) => k.phrase);
  for (const fragment of ['we decided', 'going to', 'to be', 'it was', 'in the']) {
    assert.ok(!phrases.includes(fragment), `"${fragment}" is grammar, not an idea`);
  }
});

test('the same idea at two lengths becomes one concept', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'Structural cache invalidation removes the manual step.'],
    ['B', 'We rely on structural cache invalidation throughout.'],
    ['C', 'Structural cache invalidation is why nothing goes stale.'],
  ]);

  const phrases = c.concepts().map((k) => k.phrase);
  assert.ok(phrases.includes('structural cache invalidation'));
  // Keeping both would put two nodes in the graph for one idea — precisely
  // what entity resolution exists to prevent.
  assert.ok(!phrases.includes('structural cache'), 'the shorter form is subsumed');
  assert.ok(!phrases.includes('cache invalidation'));
});

test('a name already resolved as a person is not also a concept', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  // Enrichment on, so the person is actually resolved as an entity first —
  // which is the whole condition being tested.
  for (const [title, body] of [
    ['A', 'Priya Sharma approved the change.'],
    ['B', 'Priya Sharma reviewed the rollout.'],
    ['C', 'Priya Sharma signed off on it.'],
    ['D', 'Priya Sharma is on leave.'],
  ]) {
    await c.remember({ title, body });
  }
  assert.ok(
    c.entities().some((e) => e.title === 'Priya Sharma'),
    'resolved as a person'
  );

  const phrases = c.concepts().map((k) => k.phrase.toLowerCase());
  assert.ok(!phrases.includes('priya sharma'), 'already an entity of another kind');
});

test('confidence stays modest, because a statistic is not a legal suffix', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'The proposal gateway guards every write.'],
    ['B', 'Everything passes the proposal gateway first.'],
    ['C', 'The proposal gateway is the only doorway.'],
    ['D', 'Nothing bypasses the proposal gateway.'],
    ['E', 'The proposal gateway validates twice.'],
  ]);

  const [top] = c.concepts();
  assert.equal(top.phrase, 'proposal gateway');
  assert.ok(top.confidence > 0.4 && top.confidence < 0.8, `modest, got ${top.confidence}`);
});

test('proposing a concept writes nothing until a human accepts', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'The answer ladder tries quoting first.'],
    ['B', 'The answer ladder saved the budget.'],
    ['C', 'We kept the answer ladder in place.'],
  ]);

  const before = Number(
    c.db.prepare("SELECT COUNT(*) n FROM object WHERE kind = 'entity'").get().n
  );

  const result = c.proposeConcepts();
  assert.ok(result.proposals.length >= 1);
  assert.equal(result.proposals[0].status, 'pending', 'never applied on its own');

  const after = Number(
    c.db.prepare("SELECT COUNT(*) n FROM object WHERE kind = 'entity'").get().n
  );
  assert.equal(after, before, 'the graph is untouched until somebody says yes');

  // Accepting is the normal route, and it produces a normal entity.
  const accepted = await c.accept(result.proposals[0].id);
  assert.equal(accepted.applied.kind, 'object');
  const entity = c.recall(accepted.applied.id).object;
  assert.equal(entity.attrs.entityType, 'concept');
  assert.equal(entity.title, 'answer ladder');
});

test('a concept is suggested once, not every time it is looked for', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'The answer ladder tries quoting first.'],
    ['B', 'The answer ladder saved the budget.'],
    ['C', 'We kept the answer ladder in place.'],
  ]);

  const first = c.proposeConcepts();
  assert.ok(first.proposals.length >= 1);

  // Re-proposing what is already waiting is how a review queue becomes noise
  // nobody reads.
  const second = c.proposeConcepts();
  assert.equal(second.proposals.length, 0);
  assert.ok(second.found >= 1, 'still found, just not suggested again');
});

test('a declined concept stays declined', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'The answer ladder tries quoting first.'],
    ['B', 'The answer ladder saved the budget.'],
    ['C', 'We kept the answer ladder in place.'],
  ]);

  const proposed = c.proposeConcepts();
  await c.decline(proposed.proposals[0].id, 'not a thing I think in');

  assert.equal(c.proposeConcepts().proposals.length, 0, 'no means no');
});

test('candidates read only active, non-entity knowledge', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'The answer ladder tries quoting first.'],
    ['B', 'The answer ladder saved the budget.'],
    ['C', 'We kept the answer ladder in place.'],
  ]);
  assert.equal(candidates(c.db, { workspaceId: c.workspaceId }).length, 1);

  // Something archived is no longer part of what you think in.
  const all = c.db.prepare("SELECT id FROM object WHERE kind != 'entity'").all();
  for (const row of all) await c.forget(String(row.id));

  assert.deepEqual(candidates(c.db, { workspaceId: c.workspaceId }), []);
});

test('links and paths are not ideas', async (t) => {
  // On a real corpus the strongest "concept" was `https github com nulfied`
  // and the fourth was `editors tree-sitter-halka`: a URL tokenises into
  // ordinary-looking words, so a repeated link looks like a repeated idea.
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'See https://github.com/Nulfied/halka and run editors/tree-sitter/build.sh now.'],
    ['B', 'Again https://github.com/Nulfied/halka plus editors/tree-sitter/build.sh here.'],
    ['C', 'Once more https://github.com/Nulfied/halka with editors/tree-sitter/build.sh.'],
    ['D', 'And https://github.com/Nulfied/halka beside editors/tree-sitter/build.sh too.'],
  ]);

  for (const phrase of c.concepts().map((k) => k.phrase)) {
    assert.ok(!/github|https|tree-sitter|build/.test(phrase), `"${phrase}" is an address`);
  }
});

test('a table row is not a claim', async (t) => {
  // 22 of 460 objects in a real store were markdown table rows stored as
  // knowledge. They get embedded, retrieved, and turn adjacent cells into
  // "concepts" like "start end close true newline".
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const result = await c.ingest({
    text:
      'We measured latency carefully across the whole index.\n\n' +
      '| kernel | Halka | C | Python |\n|---|---|---|---|\n| fib | 153 ms | 141 ms | 9 s |\n\n' +
      'The result was a clear improvement for every workload.',
    filename: 'bench.md',
  });

  for (const p of result.proposals) {
    const payload = typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload;
    assert.ok(!/\|.*\|.*\|/.test(payload.title), `a table row became a claim: ${payload.title}`);
  }
  assert.ok(result.proposals.length >= 2, 'the real sentences were still captured');
});

test('configuration and code are not claims, so they are not concepts', async (t) => {
  // 23 of 437 stored claims on a real corpus were TOML, Lua or HTML comments
  // from fenced blocks in editor READMEs. Tokenised as prose they produced
  // the recurring "concept" `start end close true newline`, which came from
  // `brackets start = "(" end = ")" close = true newline = false`.
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const block = (i) =>
    `Editor ${i}\n\nbrackets start = "(" end = ")" close = true newline = false\n\n` +
    `[language-server.halka] command = "halka" args = ["lsp"]\n\n` +
    `local lspconfig = require("lspconfig")\n\n` +
    `Memory safety is a compiler guarantee in every one of these editors.\n\n`;

  for (let i = 0; i < 4; i++) {
    await c.ingest({ text: block(i), filename: `editor-${i}.md`, uri: `file:///e/${i}.md` });
  }

  for (const phrase of c.concepts().map((k) => k.phrase)) {
    assert.ok(
      !/start end|close true|newline|lspconfig|command args/.test(phrase),
      `"${phrase}" came out of a config block`
    );
  }

  // And the one real sentence in there still counts.
  const titles = c.pending().map((p) => {
    const payload = typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload;
    return payload.title ?? '';
  });
  assert.ok(titles.some((t2) => t2.includes('compiler guarantee')), 'the prose survived');
});

test('an adverb does not begin a concept', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  await fill(c, [
    ['A', 'Only narrow checks are run, and only narrow ones matter here.'],
    ['B', 'Only narrow checks again, because only narrow is the rule.'],
    ['C', 'We keep only narrow checks, only narrow and nothing more.'],
  ]);

  for (const phrase of c.concepts().map((k) => k.phrase)) {
    assert.ok(!phrase.startsWith('only '), `"${phrase}" is a fragment`);
  }
});
