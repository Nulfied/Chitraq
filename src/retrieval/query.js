/**
 * Deterministic query interpretation.
 *
 * INVARIANT 25/28: retrieval starts deterministic and only escalates when it
 * needs to. Most real queries carry explicit structure — a kind, a date range,
 * a quoted phrase — and parsing that structure with a grammar is more reliable,
 * faster and cheaper than asking a model what the user meant.
 *
 * A model may later *enrich* this interpretation (see intelligence/), but it
 * never replaces it, and search works fully without one.
 */

import { STOPWORDS } from '../core/text.js';

/**
 * @typedef {object} Intent
 * @property {string} raw            the original query string
 * @property {string} text           free text with operators removed
 * @property {string[]} terms        content terms for scoring and highlighting
 * @property {string[]} phrases      quoted exact phrases
 * @property {string[]} exclude      terms that must not appear
 * @property {string[]} kinds
 * @property {string[]} origins
 * @property {string[]} epistemics
 * @property {string[]} states
 * @property {string[]} tags
 * @property {string|null} review
 * @property {string|null} after     ISO instant
 * @property {string|null} before    ISO instant
 * @property {string|null} relatedTo object id to anchor on
 * @property {boolean} temporal      whether the user asked a time-shaped question
 * @property {boolean} retrospective whether they asked about the past specifically
 * @property {string} shape          lookup | question | browse
 */

const FIELD_ALIASES = {
  kind: 'kinds',
  type: 'kinds',
  origin: 'origins',
  from: 'origins',
  epistemic: 'epistemics',
  state: 'states',
  tag: 'tags',
  is: 'is',
  after: 'after',
  since: 'after',
  before: 'before',
  until: 'before',
  during: 'during',
  in: 'during',
  related: 'relatedTo',
  near: 'relatedTo',
};

const QUESTION_WORDS = /^(what|who|when|where|why|how|which|did|do|does|is|are|was|were|should|can|could|would|will)\b/i;

const TEMPORAL_HINTS =
  /\b(when|before|after|since|until|during|recently|lately|last (week|month|year|time)|this (week|month|year)|yesterday|today|ago|first|originally|used to|previously|history|timeline|changed)\b/i;

/**
 * Asking about the past specifically, rather than merely mentioning time.
 * "What is our pricing" and "what did pricing used to be" need opposite
 * answers from the same material, and only this tells them apart.
 */
const RETROSPECTIVE_HINTS =
  /\b(used to|previously|originally|formerly|before|earlier|at the time|back then|old|former|what was|what were|did we use|have we changed|has .* changed|history of)\b/i;

/**
 * Parse a query string into a structured intent.
 * @param {string} raw
 * @param {{now?: Date}} [opts]
 * @returns {Intent}
 */
