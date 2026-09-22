# Status

What is actually built, what is partial, and what is deliberately not built.

States: **IMPLEMENTED** (built and tested), **PARTIAL** (works, with a stated
limit), **NOT BUILT** (deliberately deferred).

Last updated: 2026-09-20. 415 tests passing.

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
| **Passphrase over keys** | IMPLEMENTED | Optional. Sealed under something that exists nowhere on disk |
| **Concepts** | IMPLEMENTED | Found by what recurs across separate notes; always proposals, never automatic |

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
| **Ollama vision provider** | IMPLEMENTED | Verified live with moondream. Uses whichever vision model is pulled — `ocr.image`, `vision.describe` |
| **Whisper provider** | IMPLEMENTED | Protocol stand-in only; not run against a real engine |
| **Scanned-PDF provider** | IMPLEMENTED | Serves `ocr.document` by delegating each page to `ocr.image` |
| Claude provider | IMPLEMENTED | Structured outputs, refusal fallbacks, prompt caching |
| **OpenAI-compatible provider** | IMPLEMENTED | One adapter, ten hosts, no dependency. Free tiers, paid APIs, and local servers |

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
- **OpenAI-compatible** — one adapter over plain `fetch` for every host that
  speaks the OpenAI chat shape: Groq, Gemini, Cerebras and GitHub Models on
  their free tiers, OpenRouter, Mistral, DeepSeek and OpenAI on paid ones,
  and llama.cpp, LM Studio or vLLM locally. **Driven end to end against a
  live endpoint**: retrieval, context building, the shared prompts, the
  provider call, parsing and attribution, with the answer coming back
  credited to the provider that wrote it. Fourteen tests cover the protocol,
  including the fallback for hosts that reject `json_schema`, fenced JSON,
  and refusing to treat prose as an empty result.

- **Claude** — written against the current Messages API (structured outputs
  via `output_config.format`, server-side refusal fallbacks, prompt caching
  on the system block). **The SDK call itself has still never run**, because
  a key costs money and there is no budget for one.

  What that means changed, though, and the change is the point. The prompts,
  the schemas and every line that turns a reply into a proposal used to live
  inside this adapter, so none of it had ever executed either. They now live
  in `grounded.js`, shared with the OpenAI-compatible adapter — which runs
  them for real, for free. What remains unverified is the forty lines that
  build an Anthropic request. That is a much smaller claim than the one this
  section used to have to make.

  And `chitraq setup` closes the rest of the gap the only way it honestly
  can: it makes a live call with whatever key you supply, shows you what came
  back, and refuses to store a credential that did not work. The first person
  with an Anthropic key verifies that path, at the moment they configure it,
  without having to be told to.

## Capture — IMPLEMENTED

| Format | State | Notes |
|---|---|---|
| Text, Markdown, HTML, JSON, CSV | IMPLEMENTED | Front matter, headings, links, wikilinks |
| **Folder capture** | IMPLEMENTED | Resumable, idempotent, skips machinery, states a reason for every omission |
| **PDF** | IMPLEMENTED | Dependency-free: inflates content streams, reads text operators, extracts document info |
| **Scanned PDF** | IMPLEMENTED | Page images extracted and read, including CCITT Group 3/4 fax. JBIG2 named as unreadable |
| **Encrypted PDF** | IMPLEMENTED | Standard security handler, R2 to R6, RC4 and AES. A real user password is refused, not guessed |
| **Images** | IMPLEMENTED | Read by a local vision model through Ollama; captured verbatim with an honest note when none is present |
| **Audio** | IMPLEMENTED | Read by any local Whisper server; timestamps kept as evidence locators |
| Video | PARTIAL | Captured; no provider extracts its audio track |

The partials are honest ones: the bytes are always stored, and the capability
that would unlock them is named rather than silently doing nothing.

### Reaching Chitraq from another program

`chitraq tokens --new <name>` mints a scoped credential, and `chitraq/client`
is a dependency-free class other projects import. Together they make one
memory usable by several programs.

The rule that makes a token meaningful on a loopback install, where anything on
the machine could call the API anyway:

> **Presenting a token constrains you. Presenting nothing changes nothing.**

A `read` token is refused a write even where an anonymous caller is allowed
one. That is what lets a side project hold a credential which cannot damage the
memory it reads.

Route scopes are derived from the method — GET reads, anything else writes —
with an explicit override list for reads that need a body (`ask`, `search`) and
for the routes that destroy or grant (`erase`, `export`, `sync`, `keys`,
`tokens`). The bias in the default is deliberate: a route nobody classified is
treated as a write, never a read.

