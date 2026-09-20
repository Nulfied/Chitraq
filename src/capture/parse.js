import { extractPdfText } from './pdf.js';

/**
 * Source parsers: raw bytes or text in, plain text plus structure out.
 *
 * Parsing is deterministic and dependency-free. It extracts what is reliably
 * there (headings, links, titles, front-matter) and does not attempt to
 * interpret meaning — that is a later, separable step, so that a bad
 * interpretation never damages a good capture.
 */

/**
 * @typedef {object} Parsed
 * @property {string} text          plain text for indexing and extraction
 * @property {string|null} title    detected title, if any
 * @property {object} meta          structure found along the way
 * @property {string} mediaType
 * @property {string|null} [needsCapability] a capability that would unlock this content
 */

/**
 * @param {object} input
 * @param {string} [input.text]
 * @param {Uint8Array} [input.bytes]
 * @param {string} [input.mediaType]
 * @param {string} [input.uri]
 * @param {string} [input.filename]
 * @returns {Parsed}
 */
export function parseSource(input) {
  const mediaType = input.mediaType ?? guessMediaType(input.filename ?? input.uri ?? '') ?? 'text/plain';

  // Binary formats are handled before the text decode: running a PDF or an
  // image through TextDecoder produces plausible-looking rubbish, and rubbish
  // that looks like text is worse than an honest failure.
  if (input.bytes?.length) {
    if (mediaType === 'application/pdf' || looksLikePdf(input.bytes)) {
      const pdf = extractPdfText(input.bytes);
      return {
        text: pdf.text,
        title: pdf.meta.title ?? null,
        meta: { ...pdf.meta, pages: pdf.pages, extracted: pdf.extracted, reason: pdf.reason },
        mediaType: 'application/pdf',
        needsCapability: pdf.extracted ? null : 'ocr.document',
      };
    }
    if (mediaType.startsWith('image/')) {
      // Nothing to read without a vision or OCR provider. The bytes are still
      // captured; the capability slot says what would unlock them.
      return {
        text: '',
        title: input.filename ?? null,
        meta: { bytes: input.bytes.length, reason: 'Images need a vision or OCR capability to read.' },
        mediaType,
        needsCapability: 'ocr.image',
      };
    }
    if (mediaType.startsWith('audio/') || mediaType.startsWith('video/')) {
      return {
        text: '',
        title: input.filename ?? null,
        meta: { bytes: input.bytes.length, reason: 'Audio needs a speech-to-text capability to read.' },
        mediaType,
        needsCapability: 'speech.transcribe',
      };
    }
  }

  const raw = input.text ?? decode(input.bytes);

  switch (mediaType) {
    case 'text/markdown':
      return parseMarkdown(raw, mediaType);
    case 'text/html':
      return parseHtml(raw, mediaType);
    case 'application/json':
      return parseJson(raw, mediaType);
    case 'text/csv':
      return parseCsv(raw, mediaType);
    default:
      return { text: raw, title: firstLineTitle(raw), meta: {}, mediaType };
  }
}

/**
 * @param {string} raw
 * @param {string} mediaType
 * @returns {Parsed}
 */
export function parseMarkdown(raw, mediaType = 'text/markdown') {
  const meta = {};
  let body = raw;

  // YAML-ish front matter: read simple key: value pairs, ignore the rest
  // rather than pulling in a YAML parser for a feature this small.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    meta.frontMatter = {};
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) meta.frontMatter[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }

  const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({
    level: m[1].length,
    text: m[2].trim(),
    offset: m.index ?? 0,
  }));
  const links = markdownLinks(body);
  const wikilinks = delimited(body, '[[', ']]').map((d) => d.inner.trim());

  const withoutCode = body
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');

  const text = withoutLinkSyntax(withoutCode)
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .trim();

  return {
    text,
    title: meta.frontMatter?.title ?? headings.find((h) => h.level === 1)?.text ?? firstLineTitle(text),
    meta: { ...meta, headings, links, wikilinks },
    mediaType,
  };
}

/**
 * @param {string} raw
 * @param {string} mediaType
 * @returns {Parsed}
 */