export function parse(raw, opts = {}) {
  const at = opts.now ?? new Date();

  /** @type {Intent} */
  const intent = {
    raw,
    text: '',
    terms: [],
    phrases: [],
    exclude: [],
    kinds: [],
    origins: [],
    epistemics: [],
    states: [],
    tags: [],
    review: null,
    after: null,
    before: null,
    relatedTo: null,
    temporal: false,
    retrospective: false,
    shape: 'lookup',
  };

  let rest = raw ?? '';

  // 1. quoted phrases
  rest = rest.replace(/"([^"]+)"/g, (_, phrase) => {
    intent.phrases.push(phrase.trim());
    return ' ';
  });

  // 2. field:value operators
  rest = rest.replace(/(\w+):([^\s"]+|"[^"]*")/g, (match, field, value) => {
    const key = FIELD_ALIASES[field.toLowerCase()];
    if (!key) return match;
    const v = value.replace(/^"|"$/g, '');

    switch (key) {
      case 'is':
        if (['confirmed', 'rejected', 'unreviewed'].includes(v)) intent.review = v;
        else if (['archived', 'active', 'superseded', 'deleted'].includes(v)) intent.states.push(v);
        break;
      case 'after':
        intent.after = resolveDate(v, at, 'start');
        break;
      case 'before':
        intent.before = resolveDate(v, at, 'end');
        break;
      case 'during': {
        const range = resolveRange(v, at);
        if (range) {
          intent.after = range.from;
          intent.before = range.to;
        }
        break;
      }
      case 'relatedTo':
        intent.relatedTo = v;
        break;
      default:
        intent[key].push(v.toLowerCase());
    }
    return ' ';
  });

  // 3. negated terms
  rest = rest.replace(/(^|\s)-([\p{L}\p{N}_-]{2,})/gu, (_, lead, term) => {
    intent.exclude.push(term.toLowerCase());
    return ' ';
  });

  // 4. bare relative-time expressions in ordinary prose ("what did I decide last week")
  const relative = matchRelativePhrase(rest, at);
  if (relative) {
    intent.after ??= relative.from;
    intent.before ??= relative.to;
    rest = rest.replace(relative.matched, ' ');
  }

  intent.text = rest.replace(/\s+/g, ' ').trim();
  intent.terms = [...new Set([...tokenizeQuery(intent.text), ...intent.phrases.flatMap(tokenizeQuery)])];
  intent.temporal = TEMPORAL_HINTS.test(raw ?? '') || !!(intent.after || intent.before);
  intent.retrospective = RETROSPECTIVE_HINTS.test(raw ?? '');
  intent.shape = classifyShape(raw ?? '', intent);

  return intent;
}

/**
 * @param {string} raw
 * @param {Intent} intent
 * @returns {string}
 */
function classifyShape(raw, intent) {
  const trimmed = raw.trim();
  if (!trimmed) return 'browse';
  if (QUESTION_WORDS.test(trimmed) || trimmed.endsWith('?')) return 'question';
  if (!intent.terms.length && !intent.phrases.length) return 'browse';
  return 'lookup';
}

/**
 * Terms worth searching on.
 *
 * Stopwords are removed here, not only at index time. Without this, asking
 * "why did we drop the redis cache" sends `the` and `we` to the full-text
 * index as OR-terms, every document in the workspace matches something, and
 * the ranking has to sort genuine hits out of the entire corpus. Filtering the
 * query is what makes "matched your words" mean anything.
 *
 * A query made entirely of common words ("the who", "to be or not to be")
 * falls back to the unfiltered terms — returning nothing would be worse.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenizeQuery(text) {
  const raw = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []).filter(
    (t) => t.length > 1
  );
  const content = raw.filter((t) => !STOPWORDS.has(t));
  return content.length ? content : raw;
}

/**
 * Turn a date expression into an ISO instant. Understands absolute dates,
 * month and year precision, and a small set of relative expressions.
 *
 * Returns null on anything it does not understand — INVARIANT 18: better no
 * filter than a confidently wrong one.
 *
 * @param {string} value
 * @param {Date} at
 * @param {'start'|'end'} edge
 * @returns {string|null}
 */
export function resolveDate(value, at, edge) {
  const v = value.trim().toLowerCase();

  const relative = resolveRelativeKeyword(v, at);
  if (relative) return edge === 'start' ? relative.from : relative.to;

  // 2025, 2025-03, 2025-03-14
  const ymd = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(v);
  if (ymd) {
    const [, y, m, d] = ymd;
    const year = Number(y);
    if (edge === 'start') {
      return new Date(Date.UTC(year, m ? Number(m) - 1 : 0, d ? Number(d) : 1)).toISOString();
    }
    if (d) return new Date(Date.UTC(year, Number(m) - 1, Number(d), 23, 59, 59, 999)).toISOString();
    if (m) return new Date(Date.UTC(year, Number(m), 0, 23, 59, 59, 999)).toISOString();
    return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * @param {string} value
 * @param {Date} at
 * @returns {{from: string|null, to: string|null}|null}
 */
export function resolveRange(value, at) {
  const keyword = resolveRelativeKeyword(value.trim().toLowerCase(), at);
  if (keyword) return keyword;
  const from = resolveDate(value, at, 'start');
  const to = resolveDate(value, at, 'end');
  return from || to ? { from, to } : null;
}

/**
 * @param {string} v
 * @param {Date} at
 * @returns {{from: string, to: string}|null}
 */
function resolveRelativeKeyword(v, at) {
  const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  const dayEnd = (d) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)).toISOString();
  const shiftDays = (n) => new Date(at.getTime() + n * 86400000);

  switch (v) {
    case 'today':
      return { from: dayStart(at), to: dayEnd(at) };
    case 'yesterday':
      return { from: dayStart(shiftDays(-1)), to: dayEnd(shiftDays(-1)) };
    case 'week':
    case 'this-week':
    case 'this week':
      return { from: dayStart(shiftDays(-at.getUTCDay())), to: dayEnd(at) };
    case 'last-week':
    case 'last week':
      return { from: dayStart(shiftDays(-at.getUTCDay() - 7)), to: dayEnd(shiftDays(-at.getUTCDay() - 1)) };
    case 'month':
    case 'this month':
    case 'this-month':
      return {
        from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString(),
        to: dayEnd(at),
      };
    case 'last-month':
    case 'last month':
      return {
        from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)).toISOString(),
        to: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 0, 23, 59, 59, 999)).toISOString(),
      };
    case 'year':
    case 'this year':
    case 'this-year':
      return { from: new Date(Date.UTC(at.getUTCFullYear(), 0, 1)).toISOString(), to: dayEnd(at) };
    case 'last-year':
    case 'last year':
      return {
        from: new Date(Date.UTC(at.getUTCFullYear() - 1, 0, 1)).toISOString(),
        to: new Date(Date.UTC(at.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999)).toISOString(),
      };
    default: {
      const ago = /^(\d+)\s*(day|week|month|year)s?\s*ago$/.exec(v);
      if (ago) {
        const n = Number(ago[1]);
        const unit = ago[2];
        const days = { day: 1, week: 7, month: 30, year: 365 }[unit] * n;
        return { from: dayStart(shiftDays(-days)), to: dayEnd(at) };
      }
      return null;
    }
  }
}

