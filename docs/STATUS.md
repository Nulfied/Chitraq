# Status

What is actually built, what is partial, and what is deliberately not built.

States: **IMPLEMENTED** (built and tested), **PARTIAL** (works, with a stated
limit), **NOT BUILT** (deliberately deferred).

Last updated: 2026-09-18. 264 tests passing.

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
| **Entity resolution** | IMPLEMENTED | People, organisations, identifiers, **places, products, projects**. Exact match resolves silently; anything weaker is suggested |
| **Authentication** | IMPLEMENTED | Off until an account exists. scrypt, hashed tokens, constant-time compare |
| **Sync** | IMPLEMENTED | Divergence recorded, never silently resolved; nothing deleted by sync |
| **Sync transport** | IMPLEMENTED | `chitraq sync <url>`; peers keyed by workspace, not address; batched, resumable |
| **Bring-your-own API keys** | IMPLEMENTED | Per principal, AES-256-GCM at rest, write-only, live without a restart |

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

### Measured: how often a model is actually called

The ladder tries the free extractive answer first and only escalates when
quoting genuinely cannot answer. Measured over ten realistic questions against
the demo workspace:

| outcome | count |
|---|---|
| answered by quoting your own words, no model | 6 |
| served from cache, no model | 2 |
| escalated to a model | 2 |

**80% of questions never reached a model**, and the two that did were the right
ones: a question whose answer was spread across a long note (confidence 0.43),
and an explicit "summarize our architecture decisions".

Cache invalidation is structural rather than managed: the key is built from the
content hashes of the objects the answer rests on, so editing any of them, or
capturing something new that now retrieves for that question, moves the key. A
stale answer cannot be served because if it could be stale, the key already
changed. Unrelated captures do not invalidate anything.

`test/ladder.test.js` counts model calls directly, so a change that quietly
starts sending every question to a paid provider fails the suite.

### Measured: Ollama on modest hardware

On an i7-8550U laptop, 8 GB RAM, no usable GPU:

| operation | time | notes |
|---|---|---|
| embedding a query | ~190 ms | 768-dim, warm |
| embedding 17 chunks (reindex) | ~2 s | |
| quoted answer (no model) | 70–320 ms | the common path |
| generated answer (llama3.2) | **41–50 s** | CPU only |
| claim extraction from a page | ~26 s | happens at ingest, not interactively |

Embeddings are the win: fast, and they find paraphrases the built-in embedder
cannot. Head to head on queries sharing almost no words with the notes
("can I claim my car on expenses" against "Staff may expense an automobile"),
the built-in got 1 of 3 and Ollama got 3 of 3.

Generation on CPU is correct but slow, which changed a design decision:
**escalation now uses measured latency, not declared latency.** Ollama declares
3 s for an answer and takes 45 s here. Above `autoEscalateMaxMs` (8 s by
default) Chitraq answers instantly from your own words and *offers* a written
answer with the real wait on the button, instead of silently hanging for a
minute. On a machine with a GPU the same code escalates automatically, because
the measurement says it can.

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
| **Answer ladder** | IMPLEMENTED | Quote first, escalate only when quoting is not enough |
| **Answer cache** | IMPLEMENTED | Keyed on context content, so it invalidates itself |
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
| Ollama provider | IMPLEMENTED | Verified live — see below |
| **Ollama vision provider** | IMPLEMENTED | Verified live with moondream — `ocr.image`, `vision.describe` |
| **Whisper provider** | IMPLEMENTED | Protocol stand-in only; not run against a real engine |
| Claude provider | IMPLEMENTED | Structured outputs, refusal fallbacks, prompt caching |

### Provider verification status

- **Built-in deterministic** — fully tested, every capability.
- **Ollama** — **verified against a live endpoint** (Ollama 0.34.2,
  `nomic-embed-text` and `llama3.2`). All checks in `scripts/check-ollama.js`
  pass: batched embeddings, separation of unrelated text, schema-constrained
  extraction, grounded answering, and refusal on unrelated material. Also
  covered by a protocol stand-in in the test suite so the adapter stays
  regression-tested without Ollama installed.

  Live testing found one real bug a stand-in would not have: llama3.2 writes a
  correct answer, cites the source it used, and still reports `grounded: false`.
  The adapter now believes the answer over the flag, and strips the bracket
  wrapping the model copies from the prompt.
