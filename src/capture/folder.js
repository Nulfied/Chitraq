/**
 * Walking a folder to decide what is worth remembering.
 *
 * This is the on-ramp. A memory engine with nothing in it is a demo, and asking
 * someone to type `chitraq ingest` four hundred times is asking them not to
 * bother. Pointing Chitraq at the notes they already have is the difference.
 *
 * The walk is deliberately conservative and deliberately loud about it. It
 * captures documents, skips machinery, and returns a reason for every single
 * thing it passed over, so "why is my note not in here?" always has an answer
 * that does not require reading this file.
 *
 * Nothing here touches the database. It produces a plan; deciding to act on the
 * plan belongs to the caller, which is what makes `--dry-run` truthful rather
 * than a separate code path that might diverge.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { guessMediaType } from './parse.js';

/**
 * Extensions captured by default: things a person writes, or is given to read.
 *
 * Not `.json`, `.csv`, `.log` or `.yaml`. Chitraq can parse all of them, but a
 * folder walk that swallows every `package.json` and every log file turns a
 * memory into a haystack. They are one `--include` away.
 */
export const DOCUMENT_EXTENSIONS = Object.freeze([
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'org', 'adoc', 'html', 'htm', 'pdf',
]);

/**
 * Directories never descended into, by name, at any depth.
 *
 * Every one of these is machinery: generated, vendored, or an application's
 * private state. `.obsidian` and `.trash` are here because a notes folder often
 * has them and neither contains notes.
 */
export const SKIP_DIRECTORIES = Object.freeze([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  'vendor', 'venv', '.venv', 'env', '__pycache__', '.cache', '.next', '.nuxt',
  'coverage', '.obsidian', '.trash', '.DS_Store', 'Thumbs.db',
]);

/** Above this, a file is almost certainly not a note. Reported, never silent. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * @typedef {object} PlannedFile
 * @property {string} path       absolute path on disk
 * @property {string} relative   path relative to the root, for display
 * @property {number} bytes
 * @property {string} mediaType
 * @property {string} modified   last-write time, for noticing a file has not changed
 */

/**
 * @typedef {object} SkippedEntry
 * @property {string} relative
 * @property {'ignored-directory'|'hidden'|'symbolic-link'|'unsupported-type'|'too-large'|'empty'|'unreadable'} reason
 * @property {string} [detail]
 */

/**
 * @typedef {object} FolderPlan
 * @property {string} root
 * @property {PlannedFile[]} files    in path order, so two runs agree
 * @property {SkippedEntry[]} skipped
 * @property {number} directories     how many were walked
 * @property {boolean} limited        true when `limit` cut the list short
 */

/**
 * Decide what in a folder is worth capturing, without capturing anything.
 *
 * @param {string} root
 * @param {object} [opts]
 * @param {boolean} [opts.recursive]   default true
 * @param {boolean} [opts.hidden]      include dotfiles, default false
 * @param {string[]} [opts.include]    extra extensions, or the whole list when `only` is set
 * @param {boolean} [opts.only]        treat `include` as the complete list
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.limit]        stop after this many files
 * @returns {Promise<FolderPlan>}
 */
export async function planFolder(root, opts = {}) {
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat) throw new Error(`There is nothing at ${root}.`);
  if (!rootStat.isDirectory()) throw new Error(`${root} is a file, not a folder. Use "ingest" for one file.`);

  const allowed = new Set(
    (opts.only ? (opts.include ?? []) : [...DOCUMENT_EXTENSIONS, ...(opts.include ?? [])]).map((e) =>
      String(e).replace(/^\./, '').toLowerCase()
    )
  );
  const skipDirs = new Set(SKIP_DIRECTORIES.map((d) => d.toLowerCase()));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const recursive = opts.recursive !== false;
  const limit = opts.limit ?? Infinity;

  /** @type {PlannedFile[]} */
  const files = [];
  /** @type {SkippedEntry[]} */
  const skipped = [];
  let directories = 0;
  let limited = false;

  /** @param {string} dir */
  async function walk(dir) {
    if (files.length >= limit) return;
    directories += 1;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ relative: display(root, dir), reason: 'unreadable', detail: message(err) });
      return;
    }

    // Sorted so that two runs over the same folder produce the same order, and
    // so `--limit 20` means the same twenty files every time.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (files.length >= limit) {
        limited = true;
        return;
      }
      const full = join(dir, entry.name);
      const shown = display(root, full);

      // Not followed, in either direction. A symlinked directory can point at
      // its own ancestor, and a walk that follows one never finishes.
      if (entry.isSymbolicLink()) {
        skipped.push({ relative: shown, reason: 'symbolic-link' });
        continue;
      }
      if (entry.name.startsWith('.') && !opts.hidden) {
        skipped.push({ relative: shown, reason: 'hidden' });
        continue;
      }

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) {
          skipped.push({ relative: shown, reason: 'ignored-directory' });
          continue;
        }
        if (recursive) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extensionOf(entry.name);
      if (!allowed.has(ext)) {
        skipped.push({ relative: shown, reason: 'unsupported-type', detail: ext || 'no extension' });
        continue;
      }

      let info;
      try {
        info = await stat(full);
      } catch (err) {
        skipped.push({ relative: shown, reason: 'unreadable', detail: message(err) });
        continue;
      }
      if (info.size === 0) {
        skipped.push({ relative: shown, reason: 'empty' });
        continue;
      }
      if (info.size > maxBytes) {
        skipped.push({ relative: shown, reason: 'too-large', detail: `${Math.round(info.size / 1024)} KB` });
        continue;
      }

      files.push({
        path: full,
        relative: shown,
        bytes: info.size,
        modified: info.mtime.toISOString(),
        mediaType: guessMediaType(entry.name) ?? 'text/plain',
      });
    }
  }

  await walk(root);
  if (files.length >= limit) limited = true;

  return { root, files, skipped, directories, limited };
}

/**
 * Group skip reasons into counts, because listing four thousand `.ts` files
 * helps nobody. The individual entries are still there for anything that wants
 * to look closer.
 *
 * @param {SkippedEntry[]} skipped
 * @returns {Record<string, number>}
 */
export function skipSummary(skipped) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const s of skipped) counts[s.reason] = (counts[s.reason] ?? 0) + 1;
  return counts;
}

/** @param {string} name */
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * @param {string} root
 * @param {string} full
 */
function display(root, full) {
  const rel = relative(root, full);
  return (rel === '' ? '.' : rel).split(sep).join('/');
}

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
