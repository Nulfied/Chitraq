# Chitraq

**The memory engine for everyone.** One memory, many intelligences.

Chitraq is a persistent computational memory: it captures what you learn,
observe and decide, preserves its history and provenance, connects it across
relationships and time, retrieves it in context, and lets many kinds of
intelligence work over it — while keeping deterministic ownership of identity,
history, provenance and truth.

It runs entirely on your machine, with **zero dependencies**. Node 22.5+ ships
SQLite with FTS5 in core, so there is nothing to install, no service to run, no
account to create and no API bill.

```bash
node scripts/seed.js demo/memory.chitraq     # build a demo memory
node src/server/serve.js --db demo/memory.chitraq
```

Then open <http://127.0.0.1:4317>.

---

## What makes it different

Most tools in this space are storage with search bolted on. Chitraq is built
around a different claim: **memory is more than storage.** Storage answers
"where is the file?" Memory has to answer "what do I know, how do I know it,
what has changed, and what is relevant now?"

Four things follow from that, and they are the whole design:

**Knowledge, not documents.** A document is stored verbatim as a *Source*. The
claims, decisions and observations inside it become separate Knowledge Objects,
each carrying its own status, evidence and history.

**Provenance never gets lost.** Every object records whether *you* wrote it, a
*source* stated it, an *algorithm* derived it, or a *model* produced it — and
whether a human has since confirmed it. Confirming an AI-derived fact does not
relabel it as yours. The record of where knowledge came from is permanent.

**History is never rewritten.** Editing appends a version; superseding keeps
the old object readable and linked forward. "What did we believe in March?" is
answerable. The only operation that destroys history is an explicit `erase`,
which requires a stated reason.

**AI proposes; Chitraq decides.** No model writes to memory. Capabilities emit
*proposals*, a deterministic gateway validates them, and only an explicit
accept turns one into state — carrying the capability, provider, model and run
that produced it. A model cannot claim to be you, cannot rewrite something you
confirmed, and cannot change provenance, review status or permissions.

**Disagreement is recorded, never resolved behind your back.** Two notes that
contradict each other, a figure that changed, the same object edited on two
devices — in every case Chitraq keeps both, shows them together, and asks. The
alternative is silently discarding one, which is how memory becomes untrustworthy.

---

## It works with no AI at all

This is the part most systems get backwards. Every capability Chitraq defines
has a deterministic, offline, free implementation. With no API key, no GPU and
no network, Chitraq still:

captures · versions · links · indexes · searches (BM25 + vectors) · extracts
claims · pulls out entities and keywords · summarises · detects contradictions ·
builds context · answers questions from your own words · tracks conflicts

The built-in embedder is a hashed character-n-gram model — real vectors, stable
and local, honest about being weaker than a trained one (it scores itself 0.35).
The built-in answerer quotes your own sentences rather than generating prose, so
it cannot hallucinate; the worst it can do is quote the wrong passage, which you
can see.

