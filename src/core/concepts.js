/**
 * Concepts: the things you keep coming back to.
 *
 * Every other entity kind has a surface you can find it by. A person is a
 * capitalised run, an organisation ends in "Ltd", a place is named in a
 * gazetteer or introduced by "based in". A concept has none of that.
 * "Idempotency" and "onboarding" and "technical debt" look exactly like
 * ordinary words, because they are ordinary words.
 *
 * So this does not look at any single note. It looks at the whole workspace and
 * asks which phrases keep reappearing across *different* pieces of knowledge. A
 * phrase you wrote once is a phrase. A phrase running through nine separate
 * notes written weeks apart is something you think in.
 *
 * That definition has a property worth having: it cannot be fooled by one long
 * document. Frequency is counted in documents, never in occurrences, so a
 * transcript saying "action item" forty times contributes exactly one.
 *
 * Everything found here is a *suggestion*. Concepts are the least certain
 * entity kind and the easiest to get wrong, so nothing is created
 * automatically — the proposal gateway and a human stand between this and
 * memory, as they do for everything an algorithm believes.
 */

import { tokenize, STOPWORDS } from './text.js';
import { plainAll } from './db.js';
import { canonicalise } from './entities.js';

/** A phrase in fewer documents than this is not yet a pattern. */
export const MIN_DOCUMENTS = 3;

/** Phrase lengths considered. One word is usually a topic, four is a sentence. */
const SIZES = [2, 3];

/**
 * Words that end a phrase without being part of it, or that make a phrase
 * grammatical rather than conceptual. A phrase starting or ending on one of
 * these is a fragment: "of the database", "we decided".
 */
const EDGE_NOISE = new Set([
  ...STOPWORDS,
  'we', 'i', 'it', 'they', 'you', 'he', 'she', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'will', 'would', 'should', 'could', 'may', 'might', 'must',
  'get', 'got', 'make', 'made', 'use', 'used', 'using', 'go', 'going', 'went',
  'very', 'really', 'quite', 'just', 'also', 'still', 'now', 'then', 'here', 'there',
  'only', 'even', 'never', 'always', 'often', 'rather', 'else', 'simply', 'merely',
  'one', 'two', 'three', 'first', 'last', 'next', 'new', 'old', 'more', 'most',
  'good', 'bad', 'big', 'small', 'own', 'same', 'other', 'another', 'much', 'many',
  // Modals and vague nouns. Each ended a fabricated concept on a real
  // corpus: "proposal cannot", "packages user", "name halka".
  'cannot', 'cant', 'wont', 'shall', 'ought', 'need', 'needs', 'want', 'wants',
  'name', 'names', 'user', 'users', 'thing', 'things', 'way', 'ways', 'part',
  'case', 'cases', 'kind', 'kinds', 'type', 'types', 'item', 'items',
  // Bare verbs. A concept is a thing, not an action: "goes through",
  // "git clone", "returns true" are all things people do, not think in.
  'goes', 'go', 'run', 'runs', 'clone', 'add', 'adds', 'set', 'sets', 'put',
  'puts', 'take', 'takes', 'give', 'gives', 'keep', 'keeps', 'call', 'calls',
  'see', 'sees', 'says', 'say', 'let', 'lets', 'true', 'false', 'null', 'none',
]);

/**
 * @typedef {object} ConceptCandidate
 * @property {string} phrase        as written, in its most common casing
 * @property {number} documents     how many separate objects it appears in
 * @property {number} occurrences
 * @property {number} confidence
 * @property {string[]} examples    ids of objects it appears in
 * @property {string} because       why this was suggested, in plain words
 */

/**
 * Phrases recurring across a workspace's knowledge.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {number} [opts.minDocuments]
 * @param {number} [opts.limit]
 * @returns {ConceptCandidate[]}
 */
