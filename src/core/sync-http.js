/**
 * Moving a sync payload between two machines over HTTP.
 *
 * `sync.js` deliberately has no transport: it produces a payload and consumes
 * one, and says so. This is *a* transport, not *the* transport — a payload on a
 * USB stick is still a valid way to sync, and nothing here is load-bearing for
 * the merge rules.
 *
 * Two things this file takes seriously.
 *
 * **It is the first thing in Chitraq that sends your memory somewhere else.**
 * Everything until now has been local by construction. So this asks the remote
 * who it is before handing it anything, refuses anything that is not plainly a
 * Chitraq, and reports exactly what left and what arrived. There is no implicit
 * sync, no background sync, and no daemon.
 *
 * **Peer identity is the remote's workspace id, not its URL.** A laptop that
 * moves between home and a tailnet has two URLs and one identity. Keying the
 * sync cursor on the URL would resend the whole workspace every time the
 * address changed.
 */

import { SYNC_FORMAT } from './sync.js';

/** A remote that answers but is not a Chitraq, or is one that refuses us. */
export class PeerError extends Error {
  /** @param {string} message @param {{status?: number, url?: string}} [meta] */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'PeerError';
    this.status = meta.status;
    this.url = meta.url;
  }
}

/**
 * @typedef {object} Peer
 * @property {string} url             normalised base URL
 * @property {() => Promise<{workspaceId: string, url: string}>} identify
 * @property {(payload: any, opts?: {peerId?: string, dryRun?: boolean}) => Promise<any>} push
 * @property {(opts?: {peerId?: string, since?: string|null, limit?: number}) => Promise<any>} pull
 */

/**
 * @param {string} baseUrl
 * @param {{token?: string, timeoutMs?: number, fetch?: typeof fetch}} [opts]
 * @returns {Peer}
 */
export function httpPeer(baseUrl, opts = {}) {
  const url = normalise(baseUrl);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetch ?? fetch;

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   */
  async function call(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;

    let res;
    try {
      res = await doFetch(`${url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A refused connection and a wrong hostname are the same mistake to the
      // person making it, and neither is helped by a stack trace.
      throw new PeerError(`Could not reach ${url} — ${err?.message ?? err}`, { url });
    }

    if (res.status === 401 || res.status === 403) {
      throw new PeerError(
        `${url} needs credentials. Pass --token, or log in there and use the session token.`,
        { status: res.status, url }
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new PeerError(`${url}${path} returned ${res.status}${detail ? `: ${detail}` : ''}`, {
        status: res.status,
        url,
      });
    }

    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new PeerError(`${url}${path} answered, but not with JSON. Is that a Chitraq?`, { url });
    }
  }

  return {
    url,

    async identify() {
      const health = await call('GET', '/api/health');
      // A bare 200 from some other service is not an identity. Demanding the
      // workspace id is what makes "point it at the wrong port" fail loudly.
      if (!health?.workspace) {
        throw new PeerError(`${url} answered, but did not identify itself as a Chitraq.`, { url });
      }
      return { workspaceId: String(health.workspace), url };
    },

    async push(payload, pushOpts = {}) {
      return call('POST', '/api/sync/apply', {
        payload,
        peerId: pushOpts.peerId,
        dryRun: pushOpts.dryRun,
      });
    },

    async pull(pullOpts = {}) {
      const params = new URLSearchParams();
      if (pullOpts.peerId) params.set('peer', pullOpts.peerId);
      if (pullOpts.since !== undefined && pullOpts.since !== null) {
        params.set('since', String(pullOpts.since));
      }
      if (pullOpts.limit) params.set('limit', String(pullOpts.limit));
      const query = params.toString();
      const payload = await call('GET', `/api/sync/changes${query ? `?${query}` : ''}`);

      if (payload && payload.format !== SYNC_FORMAT) {
        throw new PeerError(
          `${url} speaks "${payload.format}" and this Chitraq speaks "${SYNC_FORMAT}". ` +
            'One of the two needs updating.',
          { url }
        );
      }
      return payload;
    },
  };
}

/**
 * Is this peer somewhere other than this machine?
 *
 * Not a security boundary — anyone can point a hostname at localhost. It exists
 * so the CLI can say "this leaves your machine" when it does, and stay quiet
 * when it does not.
 *
 * @param {string} baseUrl
 */
export function isRemoteHost(baseUrl) {
  try {
    const { hostname } = new URL(normalise(baseUrl));
    return !['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(hostname);
  } catch {
    return true;
  }
}

/** @param {string} baseUrl */
function normalise(baseUrl) {
  const withScheme = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new PeerError(`"${baseUrl}" is not a URL.`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
