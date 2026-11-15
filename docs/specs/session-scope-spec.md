# Session-Scope Retrieval — the Spec

**Status:** Blessed by Eric 2026-11-12 (evening). This document is the fixed
target: every design argument is settled by pointing at a line here, not by
re-deriving intent from chat. Building starts against it when Eric says go.

## 0. Decision log (rulings with dates — cite these, don't re-derive them)

| Date | Ruling | Consequence |
|---|---|---|
| 2026-11-08 (`6f3e605`) | Reads honor the project contract; unscoped = whole vault by choice | `project=<tag>` hard filter shipped; one syntax, no `all_projects` flag |
| 2026-11-11 (`f5b41ac`) | Known-or-ask: silent scoping from intent signals only; else ask immediately | The fuzzy hint layer retired; roster lives in the question text |
| 2026-11-12 (evening) | **The pivot:** session-as-unit, project-as-firm-metadata, invisible machinery, newb/pro parity | This spec. Current contracts remain IN FORCE until the benchmark-gated flip (§9) |
| 2026-11-15 | **§5 blessing clarified:** Eric's blessing was given under the understanding that lineage was topic-based; after the correction (lineage = **asserted session-id edges** — topic relatedness is the *retrieval* layer, already shipped), blessing confirmed "as long as it works". **§5 interpretation (amended same day):** the floor design — unlinked notes sit at **L_floor = 0.8** (tunable), so the ladder reads own 1.0 > lineage 0.92^h > unlinked 0.8 > cross-scope 0.6. Rationale: §5's own sentence ("unrelated noise … must be *clearly better* to outrank own-scope context") requires own-scope context to sit ABOVE the unlinked mass, which the first proposed reading (unlinked = L 1.0) failed — and under it, asserting a lineage edge would DEMOTE a note (0.92 < 1.0), inverting §5's intent. The floor keeps the no-hard-filter promise (0.8 multiplies uniformly; rank order within the unlinked mass is unchanged) and makes lineage edges the promotion structure §5 intends. Eric's session observation — most sessions are compactions, forks, handoff-restarts, or fresh starts — accepted: lineage is expected to be SPARSE; the zero-wiring amendment (§3, pending) captures handoff-restart continuity as asserted edges. | `scopeweight` built with the floor design; constants tunable by the benchmark |
| 2026-11-15 (§3 amendments drafted) | **Zero-wiring ladder (§3.1) + late-binding record ADOPTION (§3.2)** written into the spec as first-class language. Evidence: Eric's session taxonomy — handoff-restart is the dominant pattern and only the MODEL can see its continuity (the harness cannot); rung 1 (model relay) is the only mechanism that captures it, and adoption keeps the thread consolidated when identity arrives late. Principles: the model is the adapter; one thread of work = one record (never fork); adoption is asserted, never content-inferred. | §3 sub-sections 3.1/3.2; the one remaining build behind them is the adoption path in `bindSession` |
| 2026-11-15 (**ACTIVATION**) | **Eric's ruling: "activate everything now — we are not on npm, so that doesn't matter; my own use case is the test; as we move on we re-run benchmarks; if something breaks we revert to a gated version."** Measured basis: the weighted world is strictly better (live vault: gated 23% → activated 10%, miss 0 at every constant setting down to P=0.05). Scope of the activation: default ON, scaffold ON, Eric's vault ON at the tuned constant (P=0.15). **The ask-first gate's RETIREMENT stays DEFERRED** until its replacement (inferred project stamping at capture) exists — retiring it today would leave new vaults with no project-assignment mechanism. The §9 gate re-judges continuously via the bench; revert to gated is one config line. | Default ON (all installs), scaffold ships enabled, live vault activated; adoption built (a1d5ada); the bench is the standing instrument |

The pivot supersedes known-or-ask **eventually, not now**. Nothing in this
spec changes live behavior until §9's criteria are met.

## 1. What this system is (one sentence)

Universal global storage that doesn't muddy or dilute session storage: every
session shares one vault, searches all of it, stays focused on its own
context by default, and never misses anything directly relevant — including
relevant knowledge that lives in other sessions, other lineages, or other
projects.

## 2. The scope ladder

Four scopes, arranged by distance, each with a defined relationship to the
one above it:

- **Session** — the unit of writing. Everything one session did: its stream,
  its notes, its decisions. Default focus.
- **Lineage** — continued and branched sessions. A continuation
  (`continues:`) inherits the parent's focus nearly fully; a branch
  (`branched_from:`) inherits strongly, decaying by hops. Context one edge
  away is context picked up, not recalled.
