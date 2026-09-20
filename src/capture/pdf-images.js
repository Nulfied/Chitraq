/**
 * Getting the pictures out of a PDF, without a dependency.
 *
 * This file exists because of a claim that turned out to be wrong. STATUS.md
 * said a scanned PDF could not be read without rasterising it, and that every
 * route to that was a dependency Chitraq does not take. That is true for one
 * kind of scan and false for the common one.
 *
 * A PDF does not store pictures in some PDF-specific format. It stores them
 * with a named filter, and for the filter almost every scanner and phone
 * produces — `DCTDecode` — the stream bytes *are* a JPEG file. Nothing has to
 * be decoded to hand them to something that reads images. For `FlateDecode`
 * images the bytes are a raw bitmap, and Node's zlib is already here, so
 * wrapping one in a PNG is arithmetic rather than a library.
 *
 * `CCITTFaxDecode` — the bilevel encoding a fax machine and an old copier
 * produce — needs a real decoder, and `ccitt.js` is one, checked against
 * libtiff's encoder rather than against itself.
 *
 * That leaves `JBIG2Decode`, which is a subsystem rather than a table and has
 * no oracle to check against. It is reported by name, not guessed at.
 *
 * So the honest position is narrow: nearly every scanned PDF can be read, one
 * encoding cannot, and this says which.
 */

import { inflateSync, deflateSync } from 'node:zlib';
import { dictBefore } from './pdf.js';
import { decodeCcitt } from './ccitt.js';

/**
 * @typedef {object} ExtractedImage
 * @property {Buffer} data
 * @property {string} mediaType
 * @property {number} width
 * @property {number} height
 * @property {number} index        order of appearance in the file
 */

/**
 * @typedef {object} PdfImages
 * @property {ExtractedImage[]} images
 * @property {Array<{filter: string, reason: string}>} unreadable
 */

// `stream` also appears inside `endstream`, so a bare match finds every stream
// twice: once correctly, and once three bytes into its own terminator. The
// lookbehind requires a non-letter before the keyword, which is what the format
// actually says.
const STREAM_START = /(?<![A-Za-z])stream\r?\n/g;

/** Pictures smaller than this are rules, bullets and logos, not pages. */
const MIN_PIXELS = 100 * 100;

/**
 * Every embedded image a vision model could be handed.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {{minPixels?: number, limit?: number}} [opts]
 * @returns {PdfImages}
 */
export function extractPdfImages(bytes, opts = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const raw = buf.toString('latin1');
  const minPixels = opts.minPixels ?? MIN_PIXELS;
  const limit = opts.limit ?? 50;

  /** @type {ExtractedImage[]} */
  const images = [];
  /** @type {Array<{filter: string, reason: string}>} */
  const unreadable = [];

  const marker = new RegExp(STREAM_START.source, 'g');
  let m;
  let index = 0;

  while ((m = marker.exec(raw)) !== null && images.length < limit) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    marker.lastIndex = end;

    const dict = dictBefore(raw, m.index);
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;

    index++;
    const width = num(dict, 'Width');
    const height = num(dict, 'Height');
    if (!width || !height || width * height < minPixels) continue;

    // /Length is authoritative. Searching for `endstream` works until those
    // nine bytes occur inside compressed image data, and then it truncates a
    // picture without anyone noticing.
    const declared = num(dict, 'Length');
    const stop = declared && start + declared <= buf.length ? start + declared : end;

    let data = buf.subarray(start, stop);
    while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
      data = data.subarray(0, data.length - 1);
    }
    if (!data.length) continue;

    const filter = (/\/Filter\s*(?:\[\s*)?\/(\w+)/.exec(dict)?.[1] ?? 'none');

    // The case that matters. A DCTDecode stream is a JPEG file byte for byte;
    // handing it straight over is not a shortcut, it is the correct thing.
    if (filter === 'DCTDecode') {
      images.push({ data, mediaType: 'image/jpeg', width, height, index });
      continue;
    }

    if (filter === 'JPXDecode') {
      // JPEG 2000. Also a complete file, but almost nothing reads it, so this
      // is passed along labelled rather than claimed to work.
      images.push({ data, mediaType: 'image/jp2', width, height, index });
      continue;
    }

    if (filter === 'CCITTFaxDecode') {
      const png = fromFax(data, dict, width, height);
      if (png) images.push({ data: png, mediaType: 'image/png', width, height, index });
      else {
        unreadable.push({
          filter,
          reason: 'CCITT stream could not be decoded; the page is reported rather than guessed at.',
        });
      }
      continue;
    }

    if (filter === 'JBIG2Decode') {
      unreadable.push({
        filter,
        reason:
          'JBIG2Decode is a bilevel encoding that needs a decoder Chitraq does not have.',
      });
      continue;
    }

    if (filter === 'FlateDecode' || filter === 'none') {
      const png = toPng(filter === 'none' ? data : inflate(data), dict, width, height);
      if (png) images.push({ data: png, mediaType: 'image/png', width, height, index });
      else {
        unreadable.push({
          filter: filter === 'none' ? 'raw' : filter,
          reason: 'Unsupported colour space, bit depth or predictor.',
        });
      }
      continue;
    }

    unreadable.push({ filter, reason: `Unrecognised image filter ${filter}.` });
  }

  return { images, unreadable };
}

