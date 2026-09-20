/**
 * CCITT Group 3 and Group 4 fax decoding, from the T.4 and T.6 code tables.
 *
 * This is the encoding a fax machine and an old office copier produce, and it
 * is the one scan format `extractPdfImages` could not read. Nothing a phone
 * scanner writes today uses it — those are JPEG inside the PDF and always
 * were — so this is not the common path. It is the last one, and leaving it
 * open meant every scanned PDF came with a caveat.
 *
 * Two things made it worth writing rather than depending on.
 *
 * The first is that there is nothing to invent. T.4 and T.6 are finished
 * specifications with fixed Huffman tables; the tables below are that data,
 * and a correct decoder is a transcription plus about eighty lines of state
 * machine. The second is that it can be *checked*. The objection to writing
 * one was that a subtly wrong decoder hands a vision model a scrambled page
 * it will then read confidently, and a decoder nobody can verify is worse
 * than a gap that is named. But Pillow writes real Group 4 streams, so a
 * known bitmap can be encoded by a separate implementation, decoded here, and
 * compared pixel for pixel. `test/fixtures/ccitt/` holds streams built that
 * way and the test asserts exact equality — not that it looks about right.
 * `tools/make-ccitt-fixtures.py` is how they were generated.
 *
 * JBIG2 is deliberately not here. It is arithmetic coding plus symbol
 * dictionaries plus generic region decoding — a subsystem rather than a
 * table — and Pillow gives no oracle to check it against. It stays named as
 * unreadable, which is the honest answer for it.
 *
 * Bit order: fax data is read most significant bit first, which is the order
 * the codes were designed in and the order PDF stores them.
 */

/** Modes in a two-dimensionally coded line (T.4 table 4 / T.6). */
const PASS = 1;
const HORIZONTAL = 2;
const EXTENSION = 3;
const EOL_MODE = 4;
/** Vertical modes carry their offset directly, -3..3, stored as 10 + offset. */
const VERTICAL = 10;

/**
 * The mode codes, keyed `length:value` so a partial read can never collide
 * with a shorter code that happens to share its leading bits.
 */
const MODES = new Map([
  ['1:1', VERTICAL + 0],
  ['3:3', VERTICAL + 1],
  ['3:2', VERTICAL - 1],
  ['3:1', HORIZONTAL],
  ['4:1', PASS],
  ['6:3', VERTICAL + 2],
  ['6:2', VERTICAL - 2],
  ['7:3', VERTICAL + 3],
  ['7:2', VERTICAL - 3],
  ['7:1', EXTENSION],
  ['12:1', EOL_MODE],
]);

