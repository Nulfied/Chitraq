/**
 * Capability routing and execution.
 *
 * Flow (canonical, section 7):
 *   intent -> required capability -> router -> best available provider
 *          -> result -> validation -> memory or response
 *
 * Two rules govern everything here:
 *
 *   1. Every invocation is recorded in `capability_run`, including failures.
 *      INVARIANT 30: task, context, capability, model identity, result and
 *      uncertainty are all preserved.
 *
 *   2. A provider failure degrades the answer, never the memory. If the best
 *      provider is down the router falls through to the next; if all of them
 *      are down the caller gets a clear "capability unavailable" and the store
 *      is untouched. INVARIANT 24/42.
 */

import { newRunId, now, hashJson, stableStringify } from '../core/ids.js';
import { emit, EventType } from '../core/events.js';
import { check as checkBudget } from './budget.js';

/**
 * @typedef {object} Policy
 * @property {'quality'|'speed'|'cost'|'privacy'} [prefer]
 * @property {boolean} [allowRemote]      false keeps every call on this machine
 * @property {boolean} [allowPaid]
 * @property {number} [maxCostMicros]     per call
 * @property {number} [timeoutMs]
 * @property {string[]} [preferProviders] explicit user preference, tried first
 * @property {string[]} [denyProviders]
 * @property {import('./budget.js').Budget} [budget] spend ceilings
 * @property {number} [autoEscalateMaxMs] never wait longer than this without being asked
 */

/** Local-first by default: nothing leaves the machine unless asked. */
export const DEFAULT_POLICY = Object.freeze({
  prefer: 'quality',
  allowRemote: false,
  allowPaid: false,
  maxCostMicros: 0,
  timeoutMs: 120_000,
  preferProviders: [],
  denyProviders: [],
  budget: {},
  // Above this, a better answer is offered rather than taken automatically.
  // Eight seconds is roughly where waiting stops feeling like a response and
  // starts feeling like a hang.
  autoEscalateMaxMs: 8_000,
});

export class CapabilityUnavailableError extends Error {
  /**
   * @param {string} capability
   * @param {string[]} tried
   * @param {string} [detail]
   */
  constructor(capability, tried, detail) {
    super(
      `No provider could serve "${capability}"` +
        (tried.length ? ` (tried: ${tried.join(', ')})` : ' (none registered)') +
        (detail ? `. Last error: ${detail}` : '.')
    );
    this.name = 'CapabilityUnavailableError';
    this.capability = capability;
    this.tried = tried;
    this.status = 503;
  }
}

export class Router {
  /**
   * @param {object} deps
   * @param {import('./registry.js').Registry} deps.registry
   * @param {import('node:sqlite').DatabaseSync} [deps.db]  omit to route without recording
   * @param {Policy} [deps.policy]
   */
  constructor({ registry, db, policy, workspaceId }) {
    this.registry = registry;
    this.db = db;
    this.workspaceId = workspaceId;
    this.policy = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  }

  /** @param {Partial<Policy>} patch */
  setPolicy(patch) {
    this.policy = { ...this.policy, ...patch };
    return this.policy;
  }

  /**
   * Rank the providers that could serve a capability, best first.
   *
   * Ordering is explicit and inspectable rather than learned: the user's own
   * preference wins, then policy constraints filter, then the preferred axis
   * (quality / speed / cost / privacy) sorts what is left.
   *
   * @param {string} capability
   * @param {Policy} [override]
   * @returns {Promise<{eligible: import('./registry.js').Provider[], rejected: Array<{id: string, why: string}>}>}
   */
  async candidates(capability, override) {
    const policy = { ...this.policy, ...(override ?? {}) };
    const rejected = [];
    const eligible = [];

    for (const provider of this.registry.supporting(capability)) {
      const impl = provider.capabilities[capability];

      if (policy.denyProviders?.includes(provider.id)) {
        rejected.push({ id: provider.id, why: 'denied by policy' });
        continue;
      }
      if (provider.locality === 'remote' && !policy.allowRemote) {
        rejected.push({ id: provider.id, why: 'remote calls are switched off' });
        continue;
      }
      if (provider.cost === 'paid' && !policy.allowPaid) {
        rejected.push({ id: provider.id, why: 'paid providers are switched off' });
        continue;
      }
      if ((impl.costMicros ?? 0) > (policy.maxCostMicros ?? 0) && provider.cost === 'paid') {
        rejected.push({ id: provider.id, why: 'exceeds the per-call cost limit' });
        continue;
      }
      // Budget is checked at selection, not after the fact. A ceiling you can
      // only discover by exceeding it is not a ceiling.
      if (this.db && policy.budget && (impl.costMicros ?? 0) > 0) {
        const verdict = checkBudget(
          this.db,
          this.workspaceId ?? 'unknown',
          policy.budget,
          impl.costMicros ?? 0
        );
        if (!verdict.allowed) {
          rejected.push({ id: provider.id, why: verdict.reason ?? 'over budget' });
          continue;
        }
      }
      if (!(await this.registry.isAvailable(provider))) {
        rejected.push({ id: provider.id, why: 'not reachable' });
        continue;
      }
      eligible.push(provider);
    }

    const prefer = policy.prefer ?? 'quality';
    eligible.sort((a, b) => {
      const ai = policy.preferProviders?.indexOf(a.id) ?? -1;
      const bi = policy.preferProviders?.indexOf(b.id) ?? -1;
      if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);

      const A = a.capabilities[capability];
      const B = b.capabilities[capability];
      switch (prefer) {
        case 'speed':
          return A.latencyMs - B.latencyMs || B.quality - A.quality;
        case 'cost':
          return (A.costMicros ?? 0) - (B.costMicros ?? 0) || B.quality - A.quality;
        case 'privacy': {
          const rank = (p) => (p.locality === 'local' ? 0 : 1);
          return rank(a) - rank(b) || B.quality - A.quality;
        }
        default:
          return B.quality - A.quality || A.latencyMs - B.latencyMs;
      }
    });

