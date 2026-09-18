/**
 * The deterministic floor.
 *
 * Every capability Chitraq defines has an implementation here that runs
 * locally, offline, for free, with no model and no network, and returns the
 * same output for the same input forever.
 *
 * These are not placeholders waiting for a "real" model. They are the reason
 * INVARIANT 9 and 24 hold: a Chitraq install with no API keys, no GPU and no
 * internet still captures, indexes, searches, extracts, summarises, answers
 * from its own memory, and flags contradictions. A better model raises the
 * ceiling; it does not move the floor.
 *
 * Each one is honest about its quality score, so the router prefers a real
 * model whenever one is configured and reachable.
 */

import { Capability } from '../registry.js';
import { isKnownPlace } from '../../core/gazetteer.js';
import {
  contentTerms, matchTerms, tokenize, sentences, charNgrams, termFrequency,
  lexicalSimilarity, estimateTokens, normalise,
} from '../../core/text.js';
import { parse } from '../../retrieval/query.js';
import { hash } from '../../core/ids.js';

/** Embedding width. 256 float32 = 1 KB per chunk. */
export const EMBED_DIM = 256;
export const EMBED_MODEL = 'chitraq-hashing-ngram-v1';

/**
 * Build the deterministic provider.
 * @param {import('node:sqlite').DatabaseSync} [db] enables corpus-aware IDF
 * @returns {import('../registry.js').Provider}
 */
export function deterministicProvider(db) {
  return {
    id: 'builtin',
    label: 'Built-in (deterministic, offline)',
    locality: 'local',
    cost: 'free',
    model: EMBED_MODEL,
    modelVersion: '1',
    deterministic: true,
    capabilities: {
      [Capability.EmbedText]: {
        quality: 0.35,
        latencyMs: 2,
        costMicros: 0,
        run: async (task) => ({
          model: EMBED_MODEL,
          dim: EMBED_DIM,
          vectors: (task.texts ?? []).map(embed),
        }),
      },

      [Capability.ExtractKeywords]: {
        quality: 0.55,
        latencyMs: 3,
        costMicros: 0,
        run: async (task) => ({
          keywords: keywords(task.text ?? '', { db, workspaceId: task.workspaceId, limit: task.limit ?? 10 }),
          method: 'tf-idf over this workspace',
        }),
      },

      [Capability.ExtractEntities]: {
        quality: 0.4,
        latencyMs: 5,
        costMicros: 0,
        run: async (task) => ({
          entities: entities(task.text ?? ''),
          uncertainty:
            'Pattern-based. High precision on dates, URLs, emails and quantities. '
            + 'Places come from a short list of countries and large cities plus phrases like '
            + '"based in"; products and projects from phrasing like "the billing API" or '
            + '"the Atlas migration". Everything else capitalised is a guess.',
        }),
      },

      [Capability.ExtractClaims]: {
        quality: 0.35,
        latencyMs: 8,
        costMicros: 0,
        run: async (task) => ({
          claims: claims(task.text ?? '', task.limit ?? 12),
          uncertainty: 'Sentence segmentation with heuristic filtering. Splits text into candidate claims; it does not understand them.',
        }),
      },

      [Capability.Summarize]: {
        quality: 0.4,
        latencyMs: 6,
        costMicros: 0,
        run: async (task) => ({
          summary: summarize(task.text ?? '', task.maxSentences ?? 3),
          method: 'extractive',
          uncertainty: 'Sentences selected from the original text, not rewritten.',
        }),
      },

      [Capability.InterpretQuery]: {
        quality: 0.6,
        latencyMs: 1,
        costMicros: 0,
        run: async (task) => ({ intent: parse(task.query ?? '') }),
      },

      [Capability.ClassifyKind]: {
        quality: 0.45,
        latencyMs: 2,
        costMicros: 0,
        run: async (task) => classifyKind(task.text ?? '', task.title ?? ''),
      },

      [Capability.Answer]: {
        quality: 0.3,
        latencyMs: 10,
        costMicros: 0,
        run: async (task) => extractiveAnswer(task),
      },

      [Capability.ProposeRelations]: {
        quality: 0.35,
        latencyMs: 4,
        costMicros: 0,
        run: async (task) => proposeRelations(task),
      },

      [Capability.DetectConflict]: {
        quality: 0.4,
        latencyMs: 4,
        costMicros: 0,
        run: async (task) => detectConflict(task.a, task.b),
      },

      [Capability.Rerank]: {
        quality: 0.4,
        latencyMs: 3,
        costMicros: 0,
        run: async (task) => ({ ranking: rerank(task.query ?? '', task.candidates ?? []) }),
      },
    },
  };
}

