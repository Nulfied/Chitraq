/**
 * What to ask a general model, and what to do with what comes back.
 *
 * This is the whole of Chitraq's use of a language model, with the vendor
 * taken out. A provider supplies one function — `ask({system, user, schema})`
 * returning parsed JSON — and gets every model-backed capability back,
 * schemas, clamping and all.
 *
 * It was extracted from the Claude adapter, and the reason is worth writing
 * down. That adapter was the one piece of this project nobody had ever run:
 * an Anthropic key costs money, the author is a student, and "written but
 * never executed" is a bad thing to ship however carefully it reads. Every
 * prompt, every schema and every parser lived inside it, so none of that
 * could be exercised either.
 *
 * Moving it here changes what is unverifiable. A free provider speaking the
 * OpenAI shape runs this exact file — same prompts, same schemas, same result
 * mapping — so the part that decides what Chitraq asks and what it believes
 * is exercised for real. What remains untested in `anthropic.js` is the SDK
 * call itself: forty lines of request construction. That is a much smaller
 * thing to be honest about.
 *
 * Two rules the prompts hold throughout, and they are the reason this file is
 * long:
 *
 *   **Grounding.** Answer only from the supplied memory, cite the ids used,
 *   and say plainly when memory does not contain the answer. A confident
 *   answer with no support in the user's own material is the worst failure a
 *   memory engine has, so `grounded: false` is a correct outcome rather than
 *   a failed call.
 *
 *   **The boundary.** Nothing here writes to memory. Results become
 *   proposals, and a person accepts them.
 */

import { Capability } from '../registry.js';

/**
 * @typedef {(req: {system: string, user: string, schema: object, think?: boolean}) => Promise<any>} Ask
 */

/** What each capability is worth and costs, per provider. */
const DEFAULT_TUNING = {
  [Capability.Answer]: { quality: 0.95, latencyMs: 4000, costMicros: 3000 },
  [Capability.ExtractClaims]: { quality: 0.9, latencyMs: 3500, costMicros: 2000 },
  [Capability.Summarize]: { quality: 0.92, latencyMs: 2500, costMicros: 1200 },
  [Capability.DetectConflict]: { quality: 0.9, latencyMs: 2500, costMicros: 1500 },
  [Capability.ProposeRelations]: { quality: 0.88, latencyMs: 2500, costMicros: 1500 },
  [Capability.InterpretQuery]: { quality: 0.85, latencyMs: 1500, costMicros: 600 },
  [Capability.ExtractEntities]: { quality: 0.85, latencyMs: 2500, costMicros: 1200 },
};

/**
 * The capabilities a general model can serve, built around one `ask`.
 *
 * @param {{ask: Ask, tuning?: Record<string, {quality?: number, latencyMs?: number, costMicros?: number}>}} opts
 * @returns {Record<string, any>}
 */
