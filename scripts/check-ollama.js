#!/usr/bin/env node
/**
 * Verify the Ollama provider against a real, running Ollama.
 *
 *     node scripts/check-ollama.js
 *
 * The test suite exercises this provider against a stand-in that speaks
 * Ollama's HTTP protocol. That proves Chitraq's side is correct; it cannot
 * prove a real Ollama responds as documented. This script closes that gap.
 *
 * Setup:
 *     ollama pull nomic-embed-text     # embeddings — the big retrieval win
 *     ollama pull llama3.2             # general language tasks
 */

import { Chitraq } from '../src/chitraq.js';
import { ollamaProvider } from '../src/intelligence/providers/ollama.js';

const baseUrl = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const embedModel = process.env.CHITRAQ_OLLAMA_EMBED || 'nomic-embed-text';
const model = process.env.CHITRAQ_OLLAMA_MODEL || 'llama3.2';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`\n  Checking Ollama at ${baseUrl}\n`);

// --- is it there at all? ----------------------------------------------------

let tags;
try {
  const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  tags = await res.json();
} catch (err) {
  console.log(`  ✘ Cannot reach Ollama: ${err.message}`);
  console.log(`\n  Is it running? Start it with:  ollama serve\n`);
  process.exit(1);
}

const installed = (tags.models ?? []).map((m) => String(m.name));
console.log(`  ${installed.length} model(s) installed: ${installed.join(', ') || 'none'}\n`);

const has = (name) => installed.some((m) => m.split(':')[0] === name.split(':')[0]);
check(`embedding model "${embedModel}" is pulled`, has(embedModel), has(embedModel) ? '' : `→ ollama pull ${embedModel}`);
check(`language model "${model}" is pulled`, has(model), has(model) ? '' : `→ ollama pull ${model}`);

const provider = ollamaProvider({ baseUrl, model, embedModel });
check('provider reports itself available', await provider.available());

// --- embeddings -------------------------------------------------------------

if (has(embedModel)) {
  try {
    const t0 = Date.now();
    const result = await provider.capabilities['embed.text'].run({
      texts: ['the memory engine stores knowledge objects', 'the ficus needs watering weekly'],
    });
    const ms = Date.now() - t0;

    check('embeddings returned', result.vectors.length === 2, `dim ${result.dim}, ${ms}ms`);

    const [a, b] = result.vectors;
    const dot = a.reduce((s, v, i) => s + v * b[i], 0);
    const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const cosine = dot / (norm(a) * norm(b));

    // Two unrelated sentences should not be near-identical. If they are, the
    // model is not producing useful vectors and retrieval will be noise.
    check('unrelated texts are separated', cosine < 0.85, `cosine ${cosine.toFixed(3)}`);

    const same = await provider.capabilities['embed.text'].run({
      texts: ['the memory engine stores knowledge objects'],
    });
    const repeat = a.reduce((s, v, i) => s + v * same.vectors[0][i], 0) / (norm(a) * norm(same.vectors[0]));
    check('the same text embeds consistently', repeat > 0.999, `cosine ${repeat.toFixed(4)}`);
  } catch (err) {
    check('embeddings', false, err.message);
  }
}

// --- generation -------------------------------------------------------------

if (has(model)) {
  try {
    const t0 = Date.now();
    const result = await provider.capabilities['extract.claims'].run({
      text:
        'We decided to keep the memory engine dependency-free. ' +
        'The team measured p99 search latency at 38ms across 14,000 chunks. ' +
        'It might not hold above ten million chunks.',
      title: 'Architecture review',
    });
    check('claim extraction returned structured JSON', Array.isArray(result.claims), `${Date.now() - t0}ms`);
    check('claims were extracted', result.claims.length > 0, `${result.claims.length} claim(s)`);
    for (const c of result.claims.slice(0, 4)) {
      console.log(`      [${c.kind}/${c.epistemic}] ${c.text.slice(0, 70)}`);
    }
  } catch (err) {
    check('claim extraction', false, err.message);
  }

  try {
    const result = await provider.capabilities.answer.run({
      question: 'why did we drop the redis cache',
      rendered:
        '[obj_1] Redis decision\n  (decision, conclusion)\n  We dropped the Redis cache because the hit rate never exceeded 12 percent.',
    });
    check('grounded answering works', result.grounded === true, result.answer?.slice(0, 60) ?? '');
    check('the answer cites its sources', (result.citations ?? []).length > 0, (result.citations ?? []).join(', '));
  } catch (err) {
    check('grounded answering', false, err.message);
  }

  // The most important behaviour: refusing to answer from nothing.
  try {
    const result = await provider.capabilities.answer.run({
      question: 'what is the capital of Peru',
      rendered: '[obj_1] Batch runtime\n  (observation)\n  The nightly batch takes 40 minutes.',
    });
    check(
      'refuses to answer from unrelated material',
      result.grounded === false && !result.answer,
      result.grounded ? `WRONG — it answered: "${result.answer}"` : ''
    );
  } catch (err) {
    check('refusal behaviour', false, err.message);
  }
}

// --- end to end -------------------------------------------------------------

if (has(embedModel)) {
  const c = new Chitraq({ path: ':memory:', providers: [provider] });
  const { coverage } = await c.capabilities();
  check('Chitraq routes embedding to Ollama', coverage['embed.text'].best === 'ollama');

  const { object } = await c.remember({
    title: 'Chose SQLite for the store',
    body: 'We chose SQLite because it needs no server and ships inside Node.',
    enrich: false,
  });

  // A paraphrase that shares almost no words — the thing the deterministic
  // embedder cannot do and a real one can.
  const found = await c.search('why is there no database server to run');
  const hit = found.results.some((r) => r.id === object.id);
  check(
    'semantic search finds a paraphrase',
    hit,
    hit ? 'found it with almost no shared words' : 'did not find it — check the embedding model'
  );
  c.close();
}

console.log(
  failures === 0
    ? `\n  All checks passed. Ollama is wired up correctly.\n`
    : `\n  ${failures} check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
