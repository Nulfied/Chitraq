# Status

What is actually built, what is partial, and what is designed but not built.

States used here, per the project's own discipline: **IMPLEMENTED** (built and
tested), **PARTIAL** (works, with a stated limit), **DESIGNED** (the shape is
decided, no code), **NOT BUILT** (deliberately deferred).

Last updated: 2026-09-18. 78 tests passing.

---

## Memory core — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Knowledge Objects with kinds and epistemic status | IMPLEMENTED | |
| Append-only versioning | IMPLEMENTED | Every mutation writes a version row |
| `asOf` historical reconstruction | IMPLEMENTED | |
| Supersession with forward links | IMPLEMENTED | Both sides stay readable |
| Relationships, versioned, with provenance | IMPLEMENTED | 18 types, inverses, symmetry |
| Graph traversal with depth and path | IMPLEMENTED | BFS, explains how it reached each node |
| Sources stored verbatim, deduplicated | IMPLEMENTED | |
| Evidence with stance and locator | IMPLEMENTED | supports / contradicts / qualifies / mentions |
| Derivation chain per version | IMPLEMENTED | |
| Event log | IMPLEMENTED | 22 event types |
| Soft delete, archive, restore | IMPLEMENTED | |
| Hard erasure | IMPLEMENTED | Requires a reason; leaves a tombstone event |
| Workspaces, principals, grants | IMPLEMENTED | Single-user bootstrap is automatic |
| Export | IMPLEMENTED | Full workspace as JSON |
| Import from an export | **NOT BUILT** | Export exists; the reverse does not |

## Retrieval — IMPLEMENTED, with known limits

| Capability | State | Notes |
|---|---|---|
| Query grammar (`kind:` `after:` phrases, exclusions) | IMPLEMENTED | |
| Relative dates (`last week`, `3 months ago`) | IMPLEMENTED | |
| Lexical BM25 over FTS5 | IMPLEMENTED | Title weighted 3×|
| Vector search | PARTIAL | Brute-force cosine. Exact and fast to ~10⁵ chunks; no ANN index |
| Hybrid fusion (RRF) | IMPLEMENTED | Per-signal `why` on every result |
| Quality and recency weighting | IMPLEMENTED | Reasons returned with the result |
| Structural boosting from an anchor | IMPLEMENTED | |
| Incremental indexing | IMPLEMENTED | Unchanged chunks keep their vectors |
| Full index rebuild | IMPLEMENTED | |
| Reranking capability | PARTIAL | Deterministic implementation exists; not yet wired into the search path |

**Known limit — switching embedding models.** Vectors are compared only within
the same model. Changing the embedding provider leaves old vectors unused until
`reindex`. This is detected and reported in `/api/stats` health and on the
Status screen, but the reindex is not automatic.

## Context construction — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Direct hits + relational expansion | IMPLEMENTED | Relationship named from the included object's side |
| Predecessors for retrospective questions | IMPLEMENTED | |
| Conflict inclusion, relevance-gated | IMPLEMENTED | |
| Token budgeting with trimming | IMPLEMENTED | Smallest sufficient, not largest possible |
| Per-item justification | IMPLEMENTED | Every item states why it is present |
| Provenance-preserving rendering | IMPLEMENTED | Status travels into the prompt |

## Intelligence fabric — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Capability registry | IMPLEMENTED | 11 capabilities |
| Router with policy (quality/speed/cost/privacy) | IMPLEMENTED | |
| Health checks and fallthrough | IMPLEMENTED | Cached 30s |
| Run recording | IMPLEMENTED | Including failures and timeouts |
| Proposal gateway | IMPLEMENTED | 6 operations, field allowlist, re-validation |
| Auto-accept policy | IMPLEMENTED | Default: only additive, non-asserting operations |
| Deterministic provider (all 11 capabilities) | IMPLEMENTED | |
| Ollama provider | IMPLEMENTED | Embeddings, answer, extract, summarise |
| Claude provider | IMPLEMENTED | Structured outputs, refusal fallbacks, prompt caching |
| Cost accounting | PARTIAL | Per-call cost recorded; no budget enforcement or reporting |

**Unverified.** The Ollama and Claude providers are written against their
documented APIs and are structurally exercised by the router's tests, but have
not been run against a live endpoint in this environment. The deterministic
provider is fully tested.

## Knowledge evolution — PARTIAL

| Capability | State | Notes |
|---|---|---|
| Contradiction detection (numeric, negation) | IMPLEMENTED | Deliberately low-recall, high-precision |
| Conflict recording and resolution | IMPLEMENTED | |
| Similarity and relationship proposals | IMPLEMENTED | |
| Keyword and entity extraction | IMPLEMENTED | TF-IDF against your own corpus |
| Deduplication on capture | PARTIAL | Sources dedupe by content hash; objects do not |
| Entity resolution | **NOT BUILT** | Entities are extracted as attributes, not resolved into Entity objects |
| Salience decay / forgetting | PARTIAL | `salience` and `access_count` are tracked and updated; nothing reads them for ranking yet |

## Interfaces — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| HTTP API | IMPLEMENTED | 30 routes, loopback-only, no permissive CORS |
| CLI | IMPLEMENTED | 19 commands, works with no server |
| Web interface | IMPLEMENTED | 9 views, light and dark |
| Graph visualisation | IMPLEMENTED | Force-directed, recentred |
| Static file serving | IMPLEMENTED | Path traversal guarded |
| Authentication | **NOT BUILT** | Single-user, loopback-bound. Required before any non-local deployment |

## Not built, deliberately

These are in the design and are not started. Each is deferred because nothing
yet demonstrates the need.

- **Collaboration and sync.** The permission model and workspace scoping are
  in place to support it; no sync protocol exists.
- **Proactive surfacing.** "You researched this before" — the retrieval and
  conflict machinery it needs is built; the trigger and the interface are not.
- **Approximate nearest neighbours.** Revisit above ~10⁶ chunks, measured.
- **Import from export.** Round-tripping a workspace.
- **Audio, image and PDF ingestion.** The capability slots (OCR, speech, vision)
  exist in the registry vocabulary with no providers registered.
- **Budget enforcement.** Costs are recorded per run but nothing caps them.

## Honest weaknesses

Worth stating plainly rather than discovering later:

1. **The built-in embedder is lexical, not semantic.** It will not connect "car"
   to "automobile". It scores itself 0.35 so any real model outranks it. Install
   Ollama for genuine semantic retrieval.
2. **Deterministic claim extraction is segmentation, not comprehension.** It
   splits text into sentences and labels them from surface cues. It produces
   more noise than a language model would — which is exactly why everything it
   produces is a proposal.
3. **Contradiction detection is narrow.** It catches conflicting figures about
   the same subject and negated restatements. It will miss most real
   contradictions. It is tuned for precision because a false "these disagree" is
   expensive for the reader.
4. **No concurrency story beyond SQLite WAL.** Fine for one user and one
   process. A multi-user deployment needs work not yet done.
5. **The proposal queue grows.** Ingesting a large document produces many
   proposals and there is no bulk accept, no filtering by confidence, and no
   expiry sweep.
