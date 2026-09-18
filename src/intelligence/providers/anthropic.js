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
 */

import { Capability } from '../registry.js';

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

    capabilities: {
      [Capability.Answer]: {
        quality: 0.95,
        latencyMs: 4000,
        costMicros: 3000,
        run: async (task) => {
          const result = await ask({
            system: ANSWER_SYSTEM,
            user: answerPrompt(task),
            schema: ANSWER_SCHEMA,
            think: true,
          });
          return {
            answer: result.grounded ? result.answer : null,
            grounded: !!result.grounded,
            citations: result.citations ?? [],
            passages: [],
            uncertainty: result.uncertainty ?? null,
            conflictsNoted: result.conflicts_noted ?? [],
            method: 'generated, grounded in supplied memory',
          };
        },
      },

      [Capability.ExtractClaims]: {
        quality: 0.9,
        latencyMs: 3500,
        costMicros: 2000,
        run: async (task) => {
          const result = await ask({
            system: EXTRACT_SYSTEM,
            user: `Source title: ${task.title ?? '(untitled)'}\n\n---\n${task.text}\n---`,
            schema: CLAIMS_SCHEMA,
          });
          return {
            claims: (result.claims ?? []).slice(0, task.limit ?? 20).map((c) => ({
              text: c.text,
              kind: c.kind ?? 'note',
              epistemic: c.epistemic ?? 'observation',
              confidence: clamp(c.confidence),
              offset: typeof c.offset === 'number' ? c.offset : 0,
            })),
            uncertainty: result.uncertainty ?? null,
          };
        },
      },

      [Capability.Summarize]: {
        quality: 0.92,
        latencyMs: 2500,
        costMicros: 1200,
        run: async (task) => {
          const result = await ask({
            system:
              'Summarise the text faithfully. Do not add facts, figures, names or conclusions ' +
              'that are not present in it. If the text is too fragmentary to summarise, say so.',
            user: `Summarise in at most ${task.maxSentences ?? 3} sentences:\n\n${task.text}`,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'faithful'],
              properties: {
                summary: { type: 'string' },
                faithful: { type: 'boolean', description: 'false if the text could not be summarised without inventing' },
              },
            },
          });
          return {
            summary: result.summary,
            method: 'generated',
            uncertainty: result.faithful ? null : 'The source text was too fragmentary to summarise reliably.',
          };
        },
      },

      [Capability.DetectConflict]: {
        quality: 0.9,
        latencyMs: 2500,
        costMicros: 1500,
        run: async (task) => {
          const result = await ask({
            system: CONFLICT_SYSTEM,
            user:
              `Statement A: ${task.a?.title}\n${task.a?.body ?? ''}\n\n` +
              `Statement B: ${task.b?.title}\n${task.b?.body ?? ''}`,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['contradicts', 'confidence', 'reason'],
              properties: {
                contradicts: { type: 'boolean' },
                confidence: { type: 'number' },
                reason: { type: 'string' },
                same_subject: { type: 'boolean' },
              },
            },
          });
          return {
            contradicts: !!result.contradicts,
            confidence: clamp(result.confidence) ?? 0,
            reason: result.reason,
            detail: { sameSubject: result.same_subject ?? null },
          };
        },
      },

      [Capability.ProposeRelations]: {
        quality: 0.88,
        latencyMs: 2500,
        costMicros: 1500,
        run: async (task) => {
          const result = await ask({
            system: RELATIONS_SYSTEM,
            user:
              `A (id ${task.a?.id}): ${task.a?.title}\n${task.a?.body ?? ''}\n\n` +
              `B (id ${task.b?.id}): ${task.b?.title}\n${task.b?.body ?? ''}`,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['relations'],
              properties: {
                relations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['type', 'confidence', 'rationale'],
                    properties: {
                      type: { type: 'string', enum: RELATION_TYPES },
                      confidence: { type: 'number' },
                      rationale: { type: 'string' },
                    },
                  },
                },
              },
            },
          });
          return {
            relations: (result.relations ?? []).map((r) => ({
              type: r.type,
              confidence: clamp(r.confidence) ?? 0.5,
              rationale: r.rationale,
            })),
          };
        },
      },

      [Capability.InterpretQuery]: {
        quality: 0.85,
        latencyMs: 1500,
        costMicros: 600,
        run: async (task) => {
          const result = await ask({
            system:
              'Rewrite the search query to improve recall over a personal knowledge base. ' +
              'Add synonyms and likely alternative phrasings the writer might have used. ' +
              'Do not answer the question and do not invent proper nouns.',
            user: task.query,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['expansions'],
              properties: {
                expansions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                likely_kind: { type: 'string' },
              },
            },
          });
          return { expansions: result.expansions ?? [], likelyKind: result.likely_kind ?? null };
        },
      },
    },
  };
}

