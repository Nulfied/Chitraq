# Security

Chitraq holds the contents of your notes and documents, encrypted API keys,
access tokens for other programs, and account credentials. A flaw here is not
an inconvenience, so this document says plainly how to report one and what to
expect afterwards.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting:**
[Report a vulnerability](https://github.com/Nulfied/Chitraq/security/advisories/new)

That page is on the repository's Security tab. It opens a private thread
visible only to the maintainer, so nothing is disclosed while it is being
fixed. It needs no email address from you and exposes none of mine, which is
the reason it is the only channel offered.

**Please do not open a public issue for a security problem.** CONTRIBUTING.md
says this too, and used to say it without saying where to go instead.

Useful things to include, none of them required:

- what an attacker can reach that they should not
- the smallest set of steps that shows it
- the version or commit you were on
- whether you were on loopback, a LAN, or something exposed further

If you are unsure whether something counts, report it. A misjudged report
costs a message; a missed one costs somebody their notes.

## What to expect

This is a single-maintainer project and it is honest about what that means.

| | |
|---|---|
| First response | Within about a week. |
| Assessment | Confirmed or explained, with reasoning. |
| Fix | As fast as the severity warrants. |
| Credit | Named in the advisory and the commit, unless you'd rather not be. |

If a week passes with no reply, the report was not seen rather than ignored —
say so again on the same thread.

Please give a reasonable window to fix something before publishing it. No
fixed number of days: a hole that exposes stored keys and a crash on a
malformed PDF do not deserve the same clock.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Tagged releases | None yet |

Chitraq is pre-1.0 and there are no releases to backport to. Fixes land on
`main`, and until a release exists, running Chitraq means running `main`.

## What is in scope

- Reading, writing or deleting memory without the right credentials
- Escaping an access token's scope — a `read` token that can write, a `write`
  token that can reach an `admin` route
- Recovering stored API keys, whether the vault is locked or unlocked
- Forging, replaying or predicting a session or access token
- Anything in sync that lets a peer write knowledge attributed to someone
  else, or read a workspace it was not given
- Path traversal out of the web root or into a file outside a folder you
  asked to ingest
- A crafted document — PDF, image, audio — that does more than fail to parse

## Known and deliberate

These are documented decisions, not undiscovered bugs. Reporting them is
fine, but this is the current reasoning:

**No authentication until an account exists.** A fresh install on 127.0.0.1
answers every route without credentials, because the only caller is the
person sitting at the machine. The moment an account is created, every route
needs a login or a token.

**Serving a non-loopback address without an account is refused at startup.**
That combination once served the whole workspace, the stored key list and the
issued tokens to anyone on the network, with no warning. It now refuses to
start and says why. `CHITRAQ_ALLOW_OPEN=true` overrides it deliberately; if
you set that on an untrusted network, the exposure is real and is yours.

**An unlocked vault lives in process memory.** Once you unlock stored keys,
anything that can read this process's memory can read them. Locking is what
makes them unreadable at rest, not while in use. Listed in `docs/STATUS.md`
under honest weaknesses.

**Chitraq is not multi-tenant.** Permissions exist, but the threat model is
one person, or a small group who already trust one another with the contents.
It is not built to keep two accounts on one instance secret from each other,
and a finding that amounts to "an admin can see everything" is working as
intended.

**Local models are trusted with what they are given.** A prompt-injection
payload inside an ingested document can influence what a model proposes. The
proposal gateway is the mitigation: nothing a model produces enters memory
without passing through it, and `ai` provenance is recorded on everything
that does. A finding that a model can be *influenced* is expected; a finding
that something bypassed the gateway is a real vulnerability.

## Secrets

If you find a credential committed to this repository, report it privately
rather than opening an issue — including old ones still reachable through
git history.
