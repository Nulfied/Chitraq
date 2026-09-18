/**
 * Chitraq — the memory engine.
 *
 * This is the facade the CLI, the HTTP server and any embedding application
 * talk to. It composes the deterministic core (objects, relations, evidence,
 * history) with the intelligence fabric (registry, router, gateway) and
 * implements the central loop:
 *
 *   capture -> persist -> structure -> connect -> retrieve
 *           -> contextualise -> understand -> feedback -> evolve -> remember
 *
 * The composition rule throughout: memory operations never depend on
 * intelligence succeeding. Every call to the router here is either optional
 * (enrichment) or falls back to the deterministic provider, which is always
 * present. Capture completes, search answers, and history stays intact whether
 * or not a single model is reachable.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { open, tx } from './core/db.js';
import { now } from './core/ids.js';
import * as objects from './core/objects.js';
import * as entities from './core/entities.js';
import * as concepts from './core/concepts.js';
import * as transfer from './core/transfer.js';
import * as auth from './core/auth.js';
import * as keys from './core/keys.js';
import * as sync from './core/sync.js';
import { httpPeer, isRemoteHost } from './core/sync-http.js';
import * as relations from './core/relations.js';
import * as sources from './core/sources.js';
import * as workspaceStore from './core/workspace.js';
import * as events from './core/events.js';
import { Registry, Capability } from './intelligence/registry.js';
import { Router, DEFAULT_POLICY, runHistory, measuredLatency } from './intelligence/router.js';
import { deterministicProvider, EMBED_MODEL } from './intelligence/providers/deterministic.js';
import { providerFromKey, keyedIdFor, BUILDABLE } from './intelligence/providers/from-key.js';
import { pdfOcrProvider } from './intelligence/providers/pdf-ocr.js';
import * as gateway from './intelligence/gateway.js';
import * as budget from './intelligence/budget.js';
import * as indexer from './retrieval/indexer.js';
import * as ann from './retrieval/ann.js';
import * as salience from './retrieval/salience.js';
import { search as runSearch, similarTo } from './retrieval/search.js';
import { parse as parseQuery } from './retrieval/query.js';
import * as context from './context/builder.js';
import * as proactive from './context/proactive.js';
import * as answerCache from './context/answer-cache.js';
import { parseSource } from './capture/parse.js';
import { planFolder } from './capture/folder.js';
import { watchFolder, displayPath, resolveReal } from './capture/watch.js';
import { estimateTokens } from './core/text.js';

export { Capability } from './intelligence/registry.js';
export { Kind, Origin, Epistemic, State } from './core/objects.js';
export { RelType } from './core/relations.js';
export { Op } from './intelligence/gateway.js';

export class Chitraq {
  /** @type {Map<string, {index: any, size: number}>} */
  #annCache = new Map();

  /**
   * @param {object} [opts]
   * @param {string} [opts.path]        store location; ':memory:' for ephemeral
   * @param {import('./intelligence/router.js').Policy} [opts.policy]
   * @param {import('./intelligence/registry.js').Provider[]} [opts.providers] extra providers
   * @param {{autoAccept?: Record<string, number|null>}} [opts.acceptPolicy]
   * @param {string} [opts.keySecret]   seals stored API keys; defaults to a file beside the store
   * @param {Record<string, any>} [opts.keyedProviderOptions] per-provider settings for BYO keys
   */
  constructor(opts = {}) {
    this.db = open(opts.path ?? ':memory:');

    this.registry = new Registry();
    // The deterministic provider is registered first and is never removed.
    // It is the floor the whole system stands on.
    this.registry.register(deterministicProvider(this.db));
    for (const p of opts.providers ?? []) this.registry.register(p);

    this.router = new Router({ registry: this.registry, db: this.db, policy: opts.policy });

    // Reading a scanned PDF is reading its pictures, so this is registered
    // after the router exists and delegates straight back through it. It
    // becomes available the moment anything can read an image, and unavailable
    // again when nothing can — no configuration either way.
    this.registry.register(
      pdfOcrProvider({
        canReadImages: () => this.registry.supporting(Capability.OcrImage).length > 0,
        readImage: async (task) => {
          const run = await this.router.run(Capability.OcrImage, task, {
            workspaceId: this.workspaceId,
          });
          return run.result;
        },
      })
    );
    this.acceptPolicy = opts.acceptPolicy ?? gateway.DEFAULT_ACCEPT_POLICY;

    const boot = workspaceStore.bootstrap(this.db);
    this.workspaceId = boot.workspace.id;
    this.router.workspaceId = boot.workspace.id;

    // A provider going down is a fact about this installation worth keeping:
    // it explains why answers got worse on a particular afternoon.
    this.registry.onHealthChange = ({ providerId, ok }) => {
      events.emit(this.db, {
        workspaceId: this.workspaceId,
        type: ok ? events.EventType.ProviderRestored : events.EventType.ProviderUnavailable,
        subjectKind: 'provider',
        subjectId: providerId,
        actor: { id: providerId, kind: 'capability' },
        payload: { provider: providerId, available: ok },
      });
    };
    this.principal = boot.principal;
    this.actor = { id: boot.principal.id, kind: /** @type {const} */ ('user') };

    // A secret supplied directly rather than found on disk. Tests need this;
    // so does a hosted deployment holding it in a real secret manager.
    this.keySecret = opts.keySecret ? keys.masterSecret({ secret: opts.keySecret }) : undefined;
    /** @type {Record<string, any>} */
    this.keyedProviderOptions = opts.keyedProviderOptions ?? {};

    // Whatever this person already brought, put to work immediately.
    this.loadKeyedProviders();
  }

  // ========================================================== BYO KEYS

  /**
   * Register a provider for every key the current principal has stored.
   *
   * Called at startup and after any key change. Keyed providers are registered
   * under their own ids, so an installation-wide key set by whoever runs the
   * server and a person's own key can both exist — the router sees two
   * providers, not one being overwritten, because they are two arrangements
   * with two different bills.
   *
   * A key that cannot be opened does not throw here. Startup failing because of
   * a rotated secret would take the whole memory down over an optional extra.
   *
   * @returns {{registered: string[], failed: Array<{provider: string, error: string}>}}
   */
  loadKeyedProviders() {
    /** @type {string[]} */
    const registered = [];
    /** @type {any[]} */
    const failed = [];

    const stored = keys.providersWithKeys(this.db, this.principal.id);

    for (const provider of BUILDABLE) {
      const registryId = keyedIdFor(provider);
      if (!stored.includes(provider)) {
        this.registry.unregister(registryId);
        continue;
      }
      try {
        const key = keys.getKey(this.db, {
          principalId: this.principal.id,
          provider,
          secret: this.keySecret,
        });
        if (!key) continue;
        const built = providerFromKey(provider, key, {
          ...(this.keyedProviderOptions[provider] ?? {}),
          principalId: this.principal.id,
        });
        if (built) {
          this.registry.register(built);
          registered.push(built.id);
        }
      } catch (err) {
        this.registry.unregister(registryId);
        failed.push({ provider, error: err?.message ?? String(err) });
      }
    }

    // A provider that was just added has no health history, and a stale "down"
    // from before the key existed would keep it out of every routing decision.
    if (registered.length) this.registry.resetHealth();

    return { registered, failed };
  }

  /**
   * Store an API key for the current principal.
   *
   * The key is sealed before it touches the database and is never returned
   * again. What comes back is enough to recognise it and nothing more.
   *
   * @param {{provider: string, key: string, label?: string}} input
   */
  setApiKey(input) {
    const result = keys.setKey(this.db, {
      principalId: this.principal.id,
      provider: input.provider,
      key: input.key,
      label: input.label,
      secret: this.keySecret,
    });

    const load = this.loadKeyedProviders();
    const failure = load.failed.find((f) => f.provider === input.provider);

    events.emit(this.db, {
      workspaceId: this.workspaceId,
      type: events.EventType.CredentialChanged,
      subjectKind: 'provider',
      subjectId: input.provider,
      actor: this.actor,
      // The fingerprint, never the key. An audit log that leaks the thing it is
      // auditing is worse than no audit log.
      payload: {
        action: result.replaced ? 'key-replaced' : 'key-added',
        provider: input.provider,
        fingerprint: result.fingerprint,
      },
    });

    return {
      ...result,
      active: !failure && load.registered.includes(keyedIdFor(input.provider)),
      error: failure?.error ?? null,
    };
  }

  /** Keys this principal has stored, masked. */
  apiKeys() {
    return keys.list(this.db, this.principal.id, this.keySecret).map((k) => ({
      ...k,
      active: this.registry.get(keyedIdFor(k.provider)) !== undefined,
    }));
  }

  /** @param {{provider?: string, id?: string}} q */
  removeApiKey(q) {
    const result = keys.removeKey(this.db, { principalId: this.principal.id, ...q });
    this.loadKeyedProviders();

    events.emit(this.db, {
      workspaceId: this.workspaceId,
      type: events.EventType.CredentialChanged,
      subjectKind: 'provider',
      subjectId: result.provider,
      actor: this.actor,
      payload: { action: 'key-removed', provider: result.provider },
    });
    return result;
  }

  /** @param {string} workspaceId */
  useWorkspace(workspaceId) {
    const ws = workspaceStore.get(this.db, workspaceId);
    if (!ws) throw new objects.NotFoundError(`No workspace ${workspaceId}`);
    this.workspaceId = workspaceId;
    return ws;
  }

  /** @param {Partial<import('./intelligence/router.js').Policy>} patch */
  setPolicy(patch) {
    return this.router.setPolicy(patch);
  }

  close() {
    this.db.close();
  }

  // ============================================================== CAPTURE

  /**
   * Remember something. The primary way knowledge enters Chitraq.
   *
   * @param {object} input
   * @param {string} input.title
   * @param {string} [input.body]
   * @param {string} [input.kind]
   * @param {string} [input.epistemic]
   * @param {string} [input.origin]
   * @param {number} [input.confidence]
   * @param {object} [input.attrs]
   * @param {string} [input.occurredAt]
   * @param {string} [input.sourceId]
   * @param {boolean} [input.enrich] run background structuring, default true
   * @param {boolean} [input.allowDuplicate] capture even if identical content exists
   * @returns {Promise<{object: any, indexed: any, enrichment: any, deduplicated?: boolean}>}
   */
  async remember(input) {
    // 0. Identical content captured twice is one piece of knowledge, not two.
    //    Returning the original keeps its history, links and evidence intact
    //    rather than splitting them across a duplicate nobody meant to make.
    if (!input.allowDuplicate) {
      const duplicate = objects.findByContent(this.db, {
        workspaceId: this.workspaceId,
        kind: input.kind ?? objects.Kind.Note,
        title: input.title,
        body: input.body ?? '',
        attrs: input.attrs ?? {},
        origin: input.origin ?? objects.Origin.User,
      });
      if (duplicate) {
        events.emit(this.db, {
          workspaceId: this.workspaceId,
          type: events.EventType.KnowledgeCaptured,
          subjectKind: 'object',
          subjectId: duplicate.id,
          actor: this.actor,
          payload: { deduplicated: true, title: duplicate.title },
        });
        objects.touch(this.db, [duplicate.id]);
        return { object: duplicate, indexed: null, enrichment: null, deduplicated: true };
      }
    }

    // 1. Persist first, always. Capture must never be blocked by analysis.
    const object = objects.create(
      this.db,
      { ...input, workspaceId: this.workspaceId, derivation: { method: 'user' } },
      this.actor
    );

    if (input.sourceId) {
      sources.link(
        this.db,
        { workspaceId: this.workspaceId, targetId: object.id, sourceId: input.sourceId, stance: 'supports' },
        this.actor
      );
    }

    // 2. Index. Deterministic; the embedding step degrades independently.
    const indexed = await this.#index(object);

    // 3. Enrich. Entirely optional, entirely proposal-based.
    let enrichment = null;
    if (input.enrich !== false) {
      enrichment = await this.enrich(object.id).catch((err) => ({ error: String(err.message ?? err) }));
    }

    return { object: objects.get(this.db, object.id), indexed, enrichment };
  }

  /**
   * Capture a document, page or file: store it verbatim as a Source, then
   * propose the Knowledge Objects it contains.
   *
   * The source is stored before anything is extracted, so a failure in
   * extraction costs you an analysis, not the document.
   *
   * @param {object} input
   * @param {string} [input.text]
   * @param {Uint8Array} [input.bytes]
   * @param {string} [input.uri]
   * @param {string} [input.filename]
   * @param {string} [input.mediaType]
   * @param {string} [input.title]
   * @param {boolean} [input.extract]     propose claims, default true
   * @param {boolean} [input.keepBlob]
   * @returns {Promise<{source: any, parsed: any, proposals: any[], accepted: any[], deduplicated: boolean}>}
   */
  async ingest(input) {
    const parsed = parseSource(input);

    // An image or a recording arrives here with no text and a named capability
    // that would change that. If something serves it, this is where captured
    // bytes become readable knowledge.
    const reading = await this.#readMedia(parsed, input);

    const { source, deduplicated } = sources.capture(
      this.db,
      {
        workspaceId: this.workspaceId,
        uri: input.uri,
        mediaType: parsed.mediaType,
        title: input.title ?? parsed.title ?? input.filename ?? null,
        text: parsed.text,
        blob: input.keepBlob ? input.bytes : undefined,
        meta: {
          ...parsed.meta,
          filename: input.filename ?? null,
          // Size and last-write time, so a folder captured again can tell an
          // untouched file from a changed one without opening it. The content
          // hash is still what decides; this only avoids the reading.
          ...(input.fileStat ? { file: input.fileStat } : {}),
          // If the text came from a model rather than from the file, the source
          // says so permanently. Everything downstream that wants to claim
          // "quoted from your own words" can check.
          ...(reading ? { textVia: reading.via } : {}),
        },
        origin: 'source',
      },
      this.actor
    );

    if (deduplicated) {
      return { source, parsed, proposals: [], accepted: [], deduplicated: true, reading };
    }
    if (input.extract === false || !parsed.text.trim()) {
      return { source, parsed, proposals: [], accepted: [], deduplicated: false, reading };
    }

    // Extraction is a capability call. With no model configured this is the
    // deterministic segmenter; with one configured it is that model. Either
    // way the output is proposals, never direct writes.
    const run = await this.router.tryRun(
      Capability.ExtractClaims,
      { text: parsed.text, title: parsed.title, limit: 20 },
      { workspaceId: this.workspaceId }
    );

    /** @type {any[]} */
    const proposals = [];
    /** @type {any[]} */
    const accepted = [];

    for (const claim of run?.result?.claims ?? []) {
      const { proposal, applied } = gateway.propose(
        this.db,
        {
          workspaceId: this.workspaceId,
          runId: run?.run?.id,
          op: gateway.Op.CreateObject,
          // A claim read out of a transcription rests on two models, not one.
          // Carrying the full doubt forward is the only honest arithmetic:
          // a confident reading of a misheard sentence is still wrong.
          confidence: reading
            ? Math.round(claim.confidence * READING_DISCOUNT * 100) / 100
            : claim.confidence,
          rationale: reading
            ? `Extracted from "${source.title ?? source.uri ?? 'captured source'}", ` +
              `whose text was read by ${reading.via.provider} rather than written`
            : `Extracted from "${source.title ?? source.uri ?? 'captured source'}"`,
          payload: {
            title: truncateTitle(claim.text),
            body: claim.text,
            kind: claim.kind,
            epistemic: claim.epistemic,
            origin: 'source',
            evidence: {
              sourceId: source.id,
              excerpt: claim.text,
              locator: { offset: claim.offset, length: claim.text.length },
            },
          },
        },
        this.acceptPolicy,
        this.actor
      );
      proposals.push(proposal);
      if (applied) accepted.push(applied);
    }

    for (const a of accepted) {
      if (a.kind === 'object') await this.#index(objects.get(this.db, a.id));
    }

    return { source, parsed, proposals, accepted, deduplicated: false, reading };
  }

  /**
   * Turn bytes nobody can read into text, if something can.
   *
   * Capture never depends on this working. A vision model that is missing, slow
   * or wrong leaves exactly what Chitraq did before: the bytes stored verbatim
   * and an honest note that reading them needs a capability nobody serves. That
   * is the whole reason the slots were declared empty rather than hidden.
   *
   * Mutates `parsed` in place when it succeeds, because the text genuinely is
   * the source's text from here on — with a permanent record of where it came
   * from, which is the part that must not be lost.
   *
   * @param {any} parsed
   * @param {any} input
   * @returns {Promise<{via: any, result: any}|null>}
   */
  async #readMedia(parsed, input) {
    if (!parsed.needsCapability || parsed.text?.trim()) return null;
    if (!input.bytes?.length) return null;
    if (input.read === false) return null;

    // No provider for this slot is the normal case, not an error.
    if (!this.registry.supporting(parsed.needsCapability).length) return null;

    const run = await this.router.tryRun(
      parsed.needsCapability,
      {
        bytes: input.bytes,
        mediaType: parsed.mediaType,
        filename: input.filename ?? null,
      },
      { workspaceId: this.workspaceId }
    );

    const text = String(run?.result?.text ?? '').trim();
    if (!text) return null;

    const via = {
      capability: parsed.needsCapability,
      provider: run.run?.provider ?? 'unknown',
      model: run.result?.model ?? null,
      at: now(),
    };

    parsed.text = text;
    parsed.readBy = via;
    parsed.uncertainty = run.result?.uncertainty ?? null;
    // The slot is served now, so the honest report changes from "nobody can
    // read this" to "this was read, by a machine".
    parsed.needsCapability = null;
    if (run.result?.segments?.length) parsed.meta = { ...parsed.meta, segments: run.result.segments };

    return { via, result: run.result };
  }

  /**
   * Capture a whole folder.
   *
   * The properties that matter here are all about being interruptible. Each
   * file is committed before the next one starts, so stopping halfway loses
   * nothing; capture is keyed on content and location, so running it again
   * skips everything already taken in. Together those mean the honest advice
   * for a large folder is "start it, and press Ctrl-C whenever you like" —
   * which is the only advice that is any use when extraction with a local
   * model costs twenty seconds a file.
   *
   * Errors are collected rather than thrown. One unreadable file in four
   * hundred should cost you that file, not the run.
   *
   * @param {string} root
   * @param {object} [opts]
   * @param {boolean} [opts.recursive]
   * @param {boolean} [opts.hidden]
   * @param {string[]} [opts.include]
   * @param {boolean} [opts.only]
   * @param {number} [opts.maxBytes]
   * @param {number} [opts.limit]
   * @param {boolean} [opts.extract]    propose claims per file, default true
   * @param {boolean} [opts.keepBlob]
   * @param {boolean} [opts.rescan]     read every file again, ignoring what is on record
   * @param {any} [opts.plan]           a plan from planFolder, to capture exactly what was shown
   * @param {(p: {index: number, total: number, file: any, outcome: string, detail?: string}) => void} [opts.onProgress]
   * @returns {Promise<{plan: any, captured: any[], duplicates: any[], failures: any[], proposed: number, accepted: number, elapsedMs: number}>}
   */
  async ingestFolder(root, opts = {}) {
    // A caller that has already planned — to print the list, or to let someone
    // approve it — passes it back in. Walking twice would mean the folder could
    // change in between, and then what was shown is not what was captured.
    const plan = opts.plan ?? (await planFolder(root, opts));
    const started = Date.now();

    /** @type {any[]} */ const captured = [];
    /** @type {any[]} */ const duplicates = [];
    /** @type {any[]} */ const unchanged = [];
    /** @type {any[]} */ const failures = [];
    let proposed = 0;
    let accepted = 0;

    // What this folder looked like the last time it was captured. One query,
    // then every unchanged file costs nothing at all — which is what makes
    // re-running a large import cheap enough to do casually.
    const known = opts.rescan === true ? new Map() : this.#capturedFiles();

    for (const [i, file] of plan.files.entries()) {
      /** @type {string} */ let outcome;
      /** @type {string|undefined} */ let detail;

      const seen = known.get(pathToFileURL(file.path).href);
      if (seen && seen.bytes === file.bytes && seen.modified === file.modified) {
        unchanged.push({ file, sourceId: seen.sourceId });
        opts.onProgress?.({
          index: i + 1,
          total: plan.files.length,
          file,
          outcome: 'unchanged',
          detail: 'not touched since it was captured',
        });
        continue;
      }

      try {
        // Read as bytes, not as text. A PDF decoded as UTF-8 is convincing
        // rubbish, and rubbish that looks like text is worse than a failure.
        const bytes = await readFile(file.path);
        const result = await this.ingest({
          bytes,
          filename: basename(file.path),
          uri: pathToFileURL(file.path).href,
          fileStat: { bytes: file.bytes, modified: file.modified },
          extract: opts.extract,
          keepBlob: opts.keepBlob,
        });

        if (result.deduplicated) {
          duplicates.push({ file, sourceId: result.source.id });
          outcome = 'already captured';
        } else {
          captured.push({ file, sourceId: result.source.id, proposals: result.proposals.length });
          proposed += result.proposals.length;
          accepted += result.accepted.length;
          outcome = 'captured';
          detail = result.parsed.needsCapability
            ? `no text — needs ${result.parsed.needsCapability}`
            : opts.extract === false
              ? `${words(result.parsed.text)} words`
              : `${result.proposals.length} proposed`;
        }
      } catch (err) {
        failures.push({ file, error: err?.message ?? String(err) });
        outcome = 'failed';
        detail = err?.message ?? String(err);
      }
      opts.onProgress?.({ index: i + 1, total: plan.files.length, file, outcome, detail });
    }

    return {
      plan,
      captured,
      duplicates,
      unchanged,
      failures,
      proposed,
      accepted,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Watch a folder and capture what changes in it, until told to stop.
   *
   * A foreground watcher, not a daemon. It exists for as long as the caller
   * keeps it, prints what it takes in, and dies with the process. Nothing is
   * installed and nothing survives.
   *
   * @param {string} root
   * @param {object} [opts]  as ingestFolder, plus onEvent and settleMs
   * @returns {import('./capture/watch.js').Watcher}
   */
  watch(root, opts = {}) {
    // The same spelling the watcher will use, so display paths come out
    // relative to the folder rather than relative to a different name for it.
    const resolved = resolveReal(root);

    return watchFolder({
      root: resolved,
      recursive: opts.recursive,
      include: opts.include,
      only: opts.only,
      settleMs: opts.settleMs,
      onEvent: opts.onEvent,
      capture: async (paths) => {
        // A plan built from exactly the settled paths, so the watcher captures
        // what changed rather than re-walking the folder each time. The
        // unchanged-file check still applies underneath, which is what makes an
        // editor touching a file without altering it cost nothing.
        const files = [];
        for (const path of paths) {
          const info = await stat(path).catch(() => null);
          if (!info?.isFile()) continue;
          files.push({
            path,
            // relative(), not slice arithmetic. The watcher resolves its root to
            // the real path, which on Windows is a different length from the one
            // the caller passed, and subtracting the wrong number of characters
            // silently eats the front of every filename.
            relative: displayPath(resolved, path),
            bytes: info.size,
            modified: info.mtime.toISOString(),
            mediaType: 'text/plain',
          });
        }
        if (!files.length) return { captured: [], unchanged: [], duplicates: [], failures: [] };

        return this.ingestFolder(resolved, {
          ...opts,
          plan: { root: resolved, files, skipped: [], directories: 1, limited: false },
        });
      },
    });
  }

  /**
   * Every file already captured from disk, by URL, with what it looked like.
   *
   * Sources with no recorded size — captured before this existed, or from
   * somewhere other than a folder walk — are simply absent, so they get read
   * again. Degrading to the old behaviour is the right failure here.
   *
   * @returns {Map<string, {bytes: number, modified: string, sourceId: string}>}
   */
  #capturedFiles() {
    /** @type {Map<string, any>} */
    const out = new Map();
    const rows = this.db
      .prepare(
        `SELECT id, uri, meta FROM source
         WHERE workspace_id = ? AND uri LIKE 'file:%' ORDER BY captured_at`
      )
      .all(this.workspaceId);

    for (const row of rows) {
      let file;
      try {
        file = JSON.parse(String(row.meta ?? '{}')).file;
      } catch {
        continue;
      }
      if (!file?.modified || typeof file.bytes !== 'number') continue;
      out.set(String(row.uri), { ...file, sourceId: String(row.id) });
    }
    return out;
  }

  // ============================================================ RETRIEVAL

  /**
   * Search memory.
   * @param {string} q
   * @param {{limit?: number, anchorId?: string, includeArchived?: boolean, semantic?: boolean}} [opts]
   */
  async search(q, opts = {}) {
    const t0 = Date.now();
    const intent = parseQuery(q);

    let queryVector;
    let vectorModel;
    if (opts.semantic !== false && intent.terms.length) {
      const embedded = await this.#embed([q]);
      if (embedded) {
        queryVector = embedded.vectors[0];
        vectorModel = embedded.model;
      }
    }

    const limit = opts.limit ?? 20;
    const result = runSearch(this.db, {
      workspaceId: this.workspaceId,
      intent,
      queryVector,
      vectorModel,
      // Fetch deeper than asked for when a reranker will reorder the pool: a
      // reranker can only promote what retrieval handed it, so giving it a
      // thin list wastes it.
      limit: opts.rerank === false ? limit : Math.max(limit, 25),
      anchorId: opts.anchorId,
      includeArchived: opts.includeArchived,
      annIndex: vectorModel ? this.#annIndexFor(vectorModel) : undefined,
    });

    if (opts.rerank !== false) await this.#rerank(q, intent, result);
    result.results = result.results.slice(0, limit);

    const latencyMs = Date.now() - t0;
    context.logQuery(this.db, {
      workspaceId: this.workspaceId,
      text: q,
      intent,
      resultIds: result.results.map((r) => r.id),
      strategy: result.signals.join('+'),
      latencyMs,
    });
    objects.touch(this.db, result.results.slice(0, 5).map((r) => r.id));

    return { ...result, latencyMs };
  }

  /**
   * Ask a question of memory.
   *
   * Always returns the context it used and the citations the answer rests on.
   * When nothing in memory answers the question it says so — it does not fill
   * the gap with fluent text, because a memory engine that invents recall is
   * worse than one that admits a blank.
   *
   * @param {string} question
   * @param {{budget?: number, seeds?: number}} [opts]
   */
  async ask(question, opts = {}) {
    const t0 = Date.now();

    const embedded = await this.#embed([question]);
    const ctx = context.build(this.db, {
      workspaceId: this.workspaceId,
      question,
      budget: opts.budget ?? 3000,
      seeds: opts.seeds ?? 8,
      queryVector: embedded?.vectors[0],
      vectorModel: embedded?.model,
    });

    if (!ctx.items.length) {
      return {
        question,
        answer: null,
        grounded: false,
        uncertainty: 'Nothing in memory relates to this question yet.',
        context: ctx,
        citations: [],
        provider: null,
        cached: false,
        escalated: false,
        ladder: {
          floorConfidence: 0,
          threshold: opts.minConfidence ?? 0.55,
          reason: 'memory holds nothing about this',
          canEscalate: false,
        },
        notices: [],
        latencyMs: Date.now() - t0,
      };
    }

    const task = {
      question,
      context: ctx.items.map((i) => ({
        id: i.id,
        title: i.title,
        text: i.text,
        // Carried through so an answer can tell current knowledge from what
        // has since been replaced, instead of quoting both as fact.
        state: i.state,
        epistemic: i.epistemic,
      })),
      rendered: context.render(ctx),
      conflicts: ctx.conflicts,
      retrospective: ctx.intent.retrospective,
    };
    const contextIds = ctx.items.map((i) => i.id);

    // ---------------------------------------------------------------------
    // The answer ladder.
    //
    // Building the context above was deterministic and cost nothing. The model
    // call is the only expensive step, so it is the last resort rather than the
    // first move:
    //
    //   1. cache      — same question, same underlying material, already answered
    //   2. extractive — quote the user's own sentences; free, instant, cannot
    //                   hallucinate
    //   3. a model    — only when quoting genuinely is not enough
    //
    // Most questions asked of a personal memory are lookups, and a lookup is
    // answered perfectly by handing back the sentence you wrote. Sending those
    // to a model costs money and adds latency to buy nothing.
    // ---------------------------------------------------------------------

    const cacheKey = answerCache.keyFor({
      question,
      context: ctx.items.map((i) => ({ id: i.id, contentHash: contentHashOf(this.db, i.id) })),
      // The rung of the ladder is part of the key. Without it, asking for a
      // better answer would be served the cheaper cached one it was asked to
      // improve on — the cache would silently refuse the upgrade.
      provider: opts.escalate === 'always' ? 'escalated' : 'auto',
    });

    if (opts.cache !== false) {
      const hit = answerCache.get(this.db, { workspaceId: this.workspaceId, key: cacheKey });
      if (hit) {
        objects.touch(this.db, contextIds);
        return {
          question,
          answer: hit.answer,
          grounded: hit.grounded,
          passages: [],
          citations: hit.citations,
          uncertainty: hit.uncertainty,
          method: 'cached',
          provider: hit.provider,
          cached: true,
          escalated: false,
          degraded: false,
          // A cached answer still reports the ladder, so the interface can
          // offer a better one. Without this, caching a cheap answer would
          // quietly remove the user's ability to ask for a written one.
          ladder: {
            floorConfidence: null,
            threshold: opts.minConfidence ?? 0.55,
            reason: 'answered before, and nothing behind it has changed',
            canEscalate: hit.provider === 'builtin' && hasBetterAnswerer(this.registry),
            estimatedWaitMs: this.#escalationWait(),
            heldBackForSpeed: false,
          },
          conflicts: ctx.conflicts,
          notices: proactive.forQuestion(this.db, {
            workspaceId: this.workspaceId,
            question,
            contextIds,
          }),
          context: ctx,
          latencyMs: Date.now() - t0,
        };
      }
    }

    // Step 2: the free answer. Always computed — it is the fallback if a model
    // is unavailable, and the baseline the escalation decision is made against.
    // tryRun, not run: with every provider removed there is no floor either,
    // and losing all intelligence must still leave a working context and a
    // truthful "nothing could answer this" rather than an exception.
    const floor = await this.router.tryRun(Capability.Answer, task, {
      workspaceId: this.workspaceId,
      contextIds,
      policy: { preferProviders: ['builtin'], denyProviders: remoteAnswerers(this.registry) },
    });

    const escalation = this.#shouldEscalate(floor?.result, ctx, opts);
    let run = floor;
    let escalated = false;

    // How long escalating would actually take on this machine, measured.
    const waitMs = this.#escalationWait();
    const maxWait = opts.maxWaitMs ?? this.router.policy.autoEscalateMaxMs ?? 8000;
    const tooSlowToWait = opts.escalate !== 'always' && waitMs !== null && waitMs > maxWait;

    if (escalation.escalate && !tooSlowToWait) {
      const better = await this.router.tryRun(Capability.Answer, task, {
        workspaceId: this.workspaceId,
        contextIds,
        policy: { denyProviders: ['builtin'] },
      });
      if (better) {
        run = better;
        escalated = true;
      }
    }

    objects.touch(this.db, contextIds);

    if (opts.cache !== false && run?.result) {
      answerCache.put(this.db, {
        workspaceId: this.workspaceId,
        key: cacheKey,
        question,
        contextIds,
        provider: run.provider,
        model: this.registry.get(run.provider)?.model,
        answer: run.result.answer ?? null,
        grounded: !!run.result.grounded,
        citations: run.result.citations ?? [],
        uncertainty: run.result.uncertainty ?? null,
      });
    }

    return {
      question,
      answer: run?.result?.answer ?? null,
      grounded: run?.result?.grounded ?? false,
      passages: run?.result?.passages ?? [],
      citations: run?.result?.citations ?? [],
      uncertainty: run?.result?.uncertainty ?? 'No answering capability was available.',
      method: run?.result?.method ?? null,
      provider: run?.provider ?? null,
      degraded: run?.degraded ?? true,
      cached: false,
      escalated,
      // Why the ladder stopped where it did, so the interface can offer
      // "get a better answer" honestly rather than guessing.
      ladder: {
        floorConfidence: floor?.result?.confidence ?? 0,
        threshold: escalation.threshold,
        reason: tooSlowToWait
          ? `${escalation.reason} — but a written answer takes about ${Math.round(waitMs / 1000)}s here`
          : escalation.reason,
        canEscalate: !escalated && hasBetterAnswerer(this.registry),
        // What asking a model would cost in time, so an interface can say
        // "about 45 seconds" on the button instead of spinning silently.
        estimatedWaitMs: waitMs,
        heldBackForSpeed: tooSlowToWait && escalation.escalate,
      },
      conflicts: ctx.conflicts,
      notices: proactive.forQuestion(this.db, {
        workspaceId: this.workspaceId,
        question,
        contextIds: ctx.items.map((i) => i.id),
      }),
      context: ctx,
      latencyMs: Date.now() - t0,
    };
  }

  /**
   * Everything Chitraq holds about one object: the knowledge, its history, its
   * relationships, its evidence, its provenance and any open conflicts.
   * @param {string} objectId
   */
  recall(objectId) {
    const object = objects.get(this.db, objectId);
    if (!object) return null;

    objects.touch(this.db, [objectId]);

    return {
      object,
      history: objects.history(this.db, objectId),
      provenance: objects.derivations(this.db, objectId),
      relations: relations.neighbours(this.db, objectId, { includeRetracted: false }),
      evidence: sources.forTarget(this.db, objectId),
      conflicts: gateway
        .conflicts(this.db, { workspaceId: this.workspaceId, status: 'open' })
        .filter((c) => c.a_id === objectId || c.b_id === objectId),
      supersedes: this.db
        .prepare('SELECT id, title, updated_at FROM object WHERE superseded_by = ?')
        .all(objectId)
        .map((r) => ({ ...r })),
    };
  }

  /**
   * The timeline: memory ordered by when things happened or were recorded.
   * @param {{limit?: number, since?: string, until?: string, kinds?: string[]}} [opts]
   */
  timeline(opts = {}) {
    return objects.list(this.db, {
      workspaceId: this.workspaceId,
      kinds: opts.kinds,
      states: ['active', 'archived', 'superseded'],
      occurredAfter: opts.since,
      occurredBefore: opts.until,
      orderBy: 'occurred',
      direction: 'desc',
      limit: opts.limit ?? 50,
    });
  }

  /**
   * The audit trail: what changed, when, and who or what changed it.
   * @param {{limit?: number, subjectId?: string, types?: string[], since?: string}} [opts]
   */
  history(opts = {}) {
    return events.list(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  // ============================================================== CONNECT

  /**
   * Assert a relationship. User origin by default, which means it outranks
   * anything a model has to say about the same pair.
   * @param {string} srcId
   * @param {string} type
   * @param {string} dstId
   * @param {{note?: string, origin?: string, confidence?: number}} [opts]
   */
  connect(srcId, type, dstId, opts = {}) {
    return relations.create(
      this.db,
      { workspaceId: this.workspaceId, srcId, type, dstId, origin: opts.origin ?? 'user', ...opts },
      this.actor
    );
  }

  /**
   * @param {string} relationId
   * @param {string} [reason]
   */
  disconnect(relationId, reason) {
    return relations.retract(this.db, relationId, this.actor, reason);
  }

  /**
   * Find what this object resembles, and propose links for anything strongly
   * similar. Proposals, not writes — the user decides what is genuinely related.
   * @param {string} objectId
   * @param {{limit?: number, propose?: boolean}} [opts]
   */
  async relate(objectId, opts = {}) {
    const object = objects.get(this.db, objectId);
    if (!object) throw new objects.NotFoundError(`No knowledge object ${objectId}`);

    const embedded = await this.#embed([`${object.title}\n${object.body}`]);
    const similar = similarTo(this.db, {
      workspaceId: this.workspaceId,
      objectId,
      vector: embedded?.vectors[0],
      model: embedded?.model,
      limit: opts.limit ?? 8,
      minScore: 0.4,
    });

    /** @type {any[]} */
    const proposals = [];
    if (opts.propose !== false) {
      for (const hit of similar) {
        const other = objects.get(this.db, hit.objectId);
        if (!other) continue;

        const run = await this.router.tryRun(
          Capability.ProposeRelations,
          { a: object, b: other, similarity: hit.score },
          { workspaceId: this.workspaceId, contextIds: [objectId, hit.objectId] }
        );

        for (const rel of run?.result?.relations ?? []) {
          if (rel.confidence < 0.3) continue;
          const { proposal } = gateway.propose(
            this.db,
            {
              workspaceId: this.workspaceId,
              runId: run?.run?.id,
              op: gateway.Op.CreateRelation,
              confidence: rel.confidence,
              rationale: rel.rationale,
              payload: { srcId: objectId, type: rel.type, dstId: hit.objectId, origin: 'ai' },
            },
            this.acceptPolicy,
            this.actor
          );
          proposals.push(proposal);
        }
      }
    }

    return { similar, proposals };
  }

  /**
   * Structure a newly captured object: keywords, entities, similar material,
   * relationship proposals and contradiction checks.
   *
   * Everything it produces is a proposal or an attribute suggestion. It cannot
   * corrupt what was captured.
   *
   * @param {string} objectId
   */
  async enrich(objectId) {
    const object = objects.get(this.db, objectId);
    if (!object) throw new objects.NotFoundError(`No knowledge object ${objectId}`);
    const text = `${object.title}\n${object.body}`.trim();

    const [kw, ents] = await Promise.all([
      this.router.tryRun(
        Capability.ExtractKeywords,
        { text, workspaceId: this.workspaceId, limit: 8 },
        { workspaceId: this.workspaceId, contextIds: [objectId] }
      ),
      this.router.tryRun(
        Capability.ExtractEntities,
        { text },
        { workspaceId: this.workspaceId, contextIds: [objectId] }
      ),
    ]);

    /** @type {any[]} */
    const proposals = [];

    const keywords = (kw?.result?.keywords ?? []).map((k) => k.term);
    // 0.6 admits multi-word proper names (0.65) and every structured
    // extraction, while leaving out bare single capitalised words (0.35),
    // which are as often a month or a mis-split sentence as a name.
    const found = (ents?.result?.entities ?? []).filter((e) => e.confidence >= 0.6);

    if (keywords.length || found.length) {
      const { proposal } = gateway.propose(
        this.db,
        {
          workspaceId: this.workspaceId,
          runId: kw?.run?.id,
          op: gateway.Op.SetAttributes,
          confidence: 0.6,
          rationale: 'Derived keywords and structured entities from the text.',
          payload: {
            objectId,
            attrs: {
              keywords,
              entities: found.map((e) => ({ text: e.text, type: e.type })),
            },
          },
        },
        this.acceptPolicy,
        this.actor
      );
      proposals.push(proposal);
    }

    // Resolve named entities into Entity objects and link the mentions.
    //
    // This writes directly rather than through the gateway, and the distinction
    // matters: it asserts no new knowledge. An Entity is a structural index
    // over text that already exists, marked `algorithm`-origin, and a wrong one
    // is inert — it adds a node nobody looks at. Compare a proposed *claim*,
    // which would assert something untrue if accepted. Different risk, so a
    // different rule.
    const mentions = entities.linkMentions(
      this.db,
      {
        workspaceId: this.workspaceId,
        objectId,
        entities: found,
        minConfidence: 0.6,
      },
      this.actor
    );

    const { similar, proposals: relationProposals } = await this.relate(objectId, { limit: 5 });
    proposals.push(...relationProposals);

    // Contradiction check against the closest material only: a contradiction
    // is only meaningful between statements about the same thing.
    /** @type {any[]} */
    const conflicts = [];
    for (const hit of similar.slice(0, 5)) {
      const other = objects.get(this.db, hit.objectId);
      if (!other) continue;

      const run = await this.router.tryRun(
        Capability.DetectConflict,
        { a: object, b: other },
        { workspaceId: this.workspaceId, contextIds: [objectId, hit.objectId] }
      );

      if (run?.result?.contradicts && run.result.confidence >= 0.4) {
        const conflict = gateway.recordConflict(this.db, {
          workspaceId: this.workspaceId,
          kind: 'contradiction',
          aId: objectId,
          bId: hit.objectId,
          detail: { reason: run.result.reason, ...(run.result.detail ?? {}) },
          detectedBy: run.provider,
          confidence: run.result.confidence,
        });
        conflicts.push(conflict);
      }
    }

    const notices = proactive.forObject(this.db, {
      workspaceId: this.workspaceId,
      objectId,
      similar,
    });

    return { keywords, entities: found, mentions, similar, proposals, conflicts, notices };
  }

  // ============================================================ ENTITIES

  /**
   * The people, organisations, projects and identifiers Chitraq has resolved
   * out of your notes, most-mentioned first.
   * @param {{entityType?: string, limit?: number}} [opts]
   */
  entities(opts = {}) {
    return entities.list(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  /**
   * One entity, with everything that mentions it.
   * @param {string} entityId
   */
  entity(entityId) {
    const object = objects.get(this.db, entityId);
    if (!object) return null;
    return {
      ...this.recall(entityId),
      mentionedIn: entities.mentionedIn(this.db, entityId),
    };
  }

  /**
   * Entities that look like duplicates of each other. Suggestions only —
   * merging is always an explicit decision.
   * @param {{minScore?: number, limit?: number}} [opts]
   */
  duplicateEntities(opts = {}) {
    return entities.duplicateCandidates(this.db, this.workspaceId, opts);
  }

  /**
   * @param {string} keepId
   * @param {string} mergeId
   * @param {string} [reason]
   */
  mergeEntities(keepId, mergeId, reason) {
    return entities.merge(this.db, { keepId, mergeId, reason }, this.actor);
  }

  /**
   * @param {string} entityId
   * @param {string} alias
   */
  addAlias(entityId, alias) {
    return entities.addAlias(this.db, entityId, alias, this.actor);
  }

  // ============================================================== REVIEW

  /**
   * Proposals awaiting a human decision.
   * @param {{status?: string, limit?: number}} [opts]
   */
  pending(opts = {}) {
    return gateway.list(this.db, {
      workspaceId: this.workspaceId,
      status: opts.status ?? 'pending',
      limit: opts.limit,
    });
  }

  /**
   * @param {string} proposalId
   * @param {string} [note]
   */
  async accept(proposalId, note) {
    const result = gateway.accept(this.db, proposalId, this.actor, note);
    if (result.applied.kind === 'object') {
      await this.#index(objects.get(this.db, result.applied.id));
    }
    return result;
  }

  /**
   * @param {string} proposalId
   * @param {string} [note]
   */
  decline(proposalId, note) {
    return gateway.reject(this.db, proposalId, this.actor, note);
  }

  /**
   * Confirm knowledge. This is the user correction signal that makes memory
   * improve over time.
   * @param {string} objectId
   * @param {string} [note]
   */
  confirm(objectId, note) {
    return objects.confirm(this.db, objectId, this.actor, note);
  }

  /**
   * Correct knowledge: record the new understanding as a new version, with the
   * reason, keeping the old one readable.
   * @param {string} objectId
   * @param {object} patch
   * @param {string} [reason]
   */
  async correct(objectId, patch, reason) {
    const updated = objects.update(this.db, objectId, patch, this.actor, {
      reason: reason ?? 'user correction',
      derivation: { method: 'user' },
    });

    events.emit(this.db, {
      workspaceId: this.workspaceId,
      type: events.EventType.UserCorrectionRecorded,
      subjectKind: 'object',
      subjectId: objectId,
      actor: this.actor,
      payload: { fields: Object.keys(patch), reason: reason ?? null },
    });

    await this.#index(updated);
    return updated;
  }

  /**
   * Replace one piece of knowledge with another, preserving both.
   * @param {string} oldId
   * @param {object} replacement
   * @param {string} [reason]
   */
  async supersede(oldId, replacement, reason) {
    const created = await this.remember({ ...replacement, enrich: false });
    objects.supersede(this.db, oldId, created.object.id, this.actor, reason);
    await this.#index(objects.get(this.db, oldId));
    return { old: objects.get(this.db, oldId), new: created.object };
  }

  /** @param {{status?: string, limit?: number}} [opts] */
  conflicts(opts = {}) {
    return gateway.conflicts(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  /**
   * @param {string} conflictId
   * @param {'resolved'|'dismissed'|'acknowledged'} status
   * @param {string} [resolution]
   */
  resolveConflict(conflictId, status, resolution) {
    return gateway.resolveConflict(this.db, conflictId, this.actor, status, resolution);
  }

  /**
   * @param {string} objectId
   * @param {string} [reason]
   */
  archive(objectId, reason) {
    const result = objects.archive(this.db, objectId, this.actor, reason);
    indexer.removeFromIndex(this.db, objectId);
    return result;
  }

  /**
   * @param {string} objectId
   * @param {string} [reason]
   */
  forget(objectId, reason) {
    const result = objects.remove(this.db, objectId, this.actor, reason);
    indexer.removeFromIndex(this.db, objectId);
    return result;
  }

  /**
   * Irreversible erasure. Requires an explicit reason, because it is the one
   * operation that destroys history.
   * @param {string} objectId
   * @param {string} reason
   */
  erase(objectId, reason) {
    if (!reason) throw new objects.ValidationError('Erasing memory requires a stated reason.');
    return objects.purge(this.db, objectId, this.actor, reason);
  }

  // ================================================================ ADMIN

  /** What this installation can currently do. */
  async capabilities() {
    return {
      providers: await this.registry.describe(),
      coverage: await this.registry.coverage(),
      policy: this.router.policy,
      acceptPolicy: this.acceptPolicy,
    };
  }

  /** @param {import('./intelligence/registry.js').Provider} provider */
  addProvider(provider) {
    this.registry.register(provider);
    return provider.id;
  }

  /** @param {{limit?: number, capability?: string, status?: string}} [opts] */
  intelligenceLog(opts = {}) {
    return runHistory(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  stats() {
    const base = indexer.stats(this.db, this.workspaceId);
    const one = (sql, ...args) => Number(this.db.prepare(sql).get(...args)?.n ?? 0);
    return {
      ...base,
      workspaceId: this.workspaceId,
      versions: one('SELECT COUNT(*) n FROM object_version ov JOIN object o ON o.id = ov.object_id WHERE o.workspace_id = ?', this.workspaceId),
      events: one('SELECT COUNT(*) n FROM event WHERE workspace_id = ?', this.workspaceId),
      pendingProposals: one(`SELECT COUNT(*) n FROM proposal WHERE workspace_id = ? AND status = 'pending'`, this.workspaceId),
      openConflicts: one(`SELECT COUNT(*) n FROM conflict WHERE workspace_id = ? AND status = 'open'`, this.workspaceId),
      byKind: this.db
        .prepare(`SELECT kind, COUNT(*) AS n FROM object WHERE workspace_id = ? AND state = 'active' GROUP BY kind ORDER BY n DESC`)
        .all(this.workspaceId)
        .map((r) => ({ ...r })),
      byOrigin: this.db
        .prepare(`SELECT origin, COUNT(*) AS n FROM object WHERE workspace_id = ? AND state = 'active' GROUP BY origin`)
        .all(this.workspaceId)
        .map((r) => ({ ...r })),
    };
  }

  /**
   * Rebuild every derived index from the objects.
   * @param {(n: number, total: number) => void} [onProgress]
   */
  async reindex(onProgress) {
    const result = await indexer.rebuild(this.db, this.workspaceId, {
      embed: (texts) => this.#embedOrThrow(texts),
      onProgress,
    });
    // Derived state rebuilt together: a stale ANN index over freshly rebuilt
    // vectors would quietly return neighbours that no longer exist.
    this.#annCache.clear();
    salience.refresh(this.db, this.workspaceId);
    const vectorIndex = this.buildVectorIndex();
    return { ...result, vectorIndex };
  }

  /**
   * Export everything as portable JSON.
   * INVARIANT: memory the user cannot take with them is not theirs.
   * @param {{includeBlobs?: boolean}} [opts]
   */
  export(opts = {}) {
    return transfer.exportWorkspace(this.db, this.workspaceId, opts);
  }

  /**
   * Import a workspace export, into this workspace.
   *
   * Ids are preserved so provenance and links survive the round trip. Anything
   * already here is left alone; anything that would dangle is dropped with a
   * warning rather than written broken.
   *
   * @param {any} payload
   * @param {{onConflict?: 'skip'|'fail', dryRun?: boolean, reindex?: boolean}} [opts]
   */
  async import(payload, opts = {}) {
    const result = transfer.importWorkspace(this.db, payload, {
      workspaceId: this.workspaceId,
      onConflict: opts.onConflict,
      dryRun: opts.dryRun,
      actor: this.actor,
    });

    // Imported objects arrive with no chunks and no vectors — the index is
    // derived state and is not carried in the export.
    if (!result.dryRun && opts.reindex !== false && (result.imported.objects ?? 0) > 0) {
      await this.reindex();
    }
    return result;
  }


  /**
   * Accept or decline many proposals at once, by id or by filter.
   * @param {{action: 'accept'|'reject', ids?: string[], minConfidence?: number, op?: string, runId?: string, limit?: number, note?: string}} input
   */
  async reviewAll(input) {
    const result = gateway.bulk(this.db, { workspaceId: this.workspaceId, ...input }, this.actor);
    for (const applied of result.succeeded) {
      if (applied?.kind === 'object') await this.#index(objects.get(this.db, applied.id));
    }
    return result;
  }

  /**
   * Retire pending proposals nobody has looked at in months.
   * Expiring is not rejecting: only a rejection is a correction signal.
   * @param {{olderThanDays?: number}} [opts]
   */
  expireProposals(opts = {}) {
    return gateway.expireStale(this.db, { workspaceId: this.workspaceId, ...opts }, this.actor);
  }

  // =========================================================== PROACTIVE

  /**
   * Things worth telling the user without being asked: what this overlaps
   * with, what it disagrees with, what they already rejected.
   *
   * Read-only, thresholded, and always pointing at objects the user can open.
   * @param {string} objectId
   * @param {{minStrength?: number}} [opts]
   */
  async noticesFor(objectId, opts = {}) {
    const object = objects.get(this.db, objectId);
    if (!object) return [];

    const embedded = await this.#embed([`${object.title}\n${object.body}`]);
    const similar = similarTo(this.db, {
      workspaceId: this.workspaceId,
      objectId,
      vector: embedded?.vectors[0],
      model: embedded?.model,
      limit: 6,
      minScore: 0.4,
    });

    return proactive.forObject(this.db, {
      workspaceId: this.workspaceId,
      objectId,
      similar,
      minStrength: opts.minStrength,
    });
  }

  /**
   * Notices about the workspace as a whole: unresolved disagreements, a review
   * backlog, figures nobody has checked in a year, unconnected material.
   * @param {{staleDays?: number, limit?: number}} [opts]
   */
  notices(opts = {}) {
    return proactive.forWorkspace(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  // ============================================================== BUDGET

  /** What intelligence has cost, by provider, capability and day. */
  costs(opts = {}) {
    return budget.report(this.db, this.workspaceId, opts);
  }

  /**
   * Set spend ceilings. Running out degrades intelligence, never memory:
   * paid providers stop being offered and the free ones answer instead.
   * @param {import('./intelligence/budget.js').Budget} limits
   */
  setBudget(limits) {
    return this.router.setPolicy({ budget: { ...this.router.policy.budget, ...limits } });
  }

  /** @param {number} costMicros */
  canAfford(costMicros) {
    return budget.check(this.db, this.workspaceId, this.router.policy.budget ?? {}, costMicros);
  }


  // ================================================================ AUTH

  /**
   * Authentication is off until an account exists. A local single-user install
   * never needs one; a shared or remote-reachable one does.
   */
  get authEnabled() {
    return auth.isEnabled(this.db);
  }

  /**
   * Give a principal a username and password. With no principalId, this
   * secures the owner of the current workspace.
   * @param {{username: string, password: string, principalId?: string}} input
   */
  createAccount(input) {
    return auth.setPassword(this.db, {
      principalId: input.principalId ?? this.principal.id,
      username: input.username,
      password: input.password,
    });
  }

  /** @param {{username: string, password: string, userAgent?: string}} input */
  login(input) {
    return auth.login(this.db, input);
  }

  /** @param {string} token */
  logout(token) {
    return auth.logout(this.db, token);
  }

  /** @param {string|null|undefined} token */
  authenticate(token) {
    return auth.authenticate(this.db, token);
  }

  /** @param {string} [principalId] */
  sessions(principalId) {
    return auth.sessions(this.db, principalId ?? this.principal.id);
  }

  accounts() {
    return auth.accounts(this.db);
  }

  // ================================================================ SYNC

  /**
   * Everything that changed since a peer last pulled, ready to hand over.
   * @param {{since?: string|null, peerId?: string, limit?: number}} [opts]
   */
  changesSince(opts = {}) {
    const since =
      opts.since !== undefined
        ? opts.since
        : opts.peerId
          ? sync.cursorFor(this.db, {
              workspaceId: this.workspaceId,
              peerId: opts.peerId,
              direction: 'push',
            })
          : null;

    const payload = sync.changesSince(this.db, {
      workspaceId: this.workspaceId,
      since,
      limit: opts.limit,
    });
    if (opts.peerId) {
      sync.recordPush(this.db, {
        workspaceId: this.workspaceId,
        peerId: opts.peerId,
        cursor: payload.cursor,
      });
    }
    return payload;
  }

  /**
   * Merge a peer's changes.
   *
   * Where both sides edited the same object independently, local state is kept
   * and a conflict is raised — last-writer-wins would destroy one of the two
   * edits with nobody the wiser.
   *
   * @param {any} payload
   * @param {{peerId?: string, dryRun?: boolean, reindex?: boolean}} [opts]
   */
  async applyChanges(payload, opts = {}) {
    const result = sync.apply(this.db, payload, {
      workspaceId: this.workspaceId,
      peerId: opts.peerId,
      dryRun: opts.dryRun,
      actor: this.actor,
    });

    if (!opts.dryRun && opts.reindex !== false) {
      const changed = (result.applied.objects ?? 0) + (result.applied.versions ?? 0);
      if (changed > 0) await this.reindex();
    }
    return result;
  }

  /**
   * Exchange changes with a peer in one call, given a transport function.
   * @param {object} opts
   * @param {string} opts.peerId
   * @param {(payload: any) => Promise<any>} opts.exchange  send ours, get theirs
   */
  async syncWith(opts) {
    const outgoing = this.changesSince({ peerId: opts.peerId });
    const incoming = await opts.exchange(outgoing);
    const result = incoming ? await this.applyChanges(incoming, { peerId: opts.peerId }) : null;
    return { sent: outgoing.objects.length + outgoing.relations.length, received: result };
  }

  // =========================================================== CONCEPTS

  /**
   * Ideas that keep recurring across your knowledge.
   *
   * Read-only and computed on demand. Nothing is written, because a concept is
   * the least certain entity kind there is and creating them automatically
   * would fill the graph with confident noise.
   *
   * @param {{minDocuments?: number, limit?: number}} [opts]
   */
  concepts(opts = {}) {
    return concepts.candidates(this.db, { workspaceId: this.workspaceId, ...opts });
  }

  /**
   * Turn recurring phrases into proposals a human can accept or decline.
   *
   * This is the only route from a phrase to an entity, and it runs through the
   * same gateway everything else does. Suggesting is cheap; a wrong concept in
   * the graph has to be found and merged away by hand.
   *
   * @param {{minDocuments?: number, limit?: number}} [opts]
   */
  proposeConcepts(opts = {}) {
    const found = this.concepts(opts);
    /** @type {any[]} */
    const proposals = [];

    for (const candidate of found) {
      // Already suggested and already declined stays declined. Re-proposing
      // something a person said no to is how a review queue becomes noise.
      if (this.#conceptAlreadyKnown(candidate.phrase)) continue;

      const { proposal } = gateway.propose(
        this.db,
        {
          workspaceId: this.workspaceId,
          op: gateway.Op.CreateObject,
          confidence: candidate.confidence,
          rationale: candidate.because,
          payload: {
            title: candidate.phrase,
            body: '',
            kind: 'entity',
            epistemic: 'observation',
            origin: 'algorithm',
            attrs: {
              entityType: entities.EntityType.Concept,
              canonicalName: entities.canonicalise(candidate.phrase),
              aliases: [],
              documents: candidate.documents,
              occurrences: candidate.occurrences,
            },
          },
        },
        // Never applied automatically, whatever the accept policy says
        // elsewhere. This is the one place where the evidence is a statistic.
        { autoAccept: {} },
        this.actor
      );
      proposals.push(proposal);
    }

    return { found: found.length, proposals };
  }

  /**
   * Has this phrase already been made an entity, or already been declined?
   * @param {string} phrase
   */
  #conceptAlreadyKnown(phrase) {
    const canonical = entities.canonicalise(phrase);

    const existing = this.db
      .prepare(
        `SELECT 1 FROM object
         WHERE workspace_id = ? AND kind = 'entity' AND lower(title) = ? AND state != 'deleted'`
      )
      .get(this.workspaceId, phrase.toLowerCase());
    if (existing) return true;

    const declined = this.db
      .prepare(
        `SELECT 1 FROM proposal
         WHERE workspace_id = ? AND status IN ('rejected', 'pending')
           AND payload LIKE ?`
      )
      .get(this.workspaceId, `%"canonicalName":"${canonical}"%`);
    return Boolean(declined);
  }

  /** Peers this workspace has exchanged changes with. */
  peers() {
    return sync.peers(this.db, this.workspaceId);
  }

  /**
   * Sync with another Chitraq over HTTP.
   *
   * This is the one operation that sends your memory off this machine, so it is
   * explicit in every direction: you name the peer, you choose whether to push,
   * pull or both, and the result says exactly what left and what arrived.
   * Nothing here runs on a timer.
   *
   * The peer is identified by its workspace id rather than its address, so a
   * laptop reached at two different URLs is still one peer with one cursor.
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {string} [opts.token]
   * @param {'push'|'pull'|'both'} [opts.direction]  default both
   * @param {boolean} [opts.dryRun]   nothing is written on either side
   * @param {number} [opts.limit]    rows per batch; a big workspace takes several
   * @param {number} [opts.timeoutMs]
   * @param {typeof fetch} [opts.fetch]
   * @returns {Promise<any>}
   */
  async syncOverHttp(url, opts = {}) {
    const peer = httpPeer(url, {
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      fetch: opts.fetch,
    });
    const identity = await peer.identify();
    const peerId = identity.workspaceId;

    if (peerId === this.workspaceId) {
      // Almost always a mistyped port pointing at this very server. Syncing a
      // workspace with itself is not harmful, but it is never what was meant.
      throw new objects.ValidationError(
        `${peer.url} is this same workspace (${peerId}). There is nothing to exchange.`
      );
    }

    const direction = opts.direction ?? 'both';
    /** @type {any} */
    const report = { peer: { id: peerId, url: peer.url }, direction, dryRun: !!opts.dryRun };
    /** @type {any} */
    let justSent = null;

    if (direction !== 'pull') {
      // Built against our push cursor for this peer, so a second sync with
      // nothing new sends nothing. `changesSince` advances that cursor, which
      // is wrong to do for a dry run.
      const outgoing = opts.dryRun
        ? sync.changesSince(this.db, {
            workspaceId: this.workspaceId,
            since: sync.cursorFor(this.db, { workspaceId: this.workspaceId, peerId, direction: 'push' }),
            limit: opts.limit,
          })
        : this.changesSince({ peerId, limit: opts.limit });

      const accepted = await peer.push(outgoing, { peerId: this.workspaceId, dryRun: opts.dryRun });
      justSent = outgoing;
      report.pushed = {
        objects: outgoing.objects?.length ?? 0,
        relations: outgoing.relations?.length ?? 0,
        versions: outgoing.versions?.length ?? 0,
        sources: outgoing.sources?.length ?? 0,
        accepted: accepted?.applied ?? null,
        conflicts: accepted?.conflicts?.length ?? 0,
        complete: outgoing.complete !== false,
      };
    }

    if (direction !== 'push') {
      const raw = await peer.pull({ peerId: this.workspaceId, limit: opts.limit });

      // On first contact the peer has no cursor for us, so it sends everything
      // it holds — which now includes what we pushed a moment ago. Dropping our
      // own echo makes the merge cheaper and, more importantly, makes "received
      // 1 object" mean one object rather than one plus a reflection.
      const incoming = justSent ? withoutEcho(raw, justSent) : raw;

      const result = incoming
        ? await this.applyChanges(incoming, { peerId, dryRun: opts.dryRun })
        : null;
      report.pulled = {
        objects: incoming?.objects?.length ?? 0,
        relations: incoming?.relations?.length ?? 0,
        echoed: raw ? (raw.objects?.length ?? 0) - (incoming.objects?.length ?? 0) : 0,
        applied: result?.applied ?? null,
        skipped: result?.skipped ?? null,
        conflicts: result?.conflicts ?? [],
        complete: raw ? raw.complete !== false : true,
      };

      // After a complete two-way exchange both sides hold the same set: we sent
      // everything past our mark, they sent everything past theirs. So our push
      // mark can jump past what we just took in, and their own knowledge does
      // not come back to them on the next sync.
      //
      // Only for a full exchange. After a push-only or a pull-only that
      // reasoning does not hold, and moving the mark would skip real changes.
      //
      // Not when our own payload was truncated. Then there are changes behind
      // our mark that the peer has never seen, and jumping past them would lose
      // them quietly — the one outcome sync must never produce.
      if (!opts.dryRun && direction === 'both' && justSent && justSent.complete !== false) {
        const furthest = [justSent.cursor, raw?.cursor].filter(Boolean).sort().pop();
        if (furthest) {
          sync.recordPush(this.db, { workspaceId: this.workspaceId, peerId, cursor: furthest });
        }
      }
    }

    // Either side hitting its row limit means this exchange moved a batch, not
    // everything. Saying so is the difference between "synced" and "synced as
    // far as one call goes".
    report.more = report.pushed?.complete === false || report.pulled?.complete === false;

    return report;
  }


  /**
   * Decide whether the free answer is good enough.
   *
   * Three things force a model call:
   *   - the extractive answer failed outright (nothing quotable matched)
   *   - it matched weakly, so quoting would produce a plausible non-answer
   *   - the question asks for synthesis — comparing, summarising, counting —
   *     which quoting cannot do however well the passages match
   *
   * Everything else is a lookup, and a lookup is what quoting is *for*.
   *
   * @param {any} result
   * @param {any} ctx
   * @param {{escalate?: 'auto'|'never'|'always', minConfidence?: number}} opts
   * @returns {{escalate: boolean, reason: string, threshold: number}}
   */
  #shouldEscalate(result, ctx, opts = {}) {
    const mode = opts.escalate ?? 'auto';
    const threshold = opts.minConfidence ?? 0.55;

    if (mode === 'never') {
      return { escalate: false, reason: 'escalation switched off', threshold };
    }
    if (mode === 'always') {
      return { escalate: true, reason: 'escalation requested', threshold };
    }
    if (!ctx.items.length) {
      // Nothing retrieved. A model cannot invent what memory does not hold, and
      // asking it to is exactly how a memory engine starts making things up.
      return { escalate: false, reason: 'memory holds nothing about this', threshold };
    }
    if (!result?.grounded) {
      return { escalate: true, reason: 'nothing in the context could be quoted directly', threshold };
    }
    if (SYNTHESIS.test(ctx.intent?.raw ?? '')) {
      return {
        escalate: true,
        reason: 'the question asks for synthesis, which quoting cannot do',
        threshold,
      };
    }
    if ((result.confidence ?? 0) < threshold) {
      return {
        escalate: true,
        reason: `the quoted answer only covers part of the question (${result.confidence ?? 0})`,
        threshold,
      };
    }
    return {
      escalate: false,
      reason: 'no model was needed',
      threshold,
    };
  }


  /**
   * Measured time to get an answer from the best non-floor provider.
   *
   * Used to decide whether to escalate automatically or to offer it. On a
   * machine with a GPU this is a couple of seconds and escalation stays
   * automatic; on a laptop running a 3B model on CPU it is closer to a minute,
   * and silently making the user wait that long is worse than handing them a
   * good quoted answer and a button.
   *
   * @returns {number|null} null when there is no history to judge by
   */
  #escalationWait() {
    const candidates = this.registry
      .supporting(Capability.Answer)
      .filter((p) => !p.deterministic);

    /** @type {number[]} */
    const measured = [];
    for (const p of candidates) {
      const ms = measuredLatency(this.db, {
        workspaceId: this.workspaceId,
        capability: Capability.Answer,
        provider: p.id,
      });
      if (ms !== null) measured.push(ms);
    }
    return measured.length ? Math.min(...measured) : null;
  }

  /**
   * Ask again, forcing the best available model.
   * This is what an interface's "get a better answer" button calls.
   * @param {string} question
   * @param {object} [opts]
   */
  askBetter(question, opts = {}) {
    return this.ask(question, { ...opts, escalate: 'always', cache: opts.cache });
  }

  /** How many model calls the answer cache has avoided. */
  cacheStats() {
    return answerCache.stats(this.db, this.workspaceId);
  }

  /** @param {{olderThanDays?: number}} [opts] */
  clearAnswerCache(opts = {}) {
    return answerCache.clear(this.db, this.workspaceId, opts);
  }

  // ============================================================ internals

  /**
   * Reorder the retrieved pool with the rerank capability.
   *
   * Retrieval decides *what is plausible*; reranking decides *what is best*,
   * with the whole passage in view rather than a bag of terms. The scores are
   * blended rather than replaced: fusion already encodes agreement between
   * several independent signals, and discarding that for one reranker's
   * opinion loses information.
   *
   * Skipped for one-word and filter-only queries, where there is nothing for a
   * reranker to weigh, and absorbed entirely if the capability is unavailable.
   *
   * @param {string} q
   * @param {any} intent
   * @param {{results: any[], signals: string[]}} result
   */
  async #rerank(q, intent, result) {
    if (result.results.length < 3 || intent.terms.length < 2) return;

    const run = await this.router.tryRun(
      Capability.Rerank,
      {
        query: q,
        candidates: result.results.map((r) => ({
          id: r.id,
          text: `${r.title}\n${r.excerpt ?? ''}`,
        })),
      },
      { workspaceId: this.workspaceId, contextIds: result.results.map((r) => r.id) }
    );

    const ranking = run?.result?.ranking;
    if (!ranking?.length) return;

    const byId = new Map(ranking.map((r) => [r.id, r.score ?? 0]));
    const topFusion = Math.max(...result.results.map((r) => r.score), 1e-9);

    for (const hit of result.results) {
      const rerankScore = byId.get(hit.id) ?? 0;
      // Fusion scores are normalised into the reranker's 0..1 range before
      // blending. Without that, the RRF scale (~0.03) would make the reranker
      // dominant by accident rather than by design.
      const blended = 0.6 * (hit.score / topFusion) + 0.4 * rerankScore;
      hit.why.rerank = { score: round4(rerankScore), provider: run.provider };
      hit.score = round4(blended * topFusion);
    }

    result.results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    result.signals.push('reranked');
  }

  /**
   * The approximate vector index for a model, built on demand and cached.
   *
   * Returns undefined below the size where approximation pays for itself, so
   * small workspaces always get exact results. See retrieval/ann.js.
   * @param {string} model
   */
  #annIndexFor(model) {
    // Only ever returns an index that already exists. Building one takes
    // seconds at scale, and a search is the last place to discover that — so
    // building happens at reindex, and until then search is exact and correct.
    return this.#annCache.get(model)?.index;
  }

  /**
   * Fit the approximate vector index for this workspace.
   *
   * Called during reindex and available on its own. Below the measured
   * threshold it deliberately does nothing: an index that costs seconds to
   * build to save a millisecond per query is not worth having.
   *
   * @param {{force?: boolean}} [opts]
   */
  buildVectorIndex(opts = {}) {
    const models = this.db
      .prepare('SELECT model, COUNT(*) AS n FROM embedding WHERE workspace_id = ? GROUP BY model')
      .all(this.workspaceId);

    const built = [];
    for (const { model, n } of models) {
      if (!opts.force && !ann.shouldUse(Number(n))) continue;
      const index = ann.build(this.db, { workspaceId: this.workspaceId, model: String(model) });
      if (index) {
        this.#annCache.set(String(model), { index });
        built.push({ model, vectors: index.size, lists: index.centroids.length, ms: index.builtMs });
      }
    }
    return { built, skipped: models.length - built.length };
  }

  /**
   * Measure the approximate index against the exact scan, on real vectors.
   * @param {{queries?: string[], probes?: number}} [opts]
   */
  async benchmarkVectorIndex(opts = {}) {
    const model = this.db
      .prepare('SELECT model FROM embedding WHERE workspace_id = ? LIMIT 1')
      .get(this.workspaceId)?.model;
    if (!model) return { usable: false, reason: 'no vectors in this workspace' };

    const texts = opts.queries?.length
      ? opts.queries
      : this.db
          .prepare('SELECT text FROM chunk WHERE workspace_id = ? ORDER BY id LIMIT 20')
          .all(this.workspaceId)
          .map((r) => String(r.text).slice(0, 200));
    if (!texts.length) return { usable: false, reason: 'no text to build queries from' };

    const embedded = await this.#embed(texts);
    if (!embedded) return { usable: false, reason: 'no embedding capability' };

    return ann.benchmark(this.db, {
      workspaceId: this.workspaceId,
      model: String(model),
      queries: embedded.vectors,
      probes: opts.probes,
    });
  }

  /**
   * Recompute stored salience, which browse and timeline sort on.
   * Ranking computes salience live, so a stale column cannot make search wrong.
   */
  refreshSalience() {
    return salience.refresh(this.db, this.workspaceId);
  }

  /**
   * @param {any} object
   */
  async #index(object) {
    if (!object) return null;
    const result = await indexer.indexObject(this.db, object, {
      embed: (texts) => this.#embedOrThrow(texts),
    });

    // Keep any live approximate index current. Assignment is O(k·dim) per
    // vector, so this is imperceptible — and skipping it would quietly make
    // new captures unfindable by semantic search until the next reindex.
    for (const [model, entry] of this.#annCache) {
      const rows = this.db
        .prepare('SELECT chunk_id, object_id, vec, dim FROM embedding WHERE object_id = ? AND model = ?')
        .all(object.id, model);
      for (const row of rows) {
        ann.add(entry.index, {
          chunkId: String(row.chunk_id),
          objectId: String(row.object_id),
          vec: indexer.decodeVector(row.vec),
        });
      }
      if (ann.isStale(entry.index)) entry.stale = true;
    }

    return result;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<{model: string, vectors: number[][]}|null>}
   */
  async #embed(texts) {
    const run = await this.router.tryRun(Capability.EmbedText, { texts }, { workspaceId: this.workspaceId });
    return run?.result ?? null;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<{model: string, vectors: number[][]}>}
   */
  async #embedOrThrow(texts) {
    const result = await this.#embed(texts);
    if (!result) throw new Error('No embedding capability is available.');
    return result;
  }
}


/**
 * Questions that quoting cannot answer however well the passages match:
 * they need several pieces combined, contrasted or counted.
 */
const SYNTHESIS =
  /\b(summari[sz]e|summary|compare|contrast|difference between|overall|in total|how many|how much total|list all|what are all|trend|pattern|across all|timeline of|walk me through|explain why|pros and cons)\b/i;

/**
 * Is there a better answerer we could actually reach?
 *
 * Availability matters, not just registration. Ollama is registered on every
 * install whether or not it is running, and offering "ask a model instead" when
 * the model is not there produces a button that fails — worse than no button.
 *
 * Health is read from the registry's cache rather than probed, because this
 * runs inside a response. A provider we have never probed is offered
 * optimistically; one we know is down is not.
 *
 * @param {import('./intelligence/registry.js').Registry} registry
 */
function hasBetterAnswerer(registry) {
  return registry
    .supporting(Capability.Answer)
    .some((p) => !p.deterministic && registry.healthCache.get(p.id)?.ok !== false);
}

/**
 * Everything except the floor, for pinning step 2 of the ladder to it.
 * @param {import('./intelligence/registry.js').Registry} registry
 */
function remoteAnswerers(registry) {
  return registry.supporting(Capability.Answer).filter((p) => p.id !== 'builtin').map((p) => p.id);
}

/**
 * An object's content hash, for the cache key.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} objectId
 */
function contentHashOf(db, objectId) {
  return String(db.prepare('SELECT content_hash FROM object WHERE id = ?').get(objectId)?.content_hash ?? '');
}

/** @param {number} n */
function round4(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** @param {string} text */

/**
 * How much doubt a machine reading adds.
 *
 * Not tuned — chosen. The point is not the exact number, it is that a claim
 * standing on a transcription cannot be as trustworthy as the same claim
 * standing on text somebody typed, and the system should never present them as
 * equal.
 */
const READING_DISCOUNT = 0.75;

/**
 * Remove from an incoming payload anything identical to what we just sent.
 *
 * Only exact matches are dropped — same row, same content hash, same version.
 * A row that came back *changed* is a genuine update from the peer and stays,
 * which is what keeps this an optimisation rather than a merge rule.
 *
 * @param {any} incoming
 * @param {any} sent
 */
function withoutEcho(incoming, sent) {
  if (!incoming) return incoming;

  const objectKeys = new Set((sent.objects ?? []).map((o) => `${o.id}:${o.content_hash}:${o.head_version}`));
  const relationKeys = new Set((sent.relations ?? []).map((r) => `${r.id}:${r.head_version}`));
  const versionKeys = new Set((sent.versions ?? []).map((v) => `${v.object_id}:${v.version}`));
  const sourceKeys = new Set((sent.sources ?? []).map((x) => String(x.id)));

  return {
    ...incoming,
    objects: (incoming.objects ?? []).filter(
      (o) => !objectKeys.has(`${o.id}:${o.content_hash}:${o.head_version}`)
    ),
    relations: (incoming.relations ?? []).filter((r) => !relationKeys.has(`${r.id}:${r.head_version}`)),
    versions: (incoming.versions ?? []).filter((v) => !versionKeys.has(`${v.object_id}:${v.version}`)),
    sources: (incoming.sources ?? []).filter((x) => !sourceKeys.has(String(x.id))),
  };
}

/**
 * Roughly how much text a file yielded. Shown when extraction is off, where
 * "0 proposed" would otherwise read like the file was empty.
 *
 * @param {string} text
 */
function words(text) {
  return (text.match(/\S+/g) ?? []).length;
}

function truncateTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}…`;
}

export {
  DEFAULT_POLICY, estimateTokens, gateway, objects, relations, sources,
  events, indexer, context, entities, transfer, proactive, budget, ann, salience, auth, sync,
  answerCache,
};
