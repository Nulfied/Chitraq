/**
 * Background running, and the one way it can hurt somebody.
 *
 * `chitraq watch` died with the terminal and sync had no schedule, so a
 * memory meant to stay current only did while somebody was watching it.
 * A detached child and a file naming it fixes that on all three platforms
 * without installing a service.
 *
 * The danger is not the daemon. It is `--stop`. Process ids are reused, so a
 * recorded pid that is alive is not evidence it is ours — an hour later that
 * number can belong to somebody's editor, and signalling it would close
 * their work. `process.kill(pid, 0)` cannot tell the difference.
 *
 * So the record carries a heartbeat, and anything alive but silent is
 * treated as a stranger and left alone. These tests are mostly about that
 * distinction, because it is the only part where being wrong damages
 * something outside Chitraq.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordPath,
  readRecord,
  writeRecord,
  clearRecord,
  isAlive,
  state,
  stop,
  claim,
  stillOurs,
  duration,
  HEARTBEAT_MS,
  STALE_AFTER_MS,
} from '../src/core/daemon.js';

/** @param {(dir: string) => void} body */
function inTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'chitraq-daemon-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A kill() that reports whichever pids are "alive", and records signals. */
function fakeKill(alivePids) {
  /** @type {Array<{pid: number, signal: any}>} */
  const sent = [];
  /** @type {any} */
  const kill = (/** @type {number} */ pid, /** @type {any} */ signal) => {
    if (signal !== 0) {
      sent.push({ pid, signal });
      return;
    }
    if (!alivePids.includes(pid)) {
      const err = /** @type {any} */ (new Error('no such process'));
      err.code = 'ESRCH';
      throw err;
    }
  };
  kill.sent = sent;
  return kill;
}

const fresh = () => new Date().toISOString();
/** @param {number} ms */
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

test('the record lives beside its own store, not in a shared place', () => {
  // Two memories can be watched at once. A single global file would let one
  // stop the other.
  const a = recordPath(join('/srv', 'one', 'memory.chitraq'));
  const b = recordPath(join('/srv', 'two', 'memory.chitraq'));
  assert.notEqual(a, b);
  assert.match(a, /one/);
  assert.match(b, /two/);
});

test('a corrupt record reads as absent, not as an error', () => {
  // A record half-written by an interrupted run must not make somebody
  // unable to watch their own folder.
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    writeFileSync(path, '{ this is not json');
    assert.equal(readRecord(path), null);
  });
});

test('a live process that is checking in is ours', () => {
  const record = {
    pid: 4242,
    kind: 'watch',
    target: '/notes',
    startedAt: fresh(),
    lastSeen: fresh(),
  };
  assert.equal(state(record, { kill: fakeKill([4242]) }).status, 'running');
});

test('a dead process is stale', () => {
  const record = {
    pid: 4242,
    kind: 'watch',
    target: '/notes',
    startedAt: agoIso(60_000),
    lastSeen: agoIso(60_000),
  };
  assert.equal(state(record, { kill: fakeKill([]) }).status, 'stale');
});

test('a live process that stopped checking in is a stranger', () => {
  // The case the whole design exists for: the id was recycled.
  const record = {
    pid: 4242,
    kind: 'watch',
    target: '/notes',
    startedAt: agoIso(STALE_AFTER_MS * 4),
    lastSeen: agoIso(STALE_AFTER_MS * 4),
  };
  assert.equal(state(record, { kill: fakeKill([4242]) }).status, 'foreign');
});

test('one missed heartbeat is not death', () => {
  // A suspended laptop, a loaded disk or a long extraction all delay a
  // write. Declaring it dead after one interval would start a second daemon
  // beside the first.
  const record = {
    pid: 4242,
    kind: 'watch',
    target: '/notes',
    startedAt: agoIso(HEARTBEAT_MS * 5),
    lastSeen: agoIso(HEARTBEAT_MS + 5_000),
  };
  assert.equal(state(record, { kill: fakeKill([4242]) }).status, 'running');
});