/** White run lengths: [run, code, bitLength]. T.4 tables 1 and 2. */
const WHITE_CODES = [
  [0, 0x35, 8], [1, 0x07, 6], [2, 0x07, 4], [3, 0x08, 4], [4, 0x0b, 4],
  [5, 0x0c, 4], [6, 0x0e, 4], [7, 0x0f, 4], [8, 0x13, 5], [9, 0x14, 5],
  [10, 0x07, 5], [11, 0x08, 5], [12, 0x08, 6], [13, 0x03, 6], [14, 0x34, 6],
  [15, 0x35, 6], [16, 0x2a, 6], [17, 0x2b, 6], [18, 0x27, 7], [19, 0x0c, 7],
  [20, 0x08, 7], [21, 0x17, 7], [22, 0x03, 7], [23, 0x04, 7], [24, 0x28, 7],
  [25, 0x2b, 7], [26, 0x13, 7], [27, 0x24, 7], [28, 0x18, 7], [29, 0x02, 8],
  [30, 0x03, 8], [31, 0x1a, 8], [32, 0x1b, 8], [33, 0x12, 8], [34, 0x13, 8],
  [35, 0x14, 8], [36, 0x15, 8], [37, 0x16, 8], [38, 0x17, 8], [39, 0x28, 8],
  [40, 0x29, 8], [41, 0x2a, 8], [42, 0x2b, 8], [43, 0x2c, 8], [44, 0x2d, 8],
  [45, 0x04, 8], [46, 0x05, 8], [47, 0x0a, 8], [48, 0x0b, 8], [49, 0x52, 8],
  [50, 0x53, 8], [51, 0x54, 8], [52, 0x55, 8], [53, 0x24, 8], [54, 0x25, 8],
  [55, 0x58, 8], [56, 0x59, 8], [57, 0x5a, 8], [58, 0x5b, 8], [59, 0x4a, 8],
  [60, 0x4b, 8], [61, 0x32, 8], [62, 0x33, 8], [63, 0x34, 8],
  [64, 0x1b, 5], [128, 0x12, 5], [192, 0x17, 6], [256, 0x37, 7],
  [320, 0x36, 8], [384, 0x37, 8], [448, 0x64, 8], [512, 0x65, 8],
  [576, 0x68, 8], [640, 0x67, 8], [704, 0xcc, 9], [768, 0xcd, 9],
  [832, 0xd2, 9], [896, 0xd3, 9], [960, 0xd4, 9], [1024, 0xd5, 9],
  [1088, 0xd6, 9], [1152, 0xd7, 9], [1216, 0xd8, 9], [1280, 0xd9, 9],
  [1344, 0xda, 9], [1408, 0xdb, 9], [1472, 0x98, 9], [1536, 0x99, 9],
  [1600, 0x9a, 9], [1664, 0x18, 6], [1728, 0x9b, 9],
];

/** Black run lengths: [run, code, bitLength]. T.4 tables 1 and 2. */
const BLACK_CODES = [
  [0, 0x37, 10], [1, 0x02, 3], [2, 0x03, 2], [3, 0x02, 2], [4, 0x03, 3],
  [5, 0x03, 4], [6, 0x02, 4], [7, 0x03, 5], [8, 0x05, 6], [9, 0x04, 6],
  [10, 0x04, 7], [11, 0x05, 7], [12, 0x07, 7], [13, 0x04, 8], [14, 0x07, 8],
  [15, 0x18, 9], [16, 0x17, 10], [17, 0x18, 10], [18, 0x08, 10],
  [19, 0x67, 11], [20, 0x68, 11], [21, 0x6c, 11], [22, 0x37, 11],
  [23, 0x28, 11], [24, 0x17, 11], [25, 0x18, 11], [26, 0xca, 12],
  [27, 0xcb, 12], [28, 0xcc, 12], [29, 0xcd, 12], [30, 0x68, 12],
  [31, 0x69, 12], [32, 0x6a, 12], [33, 0x6b, 12], [34, 0xd2, 12],
  [35, 0xd3, 12], [36, 0xd4, 12], [37, 0xd5, 12], [38, 0xd6, 12],
  [39, 0xd7, 12], [40, 0x6c, 12], [41, 0x6d, 12], [42, 0xda, 12],
  [43, 0xdb, 12], [44, 0x54, 12], [45, 0x55, 12], [46, 0x56, 12],
  [47, 0x57, 12], [48, 0x64, 12], [49, 0x65, 12], [50, 0x52, 12],
  [51, 0x53, 12], [52, 0x24, 12], [53, 0x37, 12], [54, 0x38, 12],
  [55, 0x27, 12], [56, 0x28, 12], [57, 0x58, 12], [58, 0x59, 12],
  [59, 0x2b, 12], [60, 0x2c, 12], [61, 0x5a, 12], [62, 0x66, 12],
  [63, 0x67, 12],
  [64, 0x0f, 10], [128, 0xc8, 12], [192, 0xc9, 12], [256, 0x5b, 12],
  [320, 0x33, 12], [384, 0x34, 12], [448, 0x35, 12], [512, 0x6c, 13],
  [576, 0x6d, 13], [640, 0x4a, 13], [704, 0x4b, 13], [768, 0x4c, 13],
  [832, 0x4d, 13], [896, 0x72, 13], [960, 0x73, 13], [1024, 0x74, 13],
  [1088, 0x75, 13], [1152, 0x76, 13], [1216, 0x77, 13], [1280, 0x52, 13],
  [1344, 0x53, 13], [1408, 0x54, 13], [1472, 0x55, 13], [1536, 0x5a, 13],
  [1600, 0x5b, 13], [1664, 0x64, 13], [1728, 0x65, 13],
];