    return { eligible, rejected };
  }

  /**
   * Run a capability.
   *
   * @param {string} capability
   * @param {any} task              capability-specific input
   * @param {object} [opts]
   * @param {string} [opts.workspaceId]
   * @param {string[]} [opts.contextIds]  memory used as context, for provenance
   * @param {Policy} [opts.policy]
   * @param {boolean} [opts.optional]     return null instead of throwing
   * @returns {Promise<{result: any, run: any, provider: string, degraded: boolean}|null>}
   */
  async run(capability, task, opts = {}) {
    if (opts.workspaceId) this.workspaceId = opts.workspaceId;
    const { eligible, rejected } = await this.candidates(capability, opts.policy);
    const policy = { ...this.policy, ...(opts.policy ?? {}) };

    if (!eligible.length) {
      if (opts.optional) return null;
      throw new CapabilityUnavailableError(
        capability,
        rejected.map((r) => `${r.id} (${r.why})`)
      );
    }

    /** @type {string[]} */
    const attempted = [];
    /** @type {Array<{provider: string, reason: string, ms: number}>} */
    const failures = [];
    let lastError = null;

    for (const provider of eligible) {
      const impl = provider.capabilities[capability];
      const runId = newRunId();
      const startedAt = now();
      const t0 = Date.now();
      attempted.push(provider.id);

      try {
        const result = await withTimeout(
          impl.run(task, { runId, capability, provider, policy }),
          policy.timeoutMs ?? 30_000,
          `${provider.id}:${capability}`
        );

        const run = this.#record({
          runId,
          workspaceId: opts.workspaceId,
          capability,
          provider,
          task,
          contextIds: opts.contextIds,
          result,
          status: 'ok',
          latencyMs: Date.now() - t0,
          costMicros: impl.costMicros ?? 0,
          startedAt,
        });

        return {
          result,
          run,
          provider: provider.id,
          // Degraded means: answered, but only by the deterministic floor.
          degraded: !!provider.deterministic && eligible.length > 1,
          // What was tried and what went wrong on the way here. Falling
          // through is the design — memory never depends on a model — but a
          // silent fallthrough lets someone believe a model did work it did
          // not. On a real import, 26 of 27 documents were extracted by the
          // floor after the model timed out, and nothing said so.
          attempted: [...attempted],
          fellBackFrom: failures.length ? [...failures] : null,
        };
      } catch (err) {
        lastError = err;
        failures.push({
          provider: provider.id,
          reason: err?.name === 'TimeoutError' ? 'timed out' : String(err?.message ?? err),
          ms: Date.now() - t0,
        });
        this.registry.healthCache.set(provider.id, { ok: false, checkedAt: Date.now() });
        this.#record({
          runId,
          workspaceId: opts.workspaceId,
          capability,
          provider,
          task,
          contextIds: opts.contextIds,
          result: null,
          status: err?.name === 'TimeoutError' ? 'timeout' : 'error',
          error: String(err?.message ?? err),
          latencyMs: Date.now() - t0,
          costMicros: 0,
          startedAt,
        });
        // Fall through to the next provider.
      }
    }

    if (opts.optional) return null;
    throw new CapabilityUnavailableError(capability, attempted, String(lastError?.message ?? lastError));
  }

  /**
   * Run a capability and accept failure quietly.
   * Used for enrichment that improves memory but must never block capture.
   * @param {string} capability
   * @param {any} task
   * @param {any} [opts]
   */
  async tryRun(capability, task, opts = {}) {
    return this.run(capability, task, { ...opts, optional: true });
  }

  /**
   * Write the run record. This is the AI output contract in concrete form.
   * @param {any} r
   */
  #record(r) {
    const row = {
      id: r.runId,
      workspace_id: r.workspaceId ?? 'unknown',
      capability: r.capability,
      provider: r.provider.id,
      model: r.provider.model ?? null,
      model_version: r.provider.modelVersion ?? null,
      task: truncateJson(r.task),
      context_ids: stableStringify(r.contextIds ?? []),
      context_hash: r.contextIds?.length ? hashJson(r.contextIds) : null,
      result: r.result === null ? null : truncateJson(r.result),
      uncertainty: extractUncertainty(r.result),
      status: r.status,
      error: r.error ?? null,
      latency_ms: r.latencyMs,
      cost_micros: r.costMicros ?? 0,
      started_at: r.startedAt,
      finished_at: now(),
    };

    if (!this.db) return row;

    this.db
      .prepare(
        `INSERT INTO capability_run (id, workspace_id, capability, provider, model, model_version,
                                     task, context_ids, context_hash, result, uncertainty, status,
                                     error, latency_ms, cost_micros, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.workspace_id, row.capability, row.provider, row.model, row.model_version,
        row.task, row.context_ids, row.context_hash, row.result, row.uncertainty, row.status,
        row.error, row.latency_ms, row.cost_micros, row.started_at, row.finished_at
      );

    if (r.workspaceId) {
      emit(this.db, {
        workspaceId: r.workspaceId,
        type: EventType.CapabilityRun,
        subjectKind: 'run',
        subjectId: row.id,
        actor: { id: r.provider.id, kind: 'capability' },
        payload: {
          capability: r.capability,
          provider: r.provider.id,
          model: row.model,
          status: row.status,
          latencyMs: row.latency_ms,
        },
      });
    }

    return row;
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} did not answer within ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Run records are for audit, not for storing a second copy of the corpus.
 * Large payloads are truncated with a marker so the record stays useful
 * without turning the audit log into the largest table in the database.
 * @param {any} value
 * @param {number} [max]
 */
function truncateJson(value, max = 20_000) {
  const s = stableStringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…"[truncated ${s.length - max} chars]"`;
}

