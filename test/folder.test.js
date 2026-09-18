/**
 * Folder capture.
 *
 * What is under test is mostly what does NOT get captured. A walk that quietly
 * swallows node_modules, or follows a symlink into its own ancestor, or dies on
 * the one unreadable file in four hundred, is worse than no walk at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planFolder, skipSummary, DOCUMENT_EXTENSIONS } from '../src/capture/folder.js';
import { Chitraq } from '../src/chitraq.js';

/** Build a small, realistic notes folder with some machinery mixed in. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chitraq-folder-'));

  await writeFile(join(root, 'architecture.md'), '# Architecture\n\nWe chose SQLite because it needs no server.\n');
  await writeFile(join(root, 'meeting.txt'), 'Pricing was set at 40 dollars per seat on 3 March.\n');
  await writeFile(join(root, 'empty.md'), '');
  await writeFile(join(root, 'package.json'), '{"name":"not-a-note"}');
  await writeFile(join(root, 'index.ts'), 'export const x = 1;');

  await mkdir(join(root, 'projects'), { recursive: true });
  await writeFile(join(root, 'projects', 'chitraq.md'), '# Chitraq\n\nThe memory engine for everyone.\n');

  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'left-pad', 'readme.md'), '# left-pad\n');

  await mkdir(join(root, '.obsidian'), { recursive: true });
  await writeFile(join(root, '.obsidian', 'workspace.md'), 'not a note');

  await writeFile(join(root, '.secret.md'), 'hidden note');

  return root;
}

test('planFolder captures documents and explains every omission', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const plan = await planFolder(root);
  const captured = plan.files.map((f) => f.relative).sort();

  assert.deepEqual(captured, ['architecture.md', 'meeting.txt', 'projects/chitraq.md']);

  // Machinery never becomes memory.
  assert.ok(!captured.some((p) => p.includes('node_modules')));
  assert.ok(!captured.some((p) => p.includes('.obsidian')));

  // Every omission has a stated reason, so "where is my note?" is answerable.
  const reasons = skipSummary(plan.skipped);
  assert.equal(reasons['ignored-directory'], 1, 'node_modules skipped by name');
  assert.equal(reasons.empty, 1, 'the zero-byte file');
  assert.ok(reasons.hidden >= 2, '.obsidian and .secret.md');
  assert.equal(reasons['unsupported-type'], 2, 'package.json and index.ts');
  assert.equal(plan.skipped.length, Object.values(reasons).reduce((a, b) => a + b, 0));
});

test('--include widens and --only replaces', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const widened = await planFolder(root, { include: ['json'] });
  assert.ok(widened.files.some((f) => f.relative === 'package.json'));
  assert.ok(widened.files.some((f) => f.relative === 'architecture.md'), 'defaults still apply');

  const only = await planFolder(root, { include: ['json'], only: true });
  assert.deepEqual(only.files.map((f) => f.relative), ['package.json']);
});

test('the walk stays inside the folder and does not follow symlinks', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  // A link to an ancestor. Following it means walking forever.
  try {
    await symlink(root, join(root, 'projects', 'loop'), 'dir');
  } catch {
    return; // Windows without developer mode cannot create these; nothing to prove.
  }

  const plan = await planFolder(root);
  assert.equal(plan.files.length, 3, 'unchanged by the link');
  assert.ok(plan.skipped.some((s) => s.reason === 'symbolic-link'));
});

test('non-recursive and limit are honoured, and limit is stable across runs', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const shallow = await planFolder(root, { recursive: false });
  assert.deepEqual(shallow.files.map((f) => f.relative).sort(), ['architecture.md', 'meeting.txt']);

  const a = await planFolder(root, { limit: 2 });
  const b = await planFolder(root, { limit: 2 });
  assert.equal(a.files.length, 2);
  assert.ok(a.limited);
  assert.deepEqual(a.files.map((f) => f.relative), b.files.map((f) => f.relative), 'deterministic');
});

test('oversized files are skipped with their size, not silently', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, 'huge.md'), 'x'.repeat(4096));
  const plan = await planFolder(root, { maxBytes: 1024 });

  const big = plan.skipped.find((s) => s.relative === 'huge.md');
  assert.equal(big?.reason, 'too-large');
  assert.match(big?.detail ?? '', /KB/);
});

test('planFolder refuses a file and a missing path, in words', async () => {
  const root = await fixture();
  await assert.rejects(() => planFolder(join(root, 'architecture.md')), /not a folder/);
  await assert.rejects(() => planFolder(join(root, 'nowhere')), /nothing at/);
  await rm(root, { recursive: true, force: true });
});

test('ingestFolder captures, then skips what it already has', async (t) => {
  const root = await fixture();
  const c = new Chitraq({ path: ':memory:' });
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await c.ingestFolder(root, { extract: false });
  assert.equal(first.captured.length, 3);
  assert.equal(first.duplicates.length, 0);
  assert.equal(first.failures.length, 0);

  // The re-run property is the one that makes "press Ctrl-C whenever" true.
  const second = await c.ingestFolder(root, { extract: false });
  assert.equal(second.captured.length, 0);
  assert.equal(second.duplicates.length, 3);

  // And the text actually landed, rather than the files merely being counted.
  const found = await c.search('sqlite needs no server', { semantic: false });
  assert.ok(found.total >= 0);
  const sources = c.db
    .prepare('SELECT text FROM source WHERE workspace_id = ?')
    .all(c.workspaceId)
    .map((r) => String(r.text));
  assert.ok(sources.some((t2) => t2.includes('SQLite')));
});

test('ingestFolder extracts knowledge as proposals, never as writes', async (t) => {
  const root = await fixture();
  const c = new Chitraq({ path: ':memory:' });
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });

  const result = await c.ingestFolder(root);
  assert.ok(result.proposed > 0, 'the deterministic segmenter found something');

  const pending = c.db
    .prepare("SELECT COUNT(*) AS n FROM proposal WHERE workspace_id = ? AND status = 'pending'")
    .get(c.workspaceId);
  assert.ok(Number(pending.n) > 0, 'waiting for a human, not applied');
});

test('one bad file costs that file and nothing else', async (t) => {
  const root = await fixture();
  const c = new Chitraq({ path: ':memory:' });
  t.after(async () => {
    c.close();
    await chmod(join(root, 'meeting.txt'), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const plan = await planFolder(root);
  // Delete a planned file between planning and reading — the same shape as a
  // file vanishing mid-run, which on a real notes folder is not rare.
  await rm(join(root, 'meeting.txt'));

  const seen = [];
  const result = await c.ingestFolder(root, {
    plan,
    extract: false,
    onProgress: (p) => seen.push(p.outcome),
  });

  assert.equal(result.failures.length, 1);
  assert.equal(result.captured.length, plan.files.length - 1, 'the rest still went in');
  assert.equal(seen.length, plan.files.length, 'progress reported for every file, including the failure');
  assert.equal(seen.filter((o) => o === 'failed').length, 1);
});

test('progress reports every file exactly once, in plan order', async (t) => {
  const root = await fixture();
  const c = new Chitraq({ path: ':memory:' });
  t.after(async () => {
    c.close();
    await rm(root, { recursive: true, force: true });
  });

  /** @type {any[]} */
  const seen = [];
  const result = await c.ingestFolder(root, { extract: false, onProgress: (p) => seen.push(p) });

  assert.deepEqual(
    seen.map((p) => p.file.relative),
    result.plan.files.map((f) => f.relative)
  );
  assert.deepEqual(seen.map((p) => p.index), [1, 2, 3]);
  assert.ok(seen.every((p) => p.total === 3));
});

test('the default extension list is documents, not data', () => {
  for (const noisy of ['json', 'csv', 'log', 'yaml', 'ts', 'js']) {
    assert.ok(!DOCUMENT_EXTENSIONS.includes(noisy), `${noisy} is not captured by default`);
  }
  for (const wanted of ['md', 'txt', 'pdf', 'html']) {
    assert.ok(DOCUMENT_EXTENSIONS.includes(wanted));
  }
});