export function groundedCapabilities({ ask, tuning = {} }) {
  /** @param {string} capability */
  const spec = (capability) => ({ ...DEFAULT_TUNING[capability], ...(tuning[capability] ?? {}) });

  return {
    [Capability.Answer]: {
      ...spec(Capability.Answer),
      run: async (/** @type {any} */ task) => {
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
      ...spec(Capability.ExtractClaims),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: EXTRACT_SYSTEM,
          user: `Source title: ${task.title ?? '(untitled)'}\n\n---\n${task.text}\n---`,
          schema: CLAIMS_SCHEMA,
        });
        return {
          claims: (result.claims ?? []).slice(0, task.limit ?? 20).map((/** @type {any} */ c) => ({
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
      ...spec(Capability.Summarize),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: SUMMARY_SYSTEM,
          user: `Summarise in at most ${task.maxSentences ?? 3} sentences:\n\n${task.text}`,
          schema: SUMMARY_SCHEMA,
        });
        return {
          summary: result.summary,
          method: 'generated',
          uncertainty: result.faithful
            ? null
            : 'The source text was too fragmentary to summarise reliably.',
        };
      },
    },

    [Capability.DetectConflict]: {
      ...spec(Capability.DetectConflict),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: CONFLICT_SYSTEM,
          user:
            `Statement A: ${task.a?.title}\n${task.a?.body ?? ''}\n\n` +
            `Statement B: ${task.b?.title}\n${task.b?.body ?? ''}`,
          schema: CONFLICT_SCHEMA,
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
      ...spec(Capability.ProposeRelations),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: RELATIONS_SYSTEM,
          user:
            `A (id ${task.a?.id}): ${task.a?.title}\n${task.a?.body ?? ''}\n\n` +
            `B (id ${task.b?.id}): ${task.b?.title}\n${task.b?.body ?? ''}`,
          schema: RELATIONS_SCHEMA,
        });
        return {
          relations: (result.relations ?? []).map((/** @type {any} */ r) => ({
            type: r.type,
            confidence: clamp(r.confidence) ?? 0.5,
            rationale: r.rationale,
          })),
        };
      },
    },

    [Capability.ExtractEntities]: {
      ...spec(Capability.ExtractEntities),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: ENTITIES_SYSTEM,
          user: String(task.text ?? ''),
          schema: ENTITIES_SCHEMA,
        });

        const text = String(task.text ?? '');
        return {
          entities: (result.entities ?? [])
            .filter((/** @type {any} */ e) => e?.text && ENTITY_TYPES.includes(e.type))
            .map((/** @type {any} */ e) => ({
              text: String(e.text).trim(),
              type: e.type,
              confidence: clamp(e.confidence) ?? 0.6,
              // The offset is computed here rather than taken from the model.
              // Asked for one, models produce a plausible integer that is
              // usually wrong, and the offset is what makes an entity point
              // back at the words it came from.
              offset: Math.max(0, text.indexOf(String(e.text))),
            }))
            .filter((/** @type {any} */ e) => e.text.length > 1),
          uncertainty:
            'Read by a model. It finds names the pattern-based floor cannot — ' +
            'people and organisations especially — and will occasionally invent ' +
            'a type or promote a passing mention. Everything here is a proposal.',
        };
      },
    },

    [Capability.InterpretQuery]: {
      ...spec(Capability.InterpretQuery),
      run: async (/** @type {any} */ task) => {
        const result = await ask({
          system: INTERPRET_SYSTEM,
          user: task.query,
          schema: INTERPRET_SCHEMA,
        });
        return { expansions: result.expansions ?? [], likelyKind: result.likely_kind ?? null };
      },
    },
  };
}

export const RELATION_TYPES = [
  'supports', 'contradicts', 'causes', 'caused_by', 'depends_on', 'part_of',
  'contains', 'related_to', 'similar_to', 'elaborates', 'precedes', 'follows',
  'answers_question',
];

export const ANSWER_SYSTEM = `You answer questions using only the fragments of the user's own memory supplied to you.

Rules, in order of importance:

1. Use only the supplied material. Do not use general knowledge, and do not fill gaps with what is usually true. If the material does not answer the question, set grounded to false and explain what is missing. That is a correct and useful answer.
2. Cite the bracketed object ids you actually used. Every claim in your answer must trace to a cited fragment.
3. Each fragment is labelled with its kind, epistemic status, origin and review state. Respect them. A fragment marked speculation or AI-derived and unreviewed is not evidence of the same weight as a confirmed observation, and your answer should say so rather than flatten the difference.
4. If the material contains a disagreement, present both sides and name it. Never resolve a contradiction silently by choosing the more convenient side.
5. Where material carries dates, prefer the more recent unless the question is about history — and say which you used.
6. Be brief. The user wrote this material; they do not need it explained back at length.`;

/** @param {any} task */
export function answerPrompt(task) {
  return (
    `Question: ${task.question}\n\n` +
    `Material from memory:\n\n${task.rendered ?? ''}\n\n` +
    (task.conflicts?.length
      ? `Note: ${task.conflicts.length} known disagreement(s) are flagged in the material above. Address them.\n\n`
      : '') +
    'Answer using only the material above.'
  );
}

