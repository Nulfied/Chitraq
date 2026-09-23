/**
 * Running in the background, without installing anything.
 *
 * `chitraq watch` was a foreground command that died with the terminal, and
 * sync had no schedule at all. So a memory that was supposed to keep itself
 * current only did so while somebody was looking at it — which is the one
 * thing a memory engine should not need.
 *
 * The obvious fix is a service: a systemd unit, a launchd plist, a Task
 * Scheduler entry. That is three implementations of the same idea, each
 * needing privileges, each leaving something behind on the machine that
 * `chitraq` did not put there and cannot reliably take away. This does the
 * smaller thing instead — a detached child process and a file saying which
 * one it is — which works identically on all three platforms and disappears
 * completely when you stop it.
 *
 * **The hazard this file is mostly about.** A process id is reused. Kill a
 * recorded pid without checking and you eventually kill somebody's editor,
 * because the number belonged to Chitraq an hour ago and belongs to
 * something else now. `process.kill(pid, 0)` tells you *a* process is alive,
 * never that it is yours.
 *
 * So the record carries a heartbeat the daemon refreshes while it runs. A
 * pid that is alive but has not checked in is treated as somebody else's and
 * is not signalled. The cost is that a daemon killed with SIGKILL leaves a
 * record that takes one heartbeat interval to be recognised as stale; the
 * alternative cost is killing an unrelated process, which is not a trade.
 */

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How often a running daemon refreshes its record. */
export const HEARTBEAT_MS = 30_000;

/**
 * How long after the last heartbeat a record stops being believed.
 *
 * Three intervals rather than one: a machine that suspends, a loaded disk or
 * a long extraction can all delay a write, and declaring the daemon dead
 * while it is mid-document would have a second one start beside it.
 */
export const STALE_AFTER_MS = HEARTBEAT_MS * 3;

/**
 * Where the record for a given memory lives.
 *
 * Beside the store rather than in a shared directory, because two memories
 * can be watched at once and a single global file would let one stop the
 * other.
 *
 * @param {string} storePath
 * @param {string} [kind]  'watch' or 'sync'
 */
export function recordPath(storePath, kind = 'watch') {
  return join(dirname(storePath), `.chitraq-${kind}.json`);
}

/**
 * @typedef {object} DaemonRecord
 * @property {number} pid
 * @property {string} kind
 * @property {string} target      the folder watched, or the peer synced with
 * @property {string} startedAt
 * @property {string} lastSeen
 */

/**
 * Read the record, or null when there is none or it is unreadable.
 *
 * A corrupt record is treated as absent rather than as an error: it means a
 * previous run was interrupted mid-write, and refusing to start because of
 * it would leave somebody unable to watch their own folder.
 *
 * @param {string} path
 * @returns {DaemonRecord|null}
 */
export function readRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {DaemonRecord} record
 */
export function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** @param {string} path */
export function clearRecord(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone is the desired state */
  }
}

/**
 * Is some process with this id alive?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. It answers "a process exists", not "our process exists" — which
 * is exactly why `state()` below asks a second question.
 *
 * @param {number} pid
 * @param {(pid: number, signal: number) => void} [kill]  injected for tests
 */
export function isAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else. That is still
    // "alive", and still not ours — `state()` makes that distinction.
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * What the record means right now.
 *
 * @param {DaemonRecord|null} record
 * @param {{now?: number, kill?: (pid: number, signal: number) => void}} [opts]
 * @returns {{status: 'none'|'running'|'stale'|'foreign', record: DaemonRecord|null, silentFor?: number}}
 */
export function state(record, opts = {}) {
  if (!record) return { status: 'none', record: null };

  const now = opts.now ?? Date.now();
  const silentFor = now - Date.parse(record.lastSeen ?? record.startedAt ?? '');

  if (!isAlive(record.pid, opts.kill)) return { status: 'stale', record };

  // Alive, but has not checked in. Either it is wedged, or — the case that
  // matters — the id was recycled and now belongs to something that has
  // nothing to do with Chitraq. Either way it must not be signalled.
  if (!Number.isFinite(silentFor) || silentFor > STALE_AFTER_MS) {
    return { status: 'foreign', record, silentFor };
  }

  return { status: 'running', record, silentFor };
}