export function parseHtml(raw, mediaType = 'text/html') {
  const tokens = tags(raw);

  const title = between(raw, tokens, (t) => t.name === 'title')[0]?.inner.trim() ?? null;

  const links = tokens
    .map((tag, i) => (tag.name === 'a' && !tag.closing ? { tag, i } : null))
    .filter((x) => x !== null)
    .map(({ tag, i }) => {
      const href = attribute(tag.raw, 'href');
      if (!href) return null;
      const close = tokens.findIndex((t, j) => j > i && t.name === 'a' && t.closing);
      const inner = close === -1 ? '' : raw.slice(tag.end, tokens[close].start);
      return { href, text: stripTags(inner).trim() };
    })
    .filter((link) => link !== null);

  const headings = between(raw, tokens, (t) => /^h[1-6]$/.test(t.name ?? '')).map((h) => ({
    level: Number(h.open.name.slice(1)),
    text: stripTags(h.inner).trim(),
  }));

  const text = stripTags(withoutRegions(raw, tokens, HIDDEN))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, title: title ?? headings[0]?.text ?? null, meta: { links, headings }, mediaType };
}

/** Elements whose contents are markup or code, not text to remember. */
const HIDDEN = new Set(['script', 'style', 'noscript', 'svg']);

/** Elements that end a line when they close, so text does not run together. */
const BREAKS = new Set([
  'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'br',
]);

/**
 * @param {string} raw
 * @param {string} mediaType
 * @returns {Parsed}
 */
export function parseJson(raw, mediaType = 'application/json') {
  try {
    const data = JSON.parse(raw);
    return {
      text: flattenJson(data).join('\n'),
      title: data?.title ?? data?.name ?? null,
      meta: { keys: typeof data === 'object' && data ? Object.keys(data).slice(0, 50) : [] },
      mediaType,
    };
  } catch {
    // Unparseable JSON is still text worth keeping. Capture should not fail
    // because a file was malformed.
    return { text: raw, title: null, meta: { parseError: true }, mediaType: 'text/plain' };
  }
}

/**
 * @param {string} raw
 * @param {string} mediaType
 * @returns {Parsed}
 */
export function parseCsv(raw, mediaType = 'text/csv') {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { text: '', title: null, meta: {}, mediaType };

  const header = splitCsvLine(lines[0]);
  const rows = lines.slice(1, 501).map(splitCsvLine);

  // Rendered as "column: value" sentences so that ordinary text search and
  // chunking work on tabular data without a special code path.
  const text = rows
    .map((row) => header.map((h, i) => `${h}: ${row[i] ?? ''}`).join('; '))
    .join('\n');

  return { text, title: null, meta: { columns: header, rowCount: lines.length - 1 }, mediaType };
}

/** @param {string} line */
function splitCsvLine(line) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * @param {any} value
 * @param {string} [prefix]
 * @param {number} [depth]
 * @returns {string[]}
 */
function flattenJson(value, prefix = '', depth = 0) {
  if (depth > 6) return [];
  if (value === null || typeof value !== 'object') return [`${prefix}${prefix ? ': ' : ''}${value}`];
  if (Array.isArray(value)) {
    return value.slice(0, 200).flatMap((v, i) => flattenJson(v, `${prefix}[${i}]`, depth + 1));
  }
  return Object.entries(value).flatMap(([k, v]) =>
    flattenJson(v, prefix ? `${prefix}.${k}` : k, depth + 1)
  );
}

/** @param {string} html */
/** The named entities worth handling without pulling in a table of 2,231. */
const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * @param {string} html
 */
function stripTags(html) {
  // Scans its own input rather than accepting tags found earlier. An
  // attempt at reusing them was a real bug in the making: the caller passes
  // a string with whole `<script>` regions already removed, so offsets from
  // the original text point at the wrong characters. Scanning twice is
  // linear and obviously correct; the optimisation was neither.
  return (
    removeTags(html, tags(html))
      // One pass, not seven chained ones. Decoding `&amp;` before `&lt;`
      // meant `&amp;lt;` became `&lt;` and then `<`: a document that wrote
      // the literal text "&lt;" had a tag bracket stored instead. Anything
      // written *about* escaping came out saying the opposite of itself, and
      // a document could put markup back into text that had just had its
      // markup stripped. A single pass cannot consume its own output.
      .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/g, (entity) => {
        const known = ENTITIES[entity];
        if (known !== undefined) return known;

        const code = Number(entity.slice(2, -1));
        // Basic Multilingual Plane only, and nothing in the control range: a
        // numeric entity is not a licence to put a NUL into stored text.
        if (!Number.isInteger(code) || code < 32 || code > 0xffff) return entity;
        return String.fromCharCode(code);
      })
      .replace(/[ \t]{2,}/g, ' ')
  );
}

