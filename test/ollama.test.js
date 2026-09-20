/**
 * The Ollama provider, tested against a stand-in that speaks Ollama's actual
 * HTTP protocol.
 *
 * What this proves: the request shapes Chitraq sends, how it parses responses,
 * how the health check decides availability, what happens on malformed output,
 * and that a failure falls through to the deterministic floor rather than
 * breaking anything.
 *
 * What it cannot prove: that a real Ollama build responds exactly as documented.
 * That needs a live endpoint — run `scripts/check-ollama.js` against one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Chitraq } from '../src/chitraq.js';
import { ollamaProvider } from '../src/intelligence/providers/ollama.js';
import { Capability } from '../src/intelligence/registry.js';

/**
 * A stand-in Ollama. Mirrors the real API: /api/tags, /api/embed, /api/generate.
 * @param {{models?: string[], embedDim?: number, handler?: Function}} [opts]
 */
async function fakeOllama(opts = {}) {
  const models = opts.models ?? ['nomic-embed-text:latest', 'llama3.2:latest'];
  /** @type {any[]} */
  const seen = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    seen.push({ path: req.url, body });

    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (opts.handler) {
      const handled = opts.handler(req, body, reply);
      if (handled) return;
    }

    if (req.url === '/api/tags') {
      return reply(200, { models: models.map((name) => ({ name })) });
    }

    if (req.url === '/api/embed') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dim = opts.embedDim ?? 768;
      // Deterministic pseudo-embeddings, so similarity assertions are stable.
      return reply(200, {
        model: body.model,
        embeddings: inputs.map((text) =>
          Array.from({ length: dim }, (_, i) => {
            let h = i * 31;
            for (const ch of String(text)) h = (h * 33 + ch.charCodeAt(0)) % 9973;
            return (h / 9973) * 2 - 1;
          })
        ),
      });
    }

    if (req.url === '/api/generate') {
      // Real Ollama honours `format` as a JSON schema and returns a JSON string.
      const schema = body.format;
      const props = schema?.properties ?? {};
      const out = {};
      if ('grounded' in props) {
        out.grounded = true;
        out.answer = 'Answered from the supplied material.';
        out.citations = ['obj_test'];
      }
      if ('claims' in props) {
        out.claims = [
          { text: 'We decided to keep the engine dependency-free.', kind: 'decision', epistemic: 'conclusion', confidence: 0.8 },
          { text: 'The team measured p99 latency at 38ms.', kind: 'observation', epistemic: 'observation', confidence: 0.75 },
          { text: 'short', kind: 'note', epistemic: 'observation', confidence: 0.4 },
        ];
      }
      if ('summary' in props) out.summary = 'A faithful summary.';
      return reply(200, { model: body.model, response: JSON.stringify(out), done: true });
    }

    reply(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = /** @type {any} */ (server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('availability requires the needed models to actually be pulled', async () => {
  const withModels = await fakeOllama();
  const ready = ollamaProvider({ baseUrl: withModels.baseUrl });
  assert.equal(await ready.available(), true);
  await withModels.close();

  // A running Ollama with no models is not a working provider.
  const empty = await fakeOllama({ models: [] });
  const bare = ollamaProvider({ baseUrl: empty.baseUrl });
  assert.equal(await bare.available(), false);
  await empty.close();

  // Nothing listening at all.
  const absent = ollamaProvider({ baseUrl: 'http://127.0.0.1:1' });
  assert.equal(await absent.available(), false);
});

test('embeddings are requested in one batched call and parsed', async () => {
  const ollama = await fakeOllama({ embedDim: 768 });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  const result = await provider.capabilities['embed.text'].run({
    texts: ['first piece of text', 'second piece of text'],
  });

  assert.equal(result.vectors.length, 2);
  assert.equal(result.dim, 768);
  assert.equal(result.model, 'ollama:nomic-embed-text');

  const call = ollama.seen.find((c) => c.path === '/api/embed');
  assert.deepEqual(call.body.input, ['first piece of text', 'second piece of text'], 'batched, not one call per text');
  assert.equal(call.body.model, 'nomic-embed-text');
  await ollama.close();
});

test('generation asks for JSON against a schema, with temperature zero', async () => {
  const ollama = await fakeOllama();
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  await provider.capabilities['extract.claims'].run({ text: 'Some document text.', title: 'Doc' });

  const call = ollama.seen.find((c) => c.path === '/api/generate');
  assert.ok(call.body.format, 'a JSON schema constrains the output');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.options.temperature, 0, 'deterministic where it can be');
  assert.ok(call.body.system, 'grounding instructions are in the system prompt');
  await ollama.close();
});

test('extracted claims are validated rather than trusted', async () => {
  const ollama = await fakeOllama();
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  const result = await provider.capabilities['extract.claims'].run({ text: 'Document.', limit: 20 });

  assert.equal(result.claims.length, 2, 'the too-short claim is dropped');
  assert.equal(result.claims[0].kind, 'decision');
  assert.ok(result.uncertainty, 'output from a local model is labelled as needing review');
  await ollama.close();
});

test('an unknown kind from the model is replaced with a known one', async () => {
  const ollama = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/generate') return false;
      reply(200, {
        response: JSON.stringify({
          claims: [{ text: 'A claim long enough to survive filtering.', kind: 'invented-kind', epistemic: 'nonsense', confidence: 5 }],
        }),
      });
      return true;
    },
  });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  const result = await provider.capabilities['extract.claims'].run({ text: 'Document.' });
  assert.equal(result.claims[0].kind, 'note', 'an unrecognised kind falls back');
  assert.equal(result.claims[0].epistemic, 'observation');
  assert.ok(result.claims[0].confidence <= 1, 'and confidence is clamped into range');
  await ollama.close();
});

