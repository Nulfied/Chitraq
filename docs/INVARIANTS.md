# Invariants

The rules Chitraq is built to hold. Each one names where it is enforced and the
test that proves it. A change that breaks one of these is a change to the
project's foundations, not a refactor — see "Changing an invariant" at the end.

---

## The model/memory boundary

**1. Intelligence never writes memory directly.**
A capability returns a value. Anything that would become state goes through
`gateway.propose` → `validate` → `accept`. There is no other path into `object`
or `relation`.
· `src/intelligence/gateway.js`
· *ingestion produces proposals, not silent writes*

**2. A proposal cannot claim human origin.**
`origin: 'user'` in a proposal payload is rejected outright.
· `gateway.validate`, case `CreateObject`
· *a proposal may not claim to be human-authored*

**3. A proposal cannot touch what is not its business.**
Only `title`, `body`, `attrs`, `kind`, `epistemic`, `occurredAt` and
`validUntil` are proposable. Origin, review status, state, confidence and
anything touching permissions are not.
· `UPDATABLE_FIELDS` in `gateway.js`
· *a proposal cannot touch fields that are not its business*

**4. A proposal cannot rewrite what a human wrote and confirmed.**
· `gateway.validate`, case `UpdateObject`
· *a proposal cannot rewrite knowledge a human wrote and confirmed*

**5. Validation happens again at accept time.**
Memory may have changed since a proposal was made. A proposal that has gone
stale is marked invalid — and that marking survives, because it is written
outside the transaction that is about to be aborted.
· `gateway.accept`
· *a proposal that went stale is refused at accept time*

**6. Explicit user relationships outrank probabilistic ones.**
An edge asserted by a human is never overwritten, retracted or contradicted by
model output. The write is refused and reported, not silently dropped.
· `AUTHORITY` in `src/core/relations.js`
· *AI cannot overwrite a user-asserted relationship*

---

## Provenance

**7. Origin is permanent.**
Confirming AI-derived knowledge sets `review`, never `origin`. An AI-derived
fact a human checked is still AI-derived, and Chitraq keeps saying so.
· `objects.confirm`
· *confirming AI-derived knowledge does not relabel its origin*

**8. Every derived version records how it came to exist.**
Capability, provider, model, model version and run id, per version.
· `derivation` table, `objects.recordDerivation`
· *an accepted proposal carries its full provenance forever*

**9. Every intelligence call is recorded, including failures.**
· `Router.#record`
· *every intelligence call is recorded with its provider and outcome*

**10. A user assertion carries no confidence score.**
It is not a probabilistic claim, and giving it one would blur the distinction
the system exists to hold.
· `normaliseConfidence` in `objects.js`
· *creating an object writes version 1 and an event*

---

## History and time

**11. History is append-only.**
Editing appends a version. `object_version` and `event` rows are never updated
or deleted.
· `objects.update` → `writeVersion`
· *editing appends a version and never rewrites the old one*

**12. What was believed at a past instant is answerable.**
· `objects.asOf`
· *asOf reconstructs what was believed at a past instant*

**13. Superseding preserves both sides.**
The old object stays readable, marked superseded, linked forward, with its
validity window closed.
· `objects.supersede`
· *supersede preserves the old object instead of deleting it*

**14. Superseded knowledge never answers as current.**
Asking "what is our pricing" must not quote last year's price. Asking "what did
pricing used to be" must. Same material, opposite answers, decided by the
question.
· `passesFilters` in `search.js`, `extractiveAnswer` in `deterministic.js`
· *a current question never quotes superseded knowledge as fact*
· *a retrospective question answers with what was replaced, and labels it*

**15. Timestamps and identity are system-owned.**
No caller supplies an id or a recorded timestamp.
· `src/core/ids.js`

**16. No invented temporal precision.**
An unparseable date produces no filter rather than a confident wrong one.
· `resolveDate`
· *unparseable dates produce no filter rather than a wrong one*

---

## Truth and uncertainty

**17. Contradicting evidence is kept and surfaced first.**
· `sources.forTarget` ordering
· *contradicting evidence is kept and surfaced first*

**18. An answer cannot hide a disagreement in its own evidence.**
Both sides of a conflict are pulled into context together.
· `src/context/builder.js`
· *an answer never silently drops the other side of a conflict*

**19. A disagreement is only raised where it is relevant.**
Background material in a context does not get to raise warnings about itself.
· relevance gate in `builder.js`
· *an unrelated disagreement does not surface in an answer*

**20. Missing evidence is not false evidence.**
"Memory does not contain this" is a correct answer and is returned as one,
never padded into fluent prose.
· `extractiveAnswer`, and the grounding rules in every model prompt
· *ask answers from memory with citations, and admits when it cannot*

**21. Quality weighting adjusts ranking, never truth.**
A speculative note is not made false by ranking below a confirmed one, and the
reasons are returned with the result.
· `qualityMultiplier` in `search.js`
· *confirmed knowledge outranks unreviewed AI-derived knowledge*

---

## Resilience

**22. Memory works with no intelligence at all.**
Every capability has a deterministic local provider. Remove every provider and
capture, indexing, lexical search and context construction still work.
· `src/intelligence/providers/deterministic.js`
· *memory survives a total intelligence failure*

**23. A provider failure degrades the answer, never the store.**
The router falls through to the next provider; an embedding failure costs the
semantic signal, not the object.
· `Router.run`, `indexer.indexObject`
· *a failing provider is skipped and the fallback answers*

**24. Derived state is rebuildable.**
The whole index can be reconstructed from the objects.
· `indexer.rebuild`
· *the index is fully rebuildable from the objects*

**25. Nothing leaves the machine unless explicitly allowed.**
Remote and paid providers are off by default. Having an API key and permitting
network calls are two separate decisions.
· `DEFAULT_POLICY`, `src/config.js`
· *remote and paid providers are off unless switched on*

---

## The user

**26. Permissions are explicit.**
Never inferred, never model-decided. Object grants widen access; they never
narrow a workspace grant.
· `workspace.can`
· *permissions are explicit, and object grants widen rather than narrow*

**27. Declining is recorded.**
A rejected proposal is kept, with the reason, as a user-correction signal.
· `gateway.reject`
· *declining a proposal keeps it and records the correction*

**28. Erasure is possible, explicit, and auditable.**
`purge` is the only operation that destroys history. It requires a stated
reason, and the fact of erasure remains in the log.
· `objects.purge`, `Chitraq.erase`
· *erasing requires a reason and leaves an auditable trace*

**29. Memory is portable.**
Export carries objects, every version, relations, sources, evidence, provenance
and events.
· `Chitraq.export`
· *export carries the knowledge, its history and its provenance*

---

## Changing an invariant

These are not arbitrary. Each one exists because violating it makes memory
untrustworthy in a way the user cannot see. If one genuinely has to change,
record in the commit:

```
OLD DECISION      what the invariant was
WHY IT FAILED     the concrete case it got wrong
NEW DECISION      what replaces it
TRADE-OFF         what is now worse
AFFECTED          which subsystems and tests change
MIGRATION         what happens to memory already stored
```

Delete the test only after writing the one that replaces it.
