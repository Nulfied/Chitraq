/**
 * The remote path, tested without spending anything.
 *
 * Chitraq's cloud intelligence was one adapter for one paid vendor, and it
 * had never been run. Not carelessly — an Anthropic key costs money the
 * author does not have — but the effect was the same: the prompts, the
 * schemas and every line that turns a model's reply into a proposal were
 * shipped unexecuted.
 *
 * Splitting `grounded.js` out changed what that means. These tests drive a
 * stub `fetch`, so they cost nothing and need no network, and what they
 * exercise is the shared file: the same prompts, the same schemas, the same
 * parsing the Claude adapter uses. What stays untested is the Anthropic
 * request construction, which is forty lines rather than four hundred.
 *
 * The stub is deliberately unhelpful in places — returning fenced JSON,
 * refusing json_schema, returning prose — because a provider that behaves
 * perfectly is not the one that finds bugs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openAiCompatibleProvider, PRESETS, PRESET_NAMES } from '../src/intelligence/providers/openai-compatible.js';
import { Capability } from '../src/intelligence/registry.js';

/**
 * A fetch that replies with whatever the case needs, and records the calls.
 *
 * @param {Array<{status?: number, body?: any, text?: string}>} replies
 */
function stubFetch(replies) {
  /** @type {any[]} */
  const calls = [];
  let at = 0;

  /** @type {any} */
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const reply = replies[Math.min(at++, replies.length - 1)];
    const status = reply.status ?? 200;
    const text =
      reply.text ??
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply.body) } }] });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  fn.calls = calls;
  return fn;
}

/** @param {any} fetchImpl */
const provider = (fetchImpl, opts = {}) =>
  openAiCompatibleProvider({ preset: 'groq', apiKey: 'k-not-real', fetch: fetchImpl, ...opts });

test('a grounded answer comes back with its citations intact', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        grounded: true,
        answer: 'Because SQLite needs no server.',
        citations: ['obj_01', 'obj_02'],
        uncertainty: null,
      },
    },
  ]);
  const p = provider(fetchImpl);

  const out = await p.capabilities[Capability.Answer].run({
    question: 'why sqlite',
    rendered: '[obj_01] Chose SQLite.',
  });

  assert.equal(out.grounded, true);
  assert.equal(out.answer, 'Because SQLite needs no server.');
  assert.deepEqual(out.citations, ['obj_01', 'obj_02']);
  assert.match(out.method, /grounded in supplied memory/);

  // The request itself: right endpoint, right auth, schema-constrained.
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(call.init.headers.authorization, 'Bearer k-not-real');
  assert.equal(call.body.response_format.type, 'json_schema');
  assert.equal(call.body.model, PRESETS.groq.model);
});

test('an ungrounded answer returns null rather than the model\'s guess', async () => {
  // The single most important behaviour here. When memory does not contain
  // the answer, the model still writes something — and that something must
  // not reach the user as though it came from their own notes.
  const fetchImpl = stubFetch([
    {
      body: {
        grounded: false,
        answer: 'Redis is generally dropped for cost reasons.',
        citations: [],
        uncertainty: 'Memory holds nothing about Redis.',
      },
    },
  ]);

  const out = await provider(fetchImpl).capabilities[Capability.Answer].run({
    question: 'why did we drop redis',
    rendered: '',
  });

  assert.equal(out.grounded, false);
  assert.equal(out.answer, null, 'the guess is discarded, not passed through');
  assert.match(out.uncertainty, /nothing about Redis/);
});

test('confidence outside 0..1 is clamped rather than trusted', async () => {
  const fetchImpl = stubFetch([
    {
      body: {
        claims: [
          { text: 'A', kind: 'fact', epistemic: 'fact', confidence: 4 },
          { text: 'B', kind: 'note', epistemic: 'belief', confidence: -2 },
          { text: 'C', kind: 'note', epistemic: 'belief', confidence: 'nonsense' },
        ],
      },
    },
  ]);

  const out = await provider(fetchImpl).capabilities[Capability.ExtractClaims].run({ text: 'x' });
  assert.deepEqual(
    out.claims.map((/** @type {any} */ c) => c.confidence),
    [1, 0, null]
  );
});