/**
 * INVARIANT 30: uncertainty travels with the result.
 * @param {any} result
 * @returns {string|null}
 */
function extractUncertainty(result) {
  if (!result || typeof result !== 'object') return null;
  const u = result.uncertainty ?? result.confidence ?? result.caveats;
  return u === undefined ? null : stableStringify(u);
}


/**
 * What a provider actually costs in time on this machine, from its own history.
 *
 * Declared latency is a guess made by whoever wrote the adapter, on their
 * hardware. Ollama declares 3 seconds for an answer and takes 45 on a laptop
 * with no GPU. Anything that decides "is this worth waiting for" has to use the
 * measured number, or it is deciding about somebody else's computer.
 *
 * Returns null until there is enough history to be worth trusting.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, capability: string, provider: string, minRuns?: number}} q
 * @returns {number|null} median latency in ms
 */
export function measuredLatency(db, q) {
  // Timeouts count, and they count as at least what they cost.
  //
  // Only measuring successes means a provider that times out teaches nothing,
  // so the next document pays the same wait to learn the same thing. A run
  // that was cut off at seventy seconds is evidence the work takes *more*
  // than seventy seconds, which is exactly what a "is this worth trying"
  // decision needs.
  const rows = db
    .prepare(
      `SELECT latency_ms FROM capability_run
       WHERE workspace_id = ? AND capability = ? AND provider = ?
         AND status IN ('ok', 'timeout')
         AND latency_ms IS NOT NULL
       ORDER BY started_at DESC LIMIT 20`
    )
    .all(q.workspaceId, q.capability, q.provider)
    .map((r) => Number(r.latency_ms))
    .filter((n) => Number.isFinite(n));

  if (rows.length < (q.minRuns ?? 3)) return null;

  // Median, not mean: one cold model load should not define the experience.
  rows.sort((a, b) => a - b);
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2);
}

/**
 * Read the audit trail of intelligence use.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{workspaceId: string, capability?: string, limit?: number, status?: string}} opts
 */
export function runHistory(db, opts) {
  const where = ['workspace_id = ?'];
  const args = [opts.workspaceId];
  if (opts.capability) { where.push('capability = ?'); args.push(opts.capability); }
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }

  return db
    .prepare(
      `SELECT id, capability, provider, model, status, error, latency_ms, cost_micros, started_at
       FROM capability_run WHERE ${where.join(' AND ')}
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(...args, Math.min(opts.limit ?? 50, 500))
    .map((r) => ({ ...r }));
}
