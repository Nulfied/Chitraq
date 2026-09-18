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
import * as relations from './core/relations.js';
import * as sources from './core/sources.js';
import * as workspaceStore from './core/workspace.js';
import * as events from './core/events.js';
import { Registry, Capability } from './intelligence/registry.js';
import { Router, DEFAULT_POLICY, runHistory } from './intelligence/router.js';
import { deterministicProvider, EMBED_MODEL } from './intelligence/providers/deterministic.js';
import * as gateway from './intelligence/gateway.js';
import * as indexer from './retrieval/indexer.js';
import { search as runSearch, similarTo } from './retrieval/search.js';
import { parse as parseQuery } from './retrieval/query.js';
import * as context from './context/builder.js';
import { parseSource } from './capture/parse.js';
import { estimateTokens } from './core/text.js';

export { Capability } from './intelligence/registry.js';
export { Kind, Origin, Epistemic, State } from './core/objects.js';
export { RelType } from './core/relations.js';
export { Op } from './intelligence/gateway.js';

export class Chitraq {
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

    const result = runSearch(this.db, {
      workspaceId: this.workspaceId,
      intent,
      queryVector,
      vectorModel,
      limit: opts.limit ?? 20,
      anchorId: opts.anchorId,
      includeArchived: opts.includeArchived,
    });

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
        latencyMs: Date.now() - t0,
      };
    }

    const run = await this.router.tryRun(
      Capability.Answer,
      {
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
      },
      { workspaceId: this.workspaceId, contextIds: ctx.items.map((i) => i.id) }
    );

    objects.touch(this.db, ctx.items.map((i) => i.id));

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
      conflicts: ctx.conflicts,
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

    return { keywords, entities: found, mentions, similar, proposals, conflicts };
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
    return indexer.rebuild(this.db, this.workspaceId, {
      embed: (texts) => this.#embedOrThrow(texts),
      onProgress,
    });
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

  // ============================================================ internals

  /**
   * @param {any} object
   */
  async #index(object) {
    if (!object) return null;
    return indexer.indexObject(this.db, object, {
      embed: (texts) => this.#embedOrThrow(texts),
    });
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

/** @param {string} text */
function truncateTitle(text) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}…`;
}

export {
  DEFAULT_POLICY, estimateTokens, gateway, objects, relations, sources,
  events, indexer, context, entities, transfer,
};
