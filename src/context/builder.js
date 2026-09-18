/**
 * Context construction.
 *
 * Section 26: the objective is not maximum context. It is the smallest
 * sufficient context that lets an answer be well-grounded.
 *
 * The builder assembles, in priority order:
 *
 *   1. direct hits          — what retrieval found for the question
 *   2. relational neighbours — what those hits are connected to, with the
 *                              relationship named, so the link is explainable
 *   3. temporal context     — superseded predecessors, when the question is
 *                              time-shaped or the material has changed
 *   4. conflicts            — known disagreements touching anything included,
 *                              because an answer that ignores a contradiction
 *                              in its own evidence is worse than no answer
 *
 * Every item carries `reason` and `score`. Nothing appears in a context
 * without a statable justification.
 */

import { newContextId, newQueryId, now, stableStringify } from '../core/ids.js';
import { plainAll, plain } from '../core/db.js';
import { estimateTokens, excerpt } from '../core/text.js';
import { search } from '../retrieval/search.js';
import { neighbours } from '../core/relations.js';
import { parse } from '../retrieval/query.js';
import * as objects from '../core/objects.js';
import { emit, EventType } from '../core/events.js';

/**
 * @typedef {object} ContextItem
 * @property {string} id
 * @property {string} title
 * @property {string} kind
 * @property {string} text        the portion included in the budget
 * @property {string} reason      why this is here, in plain language
 * @property {number} score
 * @property {number} tokens
 * @property {string} epistemic
 * @property {string} origin
 * @property {string} review
 * @property {string|null} occurredAt
 */

/**
 * Build a context for a question.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.question
 * @param {number} [opts.budget]         token budget, default 3000
 * @param {number} [opts.seeds]          how many direct hits to start from
 * @param {number[]} [opts.queryVector]
 * @param {string} [opts.vectorModel]
 * @param {boolean} [opts.expand]        follow relationships, default true
 * @param {boolean} [opts.record]        persist the context build, default true
 * @returns {{id: string, items: ContextItem[], conflicts: any[], intent: any, usedTokens: number, budget: number, strategy: string, coverage: object}}
 */
