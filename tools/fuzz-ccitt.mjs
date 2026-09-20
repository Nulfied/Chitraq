/**
 * Check the CCITT decoder against a corpus libtiff encoded.
 *
 * The committed fixtures in `test/fixtures/ccitt/` are twelve cases chosen by
 * hand, and hand-chosen cases test what their author thought of. This runs
 * the same comparison over as many random pages as asked for, which is what
 * actually found the bugs worth finding.
 *
 * Generate a corpus first:
 *
 *   python tools/make-ccitt-fixtures.py --fuzz 500 1
 *   node tools/fuzz-ccitt.mjs .ccitt-fuzz
 *
 * The corpus is throwaway and gitignored. Nothing in the test suite depends
 * on this, and it needs Pillow, which is why it is a tool and not a test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeCcitt } from '../src/capture/ccitt.js';

const dir = process.argv[2] ?? '.ccitt-fuzz';

/** @type {Array<{name: string, width: number, height: number, k: number, style: string}>} */
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
} catch {
  console.error(`No corpus in ${dir}.`);
  console.error('Generate one:  python tools/make-ccitt-fixtures.py --fuzz 500 1');
  process.exit(2);
}

let exact = 0;
/** @type {string[]} */
const failures = [];
/** @type {Map<string, number>} */
const byStyle = new Map();

for (const item of manifest) {
  const where = `${item.name} ${item.width}x${item.height} ${item.style}`;
  try {
    const decoded = decodeCcitt(readFileSync(join(dir, `${item.name}.bin`)), {
      columns: item.width,
      rows: item.height,
      k: item.k,
    });
    if (decoded.equals(readFileSync(join(dir, `${item.name}.expected`)))) {
      exact++;
      byStyle.set(item.style, (byStyle.get(item.style) ?? 0) + 1);
    } else {
      failures.push(`${where}: decoded, but not to the same pixels`);
    }
  } catch (err) {
    failures.push(`${where}: threw ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`exact ${exact} of ${manifest.length}`);
for (const [style, n] of [...byStyle].sort()) console.log(`  ${style.padEnd(8)} ${n}`);

if (failures.length) {
  console.log(`\n${failures.length} failing:`);
  for (const line of failures.slice(0, 20)) console.log(`  ${line}`);
  if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
  process.exit(1);
}
