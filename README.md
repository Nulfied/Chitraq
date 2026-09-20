# Chitraq

[![tests](https://github.com/Nulfied/Chitraq/actions/workflows/ci.yml/badge.svg)](https://github.com/Nulfied/Chitraq/actions/workflows/ci.yml)

**The memory engine for everyone.** One memory, many intelligences.

Chitraq is a persistent computational memory: it captures what you learn,
observe and decide, preserves its history and provenance, connects it across
relationships and time, retrieves it in context, and lets many kinds of
intelligence work over it — while keeping deterministic ownership of identity,
history, provenance and truth.

It runs entirely on your machine, with **zero dependencies**. Node ships SQLite
with FTS5 in core, so there is nothing to install, no service to run, no
account to create and no API bill.

## Try it

```bash
git clone https://github.com/Nulfied/Chitraq
cd chitraq
npm test                                     # 406 tests, no install step

node scripts/seed.js demo/memory.chitraq     # build a demo memory
node src/server/serve.js --db demo/memory.chitraq
```

Then open <http://127.0.0.1:4317>.

Requires **Node 24 or later** — that is the version this is developed and
tested on. `node:sqlite` exists from 22.5, so older versions may well work;
nobody has checked, so the engines field says 24.

Runs on **Linux, macOS and Windows**. All three are in CI on every push, so
that is checked rather than assumed — the one platform-specific bug found so
far was a Windows-only crash in recursive file watching.

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

Put `chitraq` on your PATH first — a clone has the command but nothing has
linked it yet, and every example below assumes it is there:

```bash
npm link          # from the clone; `npm unlink -g chitraq` undoes it
```

If you would rather not link anything globally, `node src/cli/chitraq.js`
takes exactly the same arguments and every example works with that in place
of `chitraq`.

```bash
chitraq remember "Chose SQLite because it needs no server"
chitraq ingest notes/architecture.md      # also .pdf, .html, .csv, .json
chitraq ingest ~/Documents/notes          # or a whole folder
chitraq sync http://192.168.1.20:4317     # exchange with another machine
chitraq search 'kind:decision sqlite after:2025-01'
chitraq ask "why did we drop the redis cache"
chitraq review                # proposals waiting for you
chitraq show obj_01J...       # history, links, evidence, provenance

chitraq status --db other.chitraq   # options go after the command, not before
chitraq status                # what memory holds, what intelligence is available
```

Search understands `kind:` `origin:` `after:` `before:` `during:` `is:confirmed`
`tag:`, `"exact phrases"` and `-exclusions`, plus relative dates like
`last week` and `3 months ago`.

### Bringing in notes you already have

Point Chitraq at a folder and it captures the documents, skips the machinery,
and tells you what it passed over and why.

```bash
chitraq ingest ~/Documents/notes --dry-run     # what would be captured
chitraq ingest ~/Documents/notes               # capture and read it
chitraq ingest ~/Documents/notes --no-extract  # capture the text only, fast
```

By default it takes `md markdown mdx txt text rst org adoc html htm pdf` and
leaves everything else, because a walk that swallows every `package.json` turns
a memory into a haystack. `--include json,csv` widens it; `--only` replaces the
list outright. `node_modules`, `.git`, `dist`, `.obsidian` and their kind are
never descended into, dotfiles need `--hidden`, and symbolic links are never
followed in either direction — one pointing at its own ancestor is a walk that
never finishes.

Two properties make a large import safe to just start:

- **Each file commits before the next one begins.** Ctrl-C loses nothing.
- **Capture is keyed on content and location.** Running it again skips what is
  already in, so there is no such thing as a half-finished import — only one you
  have not resumed.

That matters because reading is the slow part. With a local model, extraction
costs roughly twenty seconds a file; `--no-extract` stores the text in
milliseconds and leaves the reading for later.

Nothing from a folder enters memory on its own. Files become sources, sources
become proposals, and proposals wait for `chitraq review`. An import that says
"24 pieces of knowledge" means twenty-four things are waiting, not twenty-four
things you now believe.

Running it again is cheap. Size and last-write time are recorded per file, so an
untouched file is skipped before it is even opened; `--rescan` reads everything
again when you want that.

### Images and recordings

Chitraq has always stored these faithfully and said, honestly, that it could not
read them. With a local model it can:

```bash
ollama pull moondream          # or llava, llama3.2-vision
```

A photographed whiteboard, a screenshot, a scanned receipt — text out of pixels,
on your own machine. Voice memos go to any local Whisper server:

```bash
CHITRAQ_WHISPER=http://127.0.0.1:8080 chitraq ingest standup.mp3
```

**What comes out is a reading, not the document's own words.** A model that
misreads "38ms" as "88ms" produces text indistinguishable from a quote — so the
source permanently records which capability, provider and model produced it, and
every claim standing on it carries that doubt. Without a provider, nothing
changes: the bytes are stored and the gap is named.

Scanned PDFs work too. Every scanner app people actually use — Adobe Scan,
CamScanner, Microsoft Lens, the camera on a phone — writes JPEG inside the
PDF, and those bytes are already a complete image. Chitraq takes the file
apart and reads each page with whatever reads images.

Fax-encoded pages (`CCITTFaxDecode`, Group 3 and Group 4) are decoded too,
from the T.4 and T.6 tables, with no dependency. Almost nothing produces them
any more — that is fax machines and old office copiers — but a decoder is only
worth shipping if it can be shown to be right, so every fixture in the test
suite was encoded by libtiff and is asserted back pixel for pixel, and the
decoder was fuzzed against it over several thousand random pages.

`JBIG2Decode` is the one encoding left. It is named as unreadable rather than
guessed at, because there is no independent encoder to check it against.

---

## Two machines, one memory

```bash
chitraq sync http://192.168.1.20:4317 --dry-run   # what would move
chitraq sync http://192.168.1.20:4317             # move it
chitraq sync http://192.168.1.20:4317 --push      # send only
chitraq peers                                     # who you have synced with
```

Sync is explicit in every direction. No daemon, no timer, nothing in the
background: it happens when you run it and not otherwise, and it says out loud
when knowledge is about to leave your machine.

A peer is identified by its workspace, not its address, so a laptop reached at
home and over a tailnet is one peer. Where both sides edited the same thing, your
version is kept and the disagreement is raised — see `chitraq conflicts`.
Last-writer-wins would silently destroy one of two real edits. Nothing is ever
deleted by sync.

---

## Using a model Chitraq does not run

```bash
chitraq setup
```

One command, run whenever you like. It looks for Ollama first — if you already
have a local model, that may be the whole answer — and otherwise offers a list
of hosted ones with the free tiers at the top:

| | |
|---|---|
| **Groq, Google Gemini, Cerebras, GitHub Models** | free tiers |
| **OpenRouter, Mistral, DeepSeek, OpenAI** | metered |
| **Claude** | metered; the best of them |
| **llama.cpp, LM Studio, vLLM** | on your machine, no key, nothing leaves |

Everything except Claude goes through one adapter over plain `fetch`, because
they all speak the same protocol. Adding a host is a line in a table, and any
endpoint speaking that shape works whether or not it is listed:

```bash
CHITRAQ_OPENAI_URL=http://127.0.0.1:8080/v1     # anything local
CHITRAQ_OPENAI_PRESET=groq CHITRAQ_OPENAI_KEY=… # or a known host
```

**Setup makes a real call before it stores anything.** You paste a key, it
asks the model to summarise one sentence, and it shows you the reply. A key
that does not work is never stored — you find out while you are looking at it,
rather than three weeks later in the middle of an import. The default model
names here will go stale as providers retire them; `--model` overrides any of
them, and a retired name produces a plain error rather than a wrong answer.

Model names and free tiers change. What does not is the shape: your key, your
bill, your choice — Chitraq never pays for your tokens and never
holds them. Keys are sealed with AES-256-GCM before they touch the database and
are never handed back: the listing shows a mask, the HTTP API has no route that
reads one, and the audit log records that a key changed, not what it is. Setting
one takes effect immediately, with no restart.

The CLI refuses a key given as an argument, because an argument lands in your
shell history and in the process list, where it outlives any care taken storing
it. `chitraq setup` takes it as typed input that is never echoed; the
non-interactive path reads `CHITRAQ_KEY`.

To check a key still works later:

```bash
chitraq keys --test              # every stored key
chitraq keys --test groq         # just one
```

By default this protects a leaked database, not a compromised machine — the
secret sits in a file beside the store. If you want the stronger thing:

```bash
CHITRAQ_PASSPHRASE='...' chitraq keys --lock
```

Now the keys are sealed under something that exists nowhere on disk. A stolen
laptop, a synced folder, a backup and the database itself all yield the same
thing: ciphertext nobody can open. The cost is exactly what you would expect —
Chitraq needs the passphrase each session, and nobody can recover it for you.
Your memory itself is never encrypted and never at risk from this; only the API
keys are.

---

## Using it from your other projects

Chitraq is a memory your other programs can share. Start the server, mint a
token for each program, and talk to it over HTTP.

```bash
chitraq tokens --new formfit --scope write
```

The token is shown once. Put it in that project's environment:

```js
import { ChitraqClient } from 'chitraq/client';

const memory = new ChitraqClient({
  url: 'http://127.0.0.1:4317',
  token: process.env.CHITRAQ_TOKEN,
});

await memory.remember({
  title: 'FormFit compresses PDFs in the browser',
  body: 'So exam form uploads never leave the device.',
  kind: 'decision',
});

const answer = await memory.ask('why do we compress client-side');
```

The client is one file with no dependencies. It never caches and never retries
blindly: a memory client that quietly returns a stale answer is worse than one
that says the server is down, because you cannot tell a remembered fact from a
remembered *response*. `ChitraqUnreachable` and `ChitraqError` are separate
types so you can tell "nothing answered" from "it answered and said no".

Every route is listed in [`docs/API.md`](docs/API.md) — all sixty-four of
them, with the scope each one needs. That file is generated from the table
the server dispatches on and checked in CI, so it cannot describe a route
that does not exist or miss one that does.

### What a token is actually for

On one machine a token cannot make access harder to obtain — anything running
there could call the API anyway. What it does is make access **narrower**:

> Presenting a token constrains you. Presenting nothing changes nothing.

A `read` token is refused a write *even where an anonymous caller would be
allowed one*. So a dashboard or a side project can hold a credential that
genuinely cannot damage the memory it reads from, and that holds whether or not
you have configured a login.

| scope | may |
|---|---|
| `read` | search, ask, recall, timeline, entities, concepts |
| `write` | all of read, plus capture, relate and review |
| `admin` | everything, including erase, export, sync and credentials |

Tokens are stored as a hash and a six-character prefix, so a listing can say
*which* token without being able to reproduce it. Revoking keeps the record
that it existed — after deciding something should not have had access, knowing
what did is the thing you want most.

---

## Watching a folder

```bash
chitraq watch ~/Documents/notes
```

Captures changes as you make them, printing each one. It runs in the
foreground, installs nothing, and stops with the terminal — the thing Chitraq
avoids is *implicit* work, not convenience. It catches up on whatever changed
while it was away before it starts.

---

## Ideas that keep coming back

```bash
chitraq concepts
chitraq concepts --propose
```

A concept is a phrase running through several *separate* pieces of knowledge. A
phrase you wrote once is a phrase; one running through nine notes written weeks
apart is something you think in. Counted in documents rather than occurrences,
so one repetitive transcript proves nothing.

These are never created automatically. It is the only entity kind whose
evidence is a statistic rather than a shape, so every one waits for you.

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
docs/              architecture, invariants, HTTP reference, status ledger
```

Start with [`docs/INVARIANTS.md`](docs/INVARIANTS.md) — it lists the rules the
system is built to hold and points at the test that proves each one.
[`docs/STATUS.md`](docs/STATUS.md) says plainly what is implemented, what is
partial, and what is designed but not built. [`docs/API.md`](docs/API.md) is
the HTTP reference, generated from the routes themselves.
[`SECURITY.md`](SECURITY.md) says what is in scope, what is a deliberate
limit, and how to report something privately.

---

## Tests

```bash
npm test
```

406 tests covering the invariants, not just the happy path: that AI cannot
overwrite your edges, that a stale proposal is refused at accept time, that
memory survives the total loss of every intelligence provider, that superseded
pricing never appears as current, that two devices editing the same note raises
a conflict instead of losing one, that running out of budget never blocks
capture, that a scoped token cannot exceed its scope, that a file being written
is never captured half-finished, and that erasure leaves an audit trail.

The suite passes with **no models installed at all**. The deterministic
provider is the floor everything stands on.

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

## Where this actually is

Built and tested, not yet lived with. Everything described here works and has
tests; `docs/STATUS.md` lists what is implemented, what is partial, and an
honest weaknesses section that is kept current rather than trimmed. Read it
before depending on this for anything.

The parts most worth knowing about: JBIG2-encoded scans cannot be read,
concepts are the weakest entity kind, the Anthropic SDK call has still never
run against the live API (though the prompts it uses are exercised by every
other provider), and nothing has yet been used daily for a month by anybody.

`docs/INVARIANTS.md` lists the sixty rules the code is built to hold, each
naming where it is enforced and the test that proves it. `docs/ARCHITECTURE.md`
is the shape of the thing.

---

## Development

AI-assisted development was used throughout implementation for code
generation, refactoring, debugging assistance, documentation, and test
development. Architecture, specifications, design decisions, integration,
validation, and project direction were performed by the project author.

---

## Licence

**AGPL-3.0-or-later.** Use it, change it, self-host it, take your data
elsewhere. If you run a *modified* version as a network service, publish your
changes so its users have what you have.

If that does not suit what you want to build, ask about a commercial licence
rather than working around it.

See [CONTRIBUTING.md](CONTRIBUTING.md) if you want to send a change.
