/**
 * Proactive memory.
 *
 * Section 39: when it is justified, Chitraq should say "you researched this
 * before", "this conflicts with a decision you made", "this may be out of
 * date". Section 39 is equally clear about the conditions — relevant,
 * explainable, dismissible, non-destructive, user-controlled — and those
 * conditions are what stop this becoming the feature everyone turns off.
 *
 * Three rules here:
 *
 *   1. **Every notice is derived from something already in memory.** Nothing
 *      here infers, generates, or asserts. A notice points at objects and
 *      explains the relationship; the user draws the conclusion.
 *   2. **Silence is the default.** A notice has to clear a threshold to appear.
 *      Weak signals produce nothing rather than a maybe.
 *   3. **It never modifies anything.** Proactive surfacing is a read.
 */

import { plainAll } from '../core/db.js';
import { lexicalSimilarity } from '../core/text.js';
import * as objects from '../core/objects.js';
import * as relations from '../core/relations.js';

/**
 * @typedef {object} Notice
 * @property {string} kind
 * @property {string} message      plain language, addressed to the user
 * @property {string[]} objectIds  what to look at
 * @property {number} strength     0..1, for ordering and thresholding
 * @property {string} because      why this was surfaced
 */

/**
 * Notices relevant to something just captured, or about to be.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.objectId
 * @param {Array<{objectId: string, score: number}>} [opts.similar] precomputed neighbours
 * @param {number} [opts.minStrength]
 * @returns {Notice[]}
 */
export function forObject(db, opts) {
  const subject = objects.get(db, opts.objectId);
  if (!subject) return [];

  const minStrength = opts.minStrength ?? 0.45;
  /** @type {Notice[]} */
  const notices = [];

  // --- you have been here before -----------------------------------------
  for (const neighbour of opts.similar ?? []) {
    const other = objects.get(db, neighbour.objectId);
    if (!other || other.id === subject.id) continue;

    const overlap = lexicalSimilarity(
      `${subject.title} ${subject.body}`,
      `${other.title} ${other.body}`
    );
    if (overlap < 0.45) continue;

    const ageDays = daysBetween(other.created_at, subject.created_at);
    notices.push({
      kind: 'seen-before',
      message:
        ageDays > 30
          ? `You wrote something close to this ${describeAge(ageDays)}: "${trim(other.title)}".`
          : `This overlaps with "${trim(other.title)}".`,
      objectIds: [other.id],
      strength: Math.min(0.95, overlap + (ageDays > 90 ? 0.1 : 0)),
      because: `${Math.round(overlap * 100)}% of the content words are shared`,
    });
  }

  // --- this disagrees with something you already decided -------------------
  const conflicts = plainAll(
    db
      .prepare(
        `SELECT c.*, a.title AS a_title, b.title AS b_title
         FROM conflict c
         LEFT JOIN object a ON a.id = c.a_id
         LEFT JOIN object b ON b.id = c.b_id
         WHERE c.workspace_id = ? AND c.status = 'open' AND (c.a_id = ? OR c.b_id = ?)`
      )
      .all(opts.workspaceId, opts.objectId, opts.objectId)
  );

  for (const conflict of conflicts) {
    const otherId = conflict.a_id === opts.objectId ? conflict.b_id : conflict.a_id;
    const otherTitle = conflict.a_id === opts.objectId ? conflict.b_title : conflict.a_title;
    if (!otherId) continue;
    notices.push({
      kind: 'contradiction',
      message: `This disagrees with "${trim(otherTitle)}", which is also in your memory.`,
      objectIds: [otherId],
      strength: Math.max(0.6, Number(conflict.confidence ?? 0.6)),
      because: safeJson(conflict.detail)?.reason ?? 'both describe the same thing differently',
    });
  }

  // --- you decided against this before ------------------------------------
  const rejected = plainAll(
    db
      .prepare(
        `SELECT id, title, updated_at FROM object
         WHERE workspace_id = ? AND review = 'rejected' AND id != ? LIMIT 50`
      )
      .all(opts.workspaceId, opts.objectId)
  );

  for (const old of rejected) {
    const overlap = lexicalSimilarity(`${subject.title} ${subject.body}`, String(old.title));
    if (overlap < 0.5) continue;
    notices.push({
      kind: 'previously-rejected',
      message: `You considered something like this before and rejected it: "${trim(old.title)}".`,
      objectIds: [old.id],
      strength: 0.75,
      because: 'closely matches knowledge you explicitly rejected',
    });
  }

  return notices
    .filter((n) => n.strength >= minStrength)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5);
}

/**
 * Notices about the workspace as a whole — the things worth a nudge when
 * nothing in particular is being captured.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {number} [opts.staleDays]
 * @param {number} [opts.limit]
 * @returns {Notice[]}
 */
