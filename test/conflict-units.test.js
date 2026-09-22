/**
 * Figures written against their unit, which is how figures are written.
 *
 * Contradiction detection is deliberately tuned for precision: a false
 * "these disagree" costs a reader's attention and makes the whole system
 * less trustworthy, so it would rather miss one than invent one. The
 * weakness worth fixing is therefore a *miss*, and there was a specific,
 * measurable one.
 *
 * `p99 latency at 38ms` against `88ms` reported no disagreement, while
 * `the trial lasts 14 days` against `30 days` reported one. The cause was
 * not the similarity test — those two sentences overlap at 0.5, well above
 * the threshold. It was that no number was extracted at all: the pattern
 * required a word boundary after the digits, and `38ms` has none, so the
 * match failed and the figure disappeared before anything could compare it.
 *
 * Both lists below matter equally. Catching more is only an improvement if
 * nothing starts firing that should not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectConflict } from '../src/intelligence/providers/deterministic.js';

/** @param {string} a @param {string} b */
const fires = (a, b) => detectConflict({ title: a }, { title: b }).contradicts;

test('a figure written against its unit is still a figure', () => {
  // The four that were missed, all of them units written with no space.
  const missed = [
    ['p99 latency at 38ms', 'p99 latency is 88ms'],
    ['Cold start takes 250ms.', 'Cold start takes 900ms.'],
    ['The index is 40MB on disk.', 'The index is 900MB on disk.'],
    ['The window is 30px wide.', 'The window is 90px wide.'],
  ];
  for (const [a, b] of missed) {
    assert.ok(fires(a, b), `missed: ${a} || ${b}`);
  }
});

test('the cases that already worked still work', () => {
  const known = [
    ['the trial lasts 14 days', 'the trial lasts 30 days'],
    ['Retention is 30 days.', 'Retention is 90 days.'],
    ['We charge $40 a month.', 'We charge $90 a month.'],
    ['Throughput held at 5 tok/s.', 'Throughput held at 40 tok/s.'],
  ];
  for (const [a, b] of known) {
    assert.ok(fires(a, b), `regressed: ${a} || ${b}`);
  }
});

test('milliseconds are not millions', () => {
  // `normaliseUnit` strips a trailing `s` to fold plurals, which would turn
  // `ms` into `m` — the token million already uses. A latency in
  // milliseconds would then compare equal to a figure in millions, and the
  // symptom would be a contradiction reported between two unrelated numbers.
  assert.ok(!fires('Latency is 5ms.', 'Latency is 5 million.'));
  assert.ok(!fires('It takes 40 minutes.', 'It takes 40 million.'));

  // And the scale units still fold together, which is the reason the
  // stripping exists at all.
  assert.ok(!fires('We raised 5 million.', 'We raised 5m.'));
  assert.ok(fires('We raised 5 million.', 'We raised 9 million.'));
});

test('nothing new fires that should not', () => {
  const quiet = [
    // Different subjects.
    ['p99 latency at 38ms', 'The office is 40 miles away.'],
    // Same subject, same figure, different wording.
    ['p99 latency at 38ms', 'The p99 latency is 38ms.'],
    // Different metrics with similar names — the classic false positive.
    ['p50 latency at 38ms', 'p99 latency at 88ms'],
    // Different periods rather than a disagreement.
    ['Revenue was 40k in 2024.', 'Revenue was 90k in 2025.'],
    // Identical statements.
    ['It takes 30 to 90 days.', 'It takes 30 to 90 days.'],
    ['The index is 40MB on disk.', 'The index is 40MB on disk.'],
  ];
  for (const [a, b] of quiet) {
    assert.ok(!fires(a, b), `false positive: ${a} || ${b}`);
  }
});

test('a reported conflict says which figures disagreed', () => {
  // A conflict a reader cannot check is a conflict they have to re-derive.
  const result = detectConflict(
    { title: 'p99 latency at 38ms' },
    { title: 'p99 latency is 88ms' }
  );
  assert.equal(result.contradicts, true);
  assert.match(result.reason, /38ms/);
  assert.match(result.reason, /88ms/);
  assert.ok(result.confidence > 0 && result.confidence < 1, 'and states how sure it is');
});