- **Ollama vision** — **verified against a live endpoint** (moondream). Given a
  PNG of a whiteboard reading "SHIP IN MARCH / P99 38 MS", it returned
  `"Ship in march 38 ms"` — the words, minus "P99", with the case normalised.
  That is a fair picture of what a 1.8 GB model on a CPU does, and exactly why
  everything it produces is marked as a reading rather than a quote. 33 s cold,
  3.7 s warm on the i7-8550U.
- **Whisper** — covered by a stand-in server speaking the OpenAI-compatible
  transcription API: request shape, multipart body, error paths, result mapping.
  **Not run against a real engine**, because none is installed here. It should
  not be read as claiming more than that.
- **Claude** — written against the current Messages API (structured outputs via
  `output_config.format`, server-side refusal fallbacks, prompt caching on the
  system block). Structurally exercised by the router's tests; **not run against
  the live API**, since no key is configured.

## Capture — IMPLEMENTED

| Format | State | Notes |
|---|---|---|
| Text, Markdown, HTML, JSON, CSV | IMPLEMENTED | Front matter, headings, links, wikilinks |
| **Folder capture** | IMPLEMENTED | Resumable, idempotent, skips machinery, states a reason for every omission |
| **PDF** | IMPLEMENTED | Dependency-free: inflates content streams, reads text operators, extracts document info |
| Scanned PDF | PARTIAL | Detected and reported honestly; names `ocr.document` as what would read it |
| Encrypted PDF | PARTIAL | Detected and reported; file still captured verbatim |
| **Images** | IMPLEMENTED | Read by a local vision model through Ollama; captured verbatim with an honest note when none is present |
| **Audio** | IMPLEMENTED | Read by any local Whisper server; timestamps kept as evidence locators |
| Video | PARTIAL | Captured; no provider extracts its audio track |

The partials are honest ones: the bytes are always stored, and the capability
that would unlock them is named rather than silently doing nothing.

### Folder capture

`chitraq ingest <folder>` walks a notes folder and captures the documents in it.
The design is shaped by one fact: reading is slow. Extraction with a local model
costs about twenty seconds a file, so a four-hundred-file folder is a two-hour
job, and a two-hour job that cannot be interrupted is a job nobody starts.

So each file commits before the next begins, and capture is keyed on content and
location, which together mean Ctrl-C is safe and re-running resumes. `--dry-run`
prints the list first; `--no-extract` stores the text in milliseconds and leaves
the reading for later.

The default extension list is documents, not data — `json`, `csv`, `log` and
source files are parseable but excluded, because a walk that swallows every
`package.json` turns a memory into a haystack. Machinery directories are never
descended into and symbolic links are never followed, in either direction.

Every omission carries a reason (`ignored-directory`, `hidden`, `symbolic-link`,
`unsupported-type`, `too-large`, `empty`, `unreadable`), summarised by count, so
"where is my note?" is answerable without reading the source.

Re-running is cheap: size and last-write time are recorded with each captured
file, so an untouched file is skipped before it is opened. The content hash is
still what decides — this only avoids the reading. `--rescan` ignores the record
when you want everything read again.

**Known limit — an edit is a new source, not a revision.** A changed file is
captured again rather than recognised as a new version of the old one. Identical
claims deduplicate at the object level, so no visible duplicates appear, but the
two captures are not linked as a history.

**Not exposed over HTTP.** The route would have to either stream progress or
block for an hour, and a bulk import belongs on the command line until real use
says otherwise.

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
5. **Nothing watches anything.** Sync and folder capture are commands you run,
   not daemons that notice. No timer, no file watcher, no background exchange.
6. **Concepts are still not resolved as entities.** People, organisations,
   identifiers, places, products and projects are. A concept has no surface
   shape to find it by, and guessing from capitalisation would fill the graph
   with noise. Recurring phrases across the corpus would be the honest
   mechanism; it is not built.
7. **Encrypted API keys protect a leaked database, not a compromised machine.**
   The secret lives in a file beside the store. Deriving it from the person's
   password would be stronger and would mean keys only work while they are
   logged in. That trade has not been made.
8. **`ocr.document` remains empty.** A scanned PDF holds its pages as embedded
   images, and extracting them means rasterising or decoding JPEG/JBIG2/CCITT —
   every route is a dependency this project does not take.
