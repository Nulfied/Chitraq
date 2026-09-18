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

import { open, tx } from './core/db.js';
import { now } from './core/ids.js';
import * as objects from './core/objects.js';
import * as entities from './core/entities.js';
import * as transfer from './core/transfer.js';
import * as auth from './core/auth.js';
import * as sync from './core/sync.js';
import * as relations from './core/relations.js';
import * as sources from './core/sources.js';
import * as workspaceStore from './core/workspace.js';
import * as events from './core/events.js';
import { Registry, Capability } from './intelligence/registry.js';
import { Router, DEFAULT_POLICY, runHistory, measuredLatency } from './intelligence/router.js';
import { deterministicProvider, EMBED_MODEL } from './intelligence/providers/deterministic.js';
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
   */
  constructor(opts = {}) {
    this.db = open(opts.path ?? ':memory:');

    this.registry = new Registry();
    // The deterministic provider is registered first and is never removed.
    // It is the floor the whole system stands on.
    this.registry.register(deterministicProvider(this.db));
    for (const p of opts.providers ?? []) this.registry.register(p);

    this.router = new Router({ registry: this.registry, db: this.db, policy: opts.policy });
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

    const { source, deduplicated } = sources.capture(
      this.db,
      {
        workspaceId: this.workspaceId,
        uri: input.uri,
        mediaType: parsed.mediaType,
        title: input.title ?? parsed.title ?? input.filename ?? null,
        text: parsed.text,
        blob: input.keepBlob ? input.bytes : undefined,
        meta: { ...parsed.meta, filename: input.filename ?? null },
        origin: 'source',
      },
      this.actor
    );

    if (deduplicated) {
      return { source, parsed, proposals: [], accepted: [], deduplicated: true };
    }
    if (input.extract === false || !parsed.text.trim()) {
      return { source, parsed, proposals: [], accepted: [], deduplicated: false };
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
          confidence: claim.confidence,
          rationale: `Extracted from "${source.title ?? source.uri ?? 'captured source'}"`,
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

    return { source, parsed, proposals, accepted, deduplicated: false };
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

  /** Peers this workspace has exchanged changes with. */
  peers() {
    return sync.peers(this.db, this.workspaceId);
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
function truncateTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}…`;
}

export {
  DEFAULT_POLICY, estimateTokens, gateway, objects, relations, sources,
  events, indexer, context, entities, transfer, proactive, budget, ann, salience, auth, sync,
  answerCache,
};