export function candidates(db, opts) {
  const minDocuments = opts.minDocuments ?? MIN_DOCUMENTS;
  const limit = opts.limit ?? 30;

  const rows = plainAll(
    db
      .prepare(
        `SELECT id, title, body FROM object
         WHERE workspace_id = ? AND state = 'active' AND kind != 'entity'
           AND review != 'rejected'`
      )
      .all(opts.workspaceId)
  );

  // Fewer documents than the threshold cannot produce a recurrence, and saying
  // "no concepts yet" is more honest than lowering the bar to find some.
  if (rows.length < minDocuments) return [];

  /** @type {Map<string, {surface: Map<string, number>, docs: Set<string>, count: number}>} */
  const phrases = new Map();

  for (const row of rows) {
    const words = tokenize(prose(`${row.title ?? ''}. ${row.body ?? ''}`));

    for (const size of SIZES) {
      for (let i = 0; i + size <= words.length; i++) {
        const window = words.slice(i, i + size);
        if (!isPhrase(window)) continue;

        const key = window.join(' ');
        const entry = phrases.get(key) ?? { surface: new Map(), docs: new Set(), count: 0 };
        entry.docs.add(String(row.id));
        entry.count++;
        entry.surface.set(key, (entry.surface.get(key) ?? 0) + 1);
        phrases.set(key, entry);
      }
    }
  }

  // Names already resolved as entities are not concepts. "Priya Sharma" recurs
  // across notes too, and is a person.
  const taken = new Set(
    plainAll(
      db
        .prepare(`SELECT title, attrs FROM object WHERE workspace_id = ? AND kind = 'entity'`)
        .all(opts.workspaceId)
    ).flatMap((e) => [canonicalise(String(e.title ?? '')), ...aliasesOf(e.attrs)])
  );

  /** @type {ConceptCandidate[]} */
  const out = [];

  for (const [phrase, entry] of phrases) {
    const documents = entry.docs.size;
    if (documents < minDocuments) continue;
    if (taken.has(canonicalise(phrase))) continue;

    // A longer phrase contained in a shorter one that appears just as often is
    // the same idea stated at more length; prefer the specific one below.
    out.push({
      phrase,
      documents,
      occurrences: entry.count,
      confidence: confidenceFor(documents, rows.length),
      examples: [...entry.docs].slice(0, 5),
      because:
        `"${phrase}" runs through ${documents} separate pieces of knowledge ` +
        `out of ${rows.length}.`,
    });
  }

  return dropSubsumed(out)
    .sort((a, b) => b.documents - a.documents || b.occurrences - a.occurrences)
    .slice(0, limit);
}

/**
 * Strip the parts of a document that are addresses rather than language.
 *
 * A URL tokenises into a sequence of ordinary-looking words, and a repeated
 * link then looks exactly like a repeated idea: on a real corpus the
 * strongest "concept" found was `https github com nulfied`, and the fourth
 * was `editors tree-sitter-halka`. Neither is anything somebody thinks in.
 *
 * Removed rather than tokenised differently, because a concept is a phrase a
 * person would say out loud, and none of this is.
 *
 * @param {string} text
 */
function prose(text) {
  return String(text ?? '')
    // Table rows are columns of values, not sentences. Read as prose they
    // produce phrases like "start end close true newline" — adjacent cells
    // from a token table, appearing together in every document that has one.
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.-]+@[\w.-]+\.\w+/g, ' ')
    .replace(/\b[\w.-]*\/[\w./-]+/g, ' ')
    .replace(/\b[\w-]+\.(js|ts|md|json|sh|py|c|h|html|yml|yaml|toml)\b/gi, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Is this window of words a phrase somebody would name?
 * @param {string[]} words
 */
function isPhrase(words) {
  if (words.some((w) => w.length < 3 || /^\d+$/.test(w))) return false;
  // An identifier is not a phrase: `tree-sitter-halka`, `build.sh`, `v49`.
  if (words.some((w) => /[-._/]|\d/.test(w))) return false;
  // Grammar at either end makes a fragment, not a concept.
  if (EDGE_NOISE.has(words[0]) || EDGE_NOISE.has(words[words.length - 1])) return false;
  // A phrase that is entirely filler in the middle is filler overall.
  return words.some((w) => !EDGE_NOISE.has(w));
}

/**
 * How much to believe a recurrence.
 *
 * Deliberately modest and capped well below certainty. Three notes sharing a
 * phrase is a hint; it is not the same kind of evidence as a capitalised name
 * next to "Ltd", and presenting it as though it were would put noise into the
 * graph with a confident face on it.
 *
 * @param {number} documents
 * @param {number} total
 */
function confidenceFor(documents, total) {
  const share = documents / Math.max(total, 1);
  // Recurring across many documents counts for more than recurring across many
  // when there are only a few documents in total.
  const weight = Math.min(1, documents / 8) * 0.7 + Math.min(1, share * 3) * 0.3;
  return Math.round((0.45 + weight * 0.25) * 100) / 100;
}

/**
 * Drop a phrase entirely contained in a longer one that occurs as often.
 *
 * "memory engine" and "the memory engine for everyone" are one idea. Keeping
 * both puts two nodes in the graph for the same thing, which is exactly the
 * duplication entity resolution exists to prevent.
 *
 * @param {ConceptCandidate[]} found
 */
function dropSubsumed(found) {
  const byLength = [...found].sort((a, b) => b.phrase.length - a.phrase.length);
  /** @type {ConceptCandidate[]} */
  const kept = [];

  for (const candidate of byLength) {
    const covered = kept.some(
      (k) => k.phrase.includes(candidate.phrase) && k.documents >= candidate.documents
    );
    if (!covered) kept.push(candidate);
  }
  return kept;
}

/** @param {unknown} attrs */
function aliasesOf(attrs) {
  try {
    const parsed = typeof attrs === 'string' ? JSON.parse(attrs) : attrs;
    return (parsed?.aliases ?? []).map((a) => canonicalise(String(a)));
  } catch {
    return [];
  }
}
