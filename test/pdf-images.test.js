/**
 * Reading a scanned PDF.
 *
 * This corrects a claim the project made about itself. STATUS.md said a scanned
 * PDF needed rasterising and that every route to it was a dependency Chitraq
 * would not take. That is true for fax-encoded scans and false for the common
 * ones: a `DCTDecode` stream *is* a JPEG, and a `FlateDecode` bitmap only needs
 * a PNG header wrapped round it, which is arithmetic.
 *
 * So most of these tests are about the boundary — what comes out, what is
 * refused, and whether the refusals say which is which.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

import { extractPdfImages } from '../src/capture/pdf-images.js';
import { extractPdfText } from '../src/capture/pdf.js';
import { pdfOcrProvider } from '../src/intelligence/providers/pdf-ocr.js';
import { Capability } from '../src/intelligence/registry.js';
import { Chitraq } from '../src/chitraq.js';

/**
 * Assemble a minimal PDF holding one image XObject.
 * @param {{dict: string, data: Buffer}} image
 */
function pdfWithImage(image) {
  const content = Buffer.from('q 200 0 0 200 0 0 cm /Im0 Do Q');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
  ];

  let pdf = '%PDF-1.4\n';
  const add = (n, dict, stream) => {
    pdf += `${n} 0 obj\n${dict}\n`;
    if (stream) pdf += `stream\n${stream.toString('latin1')}\nendstream\n`;
    pdf += 'endobj\n';
  };
  objects.forEach((d, i) => add(i + 1, d));
  add(4, `${image.dict} /Length ${image.data.length} >>`, image.data);
  add(5, `<< /Length ${content.length} >>`, content);
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF';
  return Buffer.from(pdf, 'latin1');
}

/** A 200×200 grey bitmap, uncompressed then deflated as PDF would store it. */
function greyBitmap(value = 128) {
  return deflateSync(Buffer.alloc(200 * 200, value));
}

test('a JPEG inside a PDF comes out as a JPEG, untouched', () => {
  // The heart of it. These bytes are already a complete file, so the correct
  // operation is to hand them over rather than to decode anything.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(4000, 0x42),
    Buffer.from([0xff, 0xd9]),
  ]);
  const pdf = pdfWithImage({
    dict: '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /Filter /DCTDecode',
    data: jpeg,
  });

  const { images, unreadable } = extractPdfImages(pdf);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/jpeg');
  assert.deepEqual(images[0].data, jpeg, 'byte for byte, nothing re-encoded');
  assert.deepEqual(unreadable, []);
});

