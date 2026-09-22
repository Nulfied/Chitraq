/**
 * PDF text extraction, without a dependency.
 *
 * A PDF is a container of compressed streams. Text lives in content streams as
 * operators — `Tj`, `TJ`, `'`, `"` — with the actual characters in literal
 * `(string)` or hex `<hex>` form. This walks the file, inflates the streams
 * Node can inflate, and pulls the text operands out in order.
 *
 * **What this handles:** the common case — a PDF produced by a word processor,
 * a browser's print-to-PDF, or a report generator, using Flate-compressed
 * streams and standard or WinAnsi encoding.
 *
 * **What it does not:** scanned pages (there is no text to find — that needs
 * OCR, which is a capability, not a parser), encrypted files, CID fonts with
 * custom encodings, and exotic compression filters. In each of those cases it
 * says so, and the PDF is still captured verbatim as a Source so nothing is
 * lost and a better extractor can be run later.
 *
 * Being honest about the failure is the point: silently returning mojibake
 * would put nonsense into memory and call it knowledge.
 */

import { inflateSync, unzipSync } from 'node:zlib';
import { fileKey, decryptObject } from './pdf-crypt.js';

/**
 * @typedef {object} PdfResult
 * @property {string} text
 * @property {number} pages
 * @property {boolean} extracted   false when there was no text to get
 * @property {string|null} reason  why extraction failed or was partial
 * @property {object} meta
 */

/**
 * @param {Uint8Array} bytes
 * @returns {PdfResult}
 */
export function extractPdfText(bytes, opts = {}) {
  const buf = Buffer.from(bytes);

  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return { text: '', pages: 0, extracted: false, reason: 'Not a PDF file.', meta: {} };
  }

  const version = buf.subarray(5, 8).toString('latin1');
  const raw = buf.toString('latin1');

  // An encrypted PDF is usually one whose *owner* password is set and whose
  // user password is empty: a bank statement, an exam form, a government
  // download. Those open with no prompt in any reader, so refusing to read
  // one was a gap rather than a safeguard. A document with a real user
  // password still fails the specification's own key check, and is reported
  // as needing one rather than guessed at.
  let decrypt = null;
  if (/\/Encrypt\b/.test(raw)) {
    const found = readEncryption(raw);
    if (!found) {
      return {
        text: '',
        pages: countPages(raw),
        extracted: false,
        reason: 'This PDF is encrypted with a handler Chitraq does not recognise.',
        meta: { version, encrypted: true },
      };
    }

    const key = fileKey(found, opts.password ?? '');
    if (!key) {
      return {
        text: '',
        pages: countPages(raw),
        extracted: false,
        reason:
          'This PDF is encrypted and needs its password. Chitraq stored the file; '+
          'set CHITRAQ_PDF_PASSWORD to read it.',
        meta: { version, encrypted: true, needsPassword: true },
      };
    }
    decrypt = { key, enc: found };
  }

  const streams = extractStreams(buf, raw, decrypt);
  const chunks = [];
  let unsupportedFilter = 0;

  for (const stream of streams) {
    if (stream.unsupported) {
      unsupportedFilter++;
      continue;
    }
    const text = textFromContentStream(stream.data);
    if (text.trim()) chunks.push(text);
  }

  const text = chunks.join('\n\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const pages = countPages(raw);

  if (!text) {
    return {
      text: '',
      pages,
      extracted: false,
      reason: unsupportedFilter
        ? `No readable text: ${unsupportedFilter} stream(s) use a compression filter this extractor does not support.`
        : 'No text layer found. This is most likely a scanned document, which needs OCR rather than text extraction.',
      meta: { version, pages, streams: streams.length, unsupportedFilter },
    };
  }

  return {
    text,
    pages,
    extracted: true,
    reason: unsupportedFilter
      ? `Partial: ${unsupportedFilter} stream(s) could not be decompressed.`
      : null,
    meta: { version, pages, streams: streams.length, ...documentInfo(raw) },
  };
}