/** @param {string} text */
function firstLineTitle(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/** @param {Uint8Array} bytes */
function looksLikePdf(bytes) {
  return (
    bytes.length > 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
  );
}

/** @param {Uint8Array|undefined} bytes */
function decode(bytes) {
  if (!bytes) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** @param {string} nameOrUri */
export function guessMediaType(nameOrUri) {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(nameOrUri)?.[1]?.toLowerCase();
  return {
    md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
    html: 'text/html', htm: 'text/html',
    json: 'application/json',
    csv: 'text/csv', tsv: 'text/csv',
    txt: 'text/plain', log: 'text/plain', text: 'text/plain',
    rst: 'text/plain', org: 'text/plain', adoc: 'text/plain',
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', tiff: 'image/tiff',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  }[ext ?? ''] ?? null;
}

// ---------------------------------------------------------------------------
// Linear scanning
//
// Every delimiter-pair pattern in this file used to be a regular expression
// of the shape `<[^>]+>` or `\[([^\]]+)\]`, and every one of them was
// quadratic on input that opens a delimiter it never closes. At each opening
// character the engine consumed the rest of the document looking for the
// closer, failed, backtracked, and started again one character along.
//
// That was measured, not assumed, and the first measurement got it wrong:
// inputs were crafted for one ambiguity, ten patterns came back clean, and
// the conclusion was "one real problem". Feeding the same patterns a run of
// repeated opening delimiters — `'<a href="x" '.repeat(n)` — took every one
// of them past two hundred seconds. The lesson is narrow and worth keeping:
// a measurement is only as good as the worst input somebody thought of.
//
// `indexOf` cannot backtrack. These scanners move forward and never revisit,
// so the work is proportional to the length of the document and nothing
// else. The behaviour on ordinary documents is unchanged; the tests cover
// both that and the pathological inputs.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Tag
 * @property {number} start   index of `<`
 * @property {number} end     index just past `>`
 * @property {string} raw
 * @property {string|null} name  lowercased, null when it is not an element
 * @property {boolean} closing
 */

/** Only enough of a tag to identify it; anchored, so it cannot backtrack. */
const TAG_NAME = /^<\s*(\/?)\s*([a-zA-Z][\w:-]*)/;

/**
 * Every `<…>` in the input.
 *
 * @param {string} html
 * @returns {Tag[]}
 */
function tags(html) {
  /** @type {Tag[]} */
  const found = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf('<', at);
    if (open === -1) break;
    const close = html.indexOf('>', open + 1);
    // An unclosed `<` is the rest of the document, and it is not a tag.
    if (close === -1) break;

    const raw = html.slice(open, close + 1);
    const parsed = TAG_NAME.exec(raw);
    found.push({
      start: open,
      end: close + 1,
      raw,
      name: parsed ? parsed[2].toLowerCase() : null,
      closing: parsed ? parsed[1] === '/' : false,
    });
    at = close + 1;
  }
  return found;
}

/**
 * The text between each matching open and close tag the predicate selects.
 *
 * Nesting is not tracked. These are titles, headings and anchors, which do
 * not nest inside themselves in any document worth reading, and pretending
 * to handle it would be more code claiming more correctness than it has.
 *
 * @param {string} html
 * @param {Tag[]} tokens
 * @param {(t: Tag) => boolean} wanted
 */
function between(html, tokens, wanted) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.closing || !wanted(open)) continue;
    const close = tokens.findIndex((t, j) => j > i && t.closing && t.name === open.name);
    if (close === -1) continue;
    out.push({ open, inner: html.slice(open.end, tokens[close].start) });
    i = close;
  }
  return out;
}

/**
 * Drop whole elements — the ones whose contents are code rather than prose.
 *
 * @param {string} html
 * @param {Tag[]} tokens
 * @param {Set<string>} names
 */