/**
 * Find a relative-time phrase inside ordinary prose.
 * @param {string} text
 * @param {Date} at
 * @returns {{from: string, to: string, matched: string}|null}
 */
function matchRelativePhrase(text, at) {
  const m = /\b(today|yesterday|this week|last week|this month|last month|this year|last year|\d+\s+(?:day|week|month|year)s?\s+ago)\b/i.exec(
    text
  );
  if (!m) return null;
  const range = resolveRelativeKeyword(m[1].toLowerCase(), at);
  return range ? { ...range, matched: m[0] } : null;
}

/**
 * Render an intent as an FTS5 MATCH expression.
 *
 * Terms are OR-ed rather than AND-ed: a memory engine should surface the
 * near-miss you half-remember, not return nothing because one word was wrong.
 * Ranking, not filtering, decides what rises.
 *
 * @param {Intent} intent
 * @returns {string|null} null when there is nothing to match on
 */
export function toFtsQuery(intent) {
  /** @type {string[]} */
  const parts = [];
  for (const phrase of intent.phrases) {
    const clean = phrase.replace(/"/g, '');
    if (clean.trim()) parts.push(`"${clean}"`);
  }
  for (const term of intent.terms) {
    if (intent.exclude.includes(term)) continue;
    const safe = term.replace(/["^*:(){}[\]]/g, '');
    if (safe.length > 1) parts.push(`"${safe}"*`);
  }
  if (!parts.length) return null;

  let q = parts.join(' OR ');
  for (const term of intent.exclude) {
    const safe = term.replace(/["^*:(){}[\]]/g, '');
    if (safe) q = `(${q}) NOT "${safe}"`;
  }
  return q;
}
