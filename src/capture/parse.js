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
  const links = [...body.matchAll(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g)].map((m) => ({
    text: m[1],
    href: m[2],
  }));
  const wikilinks = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim());

  const text = body
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
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
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? null;

  const links = [...raw.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    href: m[1],
    text: stripTags(m[2]).trim(),
  }));

  const headings = [...raw.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: stripTags(m[2]).trim(),
  }));

  const text = stripTags(
    raw
      .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n\n')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, title: title ?? headings[0]?.text ?? null, meta: { links, headings }, mediaType };
}

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
function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]{2,}/g, ' ');
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
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', heic: 'image/heic', tiff: 'image/tiff',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  }[ext ?? ''] ?? null;
}
