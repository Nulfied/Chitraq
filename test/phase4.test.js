/**
 * Authentication, sync and binary capture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Chitraq } from '../src/chitraq.js';
import { extractPdfText } from '../src/capture/pdf.js';
import { parseSource } from '../src/capture/parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = readFileSync(join(HERE, 'fixtures/sample.pdf'));

// ------------------------------------------------------------------ auth

test('authentication is off until an account exists', () => {
  const c = new Chitraq({ path: ':memory:' });
  assert.equal(c.authEnabled, false, 'a local single-user install needs no login');
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  assert.equal(c.authEnabled, true);
  c.close();
});

test('a correct password opens a session; a wrong one does not', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });

  const session = c.login({ username: 'priya', password: 'correct-horse-battery' });
  assert.ok(session.token);
  assert.equal(c.authenticate(session.token).principalId, c.principal.id);

  assert.throws(() => c.login({ username: 'priya', password: 'wrong' }), /do not match/);
  c.close();
});

test('the same message is returned whether the user or the password is wrong', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });

  let a;
  let b;
  try { c.login({ username: 'priya', password: 'wrong' }); } catch (e) { a = e.message; }
  try { c.login({ username: 'nobody', password: 'wrong' }); } catch (e) { b = e.message; }

  assert.equal(a, b, 'which of the two was wrong is not the caller\'s business');
  c.close();
});

test('tokens are stored hashed, so a database dump yields no live sessions', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  const { token } = c.login({ username: 'priya', password: 'correct-horse-battery' });

  const stored = c.db.prepare('SELECT token_hash FROM session').all();
  assert.ok(stored.length > 0);
  assert.ok(!stored.some((r) => String(r.token_hash) === token), 'the raw token is never stored');
  c.close();
});

test('passwords are not stored in the clear', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  const row = c.db.prepare('SELECT * FROM credential').get();
  assert.ok(!String(row.hash).includes('correct-horse'));
  assert.ok(String(row.salt).length >= 16, 'and each one is salted');
  c.close();
});

test('logging out ends that session only', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  const first = c.login({ username: 'priya', password: 'correct-horse-battery' });
  const second = c.login({ username: 'priya', password: 'correct-horse-battery' });

  c.logout(first.token);
  assert.equal(c.authenticate(first.token), null);
  assert.ok(c.authenticate(second.token), 'other sessions are untouched');
  c.close();
});

test('changing a password ends every existing session', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  const session = c.login({ username: 'priya', password: 'correct-horse-battery' });

  c.createAccount({ username: 'priya', password: 'a-completely-new-secret' });
  assert.equal(
    c.authenticate(session.token),
    null,
    'if the change was prompted by a compromise, old sessions must not survive it'
  );
  c.close();
});

test('short passwords are refused', () => {
  const c = new Chitraq({ path: ':memory:' });
  assert.throws(() => c.createAccount({ username: 'priya', password: 'short' }), /at least 10/);
  c.close();
});

test('an expired session stops authenticating', () => {
  const c = new Chitraq({ path: ':memory:' });
  c.createAccount({ username: 'priya', password: 'correct-horse-battery' });
  const session = c.login({ username: 'priya', password: 'correct-horse-battery' });

  c.db.prepare('UPDATE session SET expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    session.sessionId
  );
  assert.equal(c.authenticate(session.token), null);
  c.close();
});

// ------------------------------------------------------------------ sync

/** @returns {Promise<{a: Chitraq, b: Chitraq, ids: string[]}>} */
async function pairedWorkspaces() {
  const a = new Chitraq({ path: ':memory:' });
  const first = await a.remember({ title: 'Chose SQLite', body: 'It needs no server.', enrich: false });
  const second = await a.remember({ title: 'Dropped Redis', body: 'Hit rate was 12 percent.', enrich: false });
  a.connect(second.object.id, 'depends_on', first.object.id);

  // A second device starts from a full export so the two share history.
  const b = new Chitraq({ path: ':memory:' });
  await b.import(a.export());
  b.useWorkspace(b.db.prepare('SELECT id FROM workspace ORDER BY created_at LIMIT 1').get().id);

  return { a, b, ids: [first.object.id, second.object.id] };
}

