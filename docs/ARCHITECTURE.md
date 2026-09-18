# Architecture

## The shape

```
                            CHITRAQ
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
          MEMORY ENGINE              INTELLIGENCE FABRIC
         (deterministic)                (replaceable)
                 │                           │
   objects · relations · history    registry · router · gateway
   sources · evidence · events           │
   permissions · indexes          ┌──────┼──────────┐
                 │              built-in  Ollama   Claude
                 │              (offline) (local)  (cloud)
                 └───────────── SAME MEMORY ───────┘
```

The left side owns everything that must be true: identity, versioning,
timestamps, provenance, permissions, explicit relationships, consistency and
state transitions. The right side is a set of interchangeable capability
providers. The boundary between them is one function: `gateway.propose`.

## The loop

```
capture → persist → structure → connect → retrieve → contextualise
       → understand → feedback → evolve → remember ──┐
       └────────────────────────────────────────────┘
```

Implemented end to end in `Chitraq.remember`, `.ingest`, `.search`, `.ask`,
`.enrich`, `.accept`, `.correct` and `.supersede`.

## Writing knowledge

```
Chitraq.remember(input)
  │
  ├─ 1. objects.create ──────────► persisted, versioned, event emitted
  │      (never blocked by analysis — capture always completes first)
  │
  ├─ 2. indexer.indexObject ─────► chunks + FTS committed
  │      └─ embed (optional) ────► vectors; failure costs the semantic
  │                                signal, not the object
  │
  └─ 3. enrich (optional) ───────► keywords, entities, similar material,
         │                          relationship proposals, conflict checks
         └─ all output → gateway.propose → pending review
```

The ordering is the design. Persist, then index, then analyse — each step can
fail without damaging the one before it.

## Reading knowledge

```
Chitraq.ask(question)
  │
  ├─ query.parse ────────────► intent: terms, filters, dates, temporal,
  │                            retrospective, shape
  ├─ embed(question) ────────► optional
  ├─ search ─────────────────► lexical ∪ semantic ∪ structural, fused by RRF,
  │                            filtered, quality- and recency-weighted
  ├─ context.build ──────────► direct hits + neighbours + predecessors
  │                            + relevant conflicts, inside a token budget,
  │                            each with a stated reason
  └─ router.run('answer') ───► grounded answer + citations + uncertainty
                               (falls back to extractive quoting)
```

## The gateway

The single doorway between intelligence and memory.

```
capability result
      │
      ▼
gateway.propose ──► validate ──┬── invalid ──► recorded as invalid, kept
      │                        │
      │                        └── valid ────► pending
      ▼
  (human or policy)
      │
      ├─ accept ──► re-validate ──► apply ──► object/relation + derivation
      │                   │
      │                   └─ stale ──► marked invalid, refused
      │
      └─ reject ──► kept, with reason, as a correction signal
```

Validation is deterministic and total: unknown operations, dangling
references, cross-workspace references, out-of-range confidence, forbidden
fields, human-origin claims and human-confirmed targets are all refused before
anything is written.

## Why SQLite in core

Node 22.5+ ships SQLite with FTS5. That gives full-text search, transactions,
WAL concurrency and STRICT typing with **zero dependencies** — no native build
toolchain on Windows, no service to run, no install step beyond Node.

For a local-first memory engine this is not a convenience, it is the thesis
made practical: the claim "your memory does not depend on anyone else's
infrastructure" is only credible if the software does not either.

Vectors are `float32` blobs scanned linearly. At personal and team scale this
is a few milliseconds and exactly correct. An ANN index would add a dependency
and approximation error to solve a problem nobody has yet.

## Module boundaries

| Module | Owns | May not |
|---|---|---|
| `core/db` | connections, transactions, migration | know about domain concepts |
| `core/ids` | identity, time, hashing | be bypassed by any caller |
| `core/objects` | Knowledge Objects, versions, provenance | know about retrieval or AI |
| `core/relations` | edges, authority, traversal | be written to by a model |
| `core/sources` | verbatim material, evidence | rewrite a source to match an interpretation |
| `core/events` | the audit log | be updated or deleted |
| `retrieval/*` | indexes, ranking | be the source of truth |
| `context/*` | assembling the smallest sufficient context | assert anything |
| `intelligence/registry` | what capabilities exist | know which model is best |
| `intelligence/router` | selection, execution, recording | write memory |
| `intelligence/gateway` | validation and application | be bypassed |
| `intelligence/providers/*` | one provider each | import from `core/` except types |

Dependencies point inward. `core/` imports nothing from `retrieval/`,
`context/` or `intelligence/`. That is what makes "memory works without AI"
structural rather than aspirational.

## Adding a provider

```js
chitraq.addProvider({
  id: 'my-provider',
  label: 'Something better',
  locality: 'local',          // or 'remote' — gated by policy
  cost: 'free',               // or 'paid'  — gated by policy
  model: 'model-name',
  available: async () => true,
  capabilities: {
    'embed.text': {
      quality: 0.9,           // honest self-assessment; drives routing
      latencyMs: 50,
      costMicros: 0,
      run: async (task) => ({ model: 'model-name', vectors: [...] }),
    },
  },
});
```

Nothing else changes. The provider is ranked against the others by the active
policy, health-checked, recorded on every call, and skipped if it fails. If it
produces something that should become memory, it goes through the gateway like
everything else.

After adding an embedding provider, run `reindex` — vectors are only comparable
within one model, and Chitraq will warn you on the Status screen until you do.

## Execution model

Deterministic work is synchronous and immediate. Intelligence is asynchronous,
optional and isolated:

- **immediate** — persistence, versioning, events, FTS indexing
- **awaited but optional** — embeddings, enrichment (failure is absorbed)
- **deferred to a human** — anything that would assert new knowledge

There is no background job runner. Enrichment happens inline at capture and can
be re-run per object. That is a deliberate simplification: a queue is easy to
add when something needs it, and hard to remove once it exists.