// --------------------------------------------------------------- embedding

/**
 * Hashed bag-of-features embedding.
 *
 * Each content term and each character trigram is hashed to a dimension with
 * a signed weight; the result is L2-normalised so cosine similarity behaves.
 * Trigrams are what make it tolerant of typos and word endings — "memory" and
 * "memories" share most of their trigrams and land close together.
 *
 * Be clear about what this is: a fuzzy lexical vector, not a semantic one. It
 * will not connect "car" to "automobile". That is why it scores 0.35 and why
 * a real embedding model outranks it the moment one is available.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function embed(text) {
  const vec = new Float64Array(EMBED_DIM);
  const terms = contentTerms(text);
  if (!terms.length) return Array.from(vec);

  const tf = termFrequency(terms);

  for (const [term, count] of tf) {
    const weight = 1 + Math.log(count);
    project(vec, `w:${term}`, weight);
    // Trigrams carry less weight than the whole word: they are a similarity
    // aid, not the primary signal.
    for (const gram of charNgrams(term)) project(vec, `g:${gram}`, weight * 0.28);
  }

  let magnitude = 0;
  for (let i = 0; i < EMBED_DIM; i++) magnitude += vec[i] * vec[i];
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return Array.from(vec);

  const out = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = vec[i] / magnitude;
  return out;
}

/**
 * @param {Float64Array} vec
 * @param {string} feature
 * @param {number} weight
 */
