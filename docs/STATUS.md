# Status

What is actually built, what is partial, and what is deliberately not built.

States: **IMPLEMENTED** (built and tested), **PARTIAL** (works, with a stated
limit), **NOT BUILT** (deliberately deferred).

Last updated: 2026-09-18. 174 tests passing.

---

## Memory core — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Knowledge Objects with kinds and epistemic status | IMPLEMENTED | |
| Append-only versioning | IMPLEMENTED | Every mutation writes a version row |
| `asOf` historical reconstruction | IMPLEMENTED | |
| Supersession with forward and backward links | IMPLEMENTED | Both sides readable, chain walkable from either end |
| Relationships, versioned, with provenance | IMPLEMENTED | 18 types, inverses, symmetry, per-end labels |
| Graph traversal with depth and path | IMPLEMENTED | |
| Sources stored verbatim, deduplicated | IMPLEMENTED | |
| Object deduplication on capture | IMPLEMENTED | Scoped to origin — identical text from you and from a model is not one thing |
| Evidence with stance and locator | IMPLEMENTED | |
| Derivation chain per version | IMPLEMENTED | |
| Event log | IMPLEMENTED | 24 event types, including provider outages |
| Soft delete, archive, restore | IMPLEMENTED | |
| Hard erasure | IMPLEMENTED | Requires a reason; leaves a tombstone event |
| Workspaces, principals, grants | IMPLEMENTED | Single-user bootstrap is automatic |
| Export | IMPLEMENTED | Full workspace, checksummed |
| **Import** | IMPLEMENTED | Ids preserved; never overwrites; dangling rows dropped with warnings; dry run |
| **Entity resolution** | IMPLEMENTED | Exact match resolves silently; anything weaker is suggested; merge re-points edges and supersedes |
| **Authentication** | IMPLEMENTED | Off until an account exists. scrypt, hashed tokens, constant-time compare |
| **Sync** | IMPLEMENTED | Divergence recorded, never silently resolved; nothing deleted by sync |

## Retrieval — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Query grammar, relative dates, retrospective detection | IMPLEMENTED | |
| Lexical BM25 over FTS5 | IMPLEMENTED | Stopword-filtered queries |
| Vector search (exact) | IMPLEMENTED | Brute force, relative cutoff that survives changing model |
| **Approximate index (IVF)** | IMPLEMENTED | Built at reindex, incrementally updated, exact below threshold |
| Hybrid fusion (RRF) | IMPLEMENTED | Per-signal `why` on every result |
| **Reranking** | IMPLEMENTED | Blended with fusion, skipped on thin queries, absorbed on failure |
| **Salience** | IMPLEMENTED | Live for ranking (bounded ±15%), materialised for browsing |
| Quality and recency weighting | IMPLEMENTED | |
| Incremental indexing and full rebuild | IMPLEMENTED | |

### Measured: the approximate index

Run `node scripts/bench-vectors.js [n]` to reproduce. On this machine, 256-dim
vectors over clustered text:

| vectors | exact / query | approximate / query | recall | build |
|---|---|---|---|---|
| 400 | 4.2 ms | 0.55 ms | 1.00 | <0.5 s |
| 2,000 | 21 ms | 1.1 ms | 1.00 | ~0.6 s |
| 6,000 | 56 ms | 2.3 ms | 1.00 | ~2 s |
| 12,000 | 152 ms | 12.2 ms | 1.00 | ~10 s |

Two things this measurement changed:

1. **The threshold was wrong.** An initial guess of 20,000 vectors was three
   orders of magnitude too conservative. It is now 5,000, where exact search
   passes ~50 ms.
2. **The lifecycle was wrong.** Fitting centroids is O(n·√n·dim), so building
   inside a search call would have stalled it for seconds. Building now happens
   at reindex; new vectors are assigned to existing centroids in O(k·dim).

**Known limit — switching embedding models.** Vectors compare only within one
model. Changing provider leaves old vectors unused until `reindex`. Detected and
reported on the Status screen; not automatic.

## Context and proactive memory — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Relational expansion, labelled from the included object's side | IMPLEMENTED | |
| Predecessors for retrospective questions | IMPLEMENTED | |
| Conflict inclusion, relevance-gated | IMPLEMENTED | |
| Token budgeting with trimming | IMPLEMENTED | |
| Per-item justification | IMPLEMENTED | |
| **Proactive notices** | IMPLEMENTED | Seen-before, contradiction, previously-rejected, superseded-source, stale figures, review backlog. Read-only, thresholded, explains itself |