test('a raw bitmap comes out as a valid PNG', () => {
  const pdf = pdfWithImage({
    dict:
      '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 ' +
      '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
    data: greyBitmap(),
  });

  const { images } = extractPdfImages(pdf);
  assert.equal(images.length, 1);
  assert.equal(images[0].mediaType, 'image/png');
  assert.deepEqual(
    [...images[0].data.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    'a real PNG signature'
  );
  assert.equal(images[0].data.subarray(12, 16).toString('latin1'), 'IHDR');
});

test('fax-encoded scans are named, not guessed at', () => {
  for (const filter of ['CCITTFaxDecode', 'JBIG2Decode']) {
    const pdf = pdfWithImage({
      dict: `<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /Filter /${filter}`,
      data: Buffer.alloc(2000, 0x01),
    });
    const { images, unreadable } = extractPdfImages(pdf);
    assert.equal(images.length, 0);
    assert.equal(unreadable[0].filter, filter);
    assert.match(unreadable[0].reason, /decoder Chitraq does not have/);
  }
});

test('a colour space that would need converting is refused rather than mangled', () => {
  // A wrong picture that looks like a picture is worse than no picture: a model
  // will read it and produce confident text from nothing.
  const pdf = pdfWithImage({
    dict:
      '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 ' +
      '/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode',
    data: greyBitmap(),
  });
  const { images, unreadable } = extractPdfImages(pdf);
  assert.equal(images.length, 0);
  assert.match(unreadable[0].reason, /colour space/);
});

test('a differenced bitmap is refused rather than un-differenced wrongly', () => {
  const pdf = pdfWithImage({
    dict:
      '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 ' +
      '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ' +
      '/DecodeParms << /Predictor 12 /Colors 1 >>',
    data: greyBitmap(),
  });
  const { images, unreadable } = extractPdfImages(pdf);
  assert.equal(images.length, 0);
  assert.match(unreadable[0].reason, /predictor/i);
});

test('logos and rules are not mistaken for pages', () => {
  const pdf = pdfWithImage({
    dict: '<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /DCTDecode',
    data: Buffer.alloc(300, 0x42),
  });
  assert.equal(extractPdfImages(pdf).images.length, 0, 'too small to be a scan');
});

test('"endstream" contains "stream", and that used to find every stream twice', async () => {
  // A real bug this work uncovered. The second find landed three bytes into the
  // terminator, where the dictionary lookup reported the *previous* object's
  // filter — so readable PDFs counted phantom unsupported streams.
  const scanned = await readFile(new URL('../test/fixtures/scanned.pdf', import.meta.url));
  const { images, unreadable } = extractPdfImages(scanned);
  assert.equal(images.length, 1);
  assert.deepEqual(unreadable, [], 'no phantom second stream');

  const text = await readFile(new URL('../test/fixtures/sample.pdf', import.meta.url));
  const parsed = extractPdfText(text);
  assert.equal(parsed.extracted, true);
  assert.ok(!parsed.meta.unsupportedFilter, 'and none counted in a text PDF either');
});

// ------------------------------------------------- the provider

/** @param {(bytes: Buffer) => any} read */
function provider(read) {
  return pdfOcrProvider({ readImage: async ({ bytes }) => read(bytes) });
}

test('the document reader delegates every page to whatever reads images', async () => {
  const seen = [];
  const p = provider((bytes) => {
    seen.push(bytes.length);
    return { text: `page ${seen.length}` };
  });

  const pdf = await readFile(new URL('../test/fixtures/scanned.pdf', import.meta.url));
  const result = await p.capabilities[Capability.OcrDocument].run({ bytes: pdf });

  assert.equal(seen.length, 1, 'one image, one call');
  assert.equal(result.text, 'page 1');
  assert.equal(result.pagesRead, 1);
  assert.match(result.uncertainty, /twice removed/);
});

test('one unreadable page costs that page, not the document', async () => {
  let n = 0;
  const p = pdfOcrProvider({
    readImage: async () => {
      n++;
      if (n === 2) throw new Error('model fell over');
      return { text: `page ${n}` };
    },
  });

  // Three images, the middle one failing.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(5000, 0x42)]);
  const one = '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /Filter /DCTDecode';
  let pdf = '%PDF-1.4\n';
  for (let i = 0; i < 3; i++) {
    pdf += `${i + 1} 0 obj\n${one} /Length ${jpeg.length} >>\nstream\n${jpeg.toString('latin1')}\nendstream\nendobj\n`;
  }
  pdf += '%%EOF';

  const result = await p.capabilities[Capability.OcrDocument].run({
    bytes: Buffer.from(pdf, 'latin1'),
  });

  assert.equal(result.pagesFound, 3);
  assert.equal(result.pagesRead, 2, 'the other two survived');
  assert.equal(result.failures.length, 1);
});

test('a PDF with nothing extractable fails with the reason, not a shrug', async () => {
  const p = provider(() => ({ text: 'unused' }));
  const pdf = pdfWithImage({
    dict: '<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /Filter /JBIG2Decode',
    data: Buffer.alloc(2000, 1),
  });

  await assert.rejects(
    () => p.capabilities[Capability.OcrDocument].run({ bytes: pdf }),
    /bilevel fax encoding/
  );
});

test('the document reader is unavailable when nothing can read an image', async () => {
  const off = pdfOcrProvider({ readImage: async () => ({}), canReadImages: () => false });
  assert.equal(await off.available(), false);

  const on = pdfOcrProvider({ readImage: async () => ({}), canReadImages: () => true });
  assert.equal(await on.available(), true);
});

test('with no image reader configured, a scanned PDF is captured and reported', async (t) => {
  const c = new Chitraq({ path: ':memory:' });
  t.after(() => c.close());

  const pdf = await readFile(new URL('../test/fixtures/scanned.pdf', import.meta.url));
  const result = await c.ingest({ bytes: pdf, filename: 'scanned.pdf', keepBlob: true });

  assert.equal(result.parsed.text, '');
  assert.equal(result.parsed.needsCapability, 'ocr.document');
  assert.equal(result.reading, null);
  assert.ok(
    c.db.prepare('SELECT blob FROM source WHERE id = ?').get(result.source.id).blob.byteLength > 0
  );
});

test('with one, the scan becomes text that remembers it was read', async (t) => {
  const stub = {
    id: 'stub-vision',
    label: 'stub',
    locality: 'local',
    cost: 'free',
    available: async () => true,
    capabilities: {
      [Capability.OcrImage]: {
        quality: 0.6,
        latencyMs: 1,
        run: async () => ({ text: 'SCANNED PAGE', model: 'stub:v1' }),
      },
    },
  };
  const c = new Chitraq({ path: ':memory:', providers: [stub] });
  t.after(() => c.close());

  const pdf = await readFile(new URL('../test/fixtures/scanned.pdf', import.meta.url));
  const result = await c.ingest({ bytes: pdf, filename: 'scanned.pdf' });

  assert.equal(result.parsed.text, 'SCANNED PAGE');
  assert.equal(result.parsed.needsCapability, null);
  assert.equal(result.reading.via.capability, 'ocr.document');
  assert.equal(result.reading.via.provider, 'pdf-pages');

  const meta = JSON.parse(
    String(c.db.prepare('SELECT meta FROM source WHERE id = ?').get(result.source.id).meta)
  );
  assert.equal(meta.textVia.capability, 'ocr.document');
});
