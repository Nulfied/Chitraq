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

## Identity and merging

**30. Deduplication is scoped to origin.**
Identical text you wrote and identical text a model produced are two pieces of
knowledge, not one. Collapsing them would destroy the provenance distinction
the system exists to keep.
· `objects.findByContent`
· *capturing identical content twice returns the original*

**31. Only an exact name match merges an entity automatically.**
Anything weaker is a suggestion with a stated reason. A wrong merge fuses two
histories and is tedious to unpick, so the bar is high and the decision is the
user's.
· `entities.resolve`, `entities.duplicateCandidates`
· *similar names are suggested, never merged automatically*
· *a shared surname alone is not enough to suggest a merge*

**32. Merging preserves the merged entity.**
It is superseded, not deleted; its names become aliases; every edge that
referenced it is re-pointed.
· `entities.merge`
· *merging re-points every mention and keeps the merged entity as history*

**33. Values are not entities.**
Dates, money and percentages are measurements. Making every "40%" a node would
swamp the graph with noise.
· `entities.entityTypeFor`
· *values are not turned into entities*

---

## Moving memory between machines

**34. Import never overwrites what is already here.**
Ids are preserved so provenance and links survive, but a stale export cannot
undo a local edit.
· `transfer.importWorkspace`
· *an import never overwrites knowledge already here*

**35. Rows that would dangle are dropped with a warning.**
A broken reference written quietly is worse than a missing row reported loudly.
· `transfer.importWorkspace`
· *rows that would dangle are dropped with a warning, not written broken*

**36. Sync records divergence rather than resolving it.**
Where the same object was edited on two devices, local state is kept, the
remote version is preserved, and a conflict is raised. Last-writer-wins would
destroy one edit with nobody the wiser.
· `sync.apply`, `sync.recordDivergence`
· *independent edits to the same object raise a conflict instead of losing one*

**37. Sync never deletes.**
A peer that has not seen your object does not get to remove it.
· `sync.apply`
· *sync never deletes anything the peer has not seen*

---

## Cost and degradation

**38. Budget is checked before the call, not after.**
A ceiling you can only discover by exceeding it is not a ceiling.
· `Router.candidates`, `budget.check`
· *a daily budget stops paid providers once it is spent*

**39. Running out of budget degrades intelligence, never memory.**
Paid providers stop being offered; the free and deterministic ones answer.
Capture, search and history never needed a paid provider.
· `budget.check` (free calls are never blocked)
· *running out of budget degrades intelligence, never memory*

**40. A provider going down is recorded.**
A failed health check drops a provider from routing before it is ever called,
so nothing lands in the run log — which would make an outage invisible.
· `Registry.isAvailable`, `onHealthChange`
· *if Ollama dies mid-session, memory carries on without it*

---

## Attention and prominence

**41. Salience is a nudge, not a lever.**
Bounded to ±15%. A memory engine that ranks by popularity stops being able to
find the thing you looked at once, two years ago — which is what you need it for.
· `salience.multiplier`
· *salience can never outweigh relevance*
· *nothing is ever hidden by low salience*

**42. Approximation is opt-in and measured.**
The vector index is only used above the size where it is measurably faster, is
built at reindex rather than inside a search, and reports its own recall.
· `ann.shouldUse`, `ann.benchmark`
· *small workspaces never build an index*

---

## Proactive behaviour

**43. Notices are read-only.**
Proactive surfacing points at objects and explains itself. It asserts nothing
and changes nothing.
· `proactive.forObject`, `proactive.forWorkspace`
· *proactive surfacing never modifies memory*

**44. Silence is the default.**
A notice must clear a threshold. Weak signals produce nothing rather than a maybe.
· threshold in `proactive.forObject`
· *unrelated material produces no notices at all*

**45. Expiring is not rejecting.**
A proposal nobody looked at is not a decision. Only a rejection is a correction
signal.
· `gateway.expireStale`
· *stale proposals expire without being marked rejected*

---

## Authentication

**46. Authentication is off until an account exists.**
A local single-user install reached over loopback needs no login step.
· `auth.isEnabled`, the gate in `server/http.js`
· *authentication is off until an account exists*

**47. Secrets are never stored in a usable form.**
Passwords are scrypt-hashed with a per-user salt; session tokens are stored
hashed, so a database dump yields no live sessions.
· `auth.setPassword`, `auth.openSession`
· *tokens are stored hashed, so a database dump yields no live sessions*