## Intelligence fabric — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| Capability registry | IMPLEMENTED | 15 capabilities |
| Router with policy | IMPLEMENTED | quality / speed / cost / privacy |
| Health checks, fallthrough, **outage events** | IMPLEMENTED | A provider going down is recorded |
| Run recording | IMPLEMENTED | Including failures and timeouts |
| Proposal gateway | IMPLEMENTED | 6 operations, field allowlist, re-validation at accept |
| **Bulk review and expiry** | IMPLEMENTED | One stale proposal does not block a batch; expiry ≠ rejection |
| **Budget enforcement** | IMPLEMENTED | Checked at selection; running out degrades intelligence, never memory |
| **Cost reporting** | IMPLEMENTED | By provider, capability and day |
| Deterministic provider (11 capabilities) | IMPLEMENTED | |
| Ollama provider | IMPLEMENTED | Verified against a protocol stand-in — see below |
| Claude provider | IMPLEMENTED | Structured outputs, refusal fallbacks, prompt caching |

### Provider verification status

- **Built-in deterministic** — fully tested, every capability.
- **Ollama** — tested against a stand-in speaking Ollama's real HTTP protocol
  (`/api/tags`, `/api/embed`, `/api/generate` with schema-constrained output).
  This proves request shape, response parsing, health logic, validation of
  model output, and fallback on failure. It does **not** prove a real Ollama
  build responds as documented. Ollama is not installed on this machine; run
  `node scripts/check-ollama.js` against a live endpoint to close that gap.
- **Claude** — written against the current Messages API (structured outputs via
  `output_config.format`, server-side refusal fallbacks, prompt caching on the
  system block). Structurally exercised by the router's tests; **not run against
  the live API**, since no key is configured.

## Capture — IMPLEMENTED

| Format | State | Notes |
|---|---|---|
| Text, Markdown, HTML, JSON, CSV | IMPLEMENTED | Front matter, headings, links, wikilinks |
| **PDF** | IMPLEMENTED | Dependency-free: inflates content streams, reads text operators, extracts document info |
| Scanned PDF | PARTIAL | Detected and reported honestly; names `ocr.document` as what would read it |
| Encrypted PDF | PARTIAL | Detected and reported; file still captured verbatim |
| Images | PARTIAL | Captured; `ocr.image` / `vision.describe` declared with no provider |
| Audio and video | PARTIAL | Captured; `speech.transcribe` declared with no provider |

The partials are honest ones: the bytes are always stored, and the capability
that would unlock them is named rather than silently doing nothing.

## Interfaces — IMPLEMENTED

| Capability | State | Notes |
|---|---|---|
| HTTP API | IMPLEMENTED | ~50 routes, loopback-only, auth-gated once an account exists |
| CLI | IMPLEMENTED | Works with no server |
| Web interface | IMPLEMENTED | 11 views, light and dark |
| Graph visualisation | IMPLEMENTED | |

## Not built, deliberately

- **Background job runner.** Enrichment happens inline at capture. A queue is
  easy to add when something needs it and hard to remove once it exists.
- **CRDT-style automatic merge.** Sync raises divergence for a human instead.
  This is a choice, not a gap: automatic merge means silently discarding one
  side of an edit.
- **OCR, speech and vision providers.** The capability slots exist; no provider
  is registered, and coverage says so.
- **Multi-user real-time collaboration.** Permissions and sync exist; presence,
  live cursors and operational transforms do not.

## Honest weaknesses

1. **The built-in embedder is lexical, not semantic.** It will not connect "car"
   to "automobile". It scores itself 0.35 so any real model outranks it.
   Installing Ollama is the single biggest retrieval improvement available.
2. **Deterministic claim extraction is segmentation, not comprehension.** It
   produces more noise than a language model would — which is why everything it
   produces is a proposal.
3. **Contradiction detection is narrow.** Conflicting figures about the same
   subject, and negated restatements. It misses most real contradictions, and is
   tuned for precision because a false "these disagree" is expensive to read.
4. **Concurrency is SQLite WAL and nothing more.** Fine for one user and one
   process. A multi-user server needs work not yet done.
5. **Sync has no transport.** `changesSince` produces a payload and
   `applyChanges` consumes one; moving it between machines is left to the caller.
6. **Entity resolution only handles people, organisations and identifiers.**
   Places, products and concepts are extracted as attributes, not resolved.
