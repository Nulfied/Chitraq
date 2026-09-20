/**
 * Claude provider — cloud general intelligence (Path B).
 *
 * Entirely optional. Chitraq captures, indexes, searches, answers and evolves
 * without it; adding it raises the ceiling on extraction quality, synthesis and
 * natural-language answering. Nothing in the memory core changes when it is
 * added or removed.
 *
 * Two things this adapter is strict about:
 *
 *   1. **Grounding.** Every prompt instructs the model to answer only from the
 *      supplied memory, to cite the object ids it used, and to say plainly when
 *      memory does not contain the answer. A confident answer with no support
 *      in the user's own memory is the single worst failure mode for a memory
 *      engine, so `grounded: false` is treated as a valid, expected outcome.
 *
 *   2. **The boundary.** Results come back as structured data that becomes
 *      *proposals*. This adapter never writes to memory. It cannot: it is
 *      handed a task and returns a value, like any other capability.
 *
 * The official SDK is loaded dynamically so that Chitraq's core stays
 * dependency-free. Install it only if you want this provider:
 *
 *     npm install @anthropic-ai/sdk
 *
 * **What is left in this file.** The prompts, schemas and result parsing used
 * to live here and now live in `grounded.js`, shared with every other general
 * model. What remains is the Anthropic request shape: the SDK import, the
 * message and output_config construction, prompt caching on the system block,
 * and the stop-reason handling.
 *
 * That matters because this is the one provider nobody has run. A key costs
 * money the author does not have, so this adapter has never made a live call.
 * Before the split, that left every prompt untested too. Now a free provider
 * on the OpenAI shape exercises all of `grounded.js` for real, and what stays
 * unverified here is the forty lines below `getClient`. Stated plainly rather
 * than left to be discovered.
 */

import { groundedCapabilities } from './grounded.js';

/** Current default. Override per install; the memory does not care which. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * @param {object} [opts]
 * @param {string} [opts.apiKey]   defaults to the ANTHROPIC_API_KEY environment variable
 * @param {string} [opts.model]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [opts.effort]
 * @param {boolean} [opts.fallbacks] server-side refusal fallbacks, on by default
 * @param {number} [opts.maxTokens]
 * @returns {import('../registry.js').Provider}
 */
export function anthropicProvider(opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const effort = opts.effort ?? 'high';
  const maxTokens = opts.maxTokens ?? 16000;
  const useFallbacks = opts.fallbacks !== false;

  /** @type {any} */
  let client = null;

  async function getClient() {
    if (client) return client;
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    let Anthropic;
    try {
      ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
    } catch {
      throw new Error(
        'The Claude provider needs the official SDK. Run: npm install @anthropic-ai/sdk'
      );
    }
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    return client;
  }

  /**
   * One structured call. Returns parsed JSON matching `schema`.
   * @param {object} req
   * @param {string} req.system
   * @param {string} req.user
   * @param {object} req.schema
   * @param {boolean} [req.think]
   * @returns {Promise<any>}
   */
  async function ask({ system, user, schema, think }) {
    const api = await getClient();

    /** @type {any} */
    const request = {
      model,
      max_tokens: maxTokens,
      // The system prompt is stable across calls of the same kind, so caching
      // it makes repeated extraction over a large import substantially cheaper.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: {
        effort,
        format: { type: 'json_schema', schema },
      },
    };
    if (think) request.thinking = { type: 'adaptive' };

    const response = useFallbacks
      ? await api.beta.messages.create({
          ...request,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : await api.messages.create(request);

    // A refusal is a legitimate outcome, not a crash. The router records it and
    // the deterministic provider answers instead — memory is never blocked.
    if (response.stop_reason === 'refusal') {
      const detail = response.stop_details;
      throw new Error(
        `Claude declined this request${detail?.category ? ` (${detail.category})` : ''}. ` +
          `Falling back to the deterministic provider.`
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Response hit the token limit before completing; treating it as unusable.');
    }

    if (response.parsed_output) return response.parsed_output;

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Claude returned output that was not valid JSON for the requested schema.');
    }
  }

  return {
    id: 'anthropic',
    label: `Claude (${model})`,
    locality: 'remote',
    cost: 'paid',
    model,
    modelVersion: model,
    deterministic: false,

    available: async () => {
      if (!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY)) return false;
      try {
        await import('@anthropic-ai/sdk');
        return true;
      } catch {
        return false;
      }
    },

    capabilities: groundedCapabilities({ ask }),
  };
}