Add [Ollama](https://ollama.com) and you get real semantic embeddings and a
local language model, still free, still on your machine, still private:

```bash
ollama pull nomic-embed-text
ollama pull llama3.2
node scripts/check-ollama.js      # verify it end to end
node src/server/serve.js          # detected automatically
```

Embeddings are the win. They find things the built-in embedder cannot: asked
"can I claim my car on expenses", the built-in misses a note reading "staff may
expense an automobile"; Ollama finds it. Reindex after adding them
(`chitraq reindex`) — Chitraq will tell you if you forget.

Generation is slower on a machine without a GPU. Chitraq measures how long your
setup actually takes and adapts: if a written answer would take 45 seconds, it
answers instantly from your own words and offers the slow one on a button,
rather than making you wait without warning.

Add a Claude key and you get stronger extraction and synthesis:

```bash
export ANTHROPIC_API_KEY=...
export CHITRAQ_ALLOW_REMOTE=true      # two separate decisions, on purpose:
export CHITRAQ_ALLOW_PAID=true        # having a key ≠ permission to send data
npm install @anthropic-ai/sdk
```

**A better model raises the ceiling. It never moves the floor**, and it never
takes ownership of your memory.

---

## Command line

The CLI talks to the engine directly, so it works with no server running.

```bash
chitraq remember "Chose SQLite because it needs no server"
chitraq ingest notes/architecture.md      # also .pdf, .html, .csv, .json
chitraq search 'kind:decision sqlite after:2025-01'
chitraq ask "why did we drop the redis cache"
chitraq review                # proposals waiting for you
chitraq show obj_01J...       # history, links, evidence, provenance
chitraq status                # what memory holds, what intelligence is available
```

Search understands `kind:` `origin:` `after:` `before:` `during:` `is:confirmed`
`tag:`, `"exact phrases"` and `-exclusions`, plus relative dates like
`last week` and `3 months ago`.

---

## How retrieval works

No single technique is right for everything, so Chitraq combines several and
tells you which one fired:

- **lexical** — BM25 over FTS5. Finds the invoice number embeddings smear away.
- **semantic** — cosine over stored vectors. Finds the note that never used
  your words.
- **structural** — relationship proximity, so connected material surfaces with
  the relationship named.
- **temporal** — explicit ranges plus a gentle recency preference.
- **quality** — confirmed knowledge outranks unreviewed AI output; speculation
  ranks below observation.

Ranked lists are fused with Reciprocal Rank Fusion, and every result carries a
`why` breakdown. Ranking is never a black box.

Asking a question builds a *context*: direct hits, then what they are connected
to, then predecessors if the question is about the past, then any known
disagreement in that material. Every item states why it is there, and the
budget is the *smallest sufficient* context, not the largest possible.

---

## More than a pile of notes

**People and things.** Names, organisations and ticket ids are resolved out of
your notes into entities that many notes point at. Only an exact match on a
name or recorded alias merges automatically; anything weaker is a suggestion,
because a wrong merge fuses two histories and is tedious to unpick.

**It tells you things.** "You wrote something close to this eight months ago."
"This disagrees with a decision on record." "This answer rests on a figure
nobody has checked in a year." Every notice is read-only, explains itself, and
points at the object rather than asserting anything. Silence is the default.

**It moves between machines.** `chitraq export` and import round-trip a whole
workspace with history and provenance intact. Two installations can exchange
just what changed since they last spoke — and where both edited the same thing,
you get a conflict to resolve, not a silent overwrite.

**It knows what it costs.** Every capability call records its provider, model,
latency and cost. Set a daily or monthly ceiling and paid providers stop being
offered when it is reached; the free and deterministic ones answer instead, so
running out of budget costs you an answer, never your memory.

---

## Layout

```
src/core/          objects, relations, sources, evidence, events, history,
                   entities, auth, sync, import/export
                   — the deterministic memory engine, no AI anywhere in it
src/retrieval/     query parsing, indexing, lexical + vector + hybrid search
src/context/       context construction and rendering
src/intelligence/  capability registry, router, proposal gateway, providers
src/capture/       parsers (text, markdown, html, csv, json, pdf) and ingestion
src/server/        HTTP API
src/cli/           command line
web/               browser interface
docs/              architecture, invariants, and an honest status ledger
```

Start with [`docs/INVARIANTS.md`](docs/INVARIANTS.md) — it lists the rules the
system is built to hold and points at the test that proves each one.
[`docs/STATUS.md`](docs/STATUS.md) says plainly what is implemented, what is
partial, and what is designed but not built.

---

## Tests

```bash
npm test
```

174 tests covering the invariants, not just the happy path: that AI cannot
overwrite your edges, that a stale proposal is refused at accept time, that
memory survives the total loss of every intelligence provider, that superseded
pricing never appears as current, that two devices editing the same note raises
a conflict instead of losing one, that running out of budget never blocks
capture, and that erasure leaves an audit trail.

```bash
node scripts/bench-vectors.js 6000   # measure approximate vs exact search
node scripts/check-ollama.js         # verify a live Ollama endpoint
```

---

## Your data

Everything lives in one SQLite file. `chitraq export` writes the whole
workspace — objects, every version, relations, sources, evidence, provenance
and the event log — as JSON. Memory you cannot take with you is not yours.

Nothing leaves your machine unless you explicitly turn remote providers on.

---

MIT.