The client never caches and never retries blindly, because a memory client that
silently returns a stale answer leaves the caller unable to tell a remembered
fact from a remembered response. `remember` can be told to queue while the
server is away; that queue is in memory, opt-in, and reports `queued: true`
rather than pretending the capture succeeded.

### Reading scanned PDFs

This corrects something this file previously claimed. It said a scanned PDF
needed rasterising and that every route to it was a dependency Chitraq would
not take. That is true for one kind of scan and was wrong about the common one.

A PDF does not store pictures in a PDF-specific format. For `DCTDecode` — what
almost every scanner and phone produces — the stream bytes *are* a JPEG file,
and nothing has to be decoded to hand them to something that reads images.
`FlateDecode` bitmaps need a PNG header wrapped round them, which is arithmetic
and Node's zlib is already here.

So `ocr.document` is served by a provider that knows nothing about models: it
takes the file apart and asks whatever serves `ocr.image` to read each page.
Verified end to end against moondream.

`CCITTFaxDecode` — Group 3 and Group 4, what a fax machine and an old copier
produce — was the last gap and is now decoded from the T.4 and T.6 tables.
The reason to write it rather than keep naming it was that it can be checked:
Pillow carries libtiff's encoder, so a known bitmap goes in and the decoder's
output is compared pixel for pixel against it. Twelve committed fixtures cover
hairlines, ink against both margins, runs past 2560 pixels and a width that is
not a multiple of eight. A fuzz run over several thousand random pages found
no difference, and it is reproducible rather than reported:

```
python tools/make-ccitt-fixtures.py --fuzz 1000 7
node tools/fuzz-ccitt.mjs .ccitt-fuzz
```

Pillow is a development tool for those two scripts. It is not imported by
anything in `src/`, is not in `package.json`, and the fixtures are committed,
so the test suite and CI run without it. The zero-dependency claim holds.

**What remains true:** `JBIG2Decode` needs a decoder, and there is no
independent encoder to check one against, so it is named in the result rather
than attempted. So are colour spaces that would need converting and bitmaps
with a predictor — a wrong picture that looks like a picture is worse than
none, because a model will read it and produce confident text from nothing.

Two bugs in the existing parser fell out of this work, both long-standing:
`endstream` ends in `stream`, so every stream was found twice; and the
dictionary was located by searching back to the nearest `<<`, which finds the
*inner* dictionary whenever one nests, so every stream with `/DecodeParms` was
silently skipped.

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
| HTTP API | IMPLEMENTED | ~55 routes, loopback-only, auth-gated once an account exists |
| **Access tokens** | IMPLEMENTED | Scoped read/write/admin, hashed at rest, revocable, shown once |
| **Client library** | IMPLEMENTED | `chitraq/client` — one file, no dependencies, Node or browser |
| CLI | IMPLEMENTED | Works with no server |
| Web interface | IMPLEMENTED | 11 views, light and dark |
| **Folder watch** | IMPLEMENTED | `chitraq watch` — foreground, debounced, queued, stops with the terminal |
| **Linux, macOS, Windows** | IMPLEMENTED | All three run the full suite in CI on every push |
| Graph visualisation | IMPLEMENTED | |

## Not built, deliberately

- **Background job runner.** Enrichment happens inline at capture. A queue is
  easy to add when something needs it and hard to remove once it exists.
- **CRDT-style automatic merge.** Sync raises divergence for a human instead.
  This is a choice, not a gap: automatic merge means silently discarding one
  side of an edit.
- **A hosted OCR, speech or vision service.** All three capabilities are
  served, but only by something running on your own machine: `ocr.image` and
  `describe.image` by a vision model through Ollama, `ocr.document` by a
  provider that takes the PDF apart and delegates each page to whichever of
  those is registered, `transcribe` by any local Whisper server. Sending
  documents to somebody else's API to read them is the thing this project is
  arranged to avoid, so no adapter for one is written.
- **Multi-user real-time collaboration.** Permissions and sync exist; presence,
  live cursors and operational transforms do not.
- **JBIG2-encoded scans** (`JBIG2Decode`). CCITT Group 3 and Group 4 are now
  decoded — see below — but JBIG2 is a different size of problem: arithmetic
  coding, symbol dictionaries and generic region decoding, a subsystem rather
  than a table. The deciding factor is not difficulty, it is that there is no
  independent encoder to check a decoder against, and an unverifiable decoder
  hands a vision model a scrambled page it will read confidently. Detected and
  named instead.

## Honest weaknesses

1. **The built-in embedder is lexical, not semantic.** It will not connect "car"
   to "automobile". It scores itself 0.35 so any real model outranks it.
   Installing Ollama is the single biggest retrieval improvement available.
