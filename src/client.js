/**
 * Chitraq from another program.
 *
 * One file, no dependencies, works in Node and in a browser. Copy it into a
 * project or import it from an installed Chitraq; either way there is nothing
 * to build and nothing to keep in step but the HTTP API itself.
 *
 *     import { ChitraqClient } from 'chitraq/client';
 *
 *     const memory = new ChitraqClient({
 *       url: 'http://127.0.0.1:4317',
 *       token: process.env.CHITRAQ_TOKEN,
 *     });
 *
 *     await memory.remember({ title: 'Chose SQLite', body: 'It needs no server.' });
 *     const answer = await memory.ask('why is there no database to run');
 *
 * ## What this deliberately does not do
 *
 * It does not cache, retry blindly, or hide failures. A memory client that
 * silently returns stale answers is worse than one that says the server is
 * down, because the caller has no way to tell a remembered fact from a
 * remembered *response*. Every method either returns what the server said or
 * throws saying why.
 *
 * The one exception is `remember`, which can be told to queue: a program that
 * captures things as a side effect of doing its real job should not fail at
 * its real job because a memory server was restarting. That queue is in
 * memory, is explicitly opt-in, and says out loud that it is not durable.
 */

/** A server that answered, and said no. */
export class ChitraqError extends Error {
  /** @param {string} message @param {{status?: number, kind?: string, body?: any}} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ChitraqError';
    this.status = meta.status;
    this.kind = meta.kind;
    this.body = meta.body;
  }
}

/** A server that did not answer at all. */
export class ChitraqUnreachable extends Error {
  /** @param {string} message @param {{url?: string, cause?: unknown}} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'ChitraqUnreachable';
    this.url = meta.url;
    this.cause = meta.cause;
  }
}

export class ChitraqClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url]        default http://127.0.0.1:4317
   * @param {string} [opts.token]      an access token from `chitraq token new`
   * @param {number} [opts.timeoutMs]
   * @param {typeof fetch} [opts.fetch]
   * @param {boolean} [opts.queueWhenDown]  buffer `remember` calls in memory
   */
  constructor(opts = {}) {
    this.url = normalise(opts.url ?? 'http://127.0.0.1:4317');
    this.token = opts.token ?? null;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.queueWhenDown = opts.queueWhenDown ?? false;

    /**
     * Captures waiting for a server that was not there.
     *
     * In memory and nowhere else: this survives a server restart, not a
     * process restart. Anything that must not be lost belongs in a file the
     * caller owns, not in a client library's array.
     *
     * @type {any[]}
     */
    this.pending = [];

    if (typeof this.fetch !== 'function') {
      throw new Error('No fetch available. Pass one in, or use Node 18 or later.');
    }
  }

  // ------------------------------------------------------------ capture

  /**
   * Remember something.
   *
   * @param {{title: string, body?: string, kind?: string, epistemic?: string,
   *          occurredAt?: string, attrs?: object}} input
   */
  async remember(input) {
    if (!input?.title) throw new Error('Nothing to remember: give at least a title.');
    try {
      const result = await this.#call('POST', '/api/remember', input);
      await this.#flush();
      return result;
    } catch (err) {
      if (this.queueWhenDown && err instanceof ChitraqUnreachable) {
        // Queued, and said so in the return value rather than pretending it
        // was stored. A caller that ignores this is choosing to.
        this.pending.push(input);
        return { queued: true, pending: this.pending.length, reason: err.message };
      }
      throw err;
    }
  }

  /**
   * Capture a document.
   * @param {{text?: string, uri?: string, filename?: string, title?: string,
   *          mediaType?: string, extract?: boolean}} input
   */
  async ingest(input) {
    if (!input?.text && !input?.uri && !input?.bytes) {
      throw new Error('Nothing to ingest: give text, a uri, or bytes.');
    }
    return this.#call('POST', '/api/ingest', input);
  }

  // ------------------------------------------------------------ recall

  /**
   * Ask a question, answered from memory.
   *
   * The result says how it was answered: `grounded` when memory could support
   * it, `escalated` when a model wrote it, `cached` when it was served from an
   * earlier identical question. Worth reading rather than just taking `.answer`.
   *
   * @param {string} question
   * @param {{escalate?: 'auto'|'never'|'always', maxWaitMs?: number, limit?: number}} [opts]
   */
  async ask(question, opts = {}) {
    // Async even for the validation, so every failure from this client arrives
    // the same way. A method that sometimes throws and sometimes rejects makes
    // callers write two kinds of error handling for one API.
    if (!question?.trim()) throw new Error('Ask something.');
    return this.#call('POST', '/api/ask', { question, ...opts });
  }

