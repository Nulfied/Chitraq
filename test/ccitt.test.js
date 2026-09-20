/**
 * Checking a fax decoder against something that is not itself.
 *
 * A wrong image decoder is a particular kind of dangerous here, because the
 * output does not go to a person who would notice. It goes to a vision model,
 * which will read a scrambled page and produce confident text from it. So the
 * bar for this one is not "the picture looks about right" — it is every bit.
 *
 * The fixtures in `fixtures/ccitt/` were produced by Pillow, which carries
 * libtiff's encoder: different code, different tables, different author. Each
 * `.bin` is a real Group 3 or Group 4 stream and each `.expected` is the exact
 * pixels that went into it. `tools/make-ccitt-fixtures.py` regenerates them
 * and states the one convention they depend on. The fixtures are committed, so
 * this runs with no Python and no Pillow anywhere near it.
 *
 * The cases are chosen for where a decoder goes wrong rather than for looking
 * like documents: single-pixel features, ink against both margins, runs past
 * 2560 pixels where the shared makeup codes are the only path, dense noise
 * that forces horizontal mode, and a width that is not a multiple of eight.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeCcitt, CcittError } from '../src/capture/ccitt.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ccitt');

/** @type {Array<{name: string, width: number, height: number, k: number, encodedBytes: number, rawBytes: number}>} */
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));

/** @param {string} name */
const fixture = (name) => readFileSync(join(FIXTURES, name));

test('every fixture decodes to exactly the pixels that were encoded', () => {
  assert.ok(manifest.length >= 12, 'the fixture set is present');

  for (const item of manifest) {
    const decoded = decodeCcitt(fixture(`${item.name}.bin`), {
      columns: item.width,
      rows: item.height,
      k: item.k,
    });
    const expected = fixture(`${item.name}.expected`);

    // Reported before the comparison, because "1200 bytes differ" is useless
    // and "row 43 column 288" is where to look.
    if (!decoded.equals(expected)) {
      const rowBytes = Math.ceil(item.width / 8);
      let at = 0;
      while (at < expected.length && decoded[at] === expected[at]) at++;
      assert.fail(
        `${item.name}: first difference at row ${Math.floor(at / rowBytes)}, ` +
          `byte ${at % rowBytes} of ${rowBytes} ` +
          `(got 0x${decoded[at]?.toString(16)}, expected 0x${expected[at]?.toString(16)})`
      );
    }
  }
});

test('both Group 3 and Group 4 are covered, not just the easy one', () => {
  // The two share the run-length tables and nothing else: G4 is coded against
  // the line above, G3 is coded from scratch each row. A suite that only
  // exercised one would leave half the file untested.
  const kinds = new Set(manifest.map((m) => (m.k < 0 ? 'group4' : 'group3')));
  assert.deepEqual([...kinds].sort(), ['group3', 'group4']);
});

test('a width that is not a multiple of eight leaves no rubbish in the spare bits', () => {
  const odd = manifest.find((m) => m.width % 8 !== 0);
  assert.ok(odd, 'at least one fixture has an awkward width');

  const decoded = decodeCcitt(fixture(`${odd.name}.bin`), {
    columns: odd.width,
    rows: odd.height,
    k: odd.k,
  });

  // Nothing renders these bits, but two decodes of one page still have to
  // agree, or hashing the result means nothing.
  const rowBytes = Math.ceil(odd.width / 8);
  const spare = rowBytes * 8 - odd.width;
  const mask = (1 << spare) - 1;
  for (let y = 0; y < odd.height; y++) {
    assert.equal(decoded[y * rowBytes + rowBytes - 1] & mask, 0, `row ${y} padding`);
  }
});

test('the blank and the solid page are not the same page', () => {
  // The whole decoder is one inversion away from being confidently backwards,
  // and everything downstream would still work. This pins the polarity to the
  // PDF default, where BlackIs1 is false and a set bit is white.
  const white = manifest.find((m) => m.name.startsWith('all-white'));
  const black = manifest.find((m) => m.name.startsWith('all-black'));
  assert.ok(white && black);

  const blank = decodeCcitt(fixture(`${white.name}.bin`), {
    columns: white.width,
    rows: white.height,
    k: white.k,
  });
  const solid = decodeCcitt(fixture(`${black.name}.bin`), {
    columns: black.width,
    rows: black.height,
    k: black.k,
  });

  assert.ok(
    blank.every((b) => b === 0xff),
    'a blank page is all ones'
  );
  assert.ok(
    solid.every((b) => b === 0x00),
    'an inked page is all zeroes'
  );
});

test('BlackIs1 flips which bit means ink, and nothing else', () => {
  const item = manifest.find((m) => m.name === 'text.group4');
  assert.ok(item);
  const opts = { columns: item.width, rows: item.height, k: item.k };

  const normal = decodeCcitt(fixture(`${item.name}.bin`), opts);
  const flipped = decodeCcitt(fixture(`${item.name}.bin`), { ...opts, blackIs1: true });

  const rowBytes = Math.ceil(item.width / 8);
  for (let i = 0; i < normal.length; i++) {
    // Compare only the bits inside the picture; the spare ones are zero in
    // both, which is deliberate and would otherwise look like a mismatch.
    const last = i % rowBytes === rowBytes - 1;
    const mask = last ? (0xff << (rowBytes * 8 - item.width)) & 0xff : 0xff;
    assert.equal((~normal[i] & mask) & 0xff, flipped[i] & mask, `byte ${i}`);
  }
});

test('a short stream keeps the rows it decoded instead of throwing them away', () => {
  // Encoders pad and streams get truncated. Twenty good rows out of fifty is
  // twenty rows a model can read; refusing the page loses all of them.
  const item = manifest.find((m) => m.name === 'rects.group4');
  assert.ok(item);
  const full = fixture(`${item.name}.bin`);
  const cut = full.subarray(0, Math.floor(full.length / 2));

  const decoded = decodeCcitt(cut, { columns: item.width, rows: item.height, k: item.k });
  assert.equal(decoded.length, Math.ceil(item.width / 8) * item.height, 'full height');

  const whole = decodeCcitt(full, { columns: item.width, rows: item.height, k: item.k });
  const rowBytes = Math.ceil(item.width / 8);
  let matching = 0;
  while (
    matching < item.height &&
    decoded
      .subarray(matching * rowBytes, (matching + 1) * rowBytes)
      .equals(whole.subarray(matching * rowBytes, (matching + 1) * rowBytes))
  ) {
    matching++;
  }
  assert.ok(matching > 0, 'some rows survived');
  assert.ok(matching < item.height, 'and the truncation really did cost rows');
});

test('rubbish is refused rather than turned into a page', () => {
  // Random bytes are not a fax, and the useful answer is to say so. A decoder
  // that returns something for anything is the failure mode this whole file
  // is written against.
  const junk = Buffer.from(
    Array.from({ length: 4096 }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff)
  );
  assert.throws(() => decodeCcitt(junk, { columns: 1728, rows: 40, k: -1 }), CcittError);
});

test('an impossible width is rejected before anything is allocated', () => {
  const data = fixture('text.group4.bin');
  for (const columns of [0, -8, 1.5, Number.NaN]) {
    assert.throws(() => decodeCcitt(data, { columns }), CcittError, `columns ${columns}`);
  }
});