/**
 * Decode a fax-encoded page and wrap it in a PNG.
 *
 * The decoder returns exactly what a one-bit DeviceGray image already is —
 * rows of pixels, a set bit meaning white, padded to a byte — so there is no
 * conversion step between the two, only the container.
 *
 * Anything that does not line up returns null and is reported. A CCITT stream
 * whose declared column count disagrees with the image width would decode
 * into rows of the wrong length and come out as a sheared page, which is the
 * exact failure this file exists to avoid.
 *
 * @param {Buffer} data
 * @param {string} dict
 * @param {number} width
 * @param {number} height
 * @returns {Buffer|null}
 */
function fromFax(data, dict, width, height) {
  const parms = subDictionary(dict, 'DecodeParms') ?? '';

  // Columns defaults to 1728 in the specification, which is a fax page. When
  // a producer leaves it out on an image of some other width it meant the
  // width, so that is what is used — but a value that is present and
  // disagrees is a real inconsistency, not something to paper over.
  const declared = num(parms, 'Columns');
  const columns = declared ?? width;
  if (columns !== width) return null;

  try {
    const pixels = decodeCcitt(data, {
      columns,
      rows: num(parms, 'Rows') ?? height,
      k: signed(parms, 'K') ?? 0,
      blackIs1: flag(parms, 'BlackIs1') === true,
      byteAlign: flag(parms, 'EncodedByteAlign') === true,
    });

    // /Decode [1 0] on a one-bit image means the samples are stored the other
    // way round. Applying it here keeps the PNG honest about which end is ink.
    const inverted = /\/Decode\s*\[\s*1\s+0\s*\]/.test(dict)
      ? Buffer.from(pixels.map((b) => ~b & 0xff))
      : pixels;

    return toPng(inverted, '/ColorSpace /DeviceGray /BitsPerComponent 1', width, height);
  } catch {
    return null;
  }
}

/**
 * The text of a dictionary nested inside another one.
 *
 * Walks forward balancing `<<` and `>>` rather than matching to the first
 * `>>`, because the first one may close something deeper.
 *
 * @param {string} dict
 * @param {string} key
 * @returns {string|null}
 */
function subDictionary(dict, key) {
  const at = dict.indexOf(`/${key}`);
  if (at < 0) return null;
  const open = dict.indexOf('<<', at);
  if (open < 0) return null;

  let depth = 0;
  for (let i = open; i < dict.length - 1; i++) {
    if (dict[i] === '<' && dict[i + 1] === '<') {
      depth++;
      i++;
    } else if (dict[i] === '>' && dict[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return dict.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * @param {string} dict
 * @param {string} key
 */
function signed(dict, key) {
  const found = new RegExp(String.raw`/${key}\s+(-?\d+)`).exec(dict);
  return found ? Number(found[1]) : null;
}

/**
 * @param {string} dict
 * @param {string} key
 */
function flag(dict, key) {
  const found = new RegExp(String.raw`/${key}\s+(true|false)`).exec(dict);
  return found ? found[1] === 'true' : null;
}

/**
 * Wrap a raw PDF bitmap in a PNG container.
 *
 * PNG and PDF agree on how pixels are laid out — rows of samples, high bit
 * first — so for the shapes handled here this is a header, a filter byte per
 * row, and a checksum. No resampling and no colour management: the bytes that
 * come out are the bytes that went in.
 *
 * @param {Buffer|null} pixels
 * @param {string} dict
 * @param {number} width
 * @param {number} height
 * @returns {Buffer|null} null when the shape is not one this can honestly carry
 */
function toPng(pixels, dict, width, height) {
  if (!pixels) return null;

  // A predictor means the rows were differenced before compression. Undoing it
  // is real work and doing it wrong produces a picture that looks plausible and
  // is wrong, so it is refused instead.
  if (/\/Predictor\s+([2-9]|1[0-5])/.test(dict)) return null;

  const bits = num(dict, 'BitsPerComponent') ?? 8;
  const space = /\/ColorSpace\s*\/(\w+)/.exec(dict)?.[1] ?? 'DeviceGray';

  /** @type {number|null} */
  let colourType = null;
  let channels = 1;
  if (space === 'DeviceRGB') {
    colourType = 2;
    channels = 3;
  } else if (space === 'DeviceGray') {
    colourType = 0;
    channels = 1;
  }
  // Indexed, CMYK and ICC-based spaces need a palette or a conversion. Both are
  // places to introduce a wrong picture quietly.
  if (colourType === null) return null;
  if (bits !== 8 && bits !== 1) return null;

  const rowBytes = Math.ceil((width * channels * bits) / 8);
  if (pixels.length < rowBytes * height) return null;

  // PNG wants a filter byte at the start of every row; 0 means "stored as is".
  const framed = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    framed[y * (rowBytes + 1)] = 0;
    pixels.copy(framed, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bits;
  ihdr[9] = colourType;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(framed)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {Buffer} data */
function inflate(data) {
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** @type {number[]|null} */
let crcTable = null;

/** @param {Buffer} buf */
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} dict
 * @param {string} key
 */
function num(dict, key) {
  const found = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
  return found ? Number(found[1]) : null;
}