test('changes made on one device reach the other', async () => {
  const { a, b } = await pairedWorkspaces();

  const added = await a.remember({ title: 'Added on device A', body: 'New knowledge.', enrich: false });
  const payload = a.changesSince({ peerId: 'device-b' });
  const result = await b.applyChanges(payload, { peerId: 'device-a' });

  assert.ok(result.applied.objects >= 1);
  assert.equal(b.recall(added.object.id)?.object.title, 'Added on device A');
  assert.equal(result.conflicts.length, 0);
  a.close();
  b.close();
});

test('an edit on one device applies cleanly on the other', async () => {
  const { a, b, ids } = await pairedWorkspaces();

  await a.correct(ids[0], { body: 'It needs no server and ships inside Node.' }, 'clearer');
  const result = await b.applyChanges(a.changesSince(), { peerId: 'device-a' });

  assert.equal(result.conflicts.length, 0, 'a clean fast-forward is not a conflict');
  assert.match(b.recall(ids[0]).object.body, /ships inside Node/);
  assert.equal(b.recall(ids[0]).history.length, 2, 'and the history came with it');
  a.close();
  b.close();
});

test('independent edits to the same object raise a conflict instead of losing one', async () => {
  const { a, b, ids } = await pairedWorkspaces();

  await a.correct(ids[0], { body: 'Device A version of the text.' }, 'edited on A');
  await b.correct(ids[0], { body: 'Device B version of the text.' }, 'edited on B');

  const result = await b.applyChanges(a.changesSince(), { peerId: 'device-a' });

  assert.equal(result.conflicts.length, 1, 'divergence is recorded, not silently resolved');
  assert.equal(
    b.recall(ids[0]).object.body,
    'Device B version of the text.',
    'local state is kept rather than overwritten'
  );

  const conflict = b.conflicts({ status: 'open' }).find((x) => x.kind === 'sync-divergence');
  assert.ok(conflict, 'and it is visible to the user');
  assert.match(conflict.detail.remoteBody, /Device A version/, 'with the other side preserved');
  a.close();
  b.close();
});

test('syncing twice changes nothing the second time', async () => {
  const { a, b } = await pairedWorkspaces();
  await a.remember({ title: 'Something new', body: 'Content.', enrich: false });

  const payload = a.changesSince();
  const first = await b.applyChanges(payload, { peerId: 'device-a' });
  const second = await b.applyChanges(payload, { peerId: 'device-a' });

  assert.ok(first.applied.objects >= 1);
  assert.equal(second.applied.objects ?? 0, 0);
  a.close();
  b.close();
});

test('a cursor limits the next exchange to what is actually new', async () => {
  const { a, b } = await pairedWorkspaces();

  const firstPull = a.changesSince({ peerId: 'device-b' });
  const baseline = firstPull.objects.length;
  assert.ok(baseline > 0);

  await new Promise((r) => setTimeout(r, 5));
  await a.remember({ title: 'Only this is new', body: 'Content.', enrich: false });

  const secondPull = a.changesSince({ peerId: 'device-b' });
  assert.ok(secondPull.objects.length < baseline, 'the cursor stops us resending everything');
  assert.ok(secondPull.objects.some((o) => o.title === 'Only this is new'));
  a.close();
  b.close();
});

test('sync never deletes anything the peer has not seen', async () => {
  const { a, b } = await pairedWorkspaces();
  const localOnly = await b.remember({ title: 'Only on device B', body: 'Local.', enrich: false });

  await b.applyChanges(a.changesSince(), { peerId: 'device-a' });

  assert.ok(b.recall(localOnly.object.id), 'a peer that has not seen it does not get to remove it');
  a.close();
  b.close();
});

