/**
 * Ideas a model finds, and the check that keeps them honest.
 *
 * Recurrence finds phrases you repeat. That is shallow in a specific way:
 * a corpus where the same idea is said differently each time yields nothing,
 * and on a real corpus the strongest "concept" was once a URL, because a
 * repeated link tokenises into repeated words.
 *
 * A model can name the idea instead. The problem with letting it is that a
 * concept becomes a node in the graph, and a wrong one has to be found and
 * merged away by hand — so a model that invents a plausible-sounding theme
 * is worse than one that finds nothing.
 *
 * Hence the rule these tests are about: every proposal must name the notes
 * it came from, those numbers are resolved back to real object ids, and
 * anything citing a note that was not supplied is dropped. Grounding, the
 * same way answers are grounded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Chitraq } from '../src/chitraq.js';
import { groundedCapabilities } from '../src/intelligence/providers/grounded.js';

/**
 * A provider whose model returns exactly the concepts given.
 *
 * @param {any[]} concepts
 */
function modelProposing(concepts) {
  return {
    id: 'stub',
    label: 'Stub model',
    locality: /** @type {const} */ ('local'),
    cost: /** @type {const} */ ('free'),
    deterministic: false,
    available: async () => true,
    capabilities: groundedCapabilities({
      ask: async (/** @type {any} */ req) =>
        req.schema.properties.concepts ? { concepts } : { claims: [] },
    }),
  };
}

/** Three notes that share an idea without sharing a phrase. */
const NOTES = [
  'We chose SQLite because it needs no server to run.',
  'Zero dependencies is a hard constraint for this project.',
  'We rejected Redis to avoid another process to babysit.',
];

/**
 * @param {any[]} concepts
 * @returns {Promise<any>}
 */
async function workspace(concepts) {
  const c = new Chitraq({ path: ':memory:', providers: [modelProposing(concepts)] });
  // `enrich: false` and awaited, the same as the recurrence tests. Enrichment
  // is background work, and a test that closes the database while it is still
  // running fails on the close rather than on anything it meant to check.
  for (const title of NOTES) await c.remember({ title, enrich: false });
  return c;
}

/** @param {any} proposal */
const payloadOf = (proposal) => JSON.parse(proposal.payload);

test('a model names an idea the notes share without repeating a phrase', async (t) => {
  // The gap recurrence cannot close. These three notes have almost no words
  // in common and one clear idea between them.
  const c = await workspace([
    {
      phrase: 'operational simplicity',
      because: 'each choice removes a process to run',
      supports: [1, 2, 3],
      confidence: 0.9,
    },
  ]);
  t.after(() => c.close());

  const out = await c.proposeConcepts();
  assert.equal(out.proposals.length, 1);
  assert.equal(payloadOf(out.proposals[0]).attrs.canonicalName, 'operational simplicity');
});

test('a concept citing a note that was never supplied is dropped', async (t) => {
  // The failure that matters. A model naming a plausible theme and
  // attributing it to nothing is exactly the confident-wrong-answer shape,
  // and a concept is a graph node somebody has to clean up by hand.
  const c = await workspace([
    { phrase: 'real idea', because: 'from these notes', supports: [1, 2], confidence: 0.9 },
    { phrase: 'fabricated', because: 'cites note 99', supports: [99], confidence: 0.95 },
  ]);
  t.after(() => c.close());

  const out = await c.proposeConcepts();
  const names = out.proposals.map((/** @type {any} */ p) => payloadOf(p).attrs.canonicalName);
  assert.ok(names.includes('real idea'));
  assert.ok(!names.includes('fabricated'), 'the invented citation is not proposed');
});

test('an idea nobody wrote down twice is a remark, not a concept', async (t) => {
  const c = await workspace([
    { phrase: 'mentioned once', because: 'single note', supports: [1], confidence: 0.9 },
  ]);
  t.after(() => c.close());

  const out = await c.proposeConcepts();
  assert.equal(out.proposals.length, 0);
});

test('a model concept is rated below a repeated phrase', async (t) => {
  // Naming an idea is a suggestion about meaning. The same words appearing
  // in six separate notes is evidence. The confidence should say which is
  // which, because `--accept-above` is the control people actually use.
  const c = await workspace([
    { phrase: 'operational simplicity', because: 'x', supports: [1, 2, 3], confidence: 0.99 },
  ]);
  t.after(() => c.close());

  const out = await c.proposeConcepts();
  assert.ok(out.proposals[0].confidence <= 0.55, `capped, got ${out.proposals[0].confidence}`);
});

test('nothing is written until a person accepts, as with every other proposal', async (t) => {
  const c = await workspace([
    { phrase: 'operational simplicity', because: 'x', supports: [1, 2, 3], confidence: 0.9 },
  ]);
  t.after(() => c.close());

  await c.proposeConcepts();
  const found = await c.search('operational simplicity');
  const asEntity = found.results.filter(
    (/** @type {any} */ r) => r.object?.attrs?.entityType === 'concept'
  );
  assert.equal(asEntity.length, 0, 'the concept is proposed, not stored');
});

test('with no model configured, recurrence is still the whole story', async (t) => {
  // The floor must not change because a capability exists that nothing
  // serves. This is the ordinary install.
  const c = new Chitraq({ path: ':memory:', providers: [] });
  for (const title of NOTES) await c.remember({ title, enrich: false });
  t.after(() => c.close());

  const out = await c.proposeConcepts();
  assert.ok(Array.isArray(out.proposals), 'it runs and proposes whatever recurrence found');
});