test('malformed JSON from the model is an error, not silent rubbish', async () => {
  const ollama = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/generate') return false;
      reply(200, { response: 'I am afraid I cannot do that.' });
      return true;
    },
  });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  await assert.rejects(
    () => provider.capabilities.summarize.run({ text: 'Some text.' }),
    /not valid JSON/
  );
  await ollama.close();
});

test('an HTTP error surfaces with its status', async () => {
  const ollama = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/embed') return false;
      reply(500, { error: 'model runner crashed' });
      return true;
    },
  });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  await assert.rejects(
    () => provider.capabilities['embed.text'].run({ texts: ['x'] }),
    /returned 500/
  );
  await ollama.close();
});

// --------------------------------------------------- inside the engine

test('when Ollama is present it outranks the built-in embedder', async () => {
  const ollama = await fakeOllama();
  const c = new Chitraq({ path: ':memory:', providers: [ollamaProvider({ baseUrl: ollama.baseUrl })] });

  const { coverage } = await c.capabilities();
  assert.equal(coverage['embed.text'].best, 'ollama', 'a real embedder beats the deterministic floor');
  assert.equal(coverage['embed.text'].degraded, false);
  assert.equal(coverage['answer'].best, 'ollama');

  // And the floor is still there underneath it.
  assert.ok(coverage['embed.text'].providers.includes('builtin'));
  c.close();
  await ollama.close();
});

test('captured knowledge is embedded by Ollama and stays searchable', async () => {
  const ollama = await fakeOllama();
  const c = new Chitraq({ path: ':memory:', providers: [ollamaProvider({ baseUrl: ollama.baseUrl })] });

  const { object } = await c.remember({
    title: 'Chose SQLite for the store',
    body: 'We chose SQLite because it needs no server.',
    enrich: false,
  });

  const stored = c.db.prepare('SELECT DISTINCT model FROM embedding').all().map((r) => String(r.model));
  assert.deepEqual(stored, ['ollama:nomic-embed-text'], 'vectors come from the better provider');

  const found = await c.search('sqlite store');
  assert.ok(found.results.some((r) => r.id === object.id));
  c.close();
  await ollama.close();
});

test('if Ollama dies mid-session, memory carries on without it', async () => {
  const ollama = await fakeOllama();
  const c = new Chitraq({ path: ':memory:', providers: [ollamaProvider({ baseUrl: ollama.baseUrl })] });

  await c.remember({ title: 'Captured while Ollama was up', body: 'Content here.', enrich: false });
  await ollama.close();
  c.registry.resetHealth();

  // Capture still succeeds; it simply loses the semantic signal.
  const after = await c.remember({ title: 'Captured after it died', body: 'More content.', enrich: false });
  assert.ok(after.object.id);

  const found = await c.search('captured after it died');
  assert.ok(found.results.some((r) => r.id === after.object.id), 'lexical search still finds it');

  // The health check drops it from routing before any call is made, so the
  // outage shows up as a provider event rather than a failed run.
  const outages = c.history({ types: ['ProviderUnavailable'] });
  assert.ok(
    outages.some((e) => e.subject_id === 'ollama'),
    'the outage is recorded, not hidden'
  );
  c.close();
});

