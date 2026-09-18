/**
 * Cost accounting and budget enforcement.
 *
 * Every capability run already records what it cost. This turns that record
 * into two things the user actually needs: a bill they can read, and a ceiling
 * they cannot accidentally exceed.
 *
 * The enforcement rule follows from the rest of the architecture: **running out
 * of budget degrades intelligence, never memory.** A router that has hit its
 * ceiling stops offering paid providers and falls through to the free and
 * deterministic ones. Capture, indexing, search and history are unaffected,
 * because none of them needs a paid provider in the first place.
 */

import { plain, plainAll } from '../core/db.js';

/**
 * @typedef {object} Budget
 * @property {number} [dailyMicros]    spend cap per calendar day, UTC
 * @property {number} [monthlyMicros}  spend cap per calendar month, UTC
 * @property {number} [perCallMicros]  refuse any single call above this
 */

/** One US dollar, in the micros used throughout. */
export const DOLLAR = 1_000_000;

/**
 * What has been spent, over the usual windows.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{now?: Date}} [opts]
 */
export function spend(db, workspaceId, opts = {}) {
  const now = opts.now ?? new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const since = (from) =>
    Number(
      db
        .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS n FROM capability_run WHERE workspace_id = ? AND started_at >= ?')
        .get(workspaceId, from)?.n ?? 0
    );

  return {
    todayMicros: since(dayStart),
    monthMicros: since(monthStart),
    totalMicros: Number(
      db
        .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS n FROM capability_run WHERE workspace_id = ?')
        .get(workspaceId)?.n ?? 0
    ),
    dayStart,
    monthStart,
  };
}

/**
 * Can a call costing `costMicros` proceed?
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {Budget} budget
 * @param {number} costMicros
 * @param {{now?: Date}} [opts]
 * @returns {{allowed: boolean, reason?: string, remaining: {day: number|null, month: number|null}}}
 */
export function check(db, workspaceId, budget, costMicros, opts = {}) {
  // Free calls are never blocked. A budget is about money leaving the user's
  // account, and stopping the deterministic provider because a cloud budget ran
  // out would break memory to enforce a limit that does not apply to it.
  if (!costMicros) {
    return { allowed: true, remaining: { day: null, month: null } };
  }

  const used = spend(db, workspaceId, opts);

  const remaining = {
    day: budget.dailyMicros == null ? null : Math.max(0, budget.dailyMicros - used.todayMicros),
    month: budget.monthlyMicros == null ? null : Math.max(0, budget.monthlyMicros - used.monthMicros),
  };

  if (budget.perCallMicros != null && costMicros > budget.perCallMicros) {
    return {
      allowed: false,
      reason: `a single call costing ${money(costMicros)} exceeds the per-call limit of ${money(budget.perCallMicros)}`,
      remaining,
    };
  }
  if (remaining.day != null && costMicros > remaining.day) {
    return {
      allowed: false,
      reason: `today's budget of ${money(budget.dailyMicros)} is spent (${money(used.todayMicros)} used)`,
      remaining,
    };
  }
  if (remaining.month != null && costMicros > remaining.month) {
    return {
      allowed: false,
      reason: `this month's budget of ${money(budget.monthlyMicros)} is spent (${money(used.monthMicros)} used)`,
      remaining,
    };
  }

  return { allowed: true, remaining };
}

/**
 * A readable bill: what was spent, on what, by which provider.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} workspaceId
 * @param {{since?: string, limit?: number}} [opts]
 */
export function report(db, workspaceId, opts = {}) {
  const since = opts.since ?? new Date(Date.now() - 30 * 86400000).toISOString();

  const byProvider = plainAll(
    db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS calls,
                SUM(cost_micros) AS micros,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures,
                ROUND(AVG(latency_ms)) AS avg_latency_ms
         FROM capability_run
         WHERE workspace_id = ? AND started_at >= ?
         GROUP BY provider, model
         ORDER BY micros DESC, calls DESC`
      )
      .all(workspaceId, since)
  );

  const byCapability = plainAll(
    db
      .prepare(
        `SELECT capability, COUNT(*) AS calls, SUM(cost_micros) AS micros
         FROM capability_run
         WHERE workspace_id = ? AND started_at >= ?
         GROUP BY capability
         ORDER BY micros DESC, calls DESC`
      )
      .all(workspaceId, since)
  );

  const daily = plainAll(
    db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS calls, SUM(cost_micros) AS micros
         FROM capability_run
         WHERE workspace_id = ? AND started_at >= ?
         GROUP BY day ORDER BY day DESC LIMIT ?`
      )
      .all(workspaceId, since, opts.limit ?? 30)
  );

  const totals = plain(
    db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_micros), 0) AS micros,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS failures
         FROM capability_run WHERE workspace_id = ? AND started_at >= ?`
      )
      .get(workspaceId, since)
  );

  return {
    since,
    totals: {
      calls: Number(totals?.calls ?? 0),
      micros: Number(totals?.micros ?? 0),
      cost: money(Number(totals?.micros ?? 0)),
      failures: Number(totals?.failures ?? 0),
    },
    byProvider: byProvider.map((r) => ({ ...r, cost: money(Number(r.micros)) })),
    byCapability: byCapability.map((r) => ({ ...r, cost: money(Number(r.micros)) })),
    daily: daily.map((r) => ({ ...r, cost: money(Number(r.micros)) })),
    spend: spend(db, workspaceId),
  };
}

/**
 * @param {number|null|undefined} micros
 * @returns {string}
 */
export function money(micros) {
  const n = Number(micros ?? 0);
  if (n === 0) return 'free';
  // Sub-cent amounts are the norm for a single call, and rounding them to
  // "$0.00" would make the bill look free when it is not.
  if (n < 10_000) return `$${(n / DOLLAR).toFixed(4)}`;
  return `$${(n / DOLLAR).toFixed(2)}`;
}
