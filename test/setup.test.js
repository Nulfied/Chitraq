/**
 * Setup, and the check that makes a stored key mean something.
 *
 * The reason this exists is narrow. Chitraq's remote intelligence had never
 * been run: a key costs money, so the Claude adapter shipped unexecuted and
 * said so in STATUS.md. The repair is not to keep apologising in a document.
 * It is to make the moment somebody supplies a key the moment that path gets
 * exercised — a real call, with their credential, before anything is stored.
 *
 * That turns "unverified forever" into "verified by whoever uses it, on
 * first run, with a result they can see". These tests cover the deciding
 * behaviour: a key that does not work is never stored, and a key that does
 * is reported with what the model actually said.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { choices, probeOllama, verifyKey } from '../src/cli/setup.js';
import { Chitraq } from '../src/chitraq.js';

/** @param {{status?: number, body?: any, throws?: string}} reply */
function stubFetch(reply) {
  /** @type {any} */
  const fn = async () => {
    if (reply.throws) throw new Error(reply.throws);
    const status = reply.status ?? 200;
    const text = JSON.stringify(reply.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return fn;
}

/** A provider reply shaped the way the OpenAI protocol shapes one. */
const summarised = (summary) => ({
  choices: [{ message: { content: JSON.stringify({ summary, faithful: true }) } }],
});

test('the free options come first, and Claude comes last', () => {
  // Ordering is the whole argument of this menu. The person most helped by
  // it cannot spend money, so what they can actually use has to be at the
  // top, and the best-but-paid option must not be the first thing offered.
  const list = choices();
  const firstPaid = list.findIndex((c) => c.cost === 'paid');
  const lastFree = list.map((c) => c.cost).lastIndexOf('free');

  assert.ok(firstPaid > 0, 'something free is offered before anything paid');
  assert.ok(lastFree < firstPaid, 'free and paid are not interleaved');
  assert.equal(list.at(-1)?.name, 'anthropic');
});

test('every option can name where to get a key, or needs none', () => {
  for (const choice of choices()) {
    if (choice.name === 'local') {
      assert.equal(choice.keyUrl, null, 'a local server needs no key');
      continue;
    }
    assert.match(choice.keyUrl ?? '', /^https:\/\//, `${choice.name}: a link to get one`);
    assert.ok(choice.note, `${choice.name}: says what it costs`);
  }
});

test('a working key is reported with what the model actually said', async () => {
  const result = await verifyKey('groq', 'k-not-real', {
    fetch: stubFetch({ body: summarised('Chitraq separates memory from intelligence.') }),
  });

  assert.equal(result.ok, true);
  assert.match(result.sample, /separates memory/);
  assert.match(result.label, /Groq/);
});

test('a rejected key fails with the provider\'s own words, not a generic message', async () => {
  // "Something went wrong" sends somebody to the wrong place. The provider
  // already said what was wrong; the job here is to not lose it.
  const result = await verifyKey('groq', 'wrong', {
    fetch: stubFetch({ status: 401, body: { error: { message: 'Invalid API Key' } } }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /401|Invalid API Key/);
});

test('an unreachable provider is a failure, not a hang or a pass', async () => {
  const result = await verifyKey('groq', 'k', {
    fetch: stubFetch({ throws: 'ECONNREFUSED' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be reached/);
});

test('a provider nothing can build is refused by name', async () => {
  const result = await verifyKey('not-a-real-provider', 'k');
  assert.equal(result.ok, false);
  assert.match(result.error, /No adapter/);
});

test('a reply with an empty summary counts as failure', async () => {
  // A 200 with nothing useful in it would otherwise be stored as "working",
  // and the failure would surface later during an ingest.
  const result = await verifyKey('groq', 'k', {
    fetch: stubFetch({ body: summarised('   ') }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /nothing/i);
});

test('verifying a stored key uses it without ever handing it back', async () => {
  const c = new Chitraq({ path: ':memory:' });
  try {
    c.setApiKey({ provider: 'groq', key: 'k-secret-value', label: 'test' });

    const result = await c.verifyStoredKey('groq', {
      fetch: stubFetch({ body: summarised('It works.') }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.sample, 'It works.');

    // The stored key must not be readable through the public surface, which
    // is the whole reason it is encrypted in the first place.
    const listed = JSON.stringify(c.apiKeys());
    assert.ok(!listed.includes('k-secret-value'), 'the key is not in the listing');
    assert.ok(!JSON.stringify(result).includes('k-secret-value'), 'nor in the verdict');
  } finally {
    c.close();
  }
});

test('verifying a provider with no stored key says so plainly', async () => {
  const c = new Chitraq({ path: ':memory:' });
  try {
    const result = await c.verifyStoredKey('gemini');
    assert.equal(result.ok, false);
    assert.match(result.error, /No key stored/);
  } finally {
    c.close();
  }
});

test('Ollama being absent is an answer, not an error', async () => {
  // Setup runs this before anything else and must not fall over on a machine
  // that has never heard of Ollama.
  const absent = await probeOllama({ fetch: stubFetch({ throws: 'ECONNREFUSED' }) });
  assert.deepEqual(absent, { running: false, models: [] });

  const present = await probeOllama({
    fetch: stubFetch({ body: { models: [{ name: 'llama3.2:latest' }, { name: 'moondream' }] } }),
  });
  assert.equal(present.running, true);
  assert.deepEqual(present.models, ['llama3.2:latest', 'moondream']);
});

test('every offered provider can actually be built from a key', async () => {
  // A menu entry that cannot be turned into a provider is a dead end the
  // person only discovers after pasting a credential.
  const { providerFromKey } = await import('../src/intelligence/providers/from-key.js');
  for (const choice of choices()) {
    const built = providerFromKey(choice.name, 'k');
    assert.ok(built, `${choice.name} builds`);
    assert.ok(built.capabilities?.summarize, `${choice.name} can be verified`);
  }
});