/**
 * Stop a running daemon.
 *
 * Refuses anything not demonstrably ours, which is the whole point.
 *
 * @param {string} path
 * @param {{kill?: (pid: number, signal?: any) => void, now?: number}} [opts]
 * @returns {{stopped: boolean, reason: string, pid?: number}}
 */
export function stop(path, opts = {}) {
  const kill = opts.kill ?? process.kill;
  const current = state(readRecord(path), { now: opts.now, kill: /** @type {any} */ (kill) });

  if (current.status === 'none') return { stopped: false, reason: 'Nothing is running.' };

  if (current.status === 'stale') {
    clearRecord(path);
    return {
      stopped: false,
      reason: 'It had already stopped. The leftover record is cleared.',
      pid: current.record?.pid,
    };
  }

  if (current.status === 'foreign') {
    return {
      stopped: false,
      reason:
        `Process ${current.record?.pid} is alive but has not checked in for ` +
        `${Math.round((current.silentFor ?? 0) / 1000)}s, so it is probably no longer Chitraq — ` +
        `process ids get reused. Not signalling it. Delete ${path} if you are sure.`,
      pid: current.record?.pid,
    };
  }

  const pid = /** @type {DaemonRecord} */ (current.record).pid;
  try {
    kill(pid, 'SIGTERM');
  } catch (err) {
    return { stopped: false, reason: `Could not stop ${pid}: ${/** @type {any} */ (err)?.message}`, pid };
  }
  clearRecord(path);
  return { stopped: true, reason: `Stopped ${pid}.`, pid };
}

/**
 * Claim the record for this process, or explain why not.
 *
 * @param {string} path
 * @param {{kind: string, target: string}} what
 * @param {{pid?: number, now?: number, kill?: any}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function claim(path, what, opts = {}) {
  const current = state(readRecord(path), { now: opts.now, kill: opts.kill });

  if (current.status === 'running') {
    return {
      ok: false,
      reason:
        `Already watching, as process ${current.record?.pid} ` +
        `(${current.record?.target}). Stop it first, or run with --status to see it.`,
    };
  }
  if (current.status === 'foreign') {
    // Not ours and not safe to kill, but also not something to refuse over:
    // the record is meaningless, so it is replaced.
    clearRecord(path);
  }

  const at = new Date(opts.now ?? Date.now()).toISOString();
  writeRecord(path, {
    pid: opts.pid ?? process.pid,
    kind: what.kind,
    target: what.target,
    startedAt: at,
    lastSeen: at,
  });
  return { ok: true };
}

/**
 * Keep the record fresh while the daemon runs.
 *
 * Returns the stop function, so a caller can shut it down cleanly. The timer
 * is unref'd: a heartbeat should never be the reason a process stays alive.
 *
 * @param {string} path
 * @param {{everyMs?: number}} [opts]
 */
export function heartbeat(path, opts = {}) {
  const timer = setInterval(() => {
    const record = readRecord(path);
    // Somebody cleared it, which is how `--stop` asks a daemon to go away
    // even if the signal was missed.
    if (!record || record.pid !== process.pid) return;
    writeRecord(path, { ...record, lastSeen: new Date().toISOString() });
  }, opts.everyMs ?? HEARTBEAT_MS);

  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Has the record been taken away from us?
 *
 * A daemon checks this so `--stop` works even when the signal does not
 * arrive, which on Windows is the ordinary case rather than the exception.
 *
 * @param {string} path
 * @param {number} [pid]
 */
export function stillOurs(path, pid = process.pid) {
  const record = readRecord(path);
  return record?.pid === pid;
}

/** @param {string} path */
export function recordExists(path) {
  return existsSync(path);
}

/**
 * Parse `10m`, `2h`, `45s`, or a bare number of minutes.
 *
 * @param {string|number|undefined} value
 * @returns {number|null} milliseconds, or null when it is not a duration
 */
export function duration(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim().toLowerCase();

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // A bare number means minutes. Seconds would be a surprising default for
  // something that runs unattended, and milliseconds would be absurd.
  const unit = match[2] ?? 'm';
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return amount * /** @type {number} */ (scale);
}