2. **A local 3B model is slow for bulk extraction on modest hardware.**
   Throughput here is a fixed **five tokens a second**, so the schema decides
   the cost: asking for kind, epistemic and confidence per claim made the
   model emit 251 tokens where 45 would do — 69 seconds against 9. It is now
   asked only for the sentences, which cut a representative extraction from
   70 seconds to 26. It is still slow. Measured before that change,
   llama3.2 needed about **86 seconds for a 1,000-character passage** — roughly five tokens a second, warm, with the model resident.
   Documents are now read in pieces, which fixes the context limit and does
   nothing for throughput: a 31-piece document would be three quarters of an
   hour. So Chitraq estimates the cost from this machine's own run history
   and chooses the deterministic floor deliberately, saying so, rather than
   discovering it one timeout at a time. On a machine with a GPU the same
   code uses the model, because the measurement says it can.
3. **Extraction by the floor is segmentation, not comprehension.**
   Measured on a 41,000-character specification: llama3.2 took 80 seconds and
   returned *one* claim; the deterministic segmenter finds 46 to 69. On a real
   import of 27 documents the model timed out on four and served one, and the
   floor did the other twenty-six — which produced better extraction than the
   model would have. Falling back is now reported rather than silent. Chunked
   extraction, so the model sees pieces it can handle, is the fix and is not
   built: it would be roughly ten minutes per large document on this hardware.
4. **Confidence is derived, not asked for.** A real import produced 402 of
   460 proposals at exactly 0.4: llama3.2 emitting a default rather than
   judging. The model is now asked only for the claim sentences, and the
   score comes from what can be checked — the kind of statement, whether it
   cites a figure, whether it stands on its own rather than opening with a
   pronoun, and its length. On the same documents that gave one value, it
   now gives fourteen, and `--accept-above` is a real control. It sorts by
   whether a claim is *usable*, which is not a judgement about truth.
5. **Contradiction detection is narrow.** Conflicting figures about the same
   subject, and negated restatements. It misses most real contradictions, and
   is tuned for precision because a false "these disagree" is expensive to
   read. It also misses pairs a person would call obvious — `p99 latency at
   38ms` against `88ms` does not fire, while `the trial lasts 14 days` against
   `30 days` does, because the surrounding words have to match closely enough.
   On real documents it did find a genuine one: a README claiming Node 22.5
   against an engines field of 24.
6. **Concurrency is SQLite WAL and nothing more.** Fine for one user and one
   process. A multi-user server needs work not yet done.
7. **Nothing watches anything unless you start it.** `chitraq watch` is a
   foreground command that dies with the terminal. Sync has no watch mode at
   all, and there is still no timer, no service and no background exchange.
8. **Entity extraction is sparse on technical documentation.** Measured on a
   real corpus of 27 project documents: the first run produced 33 entities of
   which about four were real, because documentation is nothing but Title
   Case and every capitalised run was read as a person. Successive rounds —
   a name must be a positive shape; a version must be version-shaped, so "a
   null Gate 2 outcome" is not a product; paths and code are stripped before
   names are looked for — took it to 33 → 12 → 8 → **4, all four correct**
   (`MSVC`, `Node`, `Windows`, `Halka`). Precise now, and sparse: it finds
   what has an unambiguous shape and misses the rest. A model would find
   more.
9. **Concepts find phrases you repeat, not ideas you hold.** On a real
   corpus the first run's strongest "concept" was `https github com nulfied`
   — a URL tokenises into ordinary words, so a repeated link reads as a
   repeated idea. Most of the rest was structure: 23 of 437 stored claims
   were TOML, Lua or HTML comments out of fenced blocks, which produced
   `start end close true newline` from a bracket-pairing config. Links,
   paths, code, tables and configuration are now excluded upstream, and
   identifiers, bare verbs and adverbs disqualify a phrase. What is left on
   the same corpus is six, all six defensible: `memory safety`, `locked
   rule`, `lifetime annotations`, `reference interpreter`, `runtime
   dependencies`, `install step`. The definition is still shallow — a phrase
   repeated across notes — and a corpus without that repetition yields
   nothing. They are found by recurrence
   across separate notes, which is honest but shallow: it finds phrases you
   repeat, not ideas you hold. Everything it produces is a proposal, and
   confidence is capped well below the shape-based kinds.
10. **An unlocked vault lives in process memory.** Something that can read this
   process can read the data key. Defending against that is a different order
   of problem and is not attempted.
11. **Video depends on which speech server you run.** The file is posted to
    whatever serves `speech.transcribe` with its own media type, so an
    ffmpeg-backed server — Speaches, faster-whisper-server — reads an MP4
    directly. whisper.cpp's own server wants audio, and Chitraq does not
    demux the container for it. This entry previously said nothing extracts
    the audio track, which was wrong about the common case.