function withoutRegions(html, tokens, names) {
  let out = '';
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.closing || !open.name || !names.has(open.name)) continue;
    const close = tokens.findIndex((t, j) => j > i && t.closing && t.name === open.name);
    // An unclosed <script> swallows the rest of the file, which is what a
    // browser does too.
    const stop = close === -1 ? html.length : tokens[close].end;
    if (open.start >= at) {
      out += html.slice(at, open.start) + ' ';
      at = stop;
    }
    if (close === -1) break;
    i = close;
  }
  return out + html.slice(at);
}

/**
 * Replace tags with spaces, and closing block tags with a blank line.
 *
 * @param {string} html
 * @param {Tag[]} tokens
 */
function removeTags(html, tokens) {
  let out = '';
  let at = 0;
  for (const tag of tokens) {
    if (tag.start < at) continue;
    out += html.slice(at, tag.start);
    out += tag.closing && tag.name && BREAKS.has(tag.name) ? '\n\n' : ' ';
    at = tag.end;
  }
  return out + html.slice(at);
}

/**
 * One attribute out of a tag, quoted or not.
 *
 * Bounded on purpose: an attribute value is not allowed to be the rest of
 * the document, which is the property that keeps this linear.
 *
 * @param {string} raw
 * @param {string} name
 */
function attribute(raw, name) {
  const found = new RegExp(`\\s${name}\\s*=\\s*("[^"]{0,4096}"|'[^']{0,4096}'|[^\\s>]{0,4096})`, 'i').exec(
    raw
  );
  if (!found) return null;
  const value = found[1];
  return /^["']/.test(value) ? value.slice(1, -1) : value;
}

/**
 * Spans between two literal delimiters, found by scanning.
 *
 * @param {string} text
 * @param {string} open
 * @param {string} close
 */
function delimited(text, open, close) {
  const out = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    out.push({ start, end: end + close.length, inner: text.slice(start + open.length, end) });
    at = end + close.length;
  }
  return out;
}

/**
 * Markdown inline links: `[text](href)`, with an optional title after the
 * href that is not part of it.
 *
 * @param {string} body
 */
function markdownLinks(body) {
  const links = [];
  let at = 0;
  for (;;) {
    const open = body.indexOf('[', at);
    if (open === -1) break;
    const shut = body.indexOf(']', open + 1);
    if (shut === -1) break;

    // `](` or it is not a link; either way the scan continues past the `]`
    // rather than retrying every character in between.
    if (body[shut + 1] !== '(') {
      at = shut + 1;
      continue;
    }
    const end = body.indexOf(')', shut + 2);
    if (end === -1) break;

    const text = body.slice(open + 1, shut);
    const href = body.slice(shut + 2, end).split(/\s/)[0];
    if (text && href) links.push({ text, href });
    at = end + 1;
  }
  return links;
}

/**
 * Turn `[text](href)` and `[[page]]` into their visible words.
 *
 * Bounding the quantifiers was the first attempt and was not enough: a cap
 * of 500 turns quadratic into O(n x 500), which on 200 KB of `[` was still
 * 1.5 seconds. Scanning is the only version that does not depend on how
 * generous the cap is.
 *
 * @param {string} text
 */
function withoutLinkSyntax(text) {
  let out = '';
  let at = 0;

  for (;;) {
    const open = text.indexOf('[', at);
    if (open === -1) break;

    // `[[page]]` first, because it also starts with `[`.
    if (text[open + 1] === '[') {
      const shut = text.indexOf(']]', open + 2);
      if (shut !== -1) {
        out += text.slice(at, open) + text.slice(open + 2, shut);
        at = shut + 2;
        continue;
      }
    }

    const shut = text.indexOf(']', open + 1);
    if (shut === -1) break;
    if (text[shut + 1] !== '(') {
      // Not a link. Keep the bracket and carry on past it — never retry the
      // characters in between, which is what made the regex quadratic.
      out += text.slice(at, shut + 1);
      at = shut + 1;
      continue;
    }
    const end = text.indexOf(')', shut + 2);
    if (end === -1) break;

    out += text.slice(at, open) + text.slice(open + 1, shut);
    at = end + 1;
  }

  return out + text.slice(at);
}