/** Makeup codes above 1728 are the same for both colours. T.4 table 3. */
const SHARED_CODES = [
  [1792, 0x08, 11], [1856, 0x0c, 11], [1920, 0x0d, 11], [1984, 0x12, 12],
  [2048, 0x13, 12], [2112, 0x14, 12], [2176, 0x15, 12], [2240, 0x16, 12],
  [2304, 0x17, 12], [2368, 0x1c, 12], [2432, 0x1d, 12], [2496, 0x1e, 12],
  [2560, 0x1f, 12],
];

const WHITE = buildTable(WHITE_CODES);
const BLACK = buildTable(BLACK_CODES);

/** @param {number[][]} rows */
function buildTable(rows) {
  /** @type {Map<string, number>} */
  const table = new Map();
  for (const [run, code, bits] of [...rows, ...SHARED_CODES]) {
    table.set(`${bits}:${code}`, run);
  }
  return table;
}

/** The longest run code in either table, so a read knows when to give up. */
const MAX_RUN_BITS = 14;

export class CcittError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CcittError';
  }
}

/** Read bits most significant first, and say honestly when there are no more. */
class Bits {
  /** @param {Buffer} data */
  constructor(data) {
    this.data = data;
    this.pos = 0;
    this.end = data.length * 8;
  }

  get exhausted() {
    return this.pos >= this.end;
  }

  /** One bit, or -1 past the end. */
  read() {
    if (this.pos >= this.end) return -1;
    const byte = this.data[this.pos >> 3];
    const bit = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return bit;
  }