function project(vec, feature, weight) {
  const h = hash(feature);
  const bucket = parseInt(h.slice(0, 8), 16) % EMBED_DIM;
  const sign = parseInt(h.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
  vec[bucket] += sign * weight;
}

// --------------------------------------------------------------- keywords

/**
 * TF-IDF keywords, scored against what this workspace actually contains.
 *
 * Using the user's own corpus rather than a generic frequency table is the
 * point: in a memory full of database notes, "index" is not distinctive, and
 * Chitraq knows that because it counted.
 *
 * @param {string} text
 * @param {{db?: any, workspaceId?: string, limit?: number}} opts
 * @returns {Array<{term: string, score: number}>}
 */
export function keywords(text, opts = {}) {
  const terms = contentTerms(text);
  if (!terms.length) return [];

  const tf = termFrequency(terms);
  const total = terms.length;
  const { docCount, docFreq } = corpusStats(opts.db, opts.workspaceId, [...tf.keys()]);

  // Where a term first appears. In a new or small workspace every term has the
  // same document frequency, so IDF carries no signal and ranking would decay
  // into "longest word wins". Position breaks that tie the way a reader would:
  // what a passage is about is usually named early.
  /** @type {Map<string, number>} */
  const firstAt = new Map();
  terms.forEach((t, i) => {
    if (!firstAt.has(t)) firstAt.set(t, i);
  });

  /** @type {Array<{term: string, score: number}>} */
  const scored = [];
  for (const [term, count] of tf) {
    const df = docFreq.get(term) ?? 0;
    // Smoothed IDF; with no corpus this collapses to a constant.
    const idf = Math.log((docCount + 1) / (df + 1)) + 1;
    const lengthBonus = Math.min(1.15, 1 + (term.length - 4) * 0.02);
    const position = (firstAt.get(term) ?? 0) / Math.max(total, 1);
    const positionBonus = 1.3 - 0.4 * Math.min(position / 0.4, 1);
    scored.push({ term, score: (count / total) * idf * lengthBonus * positionBonus });
  }

  scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  return scored.slice(0, opts.limit ?? 10).map((s) => ({ term: s.term, score: round(s.score) }));
}

/**
 * @param {any} db
 * @param {string|undefined} workspaceId
 * @param {string[]} terms
 */
function corpusStats(db, workspaceId, terms) {
  const empty = { docCount: 1, docFreq: new Map() };
  if (!db || !workspaceId || !terms.length) return empty;

  try {
    const docCount = Number(
      db.prepare('SELECT COUNT(*) AS n FROM chunk WHERE workspace_id = ?').get(workspaceId)?.n ?? 1
    );
    const rows = db
      .prepare(
        `SELECT term, doc_freq FROM term_stat
         WHERE workspace_id = ? AND term IN (${terms.map(() => '?').join(',')})`
      )
      .all(workspaceId, ...terms);
    return {
      docCount: Math.max(1, docCount),
      docFreq: new Map(rows.map((r) => [r.term, Number(r.doc_freq)])),
    };
  } catch {
    return empty;
  }
}

// --------------------------------------------------------------- entities

const ENTITY_PATTERNS = [
  { type: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, confidence: 0.98 },
  { type: 'url', re: /\bhttps?:\/\/[^\s<>"')]+/g, confidence: 0.98 },
  { type: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g, confidence: 0.95 },
  {
    type: 'date',
    re: /\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}?,?\s*\d{4}\b/gi,
    confidence: 0.9,
  },
  { type: 'money', re: /(?:[$£€₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|dollars|euros|rupees)\b)/gi, confidence: 0.92 },
  { type: 'percent', re: /\b\d+(?:\.\d+)?\s?%/g, confidence: 0.95 },
  { type: 'version', re: /\bv?\d+\.\d+(?:\.\d+)?\b/g, confidence: 0.7 },
  { type: 'identifier', re: /\b[A-Z]{2,}-\d+\b/g, confidence: 0.85 },
  { type: 'time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi, confidence: 0.85 },

  // Things named by the shape of the phrase around them rather than by the
  // words themselves. Each of these is a cue a person actually writes, which
  // is why they hold up: "the Atlas migration", "our Mumbai office",
  // "Postgres 16", "the billing API".
  {
    type: 'project',
    re: /\b(?:[Pp]roject\s+([A-Z][\w-]*)|(?:[Tt]he\s+)?((?![Tt]he\b)[A-Z][\w-]*(?:[ \t](?!migration|project)[A-Z][\w-]*)?)\s+(?:project|migration|rollout|initiative|programme|program|rewrite))\b/g,
    confidence: 0.7,
    group: 'first',
  },
  {
    type: 'product',
    re: /\b([A-Z][\w.+-]*(?:[ \t][A-Z][\w.+-]*)?)\s+(?:API|SDK|CLI|plugin|extension|library|framework|database|dashboard|service|app|platform|integration)\b/g,
    confidence: 0.65,
    group: 'first',
  },
  {
    // A capitalised name immediately followed by a version is a product
    // essentially always: "Postgres 16", "Node 24.18", "Python 3.11".
    type: 'product',
    re: /\b([A-Z][\w.+-]{2,})\s+v?\d+(?:\.\d+)*\b/g,
    confidence: 0.75,
    group: 'first',
  },
  {
    // Location cues. "in" alone is far too loose — it introduces as many
    // abstractions as places — so this takes only the phrasings that are
    // almost always geographic.
    type: 'place',
    re: /\b(?:based\s+in|office\s+in|located\s+in|travel(?:l?ing)?\s+to|flew\s+to|moved\s+to|shipped\s+to|headquartered\s+in)\s+([A-Z][\p{Ll}]+(?:[ \t][A-Z][\p{Ll}]+)?)/gu,
    confidence: 0.75,
    group: 'first',
  },
];

/**
 * Pattern-based entity candidates.
 *
 * Structured entities (dates, money, ids) are found reliably. Proper names are
 * inferred from capitalisation, which is a guess — and is labelled as one,
 * with a lower confidence, so nothing downstream mistakes it for knowledge.
 *
 * @param {string} text
 * @returns {Array<{text: string, type: string, confidence: number, offset: number}>}
 */
export function entities(text) {
  if (!text) return [];
  /** @type {Map<string, any>} */
  const found = new Map();

  for (const { type, re, confidence, group } of ENTITY_PATTERNS) {
    for (const m of text.matchAll(re)) {
      // Cue patterns match a phrase but mean only the name inside it: "based in
      // Pune" is a place called Pune, not one called "based in Pune".
      const value = (group === 'first' ? firstGroup(m) : m[0])?.trim();
      if (!value) continue;

      remember(found, { text: value, type, confidence, offset: m.index ?? 0 });
    }
  }

  // Capitalised runs: a proper-name signal.
  //
  // The separator is [ \t]+ and not \s+ on purpose. \s crosses newlines, so a
  // title ending in a name followed by a body starting with the same name gets
  // captured as one four-word "name" spanning the break.
  //
  // Sentence-initial capitals used to be skipped outright, because the first
  // word of a sentence is capitalised for grammar rather than because it names
  // anything. That also threw away every name that happened to start a
  // sentence — "Priya Sharma at Acme" came back as "Sharma". The rule is now
  // narrower: at a sentence start a single capitalised word proves nothing, but
  // a run of them still does.
  for (const m of text.matchAll(/\b([A-Z][\p{Ll}]+(?:[ \t]+(?:of|and|&|[A-Z][\p{Ll}]*)){0,3})\b/gu)) {
    // A leading article or cue word is grammar, not part of the name. Left in,
    // "The Atlas migration" yields a person called The Atlas, and "Project
    // Nimbus" one called Project Nimbus — both alongside the correct project.
    const value = m[1]
      .trim()
      .replace(/\s+(of|and|&)$/i, '')
      .replace(LEADING_NOISE, '')
      .trim();
    if (value.length < 3) continue;
    if (STOPISH_CAPS.has(value.toLowerCase())) continue;

    const atSentenceStart = startsSentence(text, m.index ?? 0);
    if (atSentenceStart && !value.includes(' ')) continue;

    const multiWord = value.includes(' ');
    remember(found, {
      text: value,
      type: typeOfCapitalisedRun(value),
      // A multi-word capitalised run is a fair bet. A single capitalised word
      // is not — it is as likely to be a product, a month or the start of a
      // clause the sentence splitter mishandled.
      //
      // Position deliberately does not change this number. What position tells
      // you is whether the *first* capital is informative, and that is already
      // handled above by dropping single words at a sentence start. Demoting a
      // run as well pushed real names under the linking threshold, which is a
      // worse error than the one it guarded against.
      confidence: multiWord ? 0.65 : 0.35,
      offset: m.index ?? 0,
    });
  }

  return [...found.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * What a bare capitalised phrase most likely is.
 *
 * Order matters and encodes confidence. A legal suffix is decisive; a known
 * place name is nearly so; everything left over falls to "name", which is the
 * guess it has always been and is still labelled as one.
 *
 * @param {string} value
 */
function typeOfCapitalisedRun(value) {
  if (ORG_SUFFIX.test(value)) return 'organisation';
  if (isKnownPlace(value)) return 'place';
  return 'name';
}

/**
 * Record a candidate, keyed on the name rather than on the pattern that found
 * it.
 *
 * Several patterns legitimately hit the same word: "based in Pune" says place
 * with confidence, and the capitalised-run sweep says it again with a shrug.
 * Keying on type as well would emit both, and the graph would end up with two
 * Punes — one a place, one a guess at a person. The strongest reading wins, and
 * the earliest position is kept so ordering stays stable.
 *
 * @param {Map<string, any>} found
 * @param {{text: string, type: string, confidence: number, offset: number}} candidate
 */
function remember(found, candidate) {
  const key = normalise(candidate.text);
  const existing = found.get(key);
  if (!existing) {
    found.set(key, candidate);
    return;
  }
  if (candidate.confidence > existing.confidence) {
    found.set(key, { ...candidate, offset: Math.min(existing.offset, candidate.offset) });
  }
}

/**
 * Is this position the first word of a sentence, where a capital means nothing?
 *
 * @param {string} text
 * @param {number} index
 */
function startsSentence(text, index) {
  if (index === 0) return true;
  return /(?:^|[.!?:;]|\n)\s*$/.test(text.slice(Math.max(0, index - 12), index));
}

/** @param {RegExpMatchArray} m */
function firstGroup(m) {
  for (let i = 1; i < m.length; i++) if (m[i]) return m[i];
  return null;
}

/** Legal-form suffixes that reliably mark an organisation rather than a person. */
const ORG_SUFFIX = /\b(ltd|limited|inc|llc|llp|plc|gmbh|corp|corporation|company|co|group|holdings|partners|labs|technologies|systems|foundation|university|institute)\b\.?$/i;

/**
 * Words that introduce a name without being part of it.
 *
 * Kept short on purpose. Every addition here is a word that can never begin a
 * real name, and the list stops being safe the moment that is only mostly true.
 */
const LEADING_NOISE = /^(?:The|A|An|This|That|These|Those|Our|My|Their|Its|Project|Team|Mr|Mrs|Ms|Dr)\s+/;

const STOPISH_CAPS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'the', 'this', 'that', 'there',
  'we', 'i', 'it', 'they', 'he', 'she', 'but', 'and', 'if', 'when', 'however',
]);

// ----------------------------------------------------------------- claims

/**
 * Split text into candidate Knowledge Objects.
 *
 * This is segmentation, not comprehension: it finds sentences that look like
 * standalone assertions and labels their likely kind and epistemic status from
 * surface cues ("we decided" -> decision, "might" -> hypothesis). Everything
 * it returns is a *proposal* that a human or a stronger model reviews.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {Array<{text: string, kind: string, epistemic: string, confidence: number, offset: number}>}
 */
export function claims(text, limit = 12) {
  const out = [];
  let cursor = 0;

  for (const sentence of sentences(text)) {
    const offset = Math.max(text.indexOf(sentence, cursor), 0);
    cursor = offset + 1;

    const terms = contentTerms(sentence);
    // Too short to stand alone, or too long to be one claim.
    if (terms.length < 4 || estimateTokens(sentence) > 120) continue;
    // Questions are captured as questions, not asserted as claims.
    const isQuestion = /\?\s*$/.test(sentence);

    const { kind, epistemic, confidence } = classifySentence(sentence, isQuestion);
    out.push({ text: sentence.trim(), kind, epistemic, confidence, offset });
    if (out.length >= limit) break;
  }

  return out;
}

const CUES = [
  { re: /\b(we|i|they)\s+(decided|agreed|chose|will use|are going to use|settled on)\b/i, kind: 'decision', epistemic: 'conclusion', confidence: 0.7 },
  { re: /\b(decision|decided|resolution)\b/i, kind: 'decision', epistemic: 'conclusion', confidence: 0.55 },
  { re: /\b(learned|lesson|takeaway|in hindsight|next time)\b/i, kind: 'lesson', epistemic: 'conclusion', confidence: 0.6 },
  { re: /\b(might|may|could|possibly|perhaps|suspect|hypothes|unclear whether)\b/i, kind: 'hypothesis', epistemic: 'hypothesis', confidence: 0.6 },
  { re: /\b(because|therefore|so that|which means|as a result)\b/i, kind: 'note', epistemic: 'inference', confidence: 0.5 },
  { re: /\b(measured|observed|recorded|saw|showed|reported|result was)\b/i, kind: 'observation', epistemic: 'observation', confidence: 0.6 },
  { re: /\b(must|should|need to|todo|action item|follow up)\b/i, kind: 'task', epistemic: 'belief', confidence: 0.55 },
  { re: /\b(is|are|was|were|has|have)\b.*\b\d/i, kind: 'fact', epistemic: 'fact', confidence: 0.5 },
];

/**
 * @param {string} sentence
 * @param {boolean} isQuestion
 */
function classifySentence(sentence, isQuestion) {
  if (isQuestion) return { kind: 'question', epistemic: 'belief', confidence: 0.75 };
  for (const cue of CUES) {
    if (cue.re.test(sentence)) {
      return { kind: cue.kind, epistemic: cue.epistemic, confidence: cue.confidence };
    }
  }
  return { kind: 'note', epistemic: 'observation', confidence: 0.4 };
}

/**
 * @param {string} text
 * @param {string} title
 */
export function classifyKind(text, title) {
  const combined = `${title}\n${text}`;
  for (const cue of CUES) {
    if (cue.re.test(combined)) {
      return { kind: cue.kind, epistemic: cue.epistemic, confidence: cue.confidence, by: 'cue' };
    }
  }
  return { kind: 'note', epistemic: 'observation', confidence: 0.35, by: 'default' };
}

// -------------------------------------------------------------- summarize

/**
 * Extractive summary: the highest-signal sentences, in their original order
 * and original words.
 *
 * It never paraphrases, so it cannot hallucinate — the worst case is that it
 * picks the wrong sentences, which a reader can see immediately.
 *
 * @param {string} text
 * @param {number} maxSentences
 * @returns {string}
 */
export function summarize(text, maxSentences = 3) {
  const all = sentences(text);
  if (all.length <= maxSentences) return text.trim();

  const docTerms = contentTerms(text);
  const freq = termFrequency(docTerms);
  const maxFreq = Math.max(...freq.values(), 1);

  const scored = all.map((sentence, i) => {
    const terms = contentTerms(sentence);
    if (!terms.length) return { i, sentence, score: 0 };

    const density = terms.reduce((sum, t) => sum + (freq.get(t) ?? 0) / maxFreq, 0) / terms.length;
    // Opening sentences usually carry the thesis.
    const position = i === 0 ? 1.35 : i === 1 ? 1.15 : i >= all.length - 1 ? 1.05 : 1;
    // Very short and very long sentences make poor summary lines.
    const lengthFit = terms.length < 5 ? 0.6 : terms.length > 45 ? 0.75 : 1;

    return { i, sentence, score: density * position * lengthFit };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((s) => s.sentence.trim())
    .join(' ');
}

// ----------------------------------------------------------------- answer

/**
 * Answer a question from assembled context, without generating prose.
 *
 * It selects and quotes the passages from memory that best match the question,
 * each with the id it came from. When nothing matches well it says so rather
 * than padding — INVARIANT 23: missing evidence is not false evidence, and
 * "I don't have this" is a correct and useful answer.
 *
 * @param {{question: string, context: Array<{id: string, title: string, text: string}>}} task
 */
export function extractiveAnswer(task) {
  const question = task.question ?? '';
  // Stemmed, so "why did we drop redis" matches a note that says "we dropped".
  const queryTerms = new Set(matchTerms(question));
  const context = task.context ?? [];

  if (!context.length) {
    return {
      answer: null,
      grounded: false,
      confidence: 0,
      passages: [],
      uncertainty: 'Nothing in memory matched this question.',
      method: 'extractive',
    };
  }

  /** @type {Array<{objectId: string, title: string, text: string, score: number, superseded: boolean}>} */
  const passages = [];

  for (const item of context) {
    const superseded = item.state === 'superseded' || item.state === 'archived';

    // The title is part of what a passage says. A note titled "Engineering
    // headcount" whose body reads "the team is fifteen people" answers "what is
    // the engineering headcount" completely — but only if the title counts.
    const titleTerms = new Set(matchTerms(item.title ?? ''));

    for (const sentence of sentences(item.text ?? '')) {
      const terms = matchTerms(sentence);
      if (terms.length < 3) continue;

      const matched = new Set();
      for (const t of terms) if (queryTerms.has(t)) matched.add(t);
      for (const t of titleTerms) if (queryTerms.has(t)) matched.add(t);
      if (!matched.size) continue;

      // Normalise by query size, not sentence size, so a long informative
      // sentence is not penalised for also saying other things.
      const score = matched.size / Math.max(queryTerms.size, 1);
      passages.push({
        objectId: item.id,
        title: item.title,
        text: sentence.trim(),
        score: round(score),
        matched: [...matched],
        superseded,
      });
    }
  }

  passages.sort((a, b) => b.score - a.score);

  // Quoting a superseded statement beside a current one, with nothing to tell
  // them apart, states two contradictory things as equally true.
  //
  // Which one answers the question depends on what was asked. "What is our
  // pricing" wants the current figure; "what did pricing used to be" wants the
  // one it replaced. Same material, opposite answers — so the question decides
  // which set leads, and the other is reported separately and labelled.
  const current = passages.filter((p) => !p.superseded);
  const replaced = passages.filter((p) => p.superseded);

  const preferReplaced = !!task.retrospective && replaced.length > 0;
  const lead = preferReplaced ? replaced : current.length ? current : replaced;
  const aside = preferReplaced ? current : replaced;

  const best = lead.slice(0, 4);
  const alsoReplaced = aside.slice(0, 2);

  if (!best.length || best[0].score < 0.15) {
    return {
      answer: null,
      grounded: false,
      confidence: passages.length ? round(passages[0].score * 0.5) : 0,
      passages: passages.slice(0, 3),
      uncertainty:
        'Memory contains related material but nothing that answers this directly. ' +
        'Shown as related items rather than an answer.',
      method: 'extractive',
    };
  }

  const quotingReplaced = best.some((p) => p.superseded);

  return {
    answer: best.map((p) => p.text).join(' '),
    grounded: true,
    confidence: extractiveConfidence(best, queryTerms),
    passages: best,
    alsoFound: alsoReplaced,
    citations: [...new Set(best.map((p) => p.objectId))],
    uncertainty:
      'Assembled by quoting the closest matching passages in your memory. ' +
      'Nothing here was written by a model; no wording was changed.' +
      (quotingReplaced
        ? ' This is superseded material — what you believed then, not what you believe now.'
        : '') +
      (alsoReplaced.length
        ? ` ${alsoReplaced.length} ${quotingReplaced ? 'current' : 'earlier'} version(s) were found and left out of the answer above.`
        : ''),
    method: 'extractive',
  };
}


/**
 * How much to trust an extractive answer.
 *
 * This is what decides whether a paid model gets called, so it measures the
 * two things that actually predict a good quote-based answer:
 *
 *   coverage — how much of the question the chosen passages between them
 *              address. A passage answering half the question is half an answer.
 *   strength — how well the single best passage matches. Several weak fragments
 *              are worse than one strong sentence, because quoting scattered
 *              fragments produces something that reads like an answer and is not.
 *
 * Deliberately conservative: when this is wrong it should be wrong downwards,
 * because the cost of under-confidence is a model call, and the cost of
 * over-confidence is a bad answer the user believes.
 *
 * @param {Array<{text: string, score: number}>} passages
 * @param {Set<string>} queryTerms
 * @returns {number} 0..1
 */
function extractiveConfidence(passages, queryTerms) {
  if (!passages.length || !queryTerms.size) return 0;

  const covered = new Set();
  for (const p of passages) {
    for (const t of p.matched ?? []) covered.add(t);
  }

  const coverage = covered.size / queryTerms.size;
  const strength = Math.min(1, passages[0].score);

  // One passage carrying the answer beats four that each carry a fragment.
  const concentration = passages.length <= 2 ? 1 : 0.85;

  return round(Math.min(1, (0.6 * coverage + 0.4 * strength) * concentration));
}

// -------------------------------------------------------------- relations

/**
 * Propose relationships between two objects from surface signals.
 * @param {{a: any, b: any, similarity?: number}} task
 */
export function proposeRelations(task) {
  const { a, b } = task;
  if (!a || !b) return { relations: [] };

  const textA = `${a.title ?? ''} ${a.body ?? ''}`;
  const textB = `${b.title ?? ''} ${b.body ?? ''}`;
  const similarity = task.similarity ?? lexicalSimilarity(textA, textB);

  /** @type {Array<{type: string, confidence: number, rationale: string}>} */
  const relations = [];

  if (similarity >= 0.55) {
    relations.push({
      type: 'similar_to',
      confidence: round(Math.min(0.8, similarity)),
      rationale: `${Math.round(similarity * 100)}% of content words are shared.`,
    });
  } else if (similarity >= 0.25) {
    relations.push({
      type: 'related_to',
      confidence: round(similarity),
      rationale: `${Math.round(similarity * 100)}% of content words are shared.`,
    });
  }

  const conflict = detectConflict(a, b);
  if (conflict.contradicts) {
    relations.push({
      type: 'contradicts',
      confidence: conflict.confidence,
      rationale: conflict.reason,
    });
  }

  // Temporal ordering is a fact about recorded time, not an inference.
  const whenA = a.occurred_at ?? a.created_at;
  const whenB = b.occurred_at ?? b.created_at;
  if (whenA && whenB && similarity >= 0.25 && whenA !== whenB) {
    relations.push({
      type: whenA < whenB ? 'precedes' : 'follows',
      confidence: 0.5,
      rationale: 'Ordering taken from recorded timestamps on related material.',
    });
  }

  return { relations, similarity: round(similarity) };
}

// -------------------------------------------------------------- conflicts

const NEGATIONS = /\b(not|no|never|cannot|can't|won't|doesn't|didn't|isn't|aren't|wasn't|weren't|without|failed to|rejected|dropped|abandoned)\b/i;

/**
 * Heuristic contradiction detection.
 *
 * Catches the two cases that are actually detectable without understanding:
 * the same subject given two different numbers, and the same statement with
 * and without a negation. It reports low confidence and explains its reason,
 * because a false "these contradict" is expensive for the reader.
 *
 * @param {any} a
 * @param {any} b
 * @returns {{contradicts: boolean, confidence: number, reason: string, detail?: object}}
 */
export function detectConflict(a, b) {
  if (!a || !b) return { contradicts: false, confidence: 0, reason: 'Nothing to compare.' };

  const textA = `${a.title ?? ''} ${a.body ?? ''}`.trim();
  const textB = `${b.title ?? ''} ${b.body ?? ''}`.trim();
  const overlap = lexicalSimilarity(textA, textB);

  // Statements about different things cannot contradict each other.
  if (overlap < 0.3) {
    return { contradicts: false, confidence: 0, reason: 'The two statements are not about the same thing.' };
  }

  const numbersA = extractNumbers(textA);
  const numbersB = extractNumbers(textB);
  if (numbersA.length && numbersB.length) {
    const differing = numbersA.filter(
      (n) => !numbersB.some((m) => m.unit === n.unit && Math.abs(m.value - n.value) < 1e-9)
    );
    const matchedUnits = numbersB.some((m) => numbersA.some((n) => n.unit === m.unit));
    if (matchedUnits && differing.length) {
      return {
        contradicts: true,
        confidence: round(Math.min(0.7, 0.35 + overlap * 0.5)),
        reason: `Both describe the same thing but give different figures (${numbersA
          .map((n) => n.raw)
          .join(', ')} vs ${numbersB.map((n) => n.raw).join(', ')}).`,
        detail: { a: numbersA, b: numbersB, overlap: round(overlap) },
      };
    }
  }

  const negA = NEGATIONS.test(textA);
  const negB = NEGATIONS.test(textB);
  if (negA !== negB && overlap >= 0.45) {
    return {
      contradicts: true,
      confidence: round(Math.min(0.6, 0.3 + overlap * 0.4)),
      reason: 'Highly similar statements where one is negated and the other is not.',
      detail: { overlap: round(overlap), negated: negA ? 'a' : 'b' },
    };
  }

  return {
    contradicts: false,
    confidence: 0,
    reason: 'Similar subject matter, but no detectable disagreement.',
    detail: { overlap: round(overlap) },
  };
}

/**
 * @param {string} text
 * @returns {Array<{value: number, unit: string, raw: string}>}
 */
function extractNumbers(text) {
  /** @type {Map<string, {value: number, unit: string, raw: string}>} */
  const found = new Map();

  // The trailing \b matters more than it looks: without it, the `m` branch
  // matches the first letter of "minutes" and silently turns "40 minutes" into
  // forty million. Longer words are also listed before their abbreviations so
  // "5 million" is not read as "5m illion".
  const NUMBER = /([$£€₹]?)\s?(\d[\d,]*(?:\.\d+)?)\s?(%|percent|thousand|million|billion|minutes?|mins?|seconds?|secs?|hours?|hrs?|days?|weeks?|months?|years?|people|usd|eur|gbp|inr|bn|k|m)?\b/gi;

  for (const m of text.matchAll(NUMBER)) {
    const raw = m[0].trim();
    let value = Number(m[2].replace(/,/g, ''));
    if (Number.isNaN(value)) continue;

    const suffix = (m[3] ?? '').toLowerCase();
    const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, billion: 1e9 }[suffix];
    if (scale) value *= scale;

    const unit = m[1] ? 'currency' : scale ? 'count' : normaliseUnit(suffix);

    // The same figure stated in a title and again in the body is one figure,
    // not two. Deduplicating keeps conflict messages readable.
    const key = `${unit}:${value}`;
    if (!found.has(key)) found.set(key, { value, unit, raw });
  }

  return [...found.values()];
}

/**
 * Collapse unit spellings so "40 mins" and "95 minutes" are comparable.
 * @param {string} suffix
 */
function normaliseUnit(suffix) {
  if (!suffix) return 'count';
  const base = suffix.replace(/s$/, '');
  return (
    { min: 'minute', sec: 'second', hr: 'hour', percent: '%' }[base] ?? base
  );
}

// ----------------------------------------------------------------- rerank

/**
 * Reorder candidates by term coverage and proximity: a candidate containing
 * the query terms close together beats one where they are scattered.
 * @param {string} query
 * @param {Array<{id: string, text: string}>} candidates
 */
export function rerank(query, candidates) {
  const queryTerms = contentTerms(query);
  const wanted = new Set(queryTerms);

  return candidates
    .map((c) => {
      const tokens = tokenize(c.text ?? '');
      const positions = new Map();
      tokens.forEach((t, i) => {
        if (wanted.has(t) && !positions.has(t)) positions.set(t, i);
      });

      const coverage = positions.size / Math.max(wanted.size, 1);
      const spread = positions.size > 1 ? Math.max(...positions.values()) - Math.min(...positions.values()) : 0;
      const proximity = positions.size > 1 ? 1 / (1 + spread / positions.size / 10) : 0.5;

      return { id: c.id, score: round(coverage * 0.75 + proximity * 0.25), coverage: round(coverage) };
    })
    .sort((a, b) => b.score - a.score);
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 1e4) / 1e4;
}
