/**
 * Reading an encrypted PDF, and refusing the ones that are genuinely shut.
 *
 * Most PDFs people call encrypted are not protecting anything from the
 * person holding them. A bank statement, an exam form, a government
 * download: the *user* password is empty, so any reader opens them with no
 * prompt. What is set is the *owner* password, a wish about printing that
 * readers are free to ignore. Chitraq refusing to read a file its owner can
 * open on a phone was a gap, not a safeguard.
 *
 * The fixtures are encrypted by pypdf — different code, different author —
 * and the assertion is that the text which comes out equals the text that
 * went in. That matters because the failure mode here is not a crash. It is
 * a key that is almost right, producing bytes that are almost a content
 * stream, from which almost-text gets stored as though somebody wrote it.
 *
 * `tools/make-pdf-crypt-fixtures.py` regenerates them. The fixtures are
 * committed, so this runs with no Python and no pypdf present.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractPdfText } from '../src/capture/pdf.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pdf-crypt');

/** @type {{lines: string[], fixtures: any[], locked: any[], password: string}} */
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));

/** @param {string} name */
const pdf = (name) => readFileSync(join(DIR, `${name}.pdf`));

test('the unencrypted original reads, which is what the rest is measured against', () => {
  const result = extractPdfText(pdf('plain'));
  assert.equal(result.extracted, true);
  for (const line of manifest.lines) {
    assert.ok(result.text.includes(line), `missing: ${line}`);
  }
});

test('every encryption revision decrypts to exactly the original text', () => {
  // RC4-40 (R2), RC4-128 (R3), AES-128 (R4), AES-256 (R6), AES-256-R5.
  assert.ok(manifest.fixtures.length >= 5, 'all five are present');

  for (const item of manifest.fixtures) {
    const result = extractPdfText(pdf(item.name));
    assert.equal(result.extracted, true, `${item.name}: ${result.reason ?? ''}`);

    for (const line of manifest.lines) {
      assert.ok(result.text.includes(line), `${item.name} (${item.algorithm}) lost: ${line}`);
    }
  }
});

test('the figures survive, because a near-miss key would mangle them quietly', () => {
  // Prose can look plausible after a partial decryption. Numbers do not, and
  // numbers are the thing a memory engine must never quietly alter.
  const withFigures = manifest.lines.find((l) => l.includes('1728'));
  assert.ok(withFigures);

  for (const item of manifest.fixtures) {
    const { text } = extractPdfText(pdf(item.name));
    assert.ok(text.includes('1728 columns'), `${item.name}`);
    assert.ok(text.includes('27.26 seconds'), `${item.name}`);
    assert.ok(text.includes('0.35 score'), `${item.name}`);
  }
});

test('a real user password is refused rather than guessed at', () => {
  // The bug this test exists for. Revisions 2 to 4 derive a key from *any*
  // password — nothing in the derivation can fail — so without the
  // specification's Algorithm 6 check a wrong password produced a wrong key,
  // decrypted to rubbish, found no text operators, and reported "no text
  // layer found, most likely a scanned document". Not a refusal: a confident
  // wrong answer about what kind of file it was.
  for (const item of manifest.locked) {
    const bytes = pdf(item.name);

    for (const attempt of [undefined, 'wrong', '']) {
      const result = extractPdfText(bytes, { password: attempt });
      assert.equal(result.extracted, false, `${item.name} with ${attempt ?? 'no password'}`);
      assert.equal(result.meta.needsPassword, true, `${item.name}: says it needs a password`);
      assert.match(result.reason, /password/i);
      assert.ok(!/scanned/i.test(result.reason), 'and does not misdiagnose it as a scan');
    }
  }
});

test('the right password opens it', () => {
  for (const item of manifest.locked) {
    const result = extractPdfText(pdf(item.name), { password: manifest.password });
    assert.equal(result.extracted, true, `${item.name}: ${result.reason ?? ''}`);
    for (const line of manifest.lines) {
      assert.ok(result.text.includes(line), `${item.name} lost: ${line}`);
    }
  }
});

test('an unrecognised handler is named, not attempted', () => {
  // A custom security handler is somebody's rights-management plug-in.
  // Producing text from it would mean producing text this cannot read.
  const custom = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n' +
      '2 0 obj << /Filter /SomeVendor /V 4 /R 4 >> endobj\ntrailer << /Size 3 >>\n%%EOF'
  );
  const result = extractPdfText(custom);
  assert.equal(result.extracted, false);
  assert.match(result.reason, /encrypted/i);
});

test('an encrypted PDF still reports its page count', () => {
  // Refusing to read the text is not a reason to know nothing about it, and
  // the page count is what tells somebody whether it is worth finding the
  // password for.
  for (const item of manifest.locked) {
    const result = extractPdfText(pdf(item.name));
    assert.equal(result.meta.encrypted, true);
    assert.ok(result.pages >= 1, `${item.name}: pages counted`);
  }
});
