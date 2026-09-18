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
 * What genuinely cannot be done here is `CCITTFaxDecode` and `JBIG2Decode` —
 * the bilevel fax encodings a photocopier produces. Those need real decoders.
 * They are reported by name, not guessed at.
 *
 * So the honest position is narrower and more useful than the old one: most
 * scanned PDFs can be read, some cannot, and this says which.
 */

import { inflateSync, deflateSync } from 'node:zlib';
import { dictBefore } from './pdf.js';

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

    if (filter === 'CCITTFaxDecode' || filter === 'JBIG2Decode') {
      unreadable.push({
        filter,
        reason: `${filter} is a bilevel fax encoding and needs a decoder Chitraq does not have.`,
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