/**
 * The dictionary that belongs to the stream starting at `index`.
 *
 * Taking the text back to the nearest `<<` is wrong whenever a dictionary
 * contains another one — `/DecodeParms << /Predictor 12 >>` is ordinary in a
 * scanned PDF — because the nearest `<<` is then the inner dictionary, and the
 * object's own keys are invisible. Every such stream was being skipped.
 *
 * This walks backwards balancing the pairs, so it lands on the opening of the
 * outermost dictionary regardless of how deeply it nests.
 *
 * @param {string} raw
 * @param {number} index  position of the `stream` keyword
 * @returns {string}
 */
export function dictBefore(raw, index) {
  let depth = 0;
  let i = index;
  while (i >= 2) {
    const pair = raw.charCodeAt(i - 1) === 0x3e && raw.charCodeAt(i - 2) === 0x3e; // >>
    const open = raw.charCodeAt(i - 1) === 0x3c && raw.charCodeAt(i - 2) === 0x3c; // <<
    if (pair) {
      depth++;
      i -= 2;
      continue;
    }
    if (open) {
      // Decrement first. The `>>` just before the keyword is the dictionary's
      // own close, so its matching `<<` is the one that brings the count back
      // to zero — checking before decrementing can never reach it.
      depth--;
      if (depth === 0) return raw.slice(i - 2, index);
      i -= 2;
      continue;
    }
    i--;
  }
  return raw.slice(Math.max(0, raw.lastIndexOf('<<', index)), index);
}

/**
 * Pull out and decompress every stream object.
 * @param {Buffer} buf
 * @param {string} raw latin1 view of the same bytes, for index arithmetic
 */
function extractStreams(buf, raw, decrypt = null) {
  /** @type {Array<{data: Buffer, unsupported?: boolean}>} */
  const out = [];
  const marker = /(?<![A-Za-z])stream\r?\n/g;
  let m;

  // The lookbehind above matters: `endstream` ends in `stream`, so without it
  // every stream is found twice — once properly, and once three bytes into its
  // own terminator, where the dictionary lookup then reports the *previous*
  // object's filter. That inflated the count of unsupported streams and made
  // readable PDFs look partly unreadable.
  while ((m = marker.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;

    // The dictionary immediately before `stream` declares the filter.
    const dict = dictBefore(raw, m.index);

    let data = buf.subarray(start, end);
    // Trailing EOL before `endstream` is delimiter, not content.
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
      data = data.subarray(0, data.length - 1);
    }
    if (!data.length) continue;

    // Decryption comes before any filter, because the filter was applied
    // first when the file was written. Doing it the other way round inflates
    // ciphertext, which fails in a way that looks like a corrupt PDF.
    if (decrypt) {
      const owner = objectNumberBefore(raw, m.index);
      data = decryptObject(decrypt.key, decrypt.enc, owner.num, owner.gen, data);
      if (!data.length) continue;
    }

    if (/\/Filter\s*\/FlateDecode/.test(dict) || looksDeflated(data)) {
      try {
        out.push({ data: inflateSync(data) });
      } catch {
        try {
          out.push({ data: unzipSync(data) });
        } catch {
          out.push({ data: Buffer.alloc(0), unsupported: true });
        }
      }
    } else if (/\/Filter/.test(dict)) {
      // DCTDecode (JPEG), CCITTFaxDecode and friends carry images, not text.
      out.push({ data: Buffer.alloc(0), unsupported: !/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(dict) });
    } else {
      out.push({ data });
    }
    marker.lastIndex = end;
  }

  return out;
}

/** @param {Buffer} data */
function looksDeflated(data) {
  // zlib header: 0x78 followed by a byte making the pair a multiple of 31.
  return data.length > 2 && data[0] === 0x78 && (data[0] * 256 + data[1]) % 31 === 0;
}

/**
 * Read the text-showing operators out of a content stream.
 * @param {Buffer} stream
 * @returns {string}
 */
