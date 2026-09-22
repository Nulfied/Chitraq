# Contributing

Thank you for looking. A few things about how this project is built, so a
change you spend time on is a change that can be merged.

## Run it

```bash
git clone <this repo>
cd chitraq
npm test          # 424 tests, no install step — there are no dependencies
npm start         # http://127.0.0.1:4317
```

There is nothing to install. Chitraq uses `node:sqlite`, which ships with Node
24, and nothing else. **A pull request that adds a dependency needs to argue
for it in the description**, and the bar is high: every dependency is a thing
that can break, change licence, or be taken over.

## The rules the code is built on

`docs/INVARIANTS.md` lists sixty properties this project holds, each naming
where it is enforced and the test that proves it. They are not style
preferences. A few that catch people out:

- **Intelligence never writes memory directly.** A model returns a value;
  anything that becomes state goes through `gateway.propose → validate →
  accept`. There is no other path into `object` or `relation`.
- **Nothing is deleted quietly.** Versions are append-only. Supersession,
  archival and erasure all leave a record of what happened.
- **Disagreement is surfaced, not resolved.** Where two things conflict —
  including two machines syncing — both are kept and a human decides.
- **Capture never depends on intelligence succeeding.** If every model is
  unreachable, capture still completes and search still answers.

If your change breaks one of these, that is not automatically wrong — but say
so explicitly and follow the process at the end of `INVARIANTS.md`. A change
that breaks one silently will be sent back.

## What makes a good pull request here

**Measure before you tune.** Two numbers in this codebase were guesses that
turned out to be wrong by orders of magnitude, and both were caught by running
a benchmark rather than by thinking harder. `scripts/bench-vectors.js` exists
for this. If you change a threshold, show the measurement.

**Write the test that would have caught the bug.** Not a test that exercises
the new code — a test that fails before your change and passes after, named
for the behaviour rather than the function.

**Say what is still wrong.** Every module here states its own limits in its
header, and `docs/STATUS.md` keeps an honest weaknesses list. A feature that
works for the common case and not the general one is welcome; one that claims
otherwise is not.

**Comments explain why, not what.** The code says what it does. A comment
earns its place by recording a decision, a trade-off, or a mistake somebody
would otherwise repeat.

## Testing

```bash
npm test                                   # everything
node --test test/retrieval.test.js         # one file
node scripts/check-ollama.js               # live checks, needs Ollama running
```

Tests use `node:test` and run against `:memory:` databases, so they are fast
and leave nothing behind. Anything touching the filesystem cleans up after
itself in `t.after`.

The suite must pass with **no models installed at all** — the deterministic
provider is the floor everything stands on, and a test that only passes with
Ollama running is a test that will fail for most contributors.

## Licence

Chitraq is AGPL-3.0-or-later. By contributing you agree your work is released
under the same terms.

The short version of what that means: you can use, modify and self-host this
freely. If you run a *modified* version as a network service, you have to make
your changes available to its users. If that does not suit what you want to
build, ask about a commercial licence rather than working around it.

## Reporting something

For a bug, the most useful report says what you expected, what happened, and
the smallest thing that reproduces it. `chitraq status` output helps.

For a security issue, please do not open a public issue — use [private
vulnerability reporting](https://github.com/Nulfied/Chitraq/security/advisories/new),
and see [SECURITY.md](SECURITY.md) for what is in scope, what is a known
and deliberate limit, and what to expect afterwards. This paragraph used to
say "not a public issue" without saying where to go instead, which is most
of the way to saying nothing.

The parts most worth looking at are `src/core/keys.js`, `src/core/vault.js`,
`src/core/tokens.js` and `src/core/auth.js`, each of which documents what it
does and does not defend against.
