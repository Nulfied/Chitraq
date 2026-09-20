/**
 * Ollama provider — local general intelligence (Path A) and local embeddings
 * (Path C).
 *
 * This is the one that matters most for Chitraq's economics. With Ollama
 * running, a Chitraq install has real semantic embeddings and a real language
 * model, entirely on the user's own machine, at zero marginal cost and with no
 * text leaving the device. That is the configuration the local-first thesis is
 * about; the deterministic floor is what happens below it, and cloud models are
 * what happens above it.
 *
 * No SDK and no API key: Ollama exposes a plain HTTP API on localhost, so this
 * adapter is written with fetch and keeps Chitraq dependency-free.
 *
 *     ollama pull nomic-embed-text      # embeddings
 *     ollama pull llama3.2              # general language tasks
 */

import { Capability } from '../registry.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   default http://127.0.0.1:11434
 * @param {string} [opts.model]     general-purpose model
 * @param {string} [opts.embedModel]
 * @param {number} [opts.timeoutMs]
 * @returns {import('../registry.js').Provider}
 */
export function ollamaProvider(opts = {}) {
  const baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = opts.model ?? 'llama3.2';
  const embedModel = opts.embedModel ?? 'nomic-embed-text';
  const timeoutMs = opts.timeoutMs ?? 60_000;

  /**
   * How long to allow, given how much the model has to read.
   *
   * A flat sixty seconds is fine for a question and far too short for a
   * 41,000-character specification. Measured on an i7-8550U with no GPU, that
   * document took 81 seconds — so on a real import the model timed out on
   * every large file and the deterministic floor quietly did the work
   * instead. Reading speed is roughly linear in input, so the allowance is
   * too.
   *
   * @param {string} text
   */
  function budgetFor(text) {
    const chars = String(text ?? '').length;
    return Math.min(maxTimeoutMs, timeoutMs + Math.round(chars / 400) * 1000);
  }

  /** Nothing waits longer than this, however large the input. */
  const maxTimeoutMs = opts.maxTimeoutMs ?? 600_000;

  /**
   * @param {string} path
   * @param {object} body
   * @returns {Promise<any>}
   */
  async function post(path, body, allowMs) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(allowMs ?? timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama ${path} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }

  /**
   * Ask the local model for JSON.
   *
   * Ollama's `format` accepts a JSON schema and constrains generation to match,
   * so the same structured contract used for cloud models holds here. Small
   * local models still drift, so the parse is defensive.
   *
   * @param {{system: string, prompt: string, schema: object}} req
   */
  async function askJson({ system, prompt, schema }) {
    const data = await post(
      '/api/generate',
      {
        model,
        system,
        prompt,
        format: schema,
        stream: false,
        options: { temperature: 0 },
      },
      budgetFor(prompt)
    );
    try {
      return JSON.parse(data.response);
    } catch {
      throw new Error('The local model returned output that was not valid JSON.');
    }
  }

  return {
    id: 'ollama',
    label: `Ollama (${model} / ${embedModel})`,
    locality: 'local',
    cost: 'free',
    model,
    modelVersion: model,
    deterministic: false,

    available: async () => {
      try {
        const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) return false;
        const { models = [] } = await res.json();
        // Only report available if the models this provider needs are actually
        // pulled — a running Ollama with no models is not a working provider.
        const names = models.map((m) => String(m.name).split(':')[0]);
        return names.includes(embedModel.split(':')[0]) || names.includes(model.split(':')[0]);
      } catch {
        return false;
      }
    },

    capabilities: {
      [Capability.EmbedText]: {
        // Real semantic embeddings: this is the single biggest retrieval
        // improvement over the deterministic floor, and it is free and local.
        quality: 0.85,
        latencyMs: 60,
        costMicros: 0,
        run: async (task) => {
          const data = await post('/api/embed', { model: embedModel, input: task.texts });
          const vectors = data.embeddings ?? (data.embedding ? [data.embedding] : []);
          if (!vectors.length) throw new Error('Ollama returned no embeddings.');
          return { model: `ollama:${embedModel}`, dim: vectors[0].length, vectors };
        },
      },

      [Capability.Answer]: {
        quality: 0.72,
        latencyMs: 3000,
        costMicros: 0,
        run: async (task) => {
          const result = await askJson({
            system: LOCAL_ANSWER_SYSTEM,
            prompt:
              `Question: ${task.question}\n\nMaterial from memory:\n${task.rendered ?? ''}\n\n` +
              'Answer using only the material above.',
            schema: {
              type: 'object',
              required: ['grounded', 'answer', 'citations'],
              properties: {
                grounded: { type: 'boolean' },
                answer: { type: 'string' },
                citations: { type: 'array', items: { type: 'string' } },
                uncertainty: { type: 'string' },
              },
            },
          });
          // Small models answer well but report badly: a 3B model will write a
          // correct answer, cite the source it used, and still set grounded to
          // false. Trust what it produced over what it claims about itself —
          // an answer with citations is grounded, and a grounded flag with no
          // answer is not.
          const answer = String(result.answer ?? '').trim();
          const citations = (result.citations ?? [])
            .map((c) => String(c).replace(/^\[|\]$/g, '').trim())
            .filter(Boolean);
          const grounded = answer.length > 0;

          return {
            answer: grounded ? answer : null,
            grounded,
            citations: grounded ? citations : [],
            passages: [],
            uncertainty:
              result.uncertainty ??
              'Generated by a local model from your own memory. Check the cited items.',
            method: 'generated locally, grounded in supplied memory',
          };
        },
      },

      [Capability.ExtractClaims]: {
        quality: 0.68,
        // Measured, not guessed: a 41,000-character document takes about 80
        // seconds on a laptop with no GPU. The old declared 4 s was for a
        // paragraph, and the router used it to decide this was the fast option.
        latencyMs: 30_000,
        costMicros: 0,
        run: async (task) => {
          const result = await askJson({
            system: LOCAL_EXTRACT_SYSTEM,
            prompt: `Title: ${task.title ?? '(untitled)'}\n\n${task.text}`,
            schema: {
              type: 'object',
              required: ['claims'],
              properties: {
                claims: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['text', 'kind', 'epistemic', 'confidence'],
                    properties: {
                      text: { type: 'string' },
                      kind: { type: 'string' },
                      epistemic: { type: 'string' },
                      confidence: { type: 'number' },
                    },
                  },
                },
              },
            },
          });
          return {
            claims: (result.claims ?? []).slice(0, task.limit ?? 20).map((c) => ({
              text: String(c.text ?? '').trim(),
              kind: KINDS.has(c.kind) ? c.kind : 'note',
              epistemic: EPISTEMICS.has(c.epistemic) ? c.epistemic : 'observation',
              confidence: clamp(c.confidence) ?? 0.5,
              offset: 0,
            })).filter((c) => c.text.length > 10),
            uncertainty: 'Extracted by a local model; review before relying on these.',
          };
        },
      },

      [Capability.Summarize]: {
        quality: 0.7,
        latencyMs: 2500,
        costMicros: 0,
        run: async (task) => {
          const result = await askJson({
            system:
              'Summarise faithfully. Add nothing that is not in the text. Never invent numbers, ' +
              'names or dates.',
            prompt: `Summarise in at most ${task.maxSentences ?? 3} sentences:\n\n${task.text}`,
            schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
          });
          return {
            summary: result.summary,
            method: 'generated locally',
            uncertainty: 'Written by a local model; the wording is not the source\'s own.',
          };
        },
      },
    },
  };
}

const KINDS = new Set([
  'note', 'fact', 'concept', 'decision', 'observation', 'question',
  'hypothesis', 'lesson', 'event', 'entity', 'artifact', 'task',
]);
const EPISTEMICS = new Set([
  'fact', 'observation', 'belief', 'hypothesis', 'inference', 'conclusion', 'speculation',
]);

const LOCAL_ANSWER_SYSTEM = `You answer questions using the material provided, which comes from the user's own notes.

Decide grounded first:
- grounded = true when the material contains the answer, even partly. If you can point at a sentence that answers the question, it is true.
- grounded = false ONLY when nothing in the material bears on the question at all.

When grounded is true, write the answer in one or two sentences and list the ids you used.
When grounded is false, leave answer empty and list no ids.

Never use knowledge from outside the material. Never guess. Write ids exactly as obj_1, without brackets.`;

const LOCAL_EXTRACT_SYSTEM = `Split the text into separate pieces of knowledge worth remembering.

Each piece must make sense on its own and must say only what the text says. Mark something measured as an observation, something settled as a decision, something uncertain as a hypothesis. Skip filler. If there is nothing worth keeping, return an empty list.`;

/** @param {unknown} n */
function clamp(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(1, v));
}
