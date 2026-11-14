# How Mnemos Works — the mental model

One document for the concepts, from the user's side of the glass. No code
paths — for those, the code comments and `docs/specs/` are the deep reference.

## One store, three surfaces

Mnemos is **one vault** with **three ways in**, and they cannot disagree with
each other because they share the same index and the same laws:

1. **MCP** — how agents use it (wake, capture, retrieval, forgetting).
2. **CLI** — how humans inspect and drive it (`mnemos status`, `wake`,
   `explore`, `bridge`…).
3. **Library** — how a harness builder embeds it directly
   ([docs/library.md](./library.md)).

The markdown files are the truth; the index is derived from them; the learned
half (retrieval statistics) is exported alongside the markdown. You own every
byte; nothing phones home.

## The session arc: wake → work → capture

**Wake** opens a session. One call returns the standing context: who the agent
is, the vault's rules (the policy line), the project roster, and — when the
session's scope is known — that scope's full briefing (its map's Current
State, goals, recent daily log, due reminders, warm notes). Everything is
budget-capped: the briefing is bounded no matter how large the vault grows.

**Why the briefing never drowns you:** wake does not try to guess what the
session will be about. It passes what is true regardless of topic — the
standing state that past sessions *deliberately curated* (the map, the goals,
the daily log). Topical relevance is retrieval's job, not wake's.

**During the session**, the agent captures knowledge through tools
(`mnemos_add`, updates, session logs). New captures land in the inbox and
promote into the vault — auto-promotion when configured, with quality gates
(prose titles, schema validation, project routing). The user sees the adds
and the removes; the machinery stays out of the way.

**Retrieval** is where the vault earns its keep: every question an agent asks
can be answered from the vault's memory — keyword search, graph proximity
(wiki-links as spreading activation), embeddings, warmth (what has been
accessed or changed lately), and a learned layer that tunes retrieval from its
own results. Answers rank what matters and label what came from far away.

**Forgetting** is governed, not automatic: supersede (replace with a better
note, the old one marked), release (return to the user), purge (destructive —
propose-only, approval-gated, with blast-radius caps). "The user knows when
the agent removes" is a property the system is built to preserve.

## Projects and sessions — the scope model

The vault is shared by everything you work on; scope is how it stays focused.

- A **project** is a partition of the vault with its own map, goals, daily
  log, and reminders. Sessions scope to a project explicitly, by directory
  (`wake.project_paths`), or by config default.
- A **session** is one working conversation. Everything it does can be
  recorded in its own session stream.

**Where this is going** (the session-scope spec, `docs/specs/session-scope-spec.md`,
blessed 2026-11-12): sessions become the primary unit — every session bound
constructively with zero questions, lineage edges connecting continued and
branched sessions, project demoted to inferred metadata, and retrieval weighted
by scope distance so your own context leads while genuinely relevant knowledge
from *anywhere* in the vault still surfaces, labeled. This ships behind the
`retrieval.session_scope.enabled` flag (off by default) and flips only when the
benchmark proves it (dilution ≤ 5%, miss rate 0). Nothing about today's
behavior changes until then.

## What the vault does NOT do

- No background daemons, no cloud sync, no telemetry.
- No silent deletion — destructive forgetting is propose-only and
  approval-gated.
- No mind-reading: when something genuinely requires a human choice (like
  which project a conversational session belongs to), the agent relays the
  question — and the answer becomes durable, not re-asked.

## Reading more

- Setup: [docs/getting-started.md](./getting-started.md)
- Embedding in your own harness: [docs/library.md](./library.md)
- Design decisions with dates: `docs/specs/` and `CHANGELOG.md`.
