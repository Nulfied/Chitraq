/**
 * Deterministic text analysis.
 *
 * Everything here runs offline with no model and produces the same output for
 * the same input, forever. This is what makes INVARIANT 24 real: when every
 * intelligence provider is unavailable, capture, indexing, search, keyword
 * extraction and summarisation still work.
 */

import { hash } from './ids.js';

/**
 * Common words carrying little retrieval signal. Kept deliberately small:
 * over-aggressive stopword lists destroy phrase queries like "the who" or
 * "to be or not to be".
 */
export const STOPWORDS = new Set(
  ('a an the and or but if then else of in on at to for from by with without about as is are was ' +
    'were be been being do does did doing have has had having i me my we our you your he she it ' +
    'they them this that these those there here what which who whom when where why how not no nor ' +
    'so than too very can will just should now also into over under again further once ' +
    // Discourse connectives and determiners. These survive tokenisation, look
    // distinctive to TF-IDF in a small corpus, and crowd real keywords out of
    // the top ten until the corpus grows large enough to suppress them.
    'because therefore however although while whereas since thus hence moreover furthermore ' +
    'their its his her our us am being would could might must shall may ' +
    'such more most many much some any all both each every other another same ' +
    'one two three first second next last new old own via per upon within')
    .split(' ')
);

/**
 * Split text into normalised terms: lowercased, diacritics folded, punctuation
 * dropped, but digits and intra-word hyphens/dots kept so that "gpt-4",
 * "v1.2" and "2025" survive as single terms.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  return normalise(text)
    .split(/[^\p{L}\p{N}._-]+/u)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((t) => t.length > 0 && t.length < 64);
}

/**
 * Content terms: tokens minus stopwords and bare short numbers.
 * @param {string} text
 * @returns {string[]}
 */
export function contentTerms(text) {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d{1,3}$/.test(t));
}

/**
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Split into sentences. Handles the common abbreviation traps (Dr., e.g.,
 * i.e., U.S.) that would otherwise shatter a sentence mid-way.
 * @param {string} text
 * @returns {string[]}
 */
export function sentences(text) {
  if (!text) return [];
  const guarded = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|no|fig|vol|ch)\./gi, (m) =>
      m.replace('.', '')
    )
    .replace(/\b([A-Z])\./g, '$1');

  return guarded
    .split(/(?<=[.!?])[\s\n]+(?=[A-Z0-9"'\[(])|\n{2,}/)
    .map((s) => s.replace(//g, '.').trim())
    .filter(Boolean);
}

/**
 * Rough token count for context budgeting.
 *
 * This is an estimate and is named like one. Chitraq budgets context in
 * these units and leaves headroom rather than pretending to know a specific
 * tokenizer's exact count — different providers tokenize differently, and
 * the memory engine must not be coupled to any one of them.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  // ~4 characters per token for prose, with a floor based on whitespace runs
  // so that dense code or CJK text is not badly under-counted.
  const byChars = Math.ceil(text.length / 4);
  const byWords = Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
  return Math.max(byChars, byWords);
}

/**
 * Character n-grams, used by the deterministic embedding so that typos and
 * morphological variants ("memories"/"memory") still land near each other.
 * @param {string} term
 * @param {number} [n]
 * @returns {string[]}
 */
export function charNgrams(term, n = 3) {
  const padded = `#${term}#`;
  if (padded.length <= n) return [padded];
  const out = [];
  for (let i = 0; i <= padded.length - n; i++) out.push(padded.slice(i, i + n));
  return out;
}

/**
 * Term frequency map.
 * @param {string[]} terms
 * @returns {Map<string, number>}
 */
export function termFrequency(terms) {
  const tf = new Map();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Split text for indexing and context assembly.
 *
 * Chunks break on paragraph boundaries first and sentence boundaries second,
 * never mid-sentence, because a retrieved fragment that starts halfway through
 * a clause is unusable as evidence. Consecutive chunks overlap by one sentence
 * so a claim spanning a boundary is still findable whole.
 *
 * @param {string} text
 * @param {{maxTokens?: number, overlapSentences?: number}} [opts]
 * @returns {Array<{seq: number, text: string, tokens: number, offset: number}>}
 */
export function chunk(text, opts = {}) {
  const maxTokens = opts.maxTokens ?? 220;
  const overlap = opts.overlapSentences ?? 1;
  if (!text?.trim()) return [];

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  /** @type {Array<{seq: number, text: string, tokens: number, offset: number}>} */
  const chunks = [];

  /** @type {string[]} */
  let buffer = [];
  let bufferTokens = 0;
  let searchFrom = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join(' ').trim();
    if (!body) return;
    const offset = Math.max(text.indexOf(buffer[0], searchFrom), 0);
    searchFrom = offset + 1;
    chunks.push({ seq: chunks.length, text: body, tokens: estimateTokens(body), offset });
    buffer = overlap > 0 ? buffer.slice(-overlap) : [];
    bufferTokens = buffer.reduce((n, s) => n + estimateTokens(s), 0);
  };

  for (const para of paragraphs) {
    for (const sentence of sentences(para)) {
      const size = estimateTokens(sentence);

      // A single sentence longer than the budget is split on whitespace rather
      // than dropped: losing content to keep a tidy chunk size is the wrong trade.
      if (size > maxTokens) {
        flush();
        for (const piece of hardSplit(sentence, maxTokens)) {
          chunks.push({
            seq: chunks.length,
            text: piece,
            tokens: estimateTokens(piece),
            offset: Math.max(text.indexOf(piece, searchFrom), 0),
          });
        }
        buffer = [];
        bufferTokens = 0;
        continue;
      }

      if (bufferTokens + size > maxTokens) flush();
      buffer.push(sentence);
      bufferTokens += size;
    }
    // Paragraph boundaries are meaningful; prefer to end a chunk here.
    if (bufferTokens > maxTokens * 0.6) flush();
  }
  flush();

  return chunks.map((c, i) => ({ ...c, seq: i }));
}

/**
 * @param {string} text
 * @param {number} maxTokens
 * @returns {string[]}
 */
function hardSplit(text, maxTokens) {
  const words = text.split(/\s+/);
  const perChunk = Math.max(1, Math.floor(maxTokens / 1.3));
  const out = [];
  for (let i = 0; i < words.length; i += perChunk) out.push(words.slice(i, i + perChunk).join(' '));
  return out;
}

/**
 * Stable hash of a chunk's text, used to skip re-indexing unchanged content.
 * @param {string} text
 */
export function chunkHash(text) {
  return hash('chunk', text);
}

/**
 * Build a short excerpt around the first match, for search results and evidence.
 * @param {string} text
 * @param {string[]} terms
 * @param {number} [width]
 * @returns {string}
 */
export function excerpt(text, terms, width = 240) {
  if (!text) return '';
  const hay = normalise(text);
  let at = -1;
  for (const t of terms) {
    const i = hay.indexOf(normalise(t));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, width) + (text.length > width ? '…' : '');

  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/**
 * Jaccard similarity over content terms. Deterministic, cheap, and honest
 * about what it measures: shared vocabulary, not shared meaning.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
export function lexicalSimilarity(a, b) {
  const A = new Set(contentTerms(a));
  const B = new Set(contentTerms(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}