  /** Move to the next byte boundary, for EncodedByteAlign. */
  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

/**
 * @typedef {object} CcittOptions
 * @property {number} columns      pixels per row
 * @property {number} [rows]       expected row count; decoding stops there
 * @property {number} [k]          <0 pure 2D (G4), 0 pure 1D, >0 mixed (G3 2D)
 * @property {boolean} [blackIs1]  when true a 1 bit means black in the output
 * @property {boolean} [byteAlign] each row starts on a byte boundary
 */

/**
 * Decode a CCITT stream into packed one-bit-per-pixel rows.
 *
 * The output is laid out the way PDF and PNG both want it: rows of pixels,
 * most significant bit leftmost, each row padded out to a whole byte. With
 * `blackIs1` false — the PDF default — a 1 bit is white, which is what
 * DeviceGray at one bit per component already means, so what comes back needs
 * no further conversion to be wrapped in a PNG.
 *
 * @param {Uint8Array|Buffer} bytes
 * @param {CcittOptions} opts
 * @returns {Buffer}
 */
export function decodeCcitt(bytes, opts) {
  const columns = opts.columns;
  if (!Number.isInteger(columns) || columns <= 0 || columns > 1 << 16) {
    throw new CcittError(`Column count ${columns} is not a usable width.`);
  }

  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const k = opts.k ?? 0;
  const maxRows = opts.rows && opts.rows > 0 ? opts.rows : Infinity;
  const bits = new Bits(data);

  /** Changing element positions on the line above; this one is all white. */
  let reference = [columns, columns];
  /** @type {number[][]} */
  const lines = [];

  while (lines.length < maxRows && !bits.exhausted) {
    if (opts.byteAlign && k >= 0) bits.align();

    // An EOL before a line is allowed in every variant and required in some.
    // Two together is end-of-block: stop, rather than decode the padding.
    if (consumeEol(bits)) {
      if (consumeEol(bits)) break;
    }
    if (bits.exhausted) break;

    let twoDimensional = k < 0;
    if (k > 0) {
      // In mixed mode one bit after the EOL says how this line was coded.
      const flag = bits.read();
      if (flag < 0) break;
      twoDimensional = flag === 0;
    }

    let line;
    try {
      line = twoDimensional ? decode2D(bits, reference, columns) : decode1D(bits, columns);
    } catch (err) {
      // A stream that stops mid-row is ordinary: encoders pad, and the row
      // count in the dictionary is what is authoritative. Rows already decoded
      // are real and are kept. Only a failure with nothing to show is raised.
      if (lines.length && bits.exhausted) break;
      throw err;
    }
    if (line === null) break;

    lines.push(line);
    reference = line.length ? line : [columns, columns];
  }

  if (!lines.length) throw new CcittError('No complete rows could be decoded.');

  const height = Number.isFinite(maxRows) ? maxRows : lines.length;
  return render(lines, columns, height, opts.blackIs1 === true);
}

/**
 * A run-length coded line: alternating white and black runs, white first.
 *
 * @param {Bits} bits
 * @param {number} columns
 * @returns {number[]|null} changing element positions
 */
function decode1D(bits, columns) {
  /** @type {number[]} */
  const changes = [];
  let pos = 0;
  let colour = 0;

  while (pos < columns) {
    const run = readRun(bits, colour);
    if (run === null) {
      if (!changes.length) return null;
      throw new CcittError('Run-length code not in the T.4 table.');
    }
    pos = Math.min(pos + run, columns);
    changes.push(pos);
    colour ^= 1;
  }
  return changes;
}

/**
 * A line coded against the one above it.
 *
 * Every mode is a statement about where this line's next colour change sits
 * relative to the change above it: the same place (vertical 0), a few pixels
 * either side (vertical ±1..3), past it entirely (pass), or nowhere near it,
 * in which case two explicit run lengths follow (horizontal). That is all of
 * T.6, and it is why a fax of mostly-unchanging rows compresses so hard.
 *
 * @param {Bits} bits
 * @param {number[]} reference
 * @param {number} columns
 * @returns {number[]|null}
 */
function decode2D(bits, reference, columns) {
  /** @type {number[]} */
  const changes = [];
  let a0 = -1;
  let colour = 0;

  while (a0 < columns) {
    const mode = readMode(bits);
    if (mode === null) {
      if (!changes.length && bits.exhausted) return null;
      throw new CcittError('Mode code not in the T.6 table.');
    }
    if (mode === EOL_MODE) break;
    if (mode === EXTENSION) {
      throw new CcittError('Uncompressed-mode extension is not supported.');
    }

    const i = findB1(reference, a0, colour);
    const b1 = i < reference.length ? reference[i] : columns;
    const b2 = i + 1 < reference.length ? reference[i + 1] : columns;

    if (mode === PASS) {
      // The run above ends and starts again before this line's run does, so
      // this line carries its colour straight past both. No change recorded.
      a0 = b2;
      continue;
    }

    if (mode === HORIZONTAL) {
      const start = a0 < 0 ? 0 : a0;
      const first = readRun(bits, colour);
      const second = readRun(bits, colour ^ 1);
      if (first === null || second === null) {
        throw new CcittError('Horizontal mode ran past the end of the data.');
      }
      const a1 = Math.min(start + first, columns);
      const a2 = Math.min(a1 + second, columns);
      changes.push(a1, a2);
      a0 = a2;
      continue;
    }

    const a1 = clamp(b1 + (mode - VERTICAL), 0, columns);
    changes.push(a1);
    a0 = a1;
    colour ^= 1;
  }

  return changes;
}

/**
 * The first changing element on the reference line past a0 that starts a run
 * of the opposite colour to the one being coded.
 *
 * Positions alternate by construction — the element at an even index starts a
 * black run, the one at an odd index starts a white run — so "opposite colour"
 * is a parity test rather than a search.
 *
 * @param {number[]} reference
 * @param {number} a0
 * @param {number} colour
 */
function findB1(reference, a0, colour) {
  let i = 0;
  while (i < reference.length && reference[i] <= a0) i++;
  if ((i & 1) !== colour) i++;
  return i;
}

/**
 * One complete run: any number of makeup codes followed by a terminating one.
 *
 * @param {Bits} bits
 * @param {number} colour
 * @returns {number|null}
 */
function readRun(bits, colour) {
  const table = colour === 0 ? WHITE : BLACK;
  let total = 0;

  for (let guard = 0; guard < 64; guard++) {
    let code = 0;
    let length = 0;
    /** @type {number|undefined} */
    let run = undefined;

    while (length < MAX_RUN_BITS) {
      const bit = bits.read();
      if (bit < 0) return null;
      code = (code << 1) | bit;
      length++;
      const found = table.get(`${length}:${code}`);
      if (found !== undefined) {
        run = found;
        break;
      }
    }
    if (run === undefined) return null;

    total += run;
    // Terminating codes are 0..63. A makeup code is always followed by one,
    // which is why a run of exactly 64 is two codes rather than one.
    if (run < 64) return total;
  }
  return null;
}

/**
 * @param {Bits} bits
 * @returns {number|null}
 */
function readMode(bits) {
  let code = 0;
  let length = 0;
  while (length < 12) {
    const bit = bits.read();
    if (bit < 0) return null;
    code = (code << 1) | bit;
    length++;
    const found = MODES.get(`${length}:${code}`);
    if (found !== undefined) return found;
  }
  return null;
}

/**
 * Consume an end-of-line code if one is next, fill bits and all.
 *
 * Peeks and rewinds, because a run of zeroes is only fill when an EOL really
 * follows it — otherwise those bits are the start of an ordinary code.
 *
 * @param {Bits} bits
 */
function consumeEol(bits) {
  const mark = bits.pos;
  let zeroes = 0;
  while (!bits.exhausted) {
    const bit = bits.read();
    if (bit === 1) {
      if (zeroes >= 11) return true;
      break;
    }
    zeroes++;
    if (zeroes > 4096) break;
  }
  bits.pos = mark;
  return false;
}

/**
 * Turn changing-element positions into packed pixels.
 *
 * A row short of the declared height is left white, which is what a fax that
 * ended early actually looked like coming off the drum.
 *
 * @param {number[][]} lines
 * @param {number} columns
 * @param {number} height
 * @param {boolean} blackIs1
 */
function render(lines, columns, height, blackIs1) {
  const rowBytes = Math.ceil(columns / 8);
  // Every bit set, so an untouched row reads as white. With blackIs1 the
  // meaning of the bits is inverted, and so is a blank row.
  const out = Buffer.alloc(rowBytes * height, blackIs1 ? 0x00 : 0xff);

  for (let y = 0; y < Math.min(lines.length, height); y++) {
    const changes = lines[y];
    const base = y * rowBytes;
    let colour = 0;
    let pos = 0;

    for (const next of changes) {
      const stop = Math.min(next, columns);
      if (colour === 1) paint(out, base, pos, stop, blackIs1);
      pos = stop;
      colour ^= 1;
      if (pos >= columns) break;
    }
    if (colour === 1 && pos < columns) paint(out, base, pos, columns, blackIs1);
  }

  // A width that is not a multiple of eight leaves spare bits at the end of
  // every row. They are outside the picture and nothing renders them, so the
  // fill above left them reading as white — but "nothing renders them" is not
  // the same as "they can be anything". Two decodes of one page have to give
  // one answer, or a content hash is not a content hash. Zeroed.
  const spare = rowBytes * 8 - columns;
  if (spare) {
    const keep = (0xff << spare) & 0xff;
    for (let y = 0; y < height; y++) out[y * rowBytes + rowBytes - 1] &= keep;
  }

  return out;
}

/**
 * Set the pixels of one black run.
 *
 * @param {Buffer} out
 * @param {number} base
 * @param {number} from
 * @param {number} to
 * @param {boolean} blackIs1
 */
function paint(out, base, from, to, blackIs1) {
  for (let x = from; x < to; x++) {
    const at = base + (x >> 3);
    const mask = 0x80 >> (x & 7);
    if (blackIs1) out[at] |= mask;
    else out[at] &= ~mask;
  }
}

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 */
function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}