export function build(db, opts) {
  const budget = opts.budget ?? 3000;
  const intent = parse(opts.question);
  const seeds = opts.seeds ?? 8;
  const expand = opts.expand !== false;

  const found = search(db, {
    workspaceId: opts.workspaceId,
    intent,
    queryVector: opts.queryVector,
    vectorModel: opts.vectorModel,
    limit: seeds,
    // A time-shaped question ("what did we originally decide") must be able to
    // reach superseded and archived material, or it cannot be answered at all.
    includeArchived: intent.temporal,
  });

  /** @type {Map<string, ContextItem & {priority: number}>} */
  const selected = new Map();

  for (const hit of found.results) {
    const obj = objects.get(db, hit.id);
    if (!obj) continue;
    selected.set(hit.id, {
      ...toItem(obj, intent.terms),
      reason: describeHit(hit, found.signals),
      score: hit.score,
      priority: 1,
    });
  }

  if (expand && selected.size) {
    for (const seedId of [...selected.keys()].slice(0, 5)) {
      const seed = selected.get(seedId);
      const { outgoing, incoming } = neighbours(db, seedId, { minConfidence: 0.3 });

      for (const edge of [...outgoing, ...incoming]) {
        if (selected.has(edge.other_id)) continue;
        const obj = objects.get(db, edge.other_id);
        if (!obj || obj.state === 'deleted') continue;

        // The label must read from the *included* object's point of view: this
        // item is here because it "was caused by" the seed, not because the
        // seed causes it.
        const label = edge.other_perspective ?? edge.type;
        selected.set(edge.other_id, {
          ...toItem(obj, intent.terms),
          reason: `${label.replace(/_/g, ' ')} — ${truncate(seed?.title ?? '', 60)}`,
          // Connected material ranks below direct hits but above nothing; a
          // contradiction of a top hit is worth more than a weak fifth hit.
          score: (seed?.score ?? 0) * (edge.type === 'contradicts' ? 0.9 : 0.5),
          priority: edge.type === 'contradicts' ? 1.5 : 2,
        });
      }
    }
  }

  // Predecessors: what this used to say.
  if (intent.temporal) {
    for (const id of [...selected.keys()].slice(0, 6)) {
      for (const prior of predecessors(db, id)) {
        if (selected.has(prior.id)) continue;
        selected.set(prior.id, {
          ...toItem(prior, intent.terms),
          reason: `superseded by ${truncate(selected.get(id)?.title ?? '', 50)}`,
          score: 0.3,
          priority: 2.5,
        });
      }
    }
  }

  // Conflicts are surfaced only for material that is genuinely on topic.
  // Budget-filler and loosely connected neighbours are in the context to give
  // background; raising their disagreements would answer a question about
  // SQLite with a warning about last night's batch job.
  const topScore = Math.max(...[...selected.values()].map((i) => i.score), 0);
  const relevantIds = [...selected.values()]
    .filter((i) => i.priority <= 1.5 && i.score >= topScore * 0.25)
    .map((i) => i.id);
  const open = relevantIds.length ? openConflicts(db, opts.workspaceId, relevantIds) : [];

  // Pull the other side of every conflict into context. Showing one half of a
  // disagreement is how an answer ends up confidently wrong.
  for (const c of open) {
    for (const otherId of [c.a_id, c.b_id]) {
      if (!otherId || selected.has(otherId)) continue;
      const obj = objects.get(db, otherId);
      if (!obj) continue;
      selected.set(otherId, {
        ...toItem(obj, intent.terms),
        reason: 'conflicts with other material in this context',
        score: 0.45,
        priority: 1.4,
      });
    }
  }

  const ordered = [...selected.values()].sort(
    (a, b) => a.priority - b.priority || b.score - a.score
  );

  /** @type {ContextItem[]} */
  const items = [];
  let used = 0;

  for (const item of ordered) {
    const { priority, ...rest } = item;
    if (used + item.tokens <= budget) {
      items.push(rest);
      used += item.tokens;
      continue;
    }
    // Trim rather than drop when a little room is left: a truncated relevant
    // passage beats an omitted one.
    const room = budget - used;
    if (room > 120) {
      const trimmed = truncate(item.text, room * 4);
      const tokens = estimateTokens(trimmed);
      items.push({ ...rest, text: trimmed, tokens, reason: `${rest.reason} (trimmed)` });
      used += tokens;
    }
    if (budget - used < 120) break;
  }

  const contextId = newContextId();
  const strategy = found.signals.length ? found.signals.join('+') : 'none';

  const coverage = {
    candidatesConsidered: selected.size,
    included: items.length,
    droppedForBudget: selected.size - items.length,
    signals: found.signals,
    conflictsPresent: open.length,
  };

  if (opts.record !== false) {
    recordBuild(db, {
      contextId,
      workspaceId: opts.workspaceId,
      question: opts.question,
      strategy,
      budget,
      used,
      items,
      conflicts: open,
    });
  }

  return { id: contextId, items, conflicts: open, intent, usedTokens: used, budget, strategy, coverage };
}

/**
 * Render a context for a language model, or for a human reading the prompt.
 *
 * Provenance is written into the text itself. If a model is going to reason
 * over this material, it must be able to see that one passage is a confirmed
 * fact and another is an unreviewed guess — that distinction cannot be dropped
 * on the way into the prompt.
 *
 * @param {{items: ContextItem[], conflicts: any[]}} ctx
 * @returns {string}
 */