test('switching embedding provider is detected and reported', async () => {
  const ollama = await fakeOllama();
  const c = new Chitraq({ path: ':memory:' });

  // Captured with the built-in embedder…
  await c.remember({ title: 'Captured with the floor', body: 'Some text.', enrich: false });
  // …then Ollama arrives.
  c.addProvider(ollamaProvider({ baseUrl: ollama.baseUrl }));
  await c.remember({ title: 'Captured with Ollama', body: 'Other text.', enrich: false });

  const { health } = await import('../src/server/http.js').then((m) => ({ health: m.health }));
  const report = health(c);

  assert.equal(report.ok, false);
  assert.match(report.warnings[0], /different models/, 'the user is told a reindex is needed');
  assert.equal(report.embeddingModels.length, 2);
  c.close();
  await ollama.close();
});

test('a small model that answers but reports grounded:false is believed by its answer', async () => {
  // Found against a live llama3.2: it wrote a correct answer, cited the source
  // it used, and still set grounded to false. Taking that flag at face value
  // threw away a perfectly good answer.
  const ollama = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/generate') return false;
      reply(200, {
        response: JSON.stringify({
          grounded: false,
          answer: 'We dropped the Redis cache because the hit rate never exceeded 12 percent.',
          citations: ['[obj_1]'],
        }),
      });
      return true;
    },
  });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  const result = await provider.capabilities.answer.run({ question: 'why', rendered: '[obj_1] ...' });
  assert.equal(result.grounded, true, 'an answer with citations is grounded whatever the flag says');
  assert.match(result.answer, /hit rate/);
  assert.deepEqual(result.citations, ['obj_1'], 'bracket wrapping from the prompt is stripped');
  await ollama.close();
});

test('a grounded:true flag with no answer is not treated as an answer', async () => {
  const ollama = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/generate') return false;
      reply(200, { response: JSON.stringify({ grounded: true, answer: '   ', citations: ['obj_9'] }) });
      return true;
    },
  });
  const provider = ollamaProvider({ baseUrl: ollama.baseUrl });

  const result = await provider.capabilities.answer.run({ question: 'why', rendered: 'x' });
  assert.equal(result.grounded, false, 'the flag does not conjure an answer that is not there');
  assert.equal(result.answer, null);
  assert.deepEqual(result.citations, []);
  await ollama.close();
});

test('a fallthrough is reported, not silent', async (t) => {
  // On a real import, 26 of 27 documents were extracted by the deterministic
  // floor after the model timed out, and the output said only "20 proposed".
  // A timed-out model must not look like a model that ran.
  const slow = {
    id: 'slow-model',
    label: 'a model that never answers',
    locality: 'local',
    cost: 'free',
    available: async () => true,
    capabilities: {
      [Capability.ExtractClaims]: {
        quality: 0.9,
        latencyMs: 10,
        run: () => new Promise((_, reject) => setTimeout(() => reject(new Error('too slow')), 20)),
      },
    },
  };

  const c = new Chitraq({ path: ':memory:', providers: [slow] });
  t.after(() => c.close());

  const result = await c.ingest({
    text: 'We decided to keep the engine dependency-free. The team measured p99 latency at 38ms.',
    filename: 'notes.md',
  });

  assert.equal(result.extractedBy, 'builtin', 'the floor served it');
  assert.equal(result.degraded, true);
  assert.ok(result.fellBackFrom?.length, 'and it says what failed');
  assert.equal(result.fellBackFrom[0].provider, 'slow-model');
  assert.ok(result.proposals.length > 0, 'capture still produced knowledge');
});

test('the claim budget scales with the document', async (t) => {
  // A flat twenty gave an 800-word guide and a 41,000-character specification
  // the same budget — one claim per 340 words in the second case.
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  // Distinct sentences, because identical ones are correctly collapsed by the
  // duplicate check that overlapping chunks require.
  const line = (i) => `Measurement ${i}: the p99 latency was ${i} milliseconds across shard ${i}.

`;
  const many = (n) => Array.from({ length: n }, (_, i) => line(i)).join('');

  const short = await c.ingest({ text: many(3), filename: 'short.md' });
  const long = await c.ingest({ text: many(400), filename: 'long.md' });

  assert.ok(long.proposals.length > short.proposals.length, 'a longer document yields more');
  assert.ok(long.proposals.length > 20, `flat 20 would have capped this, got ${long.proposals.length}`);
});

