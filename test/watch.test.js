/**
 * Watching a folder.
 *
 * The principle being kept is that Chitraq does no implicit work: this is a
 * foreground watcher you start and stop, not a daemon that appears. What is
 * under test is mostly the three things file watchers get wrong — that one save
 * fires several events, that a file being written is not yet a file, and that
 * slow work must not pile up on itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { watchFolder, SETTLE_MS } from '../src/capture/watch.js';
import { Chitraq } from '../src/chitraq.js';

const QUICK = 60;

/** Give the watcher time to settle and drain. */
const idle = (ms = QUICK * 6) => new Promise((r) => setTimeout(r, ms));

async function folder() {
  return mkdtemp(join(tmpdir(), 'chitraq-watch-'));
}

test('a new file is captured shortly after it appears', async (t) => {
  const root = await folder();
  /** @type {string[][]} */
  const seen = [];
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async (paths) => {
      seen.push(paths);
      return { captured: paths.map((p) => ({ file: { relative: p } })) };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, 'note.md'), '# A note\n\nSomething worth keeping.\n');
  await idle();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
  assert.match(seen[0][0], /note\.md$/);
});

test('one save is one capture, however many events the editor fires', async (t) => {
  const root = await folder();
  const seen = [];
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async (paths) => {
      seen.push(paths);
      return { captured: [] };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  // Editors write, rename and touch. Three events, one save.
  const path = join(root, 'note.md');
  await writeFile(path, 'first');
  await writeFile(path, 'second');
  await writeFile(path, 'third');
  await idle();

  assert.equal(seen.length, 1, 'debounced into one');
  assert.equal(seen[0].length, 1);
});

test('a file still being written is not read half-finished', async (t) => {
  const root = await folder();
  /** @type {number[]} */
  const sizes = [];
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async (paths) => {
      const { statSync } = await import('node:fs');
      for (const p of paths) sizes.push(statSync(p).size);
      return { captured: [] };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  // Written in pieces, slower than the settle window. Capturing at the first
  // event would store a fragment as though it were the document.
  const path = join(root, 'big.md');
  const handle = await open(path, 'w');
  for (let i = 0; i < 5; i++) {
    await handle.write('x'.repeat(2000));
    await new Promise((r) => setTimeout(r, QUICK / 2));
  }
  await handle.close();
  await idle();

  assert.ok(sizes.length >= 1, 'it was captured');
  // The guarantee is that no capture ever sees a fragment — not that there is
  // exactly one. Closing a handle updates the modified time after the last
  // write, so a trailing event can legitimately arrive; that costs a second
  // read of identical bytes, which the content hash then recognises. A
  // duplicate capture is wasteful. A partial one is a corrupted memory.
  for (const size of sizes) {
    assert.equal(size, 10000, 'every capture saw the whole file');
  }
});

test('slow work does not pile up on itself', async (t) => {
  const root = await folder();
  let concurrent = 0;
  let peak = 0;
  let batches = 0;

  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async (paths) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      batches++;
      // Stands in for extraction with a local model, which is about this slow
      // relative to how fast someone can hit save.
      await new Promise((r) => setTimeout(r, QUICK * 3));
      concurrent--;
      return { captured: [] };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  for (let i = 0; i < 6; i++) {
    await writeFile(join(root, `note-${i}.md`), `Note number ${i}.`);
    await new Promise((r) => setTimeout(r, QUICK / 3));
  }
  await idle(QUICK * 20);

  assert.equal(peak, 1, 'never two captures at once');
  assert.ok(batches < 6, `saves that arrived together were batched (${batches} runs)`);
});

test('the watcher captures only what a folder walk would', async (t) => {
  const root = await folder();
  const seen = [];
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async (paths) => {
      seen.push(...paths);
      return { captured: [] };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'readme.md'), '# vendored');
  await writeFile(join(root, 'index.ts'), 'export const x = 1;');
  await writeFile(join(root, '.hidden.md'), 'secret');
  await writeFile(join(root, 'real.md'), '# A real note');
  await idle();

  // The rules come from planFolder rather than being restated here, so the
  // walk and the watch can never disagree about what counts as a note.
  assert.equal(seen.length, 1);
  assert.match(seen[0], /real\.md$/);
});

test('a failed capture does not end the watch', async (t) => {
  const root = await folder();
  let attempts = 0;
  const events = [];
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    onEvent: (e) => events.push(e.type),
    capture: async () => {
      attempts++;
      if (attempts === 1) throw new Error('disk was busy');
      return { captured: [] };
    },
  });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, 'one.md'), 'first');
  await idle();
  await writeFile(join(root, 'two.md'), 'second');
  await idle();

  assert.equal(attempts, 2, 'it kept going');
  assert.deepEqual(events, ['failed', 'captured']);
});

test('stopping is immediate and waits for work already started', async (t) => {
  const root = await folder();
  let finished = false;
  const watcher = watchFolder({
    root,
    settleMs: QUICK,
    capture: async () => {
      await new Promise((r) => setTimeout(r, QUICK * 4));
      finished = true;
      return { captured: [] };
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, 'note.md'), 'content');
  await idle(QUICK * 2);

  watcher.stop();
  await watcher.done;
  assert.equal(finished, true, 'the capture in flight was allowed to complete');

  // And nothing is picked up afterwards.
  await writeFile(join(root, 'after.md'), 'too late');
  await idle();
  assert.equal(watcher.state().queued, 0);
});

test('watching writes real knowledge, end to end', async (t) => {
  const root = await folder();
  const c = new Chitraq({ path: ':memory:' });
  const watcher = c.watch(root, { extract: false, settleMs: QUICK });
  t.after(async () => {
    watcher.stop();
    await watcher.done;
    c.close();
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, 'pricing.md'), '# Pricing\n\nForty dollars per seat from March.\n');
  await idle(QUICK * 10);

  const sources = c.db
    .prepare('SELECT text FROM source WHERE workspace_id = ?')
    .all(c.workspaceId)
    .map((r) => String(r.text));
  assert.ok(sources.some((t2) => t2.includes('Forty dollars per seat')));
});

test('the default settle window is long enough for a real editor', () => {
  // Not a tunable so much as a claim: below a few hundred milliseconds an
  // atomic-save editor gets caught mid-rename.
  assert.ok(SETTLE_MS >= 500);
});