export function render(ctx) {
  const lines = [];

  for (const item of ctx.items) {
    const marks = [item.kind, item.epistemic];
    if (item.origin === 'ai') marks.push('AI-derived');
    if (item.review === 'confirmed') marks.push('confirmed');
    if (item.review === 'rejected') marks.push('REJECTED');
    if (item.occurredAt) marks.push(item.occurredAt.slice(0, 10));

    lines.push(`[${item.id}] ${item.title}`);
    lines.push(`  (${marks.join(', ')}; included because: ${item.reason})`);
    lines.push(`  ${item.text.replace(/\n+/g, '\n  ')}`);
    lines.push('');
  }

  if (ctx.conflicts.length) {
    lines.push('KNOWN DISAGREEMENTS IN THIS MATERIAL:');
    for (const c of ctx.conflicts) {
      lines.push(
        `  - ${c.kind}: [${c.a_id}] "${truncate(c.a_title ?? '', 60)}"` +
          (c.b_id ? ` vs [${c.b_id}] "${truncate(c.b_title ?? '', 60)}"` : '') +
          (c.detail?.reason ? ` — ${c.detail.reason}` : '')
      );
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * @param {any} obj
 * @param {string[]} terms
 * @returns {ContextItem & {priority: number}}
 */
function toItem(obj, terms) {
  // Long bodies are excerpted around the query terms so the budget is spent on
  // the relevant part rather than on a note's opening paragraph.
  const text =
    obj.body && obj.body.length > 900 ? excerpt(obj.body, terms, 800) : obj.body || obj.title;
  return {
    id: obj.id,
    title: obj.title,
    kind: obj.kind,
    text,
    reason: '',
    score: 0,
    tokens: estimateTokens(`${obj.title}\n${text}`),
    epistemic: obj.epistemic,
    origin: obj.origin,
    review: obj.review,
    state: obj.state,
    occurredAt: obj.occurred_at ?? null,
    priority: 9,
  };
}

/**
 * @param {any} hit
 * @param {string[]} signals
 */
function describeHit(hit, signals) {
  const parts = [];
  if (hit.why?.lexical) parts.push('matched your words');
  if (hit.why?.semantic) parts.push('semantically close');
  if (hit.why?.structured) parts.push('matched your filters');
  if (hit.why?.structural) parts.push(`${hit.why.structural.depth} step(s) away in the graph`);
  if (!parts.length) parts.push(signals.join('+') || 'retrieved');
  return parts.join(', ');
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 */
function predecessors(db, objectId) {
  return plainAll(
    db
      .prepare(
        `SELECT * FROM object WHERE superseded_by = ? AND state != 'deleted' ORDER BY updated_at DESC LIMIT 3`
      )
      .all(objectId)
  ).map((r) => ({ ...r, attrs: JSON.parse(r.attrs) }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {string[]} ids
 */
function openConflicts(db, workspaceId, ids) {
  const list = ids.map(() => '?').join(',');
  return plainAll(
    db
      .prepare(
        `SELECT c.*, a.title AS a_title, b.title AS b_title
         FROM conflict c
         LEFT JOIN object a ON a.id = c.a_id
         LEFT JOIN object b ON b.id = c.b_id
         WHERE c.workspace_id = ? AND c.status = 'open'
           AND (c.a_id IN (${list}) OR c.b_id IN (${list}))
         ORDER BY c.confidence DESC NULLS LAST LIMIT 10`
      )
      .all(workspaceId, ...ids, ...ids)
  ).map((r) => ({ ...r, detail: safeJson(r.detail) }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {any} b
 */
function recordBuild(db, b) {
  db.prepare(
    `INSERT INTO context_build (id, workspace_id, query_id, question, strategy, budget,
                                used_tokens, items, conflicts, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.contextId, b.workspaceId, null, b.question, b.strategy, b.budget, b.used,
    stableStringify(b.items.map((i) => ({ id: i.id, reason: i.reason, score: i.score, tokens: i.tokens }))),
    stableStringify(b.conflicts.map((c) => c.id)),
    now()
  );

  emit(db, {
    workspaceId: b.workspaceId,
    type: EventType.ContextBuilt,
    subjectKind: 'context',
    subjectId: b.contextId,
    payload: { question: b.question, items: b.items.length, tokens: b.used, strategy: b.strategy },
  });
}

/**
 * Log a query. Feeds "what have I been looking for" and future relevance work.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, text: string, intent: any, resultIds: string[], strategy: string, latencyMs: number}} q
 */
export function logQuery(db, q) {
  const id = newQueryId();
  db.prepare(
    `INSERT INTO query_log (id, workspace_id, text, intent, result_ids, strategy, latency_ms, at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id, q.workspaceId, q.text, stableStringify(q.intent), stableStringify(q.resultIds),
    q.strategy, q.latencyMs, now()
  );

  emit(db, {
    workspaceId: q.workspaceId,
    type: EventType.QueryAsked,
    subjectKind: 'query',
    subjectId: id,
    payload: { text: q.text, results: q.resultIds.length, strategy: q.strategy },
  });

  return id;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} contextId
 */
export function getBuild(db, contextId) {
  const row = plain(db.prepare('SELECT * FROM context_build WHERE id = ?').get(contextId));
  if (!row) return null;
  return { ...row, items: JSON.parse(row.items), conflicts: JSON.parse(row.conflicts) };
}

/** @param {string} s @param {number} n */
function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** @param {any} s */
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