- **Project** — a firm but permeable partition. Firm: other-project noise
  essentially never dominates an answer. Permeable: genuine relevance buys
  back the boundary instantly ("that elegant method we used there" must
  cross as if the line weren't there).
- **Vault** — universal. The search space is always the whole vault. The
  storage never fragments.

**The governing invariant:** the default path assumes the user knows nothing
about the machinery and says nothing useful. Explicit pointers ("use the
roust method") are accelerations, never requirements. Newb and pro must get
the same correct answer from the same default path; the pro's pointers just
save work.

## 3. Session binding (zero questions, ever)

Wake stops resolving a project and starts **binding a session**:

- The harness supplies session graph metadata: `session=<id>` and, when the
  session continues or branches, `parent=<id>`. Deterministic intake — the
  harness knows its own session parentage; mnemos accepts it. This is the
  generalized opaque-harness intake: sources map to *sessions*, not projects.
- No harness metadata (bare CLI, cold MCP): the session binds constructively —
  an ephemeral identity from the invocation, a session record created on
  first capture. No naming ceremony, no ask.
- `project_choice_required` is retired at the flip. Before the flip it
  remains exactly as shipped. Projects become **inferred metadata** stamped
  from harness source/repo at capture — a hint for navigation and the user's
  curation, never a gate.

### 3.1 The zero-wiring ladder (who supplies identity, by harness class)

The binding args above are the *mechanics*. This ladder is the *supply path* —
and its principle is: **the model is the adapter.** No harness is excluded;
harness wiring is an optimization, never an entry requirement.

| Rung | Identity source | Result |
|---|---|---|
| **0** | Nothing → mnemos mints an **ephemeral id** per connection | Durable captures from the very first session, unnamed |
| **1** | The **model relays** what its context already shows — nearly every harness prints its session id; the model repeats it as `session=` | Durable **named** sessions with zero harness code changes |
| **2** | The **harness passes metadata** (hooks, plugin, native integration) | Deterministic intake — Pattern A, the optimization |

Rung 1 is first-class, not a fallback: the model reading its own context is
deterministic intake by another channel. The relay is honest exactly when the
model can SEE the id — an id the model invented is rung 0, not rung 1.
Lineage rides the same ladder: a session that knows it continued or forked
another session's work asserts `parent=` at any rung (see §3.2 and §4).

### 3.2 Late-binding record ADOPTION (rename + repoint, never fork)

Identity commonly arrives LATE: a session works under an ephemeral id (rung
0) or a provisional one, and only later — the harness reveals it, or the
model reads the handoff and recognizes the thread — does the real identity
appear. When it does:

- The named session **ADOPTS** the existing record: rename the record file,
  update the `session:` field, repoint every capture that referenced the old
  id, and preserve `created`, body, and any existing lineage edges.
- The thread **never forks**. One thread of work = one record, always; a
  fork would strand half the thread's memory under an orphan — the exact
  fragmentation this spec exists to prevent.
- If the adopted identity also declares `parent=`, the lineage edge is
  written at adoption — the handoff-restart becomes a first-class
  continuation instead of an invisible one.

Trigger conditions: adoption happens on explicit identity arrival (harness
metadata, or the model asserting an id it can genuinely see in context).
It is never triggered by content similarity — adoption is asserted, like
every lineage edge (§4).

## 4. Lineage edges

Session records gain two frontmatter fields, written by the binding path:

- `continues: <session-id>` — same thread, carried forward.
- `branched_from: <session-id>` — a fork; strong but decaying inheritance.

These are graph edges the engine already knows how to weight (PPR, warmth
handle edge types). Continuation is one hop of focus; "picking up that
context" becomes graph proximity, not retrieval heroics.

## 5. Scope-distance weighting (the no-dilution guarantee)

Every note's scope coordinates (own session, lineage hops, project) are
derivable from frontmatter and session-record links. Retrieval applies a
graded multiplier **post-fusion, pre-trim**, alongside the existing
dampening pipeline (which stays unchanged):

```
M(n) = L(hops) × P
  L(h) = 0.92^h          h = lineage hops from the reading session (h=0 → own)
  P   = 1.0 same project, 0.75 other scope
```

Starting constants, marked as tunable by the benchmark (§8). No hard filter
anywhere in the default path: unrelated noise doesn't vanish, it must be
*clearly better* to outrank own-scope context. Every result carries its
scope trace: `{ band, hops, multiplier, waived }`.

**Anchor waiver (the no-miss guarantee):** a note anchored by ≥1 rare token
from the query (reuse the forget matcher's `richTokens`/anchoring machinery —
the same insight that makes "Grace paella" an exact address) with a signal
score in the top decile of its signal gets its distance penalty waived
(`multiplier` raised to ≥ 0.95) and surfaces in the **reach tier** labeled
with its origin scope ("relevant from roust"). Rare evidence crosses any
boundary; common words never do.

## 6. Tiered answer shape

Results carry their shape instead of pretending one flat list is one thing:

- **Tier 1 — directly relevant:** own session + lineage + strong same-project
  matches.
- **Tier 2 — reach:** anchored cross-scope notes, each labeled with origin
  (`project_scope`/lineage distance). The original design's sin was mixing
  these silently; the cure is a labeled gradient, invisible to the user,
  legible to the agent.

The deliberate narrow tool survives unchanged: `project=<tag>` still
hard-filters on demand (the pro's pointer). It stops being the mental model;
the seeded default becomes the model.

## 7. Two-tier capture (the user only knows adds and removes)

- **Session stream** — `ops/sessions/`, append-only, auto-maintained by the
  binding path, zero gates, fast decay (the ops 3.0× rate). This is the
  machinery nobody sees.
- **Promoted notes** — the visible "adds." The existing inbox → promote
  pipeline, its quality gates, and its schema are the curation layer and do
  not loosen.
- **Removal** — the forget machinery's laws are unchanged and non-negotiable:
  dry-run default, blast-radius caps, purge propose-only with TTY +
  ancestry gates. "User knows when the agent removes" is a property to
  preserve, not revisit.

## 8. Scope-aware learning, decay, and the forever-vault

- **Learning:** Q-values, stage policies, and co-occurrence must be scoped
  (per scope-band at minimum). A roust-heavy week must not silently retune
  mnemos sessions. Global learning only where evidence is scope-independent.
- **Decay:** `coverDaily`'s fovea/mid/aged compression applied to lineages —
  recent sessions raw, old lineages compress into summaries, lineage edges
  decay, ancient streams archive. "Never miss" must survive year three.
- **Concurrency:** every session writing one shared vault is the product
  now. The 0.7.0 atomicity fixes carry over; session-stream contention
  (parallel sessions, related lineages) gets its own test suite.
- **Zero migration:** the live vault runs unmodified. Project tags read as
  ordinary metadata; existing maps stay; existing session records become
  lineage roots retroactively. If the design needs a re-tagging pass, the
  design is wrong.

## 9. The benchmark gate (the flip criterion)

Built from live vault data in `bench/`, two numbers decide everything:

- **Dilution:** the fraction of top-10 results that come from another scope
  band *without* anchor waiver. Target: ≤ 5% on the focus case set.
- **Miss rate:** the fraction of curated directly-relevant cross-boundary
  notes (the "elegant method" cases) absent from the answer's union of
  tiers. Target: 0%.

Benchmark cases drawn from the real vault: focus (each project's sessions
should own their top-10), reach (known cross-project references — e.g.
capability-model insights applied in ai-flutter-chat), dilution probes
(vague queries that historically blended projects — the "ai memory" phantom
case is the canonical one).

**The flip:** defaults change, contracts retire, and doctrine is rewritten
in ONE change set — only when dilution ≤ 5% and miss = 0 on the benchmark
set, measured, not asserted.

## 10. Implementation flags and sequencing

Everything ships behind `retrieval.session_scope.enabled` (default `false`)
until the flip.

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | This spec + benchmark cases | Eric blesses (✅ 2026-11-12) |
| 1 | Session binding + lineage edges (flagged) | Continuation/branch context flows in tests |
| 2 | Scope weighting + anchor waiver + tiered surfaces (flagged) | §9 numbers on the benchmark |
| 3 | Two-tier capture (stream auto, promote visible) | Zero-gate capture; forget laws intact |
| 4 | Scope-aware learning + stream decay | No cross-scope policy pollution |
| 5 | Benchmark-gated flip + one doctrine rewrite | Newb case: zero questions, full recall |

## 11. What does NOT change (in any phase)

Markdown-native storage; the vault-is-human-owned principle; the MCP-only
access law for client agents; the scaffold and bypass defense; the forget
machinery's capability model; the retrieval engine's signals (BM25, PPR,
embeddings, warmth, learning) — all of it is the substrate this spec
recombines, not replaces.

## 12. Open questions (Eric's to settle, none blocking Phase 1)

1. Weighting constants (§5) — tuned by benchmark, Eric reviews the curve.
2. Does the reach tier ever relay to the user, or is it agent-legible only?
   (Working assumption: agent-legible only — invisibility.)
3. The `explain` surface for pros: formalize `signalScores` + scope trace as
   a documented answer to "why did this surface?" — shape TBD during Phase 2.