export function forWorkspace(db, opts) {
  const staleDays = opts.staleDays ?? 365;
  /** @type {Notice[]} */
  const notices = [];

  const openConflicts = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM conflict WHERE workspace_id = ? AND status = 'open'`)
      .get(opts.workspaceId)?.n ?? 0
  );
  if (openConflicts > 0) {
    notices.push({
      kind: 'open-conflicts',
      message: `${openConflicts} disagreement${openConflicts === 1 ? '' : 's'} in your memory ${openConflicts === 1 ? 'is' : 'are'} unresolved.`,
      objectIds: [],
      strength: Math.min(0.9, 0.5 + openConflicts * 0.1),
      because: 'contradictions left open quietly undermine every answer that touches them',
    });
  }

  const pending = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM proposal WHERE workspace_id = ? AND status = 'pending'`)
      .get(opts.workspaceId)?.n ?? 0
  );
  if (pending >= 10) {
    notices.push({
      kind: 'review-backlog',
      message: `${pending} suggestions are waiting for you.`,
      objectIds: [],
      strength: Math.min(0.8, 0.3 + pending / 100),
      because: 'proposals do not become memory until you decide',
    });
  }

  // Claims that carry a figure, have never been confirmed, and have not been
  // touched in a long time. These are the ones most likely to be quietly wrong.
  const stale = plainAll(
    db
      .prepare(
        `SELECT id, title, updated_at FROM object
         WHERE workspace_id = ? AND state = 'active' AND review = 'unreviewed'
           AND updated_at < ?
           AND (body GLOB '*[0-9]*' OR title GLOB '*[0-9]*')
         ORDER BY updated_at ASC LIMIT ?`
      )
      .all(
        opts.workspaceId,
        new Date(Date.now() - staleDays * 86400000).toISOString(),
        opts.limit ?? 5
      )
  );

  for (const old of stale) {
    notices.push({
      kind: 'possibly-outdated',
      message: `"${trim(old.title)}" has a figure in it and has not been checked since ${String(old.updated_at).slice(0, 10)}.`,
      objectIds: [String(old.id)],
      strength: 0.5,
      because: 'numbers go out of date more quietly than anything else in a memory',
    });
  }

  // Knowledge with nothing linked to it: findable by search, invisible to the
  // graph, and easy to forget exists.
  const orphans = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM object o
         WHERE o.workspace_id = ? AND o.state = 'active' AND o.kind != 'entity'
           AND NOT EXISTS (
             SELECT 1 FROM relation r
             WHERE (r.src_id = o.id OR r.dst_id = o.id) AND r.state = 'active' AND r.type != 'mentions'
           )`
      )
      .get(opts.workspaceId)?.n ?? 0
  );
  const total = Number(
    db
      .prepare(`SELECT COUNT(*) AS n FROM object WHERE workspace_id = ? AND state = 'active' AND kind != 'entity'`)
      .get(opts.workspaceId)?.n ?? 0
  );
  if (total >= 20 && orphans / total > 0.7) {
    notices.push({
      kind: 'unconnected',
      message: `${orphans} of ${total} notes are not linked to anything.`,
      objectIds: [],
      strength: 0.45,
      because: 'unconnected memory is a pile of notes rather than a graph you can ask questions of',
    });
  }

  return notices.sort((a, b) => b.strength - a.strength);
}

/**
 * Notices relevant to a question that was just asked — shown alongside the
 * answer, not instead of it.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, question: string, contextIds: string[]}} opts
 * @returns {Notice[]}
 */
export function forQuestion(db, opts) {
  /** @type {Notice[]} */
  const notices = [];
  if (!opts.contextIds.length) return notices;

  // Material that answered the question but has since been replaced.
  const superseded = plainAll(
    db
      .prepare(
        `SELECT o.id, o.title, n.title AS newer_title, n.id AS newer_id
         FROM object o JOIN object n ON n.id = o.superseded_by
         WHERE o.id IN (${opts.contextIds.map(() => '?').join(',')})`
      )
      .all(...opts.contextIds)
  );

  for (const row of superseded) {
    notices.push({
      kind: 'superseded-source',
      message: `"${trim(row.title)}" has been replaced by "${trim(row.newer_title)}".`,
      objectIds: [String(row.newer_id)],
      strength: 0.7,
      because: 'the answer drew on material you have since updated',
    });
  }

  // Everything in the answer is old. Worth saying — not worth blocking on.
  const ages = plainAll(
    db
      .prepare(
        `SELECT MAX(COALESCE(occurred_at, created_at)) AS newest
         FROM object WHERE id IN (${opts.contextIds.map(() => '?').join(',')})`
      )
      .all(...opts.contextIds)
  );
  const newest = ages[0]?.newest;
  if (newest) {
    const age = daysBetween(String(newest), new Date().toISOString());
    if (age > 365) {
      notices.push({
        kind: 'all-old',
        message: `Everything behind this answer is at least ${describeAge(age)} old.`,
        objectIds: [],
        strength: 0.55,
        because: 'nothing more recent in memory bears on this question',
      });
    }
  }

  return notices.sort((a, b) => b.strength - a.strength).slice(0, 3);
}

/** @param {string} a @param {string} b */
function daysBetween(a, b) {
  const diff = Math.abs(Date.parse(b) - Date.parse(a));
  return Number.isFinite(diff) ? diff / 86400000 : 0;
}

/** @param {number} days */
function describeAge(days) {
  if (days < 45) return `${Math.round(days)} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  const years = days / 365;
  return years < 1.75 ? 'about a year' : `${Math.round(years)} years`;
}

/** @param {string} s */
function trim(s) {
  const t = String(s ?? '');
  return t.length <= 70 ? t : `${t.slice(0, 67)}…`;
}

/** @param {any} s */
function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}
