/**
 * The capability registry.
 *
 * INVARIANT 26/27: Chitraq routes to *capabilities*, not to models. "I need
 * text embedded" is a durable statement about the task; "call model X" is a
 * statement about this month's vendor landscape. Providers register against
 * capabilities and are ranked, swapped and removed without the memory engine
 * knowing or caring which one answered.
 *
 * A capability always has at least one deterministic, local, free provider, so
 * the system has somewhere to fall back to when everything else is gone.
 */

/**
 * The capability vocabulary. Each entry describes a task shape, not a model.
 */
export const Capability = Object.freeze({
  /** text[] -> vectors. Powers semantic retrieval. */
  EmbedText: 'embed.text',
  /** text -> salient terms. Powers tagging and similarity. */
  ExtractKeywords: 'extract.keywords',
  /** text -> candidate entities (people, orgs, dates, ids). */
  ExtractEntities: 'extract.entities',
  /** text -> candidate Knowledge Objects. The heart of ingestion. */
  ExtractClaims: 'extract.claims',
  /** text -> shorter text. */
  Summarize: 'summarize',
  /** query string -> structured intent. */
  InterpretQuery: 'interpret.query',
  /** question + context -> grounded answer. */
  Answer: 'answer',
  /** object pair -> proposed relationship. */
  ProposeRelations: 'relate.propose',
  /** object pair -> contradiction assessment. */
  DetectConflict: 'detect.conflict',
  /** text -> object kind. */
  ClassifyKind: 'classify.kind',
  /** query + candidates -> reordered candidates. */
  Rerank: 'rerank',

  // Slots for content Chitraq can capture but not yet read. Declared here so
  // the registry can report honestly that nothing serves them, and so adding a
  // provider later needs no change anywhere else.
  /** image bytes -> text. */
  OcrImage: 'ocr.image',
  /** document bytes (scanned PDF) -> text. */
  OcrDocument: 'ocr.document',
  /** audio bytes -> transcript. */
  Transcribe: 'speech.transcribe',
  /** image bytes + question -> description. */
  DescribeImage: 'vision.describe',
});

/**
 * @typedef {object} ProviderCapability
 * @property {number} quality       0..1, honest self-assessment used for ranking
 * @property {number} latencyMs     typical, for routing decisions
 * @property {number} [costMicros]  per call, 0 for local
 * @property {(task: any, ctx: any) => Promise<any>} run
 *
 * @typedef {object} Provider
 * @property {string} id
 * @property {string} label
 * @property {'local'|'remote'} locality
 * @property {'free'|'paid'} cost
 * @property {string} [model]
 * @property {string} [modelVersion]
 * @property {boolean} [deterministic] same input always yields same output
 * @property {Record<string, ProviderCapability>} capabilities
 * @property {() => Promise<boolean>} [available]
 */

export class Registry {
  constructor() {
    /** @type {Map<string, Provider>} */
    this.providers = new Map();
    /** @type {Map<string, {ok: boolean, checkedAt: number}>} */
    this.healthCache = new Map();
    /**
     * Last known state per provider, kept separately from the TTL cache.
     *
     * `resetHealth()` clears the cache to force a re-probe, which would also
     * erase the memory of what the state *was* — and a transition you cannot
     * see is a transition you cannot report.
     * @type {Map<string, boolean>}
     */
    this.lastKnownHealth = new Map();
    /** Health results are cached briefly so routing does not probe on every call. */
    this.healthTtlMs = 30_000;
    /**
     * Called when a provider changes between reachable and not.
     *
     * A provider that fails its health check is dropped from routing before it
     * is ever called, so nothing lands in the run log — which would leave an
     * outage completely invisible. This is how it gets recorded.
     * @type {((change: {providerId: string, ok: boolean, at: string}) => void)|null}
     */
    this.onHealthChange = null;
  }

  /**
   * @param {Provider} provider
   * @returns {this}
   */
  register(provider) {
    if (!provider.id) throw new Error('A provider needs an id.');
    if (!provider.capabilities || !Object.keys(provider.capabilities).length) {
      throw new Error(`Provider ${provider.id} declares no capabilities.`);
    }
    for (const [cap, impl] of Object.entries(provider.capabilities)) {
      if (typeof impl.run !== 'function') {
        throw new Error(`Provider ${provider.id} declares ${cap} without a run().`);
      }
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  /** @param {string} providerId */
  unregister(providerId) {
    this.providers.delete(providerId);
    this.healthCache.delete(providerId);
    this.lastKnownHealth.delete(providerId);
  }

  /**
   * Every provider that claims a capability, regardless of availability.
   * @param {string} capability
   * @returns {Provider[]}
   */
  supporting(capability) {
    return [...this.providers.values()].filter((p) => capability in p.capabilities);
  }

  /** @param {string} id */
  get(id) {
    return this.providers.get(id);
  }

  /**
   * Is this provider reachable right now?
   *
   * A provider without an `available` check is assumed up — that is true of
   * the deterministic ones, which are just functions. Remote providers must
   * say how to check, and a failed check removes them from routing without
   * removing them from the registry.
   *
   * @param {Provider} provider
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<boolean>}
   */
  async isAvailable(provider, opts = {}) {
    if (!provider.available) return true;

    const cached = this.healthCache.get(provider.id);
    if (!opts.force && cached && Date.now() - cached.checkedAt < this.healthTtlMs) {
      return cached.ok;
    }
    let ok = false;
    try {
      ok = await provider.available();
    } catch {
      ok = false;
    }

    const previous = this.lastKnownHealth.get(provider.id);
    this.healthCache.set(provider.id, { ok, checkedAt: Date.now() });
    this.lastKnownHealth.set(provider.id, ok);

    if (previous !== undefined && previous !== ok) {
      try {
        this.onHealthChange?.({ providerId: provider.id, ok, at: new Date().toISOString() });
      } catch {
        // Reporting a health change must never break routing.
      }
    }
    return ok;
  }

  /**
   * Forget cached health, so the next route re-probes.
   * Last-known state is deliberately kept, so a change is still noticed.
   */
  resetHealth() {
    this.healthCache.clear();
  }

  /**
   * A description of what this installation can currently do, suitable for
   * showing the user. INVARIANT 40: the interface should make clear what is
   * available and what is not, without exposing internal plumbing.
   * @returns {Promise<any[]>}
   */
  async describe() {
    const out = [];
    for (const p of this.providers.values()) {
      out.push({
        id: p.id,
        label: p.label,
        locality: p.locality,
        cost: p.cost,
        model: p.model ?? null,
        deterministic: !!p.deterministic,
        available: await this.isAvailable(p),
        capabilities: Object.entries(p.capabilities).map(([name, c]) => ({
          name,
          quality: c.quality,
          latencyMs: c.latencyMs,
          costMicros: c.costMicros ?? 0,
        })),
      });
    }
    return out;
  }

  /**
   * Which capabilities currently have at least one working provider.
   * @returns {Promise<Record<string, {providers: string[], best: string|null, degraded: boolean}>>}
   */
  async coverage() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const cap of Object.values(Capability)) {
      const all = this.supporting(cap);
      const up = [];
      for (const p of all) if (await this.isAvailable(p)) up.push(p);
      const best = up.sort(
        (a, b) => b.capabilities[cap].quality - a.capabilities[cap].quality
      )[0];
      out[cap] = {
        providers: up.map((p) => p.id),
        best: best?.id ?? null,
        // Degraded = only the deterministic floor is answering this capability.
        degraded: up.length > 0 && up.every((p) => p.deterministic),
      };
    }
    return out;
  }
}