test('a long document is read in pieces, not swallowed whole', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const line = (i) => `Measurement ${i}: the p99 latency was ${i} milliseconds on shard ${i}.\n\n`;
  const text = Array.from({ length: 400 }, (_, i) => line(i)).join('');

  const result = await c.ingest({ text, filename: 'long.md' });
  assert.ok(result.pieces > 10, `read in pieces, got ${result.pieces}`);
  assert.ok(result.proposals.length > 20, 'and produced more than the old flat cap');

  const short = await c.ingest({ text: 'One short note about latency.', filename: 'short.md' });
  assert.equal(short.pieces, 1, 'a short note is one call, not a round trip per sentence');
});

test('overlapping pieces do not produce the same claim twice', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  // Chunks overlap by a sentence on purpose, so the same sentence arrives in
  // two pieces and must be recognised as one claim.
  const line = (i) => `Fact number ${i} states that shard ${i} held ${i} records.\n\n`;
  const text = Array.from({ length: 300 }, (_, i) => line(i)).join('');

  const result = await c.ingest({ text, filename: 'overlap.md' });
  // The payload comes back as stored, which is a JSON string.
  const titles = result.proposals.map((p) =>
    (typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload).title
  );
  assert.ok(titles.length > 5, `enough to be worth checking, got ${titles.length}`);
  assert.equal(new Set(titles).size, titles.length, 'every proposed claim is distinct');
});

test('a model too slow for the job is skipped, not discovered by timing out', async (t) => {
  // Measured on this hardware: llama3.2 needs about 86 seconds for a
  // 1,000-character piece. A 25-piece document is half an hour. Without this
  // the router learns that one timeout at a time.
  const slow = {
    id: 'slow-model',
    label: 'slow',
    locality: 'local',
    cost: 'free',
    available: async () => true,
    capabilities: {
      [Capability.ExtractClaims]: {
        quality: 0.9,
        latencyMs: 10,
        run: async () => ({ claims: [{ text: 'a claim', kind: 'note', epistemic: 'observation', confidence: 0.8, offset: 0 }] }),
      },
    },
  };
  const c = new Chitraq({ path: ':memory:', providers: [slow] });
  t.after(() => c.close());

  const { newRunId, now } = await import('../src/core/ids.js');
  for (let i = 0; i < 4; i++) {
    c.db
      .prepare(
        `INSERT INTO capability_run (id,workspace_id,capability,provider,task,context_ids,result,status,latency_ms,cost_micros,started_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(newRunId(), c.workspaceId, 'extract.claims', 'slow-model', '{}', '[]', '{}', 'ok', 86_000, 0, now());
  }

  const line = (i) => `Measurement ${i}: latency was ${i} ms on shard ${i}.\n\n`;
  const result = await c.ingest({
    text: Array.from({ length: 400 }, (_, i) => line(i)).join(''),
    filename: 'big.md',
  });

  assert.equal(result.extractedBy, 'builtin');
  assert.ok(result.skippedModel, 'and it says it made that choice');
  assert.match(result.skippedModel.reason, /too slow/);
  assert.ok(result.proposals.length > 20, 'the floor still did the work');
});

test('the model is asked for sentences, and the labels are derived', async (t) => {
  // Generation runs at about five tokens a second here whatever is asked
  // for, so the schema decides the cost. Demanding kind, epistemic and
  // confidence per claim made the model emit 251 tokens where 45 would do —
  // 69 seconds against 9 — and the confidence it returned was the same
  // constant every time, which is no signal at all.
  const stand = await fakeOllama({
    handler: (req, body, reply) => {
      if (req.url !== '/api/generate') return false;
      reply(200, {
        response: JSON.stringify({
          claims: [
            'We decided to keep the engine dependency-free.',
            'We measured p99 latency at 38ms across 14000 chunks.',
            'It might not hold above ten million chunks.',
          ],
        }),
      });
      return true;
    },
  });
  t.after(() => stand.close());

  const p = ollamaProvider({ baseUrl: stand.baseUrl });
  const result = await p.capabilities[Capability.ExtractClaims].run({ text: 'irrelevant', limit: 20 });

  // Plain strings in, labelled claims out.
  assert.equal(result.claims.length, 3);
  const byKind = Object.fromEntries(result.claims.map((c) => [c.kind, c.confidence]));
  assert.ok('decision' in byKind, `derived a decision, got ${Object.keys(byKind)}`);
  assert.ok('hypothesis' in byKind, 'and a hypothesis');

  // The whole point: confidence varies, so a threshold can sort them.
  assert.ok(new Set(result.claims.map((c) => c.confidence)).size > 1, 'confidence is not a constant');

  // And the request really did ask for the cheap shape.
  const sent = stand.seen.find((r) => r.path === '/api/generate').body;
  assert.equal(sent.format.properties.claims.items.type, 'string', 'strings, not objects');
});