test('the claim limit is enforced here, not hoped for in the prompt', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({
    text: `claim ${i}`,
    kind: 'note',
    epistemic: 'observation',
    confidence: 0.5,
  }));
  const fetchImpl = stubFetch([{ body: { claims: many } }]);

  const out = await provider(fetchImpl).capabilities[Capability.ExtractClaims].run({
    text: 'x',
    limit: 5,
  });
  assert.equal(out.claims.length, 5);
});

test('a host that refuses json_schema is retried once in the weaker mode', async () => {
  const fetchImpl = stubFetch([
    { status: 400, text: 'response_format json_schema is not supported by this model' },
    { body: { summary: 'It works.', faithful: true } },
  ]);
  const p = provider(fetchImpl);

  const out = await p.capabilities[Capability.Summarize].run({ text: 'long text' });
  assert.equal(out.summary, 'It works.');
  assert.equal(fetchImpl.calls.length, 2);

  assert.equal(fetchImpl.calls[0].body.response_format.type, 'json_schema');
  assert.equal(fetchImpl.calls[1].body.response_format.type, 'json_object');
  // The downgrade has to carry the schema somewhere, or the model has no
  // idea what shape to produce.
  assert.match(fetchImpl.calls[1].body.messages[0].content, /schema exactly/);
  assert.match(fetchImpl.calls[1].body.messages[0].content, /faithful/);
});

test('once downgraded, it stays downgraded instead of paying the cost every call', async () => {
  const fetchImpl = stubFetch([
    { status: 400, text: 'json_schema not supported' },
    { body: { summary: 'one', faithful: true } },
    { body: { summary: 'two', faithful: true } },
  ]);
  const p = provider(fetchImpl);

  await p.capabilities[Capability.Summarize].run({ text: 'a' });
  await p.capabilities[Capability.Summarize].run({ text: 'b' });

  assert.equal(fetchImpl.calls.length, 3, 'one failure, then two successes — not two failures');
  assert.equal(fetchImpl.calls[2].body.response_format.type, 'json_object');
});

test('a bad key fails once and says so, rather than being retried', async () => {
  // Retrying an auth failure in a weaker mode wastes a round trip and then
  // reports the weaker mode's error, which is further from the real problem.
  const fetchImpl = stubFetch([{ status: 401, text: 'Invalid API key' }]);

  await assert.rejects(
    () => provider(fetchImpl).capabilities[Capability.Summarize].run({ text: 'x' }),
    /401|Invalid API key/
  );
  assert.equal(fetchImpl.calls.length, 1, 'no retry');
});

test('JSON wrapped in a code fence is still JSON', async () => {
  const fetchImpl = stubFetch([
    {
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: '```json\n{"expansions":["sqlite","embedded database"]}\n```',
            },
          },
        ],
      }),
    },
  ]);

  const out = await provider(fetchImpl).capabilities[Capability.InterpretQuery].run({
    query: 'sqlite',
  });
  assert.deepEqual(out.expansions, ['sqlite', 'embedded database']);
});

test('prose where JSON was asked for is an error, not an empty result', async () => {
  // Returning {} here would look like "the model found nothing", which is a
  // different and much quieter kind of wrong.
  const fetchImpl = stubFetch([
    {
      text: JSON.stringify({
        choices: [{ message: { content: 'Sure! Here are the relations you asked for.' } }],
      }),
    },
  ]);

  await assert.rejects(
    () => provider(fetchImpl).capabilities[Capability.ProposeRelations].run({ a: {}, b: {} }),
    /not valid JSON/
  );
});

test('an unreachable host says which host, not just that something failed', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(
    () => provider(fetchImpl).capabilities[Capability.Summarize].run({ text: 'x' }),
    /Groq could not be reached/
  );
});

test('a local server is local and free; a hosted one is neither by default', async () => {
  // This decides which policy gate applies, so getting it wrong either
  // blocks a local model behind an allow-remote flag or lets a paid API
  // through without one.
  const local = openAiCompatibleProvider({ preset: 'local' });
  assert.equal(local.locality, 'local');
  assert.equal(local.cost, 'free');
  assert.equal(await local.available(), true, 'a local server needs no key');

  const hosted = openAiCompatibleProvider({ preset: 'openai' });
  assert.equal(hosted.locality, 'remote');
  assert.equal(hosted.cost, 'paid');
  assert.equal(await hosted.available(), false, 'no key, so not available');
});