export const ANSWER_SCHEMA = {
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

export const EXTRACT_SYSTEM = `Split the text into standalone units of knowledge worth remembering.

Each unit must:
- stand on its own, readable a year from now without the surrounding document
- be stated in the source's own terms; do not embellish, generalise or conclude beyond it
- carry the right epistemic status: something measured is an observation, something settled is a decision, something floated is a hypothesis, something guessed is speculation

Do not extract pleasantries, headings, navigation or restatements of the same point. Ten good units beat forty weak ones. If the text contains nothing worth remembering, return an empty list.`;

export const CLAIMS_SCHEMA = {
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

export const SUMMARY_SYSTEM =
  'Summarise the text faithfully. Do not add facts, figures, names or conclusions ' +
  'that are not present in it. If the text is too fragmentary to summarise, say so.';

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'faithful'],
  properties: {
    summary: { type: 'string' },
    faithful: {
      type: 'boolean',
      description: 'false if the text could not be summarised without inventing',
    },
  },
};

export const CONFLICT_SYSTEM = `Decide whether two statements genuinely contradict each other.

They contradict only if they are about the same subject and cannot both be true at the same time. Two statements are NOT in contradiction merely because they differ in wording, cover different periods, describe different scopes, or one is more specific than the other. A later correction of an earlier figure is a contradiction worth flagging; a different metric with a similar name is not.

A false contradiction wastes the reader's attention and makes the system less trustworthy. When unsure, say they do not contradict and explain why.`;

export const CONFLICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['contradicts', 'confidence', 'reason'],
  properties: {
    contradicts: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    same_subject: { type: 'boolean' },
  },
};

export const RELATIONS_SYSTEM = `Identify how two pieces of knowledge relate, if they relate at all.

Only propose a relationship you could justify to the person who wrote both. Prefer no relationship over a vague one: "related_to" between two notes that merely share a topic word adds noise to the graph and makes real connections harder to see.

Give each proposal an honest confidence. These become suggestions a human reviews, not facts.`;

export const RELATIONS_SCHEMA = {
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
};

/**
 * The types an entity may have.
 *
 * Deliberately not the full extraction vocabulary. Dates, money and
 * percentages are *values*, and `entityTypeFor` drops them on the way in —
 * making every "40%" a node would swamp the graph. Asking the model for them
 * would spend tokens producing things the next function discards.
 */
export const ENTITY_TYPES = [
  'name',
  'organisation',
  'place',
  'product',
  'project',
  'concept',
  'identifier',
];

export const ENTITIES_SYSTEM = `Find the named things in the text: people, organisations, places, products, projects, and identifiers such as ticket or model numbers.

Rules:
- Use the exact span as it appears. Do not expand abbreviations, correct spelling, or resolve pronouns.
- A title-cased phrase is not automatically a name. Headings, section labels and ordinary nouns that happen to be capitalised are not entities.
- \`name\` means a person. An organisation is not a person, and a product named after its founder is a product.
- Prefer missing a doubtful one to inventing a confident one. Ten real entities beat forty guesses.
- Give an honest confidence. These become proposals a human reviews, not facts.
- If the text names nothing, return an empty list. That is a correct answer.`;

export const ENTITIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entities'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'type', 'confidence'],
        properties: {
          text: { type: 'string', description: 'the exact span from the text' },
          type: { type: 'string', enum: ENTITY_TYPES },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

export const INTERPRET_SYSTEM =
  'Rewrite the search query to improve recall over a personal knowledge base. ' +
  'Add synonyms and likely alternative phrasings the writer might have used. ' +
  'Do not answer the question and do not invent proper nouns.';

export const INTERPRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['expansions'],
  properties: {
    expansions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    likely_kind: { type: 'string' },
  },
};

/**
 * @param {unknown} n
 * @returns {number|null}
 */
function clamp(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return null;
  return Math.max(0, Math.min(1, v));
}