**48. A failed login says nothing about why.**
One message whether the user or the password was wrong, and a hash is computed
either way so timing does not reveal it.
· `auth.login`
· *the same message is returned whether the user or the password is wrong*

---

## Reading what cannot be read

**49. An unreadable file says so and names what would read it.**
A scanned PDF, an image or an audio file is captured verbatim and reports the
capability that would unlock it. Returning mojibake would put nonsense into
memory and call it knowledge.
· `capture/parse.js`, `capture/pdf.js`
· *a scanned PDF names the capability that would read it*
· *an encrypted PDF says so instead of returning rubbish*

**50. Text a machine read is never presented as text a person wrote.**
When OCR or transcription supplies a source's text, the source permanently
records `textVia` — capability, provider, model — and every claim standing on it
carries a reduced confidence and says so in its rationale. A model that misreads
"38ms" as "88ms" produces something indistinguishable from a quote, so the
distinction has to live in the data rather than in anyone's memory of how the
file got there.
· `chitraq.js#readMedia`, `sources.capture`
· *with a provider, an image becomes readable knowledge that knows it was read*

**51. A stored API key is never handed back.**
Keys are sealed with AES-256-GCM before they touch the database. The listing
returns a mask and a fingerprint, the HTTP API has no route that reads one, and
the event log records that a key changed, never the key. The plaintext exists
only between decryption and the provider call that uses it.
· `core/keys.js`, `server/http.js` route `/api/keys`
· *a stored key never comes back out*

**52. A key that cannot be used says so rather than looking absent.**
A key sealed under a secret this installation no longer has is listed, marked
unreadable, and refused loudly. Reporting "no key configured" would route the
request somewhere cheaper while the person believes theirs is in use.
· `keys.getKey`, `keys.list`
· *a key sealed under a different secret says so instead of looking absent*

**53. Sync never advances a cursor past changes the peer has not received.**
`changesSince` truncates at a row limit, and the payload says so. The push mark
only jumps after a complete two-way exchange of a complete payload; after a
truncated one it stays, and the caller is told there is more. Moving it would
drop those rows permanently and invisibly.
· `core/sync.js`, `chitraq.js#syncOverHttp`
· *a batched sync says there is more, and loses nothing across rounds*

**54. A key is never sealed under a secret that is not the one in force.**
While a passphrase is set and not supplied, storing a key is refused rather
than sealed under the file secret. The alternative is two kinds of key sitting
side by side with no way to tell from outside which is which, half of them
unopenable by whichever secret you have.
· `chitraq.js#setApiKey`, `vault.describe`
· *a key stored while unlocked is sealed under the vault, not the file*

**55. Locking and unlocking never strand a key.**
Both re-seal every stored key inside the same operation that changes the
secret. A key belonging to neither secret cannot be recovered by anyone,
including its owner.
· `chitraq.js#lockKeys`, `#unlockKeysPermanently`
· *removing the passphrase leaves the keys usable, not stranded*

**56. A concept is never created without a person saying so.**
Every other entity kind rests on a shape in the text. A concept rests on a
statistic, so it is proposed and never applied, whatever the accept policy says
elsewhere, and one declined is never suggested again.
· `chitraq.js#proposeConcepts`
· *proposing a concept writes nothing until a human accepts*

**57. A file is never captured while it is still being written.**
The watcher waits for a path's size to stop changing before handing it over.
Reading at the first event stores a fragment as though it were the document,
which is a corrupted memory rather than a missing one.
· `capture/watch.js`
· *a file still being written is not read half-finished*

**58. An access token is shown once and stored as a hash.**
Issuing is the only moment the plaintext exists outside the caller's hands.
The listing returns a six-character prefix, the HTTP API has no route that
reads one back, and the event log records the name and scope, never the token.
· `core/tokens.js`, `server/http.js` route `/api/tokens`
· *a token is returned once and never again*

**59. Holding a token can only narrow what you may do.**
A scoped token is refused work beyond its scope even where an anonymous caller
on the same install would be permitted it. Access is never widened by
presenting a credential, so a token is always safe to hand to a small program.
· `server/http.js` request handler
· *a read token is refused a write, where anonymous would be allowed*

**60. A route nobody classified costs a write, not a read.**
Route scopes default from the method and are overridden by an explicit list.
Forgetting to classify a new route fails closed.
· `server/http.js#scopeFor`
· *write does not reach the routes that destroy or grant*

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