  /**
   * Search memory. Supports the same grammar as the CLI: `kind:`, `after:`,
   * `"exact phrases"`, `-exclusions`.
   *
   * @param {string} query
   * @param {{limit?: number, includeArchived?: boolean, semantic?: boolean}} [opts]
   */
  search(query, opts = {}) {
    return this.#call('GET', `/api/search${query_(query, opts)}`);
  }

  /** @param {string} id */
  recall(id) {
    return this.#call('GET', `/api/objects/${encodeURIComponent(id)}`);
  }

  /** @param {{limit?: number, kind?: string}} [opts] */
  timeline(opts = {}) {
    return this.#call('GET', `/api/timeline${query_(null, opts)}`);
  }

  /** Things worth knowing without having asked. */
  notices() {
    return this.#call('GET', '/api/notices');
  }

  /** People, places, products and projects found in your notes. */
  entities(opts = {}) {
    return this.#call('GET', `/api/entities${query_(null, opts)}`);
  }

  /** Ideas that recur across separate notes. */
  concepts(opts = {}) {
    return this.#call('GET', `/api/concepts${query_(null, opts)}`);
  }

  // ------------------------------------------------------------ review

  /** Proposals waiting for a decision. */
  proposals(opts = {}) {
    return this.#call('GET', `/api/proposals${query_(null, opts)}`);
  }

  /** @param {string} id @param {string} [note] */
  accept(id, note) {
    return this.#call('POST', `/api/proposals/${encodeURIComponent(id)}/accept`, { note });
  }

  /** @param {string} id @param {string} [note] */
  reject(id, note) {
    return this.#call('POST', `/api/proposals/${encodeURIComponent(id)}/reject`, { note });
  }

  /** Disagreements Chitraq has noticed between things you told it. */
  conflicts(opts = {}) {
    return this.#call('GET', `/api/conflicts${query_(null, opts)}`);
  }

  // ------------------------------------------------------------ status

  /** Reachable, and whose memory is it? */
  async health() {
    return this.#call('GET', '/api/health');
  }

  /** What memory holds and which intelligence is available. */
  stats() {
    return this.#call('GET', '/api/stats');
  }

  /**
   * Is the server there?
   *
   * Never throws — this is the one method whose whole purpose is answering
   * that question, so turning "no" into an exception would be perverse.
   */
  async reachable() {
    try {
      const health = await this.health();
      return { ok: true, workspace: health.workspace };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Try to send anything that was queued while the server was away.
   * @returns {Promise<{sent: number, remaining: number}>}
   */
  async flush() {
    return this.#flush();
  }

  // ------------------------------------------------------------ internals

  async #flush() {
    if (!this.pending.length) return { sent: 0, remaining: 0 };

    let sent = 0;
    // A copy, so a failure halfway leaves the rest queued rather than lost.
    const waiting = [...this.pending];
    this.pending = [];

    for (let i = 0; i < waiting.length; i++) {
      try {
        await this.#call('POST', '/api/remember', waiting[i]);
        sent++;
      } catch (err) {
        if (err instanceof ChitraqUnreachable) {
          this.pending = waiting.slice(i);
          break;
        }
        // A rejection is not a transport failure. Re-queuing something the
        // server refuses would retry it forever.
      }
    }
    return { sent, remaining: this.pending.length };
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  async #call(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await this.fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ChitraqUnreachable(
        `Could not reach Chitraq at ${this.url} — ${err?.message ?? err}`,
        { url: this.url, cause: err }
      );
    }

    const text = await res.text();
    /** @type {any} */
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) {
        throw new ChitraqError(`${this.url}${path} answered, but not with JSON.`, {
          status: res.status,
        });
      }
    }

    if (!res.ok) {
      // The server's own words. It knows why it said no; inventing a message
      // here would hide the useful half.
      throw new ChitraqError(payload?.error ?? `${method} ${path} returned ${res.status}`, {
        status: res.status,
        kind: payload?.kind,
        body: payload,
      });
    }
    return payload;
  }
}

/**
 * @param {string|null} q
 * @param {Record<string, any>} opts
 */
function query_(q, opts = {}) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  for (const [key, value] of Object.entries(opts)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const built = params.toString();
  return built ? `?${built}` : '';
}

/** @param {string} url */
function normalise(url) {
  const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
  return new URL(withScheme).origin;
}

export default ChitraqClient;