function textFromContentStream(stream) {
  const content = stream.toString('latin1');
  if (!/\b(Tj|TJ|Td|TD|Tm)\b/.test(content)) return ''; // not a text stream

  const out = [];
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (ch === '(') {
      const { value, next } = readLiteral(content, i);
      out.push(value);
      i = next;
      continue;
    }

    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i);
      if (close > 0) {
        out.push(readHex(content.slice(i + 1, close)));
        i = close + 1;
        continue;
      }
    }

    // Operators that move to a new line are the only reliable line breaks
    // available without laying out glyph positions.
    if (content.startsWith('TD', i) || content.startsWith('Td', i) || content.startsWith("T*", i)) {
      out.push('\n');
      i += 2;
      continue;
    }
    if (content.startsWith('ET', i)) {
      out.push('\n');
      i += 2;
      continue;
    }

    i++;
  }

  return out
    .join('')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Read a `(...)` literal string, honouring escapes and nested parentheses.
 * @param {string} s
 * @param {number} start index of the opening parenthesis
 */
function readLiteral(s, start) {
  let depth = 0;
  let out = '';

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (ch === '\\') {
      const next = s[i + 1];
      const simple = { n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
      if (next in simple) {
        out += simple[next];
        i++;
        continue;
      }
      // Octal character escape, \ddd
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8));
        i += octal[0].length;
        continue;
      }
      i++;
      continue;
    }

    if (ch === '(') {
      depth++;
      if (depth === 1) continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { value: decodeLatin(out), next: i + 1 };
    }
    if (depth >= 1) out += ch;
  }

  return { value: decodeLatin(out), next: s.length };
}

/**
 * Hex strings are either one byte per character or UTF-16BE.
 * @param {string} hex
 */
function readHex(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (!clean) return '';

  if (clean.length >= 4 && clean.slice(0, 4).toUpperCase() === 'FEFF') {
    let out = '';
    for (let i = 4; i + 3 < clean.length; i += 4) {
      out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    }
    return out;
  }

  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 || code === 10) out += String.fromCharCode(code);
  }
  return decodeLatin(out);
}

/**
 * Map the handful of WinAnsi positions that differ from Latin-1 and would
 * otherwise show up as control characters in ordinary prose.
 * @param {string} s
 */
function decodeLatin(s) {
  const WINANSI = {
    0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’',
    0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–',
    0x97: '—', 0x99: '™',
  };
  return [...s].map((ch) => WINANSI[ch.charCodeAt(0)] ?? ch).join('');
}

/** @param {string} raw */
function countPages(raw) {
  const explicit = /\/Count\s+(\d+)/.exec(raw);
  if (explicit) return Number(explicit[1]);
  return (raw.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

/** @param {string} raw */
function documentInfo(raw) {
  const field = (name) => {
    const m = new RegExp(`/${name}\\s*\\(([^)]*)\\)`).exec(raw);
    return m ? m[1].replace(/\\(.)/g, '$1').trim() : undefined;
  };
  const info = {
    title: field('Title'),
    author: field('Author'),
    subject: field('Subject'),
    creator: field('Creator'),
  };
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v));
}

/**
 * The `N G obj` header that owns the stream at `index`.
 *
 * Revisions up to 4 mix the object and generation numbers into a per-object
 * key, so getting this wrong produces a plausible-looking key and complete
 * rubbish. Searched backwards from the stream rather than forwards from the
 * file, because object numbers are not in file order.
 *
 * @param {string} raw
 * @param {number} index
 */
function objectNumberBefore(raw, index) {
  const window = raw.slice(Math.max(0, index - 2048), index);
  const found = [...window.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)].pop();
  return found ? { num: Number(found[1]), gen: Number(found[2]) } : { num: 0, gen: 0 };
}

/**
 * Read a PDF string: `(literal)` with escapes, or `<hex>`.
 *
 * @param {string} raw
 * @param {number} at   index of the opening delimiter
 * @returns {Buffer|null}
 */