test('a free tier is remote but not paid, so it needs one gate and not the other', async () => {
  const groq = openAiCompatibleProvider({ preset: 'groq', apiKey: 'k' });
  assert.equal(groq.locality, 'remote');
  assert.equal(groq.cost, 'free');
  assert.equal(await groq.available(), true);
});

test('a custom base URL works without any preset', async () => {
  const fetchImpl = stubFetch([{ body: { summary: 's', faithful: true } }]);
  const p = openAiCompatibleProvider({
    baseUrl: 'https://example.invalid/v1/',
    model: 'my-model',
    apiKey: 'k',
    fetch: fetchImpl,
  });

  await p.capabilities[Capability.Summarize].run({ text: 'x' });
  // The trailing slash must not produce a double slash in the path.
  assert.equal(fetchImpl.calls[0].url, 'https://example.invalid/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].body.model, 'my-model');
});

test('every preset is usable and declares what the router needs', () => {
  for (const name of PRESET_NAMES) {
    const p = openAiCompatibleProvider({ preset: name, apiKey: 'k' });
    assert.ok(p.id.includes(name), `${name}: id`);
    assert.match(p.locality, /^(local|remote)$/, `${name}: locality`);
    assert.match(p.cost, /^(free|paid)$/, `${name}: cost`);
    assert.ok(p.model, `${name}: a default model`);
    assert.ok(PRESETS[name].baseUrl.startsWith('http'), `${name}: base URL`);

    for (const capability of ['answer', 'extract.claims', 'summarize', 'detect.conflict', 'relate.propose', 'interpret.query']) {
      assert.ok(p.capabilities[capability], `${name}: serves ${capability}`);
    }

    // Embeddings only where the host actually has a model for them. A
    // provider that advertises the capability and then fails on the first
    // document is worse than one that never claimed it: the router already
    // ranked it above the floor it would have to fall back to.
    assert.equal(
      Boolean(p.capabilities['embed.text']),
      Boolean(PRESETS[name].embedModel),
      `${name}: embeddings declared only when served`
    );
  }
});

test('embeddings come back aligned to the texts that produced them', async () => {
  // Hosts return the rows with an `index` field and are not obliged to keep
  // them in order. Trusting position would pair every vector with the wrong
  // text — which is not an error anywhere, just permanently worse search.
  // `text` rather than `body`: the stub's default wraps a body in the chat
  // `choices` envelope, and an embeddings reply is not that shape.
  const fetchImpl = stubFetch([
    {
      text: JSON.stringify({
        data: [
          { index: 2, embedding: [0.3, 0.3] },
          { index: 0, embedding: [0.1, 0.1] },
          { index: 1, embedding: [0.2, 0.2] },
        ],
      }),
    },
  ]);
  const p = openAiCompatibleProvider({ preset: 'gemini', apiKey: 'k', fetch: fetchImpl });

  const out = await p.capabilities['embed.text'].run({ texts: ['first', 'second', 'third'] });
  assert.deepEqual(out.vectors, [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]);
  assert.equal(out.dim, 2);
  assert.match(out.model, /text-embedding/);

  assert.equal(fetchImpl.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings');
  assert.deepEqual(fetchImpl.calls[0].body.input, ['first', 'second', 'third']);
});

test('a short embedding response is an error, not a silent misalignment', async () => {
  // Returning fewer vectors than texts would otherwise leave later chunks
  // paired with earlier vectors, or undefined.
  const fetchImpl = stubFetch([
    { text: JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }) },
  ]);
  const p = openAiCompatibleProvider({ preset: 'gemini', apiKey: 'k', fetch: fetchImpl });

  await assert.rejects(
    () => p.capabilities['embed.text'].run({ texts: ['a', 'b', 'c'] }),
    /1 embeddings for 3 texts/
  );
});

test('a free-tier embedder is free and remote, so it needs one gate only', () => {
  const gemini = openAiCompatibleProvider({ preset: 'gemini', apiKey: 'k' });
  assert.equal(gemini.capabilities['embed.text'].costMicros, 0);
  assert.equal(gemini.cost, 'free');
  assert.equal(gemini.locality, 'remote');
});