const RELATION_TYPES = [
  'supports', 'contradicts', 'causes', 'caused_by', 'depends_on', 'part_of',
  'contains', 'related_to', 'similar_to', 'elaborates', 'precedes', 'follows',
  'answers_question',
];

const ANSWER_SYSTEM = `You answer questions using only the fragments of the user's own memory supplied to you.

Rules, in order of importance:

1. Use only the supplied material. Do not use general knowledge, and do not fill gaps with what is usually true. If the material does not answer the question, set grounded to false and explain what is missing. That is a correct and useful answer.
2. Cite the bracketed object ids you actually used. Every claim in your answer must trace to a cited fragment.
3. Each fragment is labelled with its kind, epistemic status, origin and review state. Respect them. A fragment marked speculation or AI-derived and unreviewed is not evidence of the same weight as a confirmed observation, and your answer should say so rather than flatten the difference.
4. If the material contains a disagreement, present both sides and name it. Never resolve a contradiction silently by choosing the more convenient side.
5. Where material carries dates, prefer the more recent unless the question is about history — and say which you used.
6. Be brief. The user wrote this material; they do not need it explained back at length.`;

/** @param {any} task */
function answerPrompt(task) {
  return (
    `Question: ${task.question}\n\n` +
    `Material from memory:\n\n${task.rendered ?? ''}\n\n` +
    (task.conflicts?.length
      ? `Note: ${task.conflicts.length} known disagreement(s) are flagged in the material above. Address them.\n\n`
      : '') +
    'Answer using only the material above.'
  );
}

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['grounded', 'answer', 'citations'],
  properties: {
    grounded: {
      type: 'boolean',
      description: 'true only if the supplied material genuinely answers the question',
    },
    answer: { type: 'string', description: 'empty when grounded is false' },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description: 'object ids actually used, exactly as bracketed in the material',
    },
    uncertainty: {
      type: 'string',
      description: 'what is missing, ambiguous, out of date or disputed',
    },
    conflicts_noted: { type: 'array', items: { type: 'string' } },
  },
};

const EXTRACT_SYSTEM = `Split the text into standalone units of knowledge worth remembering.

Each unit must:
- stand on its own, readable a year from now without the surrounding document
- be stated in the source's own terms; do not embellish, generalise or conclude beyond it
- carry the right epistemic status: something measured is an observation, something settled is a decision, something floated is a hypothesis, something guessed is speculation

Do not extract pleasantries, headings, navigation or restatements of the same point. Ten good units beat forty weak ones. If the text contains nothing worth remembering, return an empty list.`;

const CLAIMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'epistemic', 'confidence'],
        properties: {
          text: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['note', 'fact', 'concept', 'decision', 'observation', 'question', 'hypothesis', 'lesson', 'event', 'task'],
          },
          epistemic: {
            type: 'string',
            enum: ['fact', 'observation', 'belief', 'hypothesis', 'inference', 'conclusion', 'speculation'],
          },
          confidence: { type: 'number' },
          offset: { type: 'integer' },
        },
      },
    },
    uncertainty: { type: 'string' },
  },
};

const CONFLICT_SYSTEM = `Decide whether two statements genuinely contradict each other.

They contradict only if they are about the same subject and cannot both be true at the same time. Two statements are NOT in contradiction merely because they differ in wording, cover different periods, describe different scopes, or one is more specific than the other. A later correction of an earlier figure is a contradiction worth flagging; a different metric with a similar name is not.

A false contradiction wastes the reader's attention and makes the system less trustworthy. When unsure, say they do not contradict and explain why.`;

const RELATIONS_SYSTEM = `Identify how two pieces of knowledge relate, if they relate at all.

Only propose a relationship you could justify to the person who wrote both. Prefer no relationship over a vague one: "related_to" between two notes that merely share a topic word adds noise to the graph and makes real connections harder to see.

Give each proposal an honest confidence. These become suggestions a human reviews, not facts.`;

/**
 * @param {unknown} n
 * @returns {number|null}
 */
function clamp(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(1, v));
}