test('stop signals a running daemon and clears the record', () => {
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    writeRecord(path, {
      pid: 4242,
      kind: 'watch',
      target: '/notes',
      startedAt: fresh(),
      lastSeen: fresh(),
    });

    const kill = fakeKill([4242]);
    const result = stop(path, { kill });

    assert.equal(result.stopped, true);
    assert.deepEqual(kill.sent, [{ pid: 4242, signal: 'SIGTERM' }]);
    assert.ok(!existsSync(path), 'the record is gone');
  });
});

test('stop will not signal a process that stopped checking in', () => {
  // If this ever sends a signal, it closes somebody's unrelated program.
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    writeRecord(path, {
      pid: 4242,
      kind: 'watch',
      target: '/notes',
      startedAt: agoIso(STALE_AFTER_MS * 10),
      lastSeen: agoIso(STALE_AFTER_MS * 10),
    });

    const kill = fakeKill([4242]);
    const result = stop(path, { kill });

    assert.equal(result.stopped, false);
    assert.deepEqual(kill.sent, [], 'nothing was signalled');
    assert.match(result.reason, /reused/i, 'and it says why');
    assert.ok(existsSync(path), 'the record is left for a person to judge');
  });
});

test('stop over a dead process cleans up and says so', () => {
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    writeRecord(path, {
      pid: 4242,
      kind: 'watch',
      target: '/notes',
      startedAt: agoIso(60_000),
      lastSeen: agoIso(60_000),
    });

    const kill = fakeKill([]);
    const result = stop(path, { kill });

    assert.equal(result.stopped, false);
    assert.deepEqual(kill.sent, []);
    assert.match(result.reason, /already stopped/i);
    assert.ok(!existsSync(path));
  });
});

test('a second watcher on the same memory is refused', () => {
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    const kill = fakeKill([4242]);

    const first = claim(path, { kind: 'watch', target: '/notes' }, { pid: 4242, kill });
    assert.equal(first.ok, true);

    const second = claim(path, { kind: 'watch', target: '/notes' }, { pid: 5555, kill });
    assert.equal(second.ok, false);
    assert.match(/** @type {any} */ (second).reason, /already watching/i);
    assert.equal(readRecord(path)?.pid, 4242, 'the first one keeps the claim');
  });
});

test('a stale record does not block a new watcher', () => {
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    writeRecord(path, {
      pid: 4242,
      kind: 'watch',
      target: '/notes',
      startedAt: agoIso(60_000),
      lastSeen: agoIso(60_000),
    });

    const result = claim(path, { kind: 'watch', target: '/notes' }, { pid: 7777, kill: fakeKill([]) });
    assert.equal(result.ok, true);
    assert.equal(readRecord(path)?.pid, 7777);
  });
});

test('clearing the record is how a daemon is told to stand down', () => {
  // Signals are unreliable on Windows, so a running daemon also checks
  // whether the record is still its own.
  inTempDir((dir) => {
    const path = join(dir, 'rec.json');
    claim(path, { kind: 'watch', target: '/notes' }, { pid: 4242, kill: fakeKill([]) });

    assert.equal(stillOurs(path, 4242), true);
    clearRecord(path);
    assert.equal(stillOurs(path, 4242), false);
  });
});

test('durations read the way people write them', () => {
  assert.equal(duration('30s'), 30_000);
  assert.equal(duration('10m'), 600_000);
  assert.equal(duration('2h'), 7_200_000);
  assert.equal(duration('1d'), 86_400_000);

  // A bare number is minutes. Seconds would be a surprising default for
  // something that runs unattended.
  assert.equal(duration('15'), 900_000);

  for (const bad of ['', 'soon', '0', '-5', '10x', undefined, 'NaN']) {
    assert.equal(duration(bad), null, `${bad} is not a duration`);
  }
});

test('isAlive treats a permission error as alive', () => {
  // A process owned by somebody else exists. It is not ours, which `state`
  // decides separately — but it is certainly not dead.
  /** @type {any} */
  const denying = () => {
    const err = /** @type {any} */ (new Error('operation not permitted'));
    err.code = 'EPERM';
    throw err;
  };
  assert.equal(isAlive(4242, denying), true);
  assert.equal(isAlive(0), false, 'and nonsense ids are not');
  assert.equal(isAlive(-1), false);
});