function pdfString(raw, at) {
  if (raw[at] === '<') {
    const end = raw.indexOf('>', at);
    if (end < 0) return null;
    const hex = raw.slice(at + 1, end).replace(/[^0-9a-fA-F]/g, '');
    return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
  }
  if (raw[at] !== '(') return null;

  const out = [];
  let depth = 0;
  for (let i = at; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const next = raw[i + 1];
      i++;
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12 }[next];
      if (simple !== undefined) out.push(simple);
      else if (next >= '0' && next <= '7') {
        // Up to three octal digits.
        let digits = next;
        while (digits.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') digits += raw[++i];
        out.push(parseInt(digits, 8) & 0xff);
      } else if (next === '\n') {
        /* a line continuation contributes nothing */
      } else out.push(next.charCodeAt(0) & 0xff);
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth === 1) continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) return Buffer.from(out);
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return null;
}

/**
 * @param {string} dict
 * @param {string} key
 */
function stringEntry(dict, key) {
  const at = new RegExp(`/${key}\\s*(?=[(<])`).exec(dict);
  return at ? pdfString(dict, at.index + at[0].length) : null;
}

/**
 * The /Encrypt dictionary and the file identifier, or null when this is not
 * the standard security handler.
 *
 * Only `/Filter /Standard` is handled. A custom handler is somebody's
 * digital-rights plug-in, and pretending to support one would mean
 * producing text from a document this cannot actually read.
 *
 * @param {string} raw
 */
function readEncryption(raw) {
  const at = raw.search(/\/Encrypt\b/);
  if (at < 0) return null;

  // The dictionary may be inline in the trailer or in its own object. Both
  // are searched, nearest first, because a reference is the common case.
  const reference = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(raw);
  let dict = null;
  if (reference) {
    const object = new RegExp(`(?<![0-9])${reference[1]}\\s+${reference[2]}\\s+obj([\\s\\S]{0,4096})`).exec(raw);
    if (object) dict = object[1];
  }
  if (!dict) dict = raw.slice(at, at + 4096);
  if (!/\/Filter\s*\/Standard/.test(dict)) return null;

  const num = (/** @type {string} */ key, /** @type {number} */ fallback) => {
    const found = new RegExp(`/${key}\\s+(-?\\d+)`).exec(dict ?? '');
    return found ? Number(found[1]) : fallback;
  };

  const v = num('V', 0);
  const r = num('R', 0);
  const o = stringEntry(dict, 'O');
  const u = stringEntry(dict, 'U');
  if (!o || !u || !r) return null;

  // /Length is in bits and defaults to 40. Revisions 5 and 6 are always 256.
  const length = r >= 5 ? 32 : Math.max(5, Math.floor(num('Length', 40) / 8));

  // V4 and V5 name a crypt filter rather than implying the algorithm. The
  // two that occur are AESV2 (128-bit) and AESV3 (256-bit); V2 means RC4.
  let method = /** @type {'rc4'|'aes'|'none'} */ (v >= 5 ? 'aes' : 'rc4');
  if (v === 4) method = /\/AESV[23]/.test(dict) ? 'aes' : /\/V2\b|\/RC4/.test(dict) ? 'rc4' : 'aes';
  if (/\/StmF\s*\/Identity/.test(dict)) method = 'none';

  const idAt = /\/ID\s*\[\s*/.exec(raw);
  const id = idAt ? pdfString(raw, idAt.index + idAt[0].length) : null;

  return {
    v,
    r,
    o,
    u,
    ue: stringEntry(dict, 'UE'),
    p: num('P', 0),
    length,
    encryptMetadata: !/\/EncryptMetadata\s+false/.test(dict),
    method,
    // A file with no /ID still has a key; the specification treats the
    // missing identifier as empty rather than as an error.
    id: id ?? Buffer.alloc(0),
  };
}
