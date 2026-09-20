/**
 * Every "N tests" written in the documentation has to be the real N.
 *
 * The count was stated in five places and had drifted in four of them: the
 * README, the landing page twice, and CONTRIBUTING all said 326 while
 * STATUS.md said 352. A visitor reading the front page and then the status
 * document got two different numbers, which is a worse signal than no number
 * at all — it makes a synchronized repository look unsynchronized.
 *
 * The usual fix is to delete the numbers. That trades a wrong fact for no
 * fact, and the number is worth stating: it is the main evidence behind the
 * claim that this is tested rather than asserted to be. So the number stays
 * and this makes it impossible to be wrong for more than one CI run.
 *
 *     node tools/check-test-count.mjs            counts by running the suite
 *     node tools/check-test-count.mjs 370        checks against a known count
 *     node tools/check-test-count.mjs 370 --fix  rewrites the documents
 *
 * CI passes the count it already measured, so the suite is not run twice.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Where the count is allowed to appear. Anywhere else is not checked. */
const DOCUMENTS = ['README.md', 'CONTRIBUTING.md', 'docs/STATUS.md', 'docs/index.html'];

/**
 * "326 tests", "352 tests passing", "v0.1 · 326 tests · zero dependencies".
 *
 * Deliberately narrow. A document that says "the tests" or "1728 columns"
 * must not be rewritten, so this wants a number immediately followed by the
 * word, and a word boundary before it so it cannot start mid-number.
 *
 * **This owns every "<digits> tests" in the documents it checks.** It cannot
 * tell the suite total from any other count, and it proved that by rewriting
 * "14 tests cover the protocol" into "395 tests cover the protocol" — a
 * sentence that was true, in a file about being accurate. Write other counts
 * as words: "fourteen tests". Narrowing the pattern instead would mean
 * guessing which numbers are the total, and guessing wrong in that direction
 * lets a stale figure through, which is the thing this exists to stop.
 */
const COUNT = /\b(\d{2,5}) tests\b/g;

const args = process.argv.slice(2);
const fix = args.includes('--fix');

// An argument that is present but not a number is a caller that tried to
// pass a count and failed — a shell pipeline that extracted nothing, most
// likely. Falling back to measuring would turn that into a pass, which is
// exactly the wrong answer: it already happened once, with an empty string
// from a grep whose pattern did not match.
const positional = args.filter((a) => a !== '--fix');
if (positional.some((a) => !/^\d+$/.test(a))) {
  console.error(`  Expected a test count, got ${JSON.stringify(positional[0])}.`);
  console.error('  Pass a number, or pass nothing to run the suite and measure it.');
  process.exit(2);
}

const actual = positional.length ? Number(positional[0]) : measure();

let wrong = 0;
let fixed = 0;

for (const file of DOCUMENTS) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    console.error(`  ${file}: not found`);
    wrong++;
    continue;
  }

  const found = [...text.matchAll(COUNT)];
  if (!found.length) continue;

  for (const match of found) {
    const stated = Number(match[1]);
    if (stated === actual) continue;
    const line = text.slice(0, match.index).split('\n').length;
    console.error(`  ${file}:${line}  says ${stated} tests, the suite has ${actual}`);
    wrong++;
  }

  if (fix && found.some((m) => Number(m[1]) !== actual)) {
    writeFileSync(file, text.replace(COUNT, `${actual} tests`));
    fixed++;
  }
}

if (fix && fixed) {
  console.log(`  rewrote ${fixed} document(s) to ${actual} tests`);
  process.exit(0);
}

if (wrong) {
  console.error('');
  console.error(`  ${wrong} stale count(s). Fix them, or run:`);
  console.error(`    node tools/check-test-count.mjs ${actual} --fix`);
  process.exit(1);
}

console.log(`  every documented count says ${actual} tests, and so does the suite`);

/** Run the suite and read the count out of the reporter's summary. */
function measure() {
  let output;
  try {
    output = execSync('npm test', { encoding: 'utf8' });
  } catch (err) {
    // A failing suite still prints the summary, and the count is what is
    // wanted here — whether the tests pass is a different job's to report.
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const found = /^\s*(?:ℹ\s*)?tests (\d+)\s*$/m.exec(output);
  if (!found) {
    console.error('  Could not find a test count in the output of `npm test`.');
    process.exit(2);
  }
  return Number(found[1]);
}