test('a user-asserted relationship is not displaced by a remote one', async () => {
  const { a, b, ids } = await pairedWorkspaces();

  // Both sides independently assert the same edge; neither should clobber the other.
  a.connect(ids[0], 'related_to', ids[1]);
  b.connect(ids[0], 'related_to', ids[1]);

  const result = await b.applyChanges(a.changesSince(), { peerId: 'device-a' });
  const edges = b.recall(ids[0]).relations.outgoing.filter((e) => e.type === 'related_to');
  assert.equal(edges.length, 1, 'agreement does not create a duplicate edge');
  assert.equal(edges[0].origin, 'user');
  a.close();
  b.close();
});

test('a dry run reports what sync would do without writing', async () => {
  const { a, b } = await pairedWorkspaces();
  await a.remember({ title: 'Pending arrival', body: 'Content.', enrich: false });

  const before = b.stats().objects;
  const dry = await b.applyChanges(a.changesSince(), { dryRun: true });
  assert.ok(dry.applied.objects >= 1);
  assert.equal(b.stats().objects, before, 'nothing was written');
  a.close();
  b.close();
});

test('an unrecognised sync format is refused', async () => {
  const c = new Chitraq({ path: ':memory:' });
  await assert.rejects(
    async () => c.applyChanges({ format: 'something-else/v1' }),
    /Unrecognised sync format/
  );
  c.close();
});

// -------------------------------------------------------- binary capture

test('a PDF yields its text, page count and document metadata', () => {
  const result = extractPdfText(SAMPLE_PDF);
  assert.equal(result.extracted, true);
  assert.equal(result.pages, 1);
  assert.match(result.text, /dependency-free/);
  assert.match(result.text, /38ms across 14,000 chunks/);
  assert.equal(result.meta.title, 'Architecture review');
  assert.equal(result.meta.author, 'Priya Rao');
});

test('a PDF is detected by its bytes, not only its filename', () => {
  const parsed = parseSource({ bytes: SAMPLE_PDF, filename: 'mystery.bin' });
  assert.equal(parsed.mediaType, 'application/pdf');
  assert.match(parsed.text, /dependency-free/);
});

test('a PDF flows through ingestion into reviewable proposals', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const result = await c.ingest({
    bytes: SAMPLE_PDF,
    filename: 'review.pdf',
    keepBlob: true,
  });

  assert.equal(result.source.media_type, 'application/pdf');
  assert.ok(result.proposals.length > 0, 'the claims inside it become proposals');
  assert.ok(result.parsed.meta.pages === 1);

  await c.reviewAll({ action: 'accept' });
  const found = await c.search('dependency-free memory engine');
  assert.ok(found.results.length > 0, 'and the content is then searchable');
  c.close();
});

test('an encrypted PDF says so instead of returning rubbish', () => {
  const fake = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.from('1 0 obj << /Encrypt 2 0 R /Type /Catalog >> endobj\n'),
  ]);
  const result = extractPdfText(fake);
  assert.equal(result.extracted, false);
  assert.match(result.reason, /encrypted/i);
});

test('a scanned PDF names the capability that would read it', () => {
  // A PDF with page structure but no text operators — what a scan looks like.
  const scanned = Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << /Size 2 >>\n%%EOF'
  );
  const parsed = parseSource({ bytes: scanned, filename: 'scan.pdf' });
  assert.equal(parsed.needsCapability, 'ocr.document');
  assert.match(parsed.meta.reason, /scanned|OCR/i);
});

test('images and audio are captured with the capability they await', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const image = parseSource({ bytes: png, filename: 'diagram.png' });
  assert.equal(image.needsCapability, 'ocr.image');
  assert.equal(image.mediaType, 'image/png');

  const audio = parseSource({ bytes: Buffer.from([0xff, 0xfb, 0x90, 0x00]), filename: 'standup.mp3' });
  assert.equal(audio.needsCapability, 'speech.transcribe');
});

test('capability coverage reports honestly that nothing reads images yet', async () => {
  const c = new Chitraq({ path: ':memory:' });
  const { coverage } = await c.capabilities();

  assert.equal(coverage['ocr.image'].best, null, 'no provider is claimed where none exists');
  assert.equal(coverage['speech.transcribe'].best, null);
  assert.ok(coverage['embed.text'].best, 'while the ones that do work are reported');
  c.close();
});
