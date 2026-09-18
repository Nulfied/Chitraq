/**
 * Watching a folder, when you ask it to.
 *
 * STATUS.md has said, as a deliberate choice, that nothing in Chitraq watches
 * anything: no timer, no file watcher, no background exchange. That choice was
 * about *implicit* work — a process that quietly reads your disk and calls
 * models without you having asked is a different piece of software from one
 * that does what you told it to.
 *
 * This keeps the principle and drops the inconvenience. It is a foreground
 * command you start and stop, printing every file it takes in as it happens.
 * Nothing is installed, nothing survives the process, and closing the terminal
 * ends it. A daemon you can see is not the thing that was being avoided.
 *
 * Three things it takes seriously, all learned from what file watchers do
 * wrong:
 *
 *   - **A save is not one event.** Editors write, rename and touch, so a single
 *     Ctrl-S can fire three times. Everything is debounced per path.
 *   - **A file being written is not a file.** Reading the instant an event
 *     arrives catches half-written bytes. A path is only captured once its size
 *     has stopped changing.
 *   - **Work does not overlap.** Extraction with a local model takes twenty
 *     seconds; ten saves in that window must not start ten runs. Captures are
 *     queued and run one at a time.
 */

import { watch, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { planFolder } from './folder.js';

/** How long a path must be quiet before it is considered saved. */
export const SETTLE_MS = 700;

/**
 * @typedef {object} Watcher
 * @property {() => void} stop
 * @property {Promise<void>} done   resolves once stopped and the queue is drained
 * @property {() => {queued: number, captured: number, running: boolean}} state
 */

/**
 * Watch a folder and capture what changes in it.
 *
 * @param {object} opts
 * @param {string} opts.root
 * @param {(paths: string[]) => Promise<any>} opts.capture   called with settled paths
 * @param {(event: any) => void} [opts.onEvent]
 * @param {number} [opts.settleMs]
 * @param {boolean} [opts.recursive]
 * @param {string[]} [opts.include]
 * @param {boolean} [opts.only]
 * @returns {Watcher}
 */
export function watchFolder(opts) {
  const settleMs = opts.settleMs ?? SETTLE_MS;

  // Watch the path the filesystem actually calls this folder.
  //
  // On Windows a short 8.3 path (VINODS~1) or a junction gives libuv a watch
  // root that does not match the names its own events carry, and it aborts the
  // process on an internal assertion rather than returning an error. Resolving
  // first also keeps the paths here comparable with what planFolder produces.
  const root = resolveReal(opts.root);

  /** Paths seen recently, with the timer that will decide they are settled. */
  const pending = new Map();
  /** Paths waiting their turn to be captured. */
  const queue = new Set();
  /** What each path looked like when it was last handed over. */
  const lastCaptured = new Map();

  /**
   * Paths past their settle timer but not yet queued.
   *
   * Deciding whether a path is admissible is asynchronous, and without counting
   * it there is a window where a file is genuinely in flight while the watcher
   * looks completely idle — long enough for `stop()` to resolve early and for
   * the capture to be abandoned.
   */
  let admitting = 0;

  let running = false;
  let stopped = false;
  let captured = 0;
  /** @type {import('node:fs').FSWatcher|null} */
  let watcher = null;
  /** @type {() => void} */
  let finished = () => {};
  const done = new Promise((resolve) => {
    finished = resolve;
  });

  /**
   * Is this a path the same rules would have captured in a folder walk?
   *
   * Reusing `planFolder` rather than re-deriving the rules means the watcher
   * and the walk can never disagree about what counts as a note — which they
   * would, the first time one of the two lists changed.
   *
   * @param {string} path
   */
  async function admissible(path) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) return false;

    const plan = await planFolder(root, {
      recursive: opts.recursive,
      include: opts.include,
      only: opts.only,
    }).catch(() => null);
    return Boolean(plan?.files.some((f) => f.path === path));
  }

  /** @param {string} path */
  function note(path) {
    if (stopped) return;

    // Editors save by writing, renaming and touching, so one Ctrl-S can arrive
    // three times. The timer restarts on each, so only the last one counts.
    clearTimeout(pending.get(path)?.timer);

    const entry = { size: pending.get(path)?.size ?? -1, timer: null };

    // Record the size now, not at settle time. Starting from "unknown" makes
    // the first comparison always differ, so every new file costs two settle
    // windows before anything happens — and a file written in one go is the
    // common case, not the exception.
    if (entry.size < 0) {
      stat(path)
        .then((info) => {
          if (entry.size < 0) entry.size = info.size;
        })
        .catch(() => {});
    }

    entry.timer = setTimeout(async () => {
      admitting++;
      try {
        const info = await stat(path).catch(() => null);
        if (!info) {
          pending.delete(path);
          return;
        }
        // Still growing: a large file is mid-write, and reading it now captures
        // half a document as though it were the whole one.
        if (info.size !== entry.size) {
          pending.set(path, { size: info.size, timer: null });
          note(path);
          return;
        }
        pending.delete(path);

        // Unchanged since the last time it was handed over. A save produces
        // several events and some of them arrive after the capture, so without
        // this one Ctrl-S becomes three captures of identical bytes.
        const fingerprint = `${info.size}:${info.mtimeMs}`;
        if (lastCaptured.get(path) === fingerprint) return;

        if (!(await admissible(path))) return;
        lastCaptured.set(path, fingerprint);
        queue.add(path);
        drain();
      } finally {
        admitting--;
        if (stopped) maybeFinish();
      }
    }, settleMs);

    pending.set(path, entry);
  }

  /**
   * Capture what has settled, one batch at a time.
   *
   * Never concurrently. A local model takes twenty seconds a file, and ten
   * saves inside that window starting ten runs would make the machine unusable
   * and the ordering meaningless.
   */
  async function drain() {
    if (running || !queue.size) {
      if (stopped) maybeFinish();
      return;
    }
    running = true;

    const batch = [...queue];
    queue.clear();

    try {
      const result = await opts.capture(batch);
      captured += result?.captured?.length ?? 0;
      opts.onEvent?.({ type: 'captured', paths: batch, result });
    } catch (err) {
      // A failed capture must not end the watch. The next save gets another go.
      opts.onEvent?.({ type: 'failed', paths: batch, error: err?.message ?? String(err) });
    } finally {
      running = false;
    }

    if (queue.size) return drain();
    if (stopped) maybeFinish();
  }

  /** Nothing settling, nothing queued, nothing running: the watch is over. */
  function maybeFinish() {
    if (!running && !queue.size && admitting === 0) finished();
  }

  watcher = watch(root, { recursive: opts.recursive !== false }, (_event, filename) => {
    if (!filename) return;
    note(join(root, filename.toString()));
  });

  watcher.on('error', (err) => {
    opts.onEvent?.({ type: 'error', error: err?.message ?? String(err) });
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      // Timers that have not fired are abandoned; work already past them is
      // not. Stopping should not lose a file that was halfway in.
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      maybeFinish();
    },
    done,
    state: () => ({ queued: queue.size, captured, running, settling: admitting }),
  };
}

/**
 * The name the filesystem itself uses for this path.
 *
 * Exported because anything computing a path *relative* to the watch root has
 * to start from the same spelling. Resolving in one place and not the other
 * produces display paths full of `../..`, which is how this was found.
 *
 * @param {string} path
 */
export function resolveReal(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * @param {string} root
 * @param {string} full
 */
export function displayPath(root, full) {
  const rel = relative(root, full);
  return (rel === '' ? '.' : rel).split(sep).join('/');
}
