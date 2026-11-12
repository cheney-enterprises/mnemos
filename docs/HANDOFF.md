# Session Handoff — 2026-11-11

Agent: Ori intern (z-ai/glm-5.3-flash), project mnemos. New sessions: read
`docs/project-briefing.md` first — it is the standing system prompt for
build sessions; this handoff is the delta since 2026-11-09.

## What this session accomplished

Driver: five Eric directives across the session — (1) check whether the
instructional manual inflates context, (2) "get started on the next steps,
physically test everything," (3) "how does the agent know the project if I
just say 'open memory vault'?" and "the directory isn't always the project —
force a question or suggestions," (4) "we are overthinking this — just ask
immediately," (5) "the cold-start agents bypassed MCP and went straight to
the vault." Plus: a project briefing written at Eric's request.

### 1. Manual dedupe (commit 2e1fbc9)
The manual no longer restates command workflows/quality bars/capability
model — doctrine owns the always-present contract; the manual is the
section-addressed deep reference (§1 intended use, §2-4 scope/tagging/
naming, §5 layout, §6 pointers). 10.4 KB → 7.0 KB. Every trigger addresses
sections (wake pointer, both doctrine RESOURCES lines, onboarding
first-capture read stops at §4). New drift-guard test
(`tests/docs/manual-sync.test.ts`) requires the live vault's manual
byte-identical to the scaffold — it caught its first real drift the day it
shipped (this session, see below).

### 2. Resolve-first wake (commit 9913578)
- `wake.project_paths` config: repo dir → project tag (exact/nested match,
  longest wins, ~ expansion, `parseStringRecord` boundary validation).
- `resolveProjectByPath` pure resolver in `src/cli/wake.ts`; `path=` on the
  MCP wake tool; `--path`/`--ask` on the CLI.
- `resolution` block on every silent scoping (method: path|default + note).
- Intent-first tool descriptions on the retrieval five: wake ("OPEN the
  memory vault — call this FIRST"), query_ranked ("SEARCH memory"),
  query_similar ("FAST semantic search"), explore ("EXPLORE along the
  wiki-link graph"), warmth ("SEE what memory is resonating"). Q-value/PPR/
  RRF vocabulary trails.
- Doctrine SESSION START retargeted; README rows updated.

### 3. MCP roots bridge + ask + dir-suggestions (commit 96c5354)
- The MCP server is vault-bound — a bare MCP wake never saw the session's
  cwd. Fix: wake asks roots-capable clients (Claude Code/Cursor/Ori) for
  workspace dirs via `server.server.getClientCapabilities()` +
  `listRoots()`, feeds them through the path bridge. Verified end-to-end
  over stdio MCP with a roots-capable test client
  (`tests/mcp/wake-roots.test.ts`; harness gained a roots option).
- Precedence bug found and fixed: 0.9.0 had config default outranking a
  directory match — backwards; now most-specific-wins.
- `ask=true` (MCP) / `--ask` (CLI): forces the question through every
  silent path; explicit project still wins.
- Live vault config registers three repos: `~/dev/mnemos`→mnemos,
  `~/Desktop/AI Chat Project`→ai-flutter-chat, `~/Desktop/Alarm App`→roust
  (the folder-name↔tag mismatch case Eric raised).

### 4. Known-or-ask simplification (commit f5b41ac) — Eric's ruling
The suggestion layer manufactured phantom ties in the live vault: bare wake
from cwd "ai memory" ranked all three projects ~1.00 on "memory" (a token
every footprint contained — IDF formula ln(1+N/df) gave universal tokens
0.69 weight), and the race note named only the top two, hiding mnemos. Eric:
"we are overthinking this — the ai should just ask immediately."
- RETIRED: `hint=`/`--hint`, dir-name folding, race notes,
  suggestions-in-question. `mnemos_suggest_scope` keeps its original job
  (ranking the USER's vague words, never a silent wake path).
- FINAL CONTRACT: silent scoping from intent signals only (explicit
  project= / registered dir / config default); otherwise ask immediately —
  `project_choice_required.question` now embeds the roster with note counts
  (`projectChoiceQuestion()` in `src/cli/wake.ts`) so the relayed question
  always shows the existing options plus the new-project option.
- Suggester IDF fixed for its remaining callers (suggest_scope tool + the
  inline scoped-query suggestions in search.ts): df=N across N≥2 → weight 0;
  a lone candidate still earns full containment credit (what the N=1 inline
  suggester runs on). Pinned in `tests/core/scopesuggest.test.ts`.
- Unknown-project `projectWake` gained `new_project_ready: true`
  (machine-actionable create invitation).
- Test-suite drift from the signature change (hint removed) fixed;
  scoped-retrieval inline-suggestions test caught the N=1 IDF regression
  before commit — the two-tier formula is the fix.

### 5. Bypass defense at the filesystem layer (commit b8a57e4)
Eric's report: a cold-start feedback agent bypassed MCP entirely and
browsed the vault as plain files — every protective layer travels through
the MCP surface, so it received none, and the vault greeted it as
beautifully browsable markdown with no warning anywhere.
- `scaffold/AGENT.md`: the vault-front STOP sign (why a direct read
  misleads, why a direct write corrupts, the only correct door: wake bare →
  project=<tag>; or the CLI).
- `_bypass_warning` frontmatter line in `scaffold/templates/*.md` — the
  warning travels inside every file an agent opens.
- Manual's opening paragraph turns file-readers back to the door.
- Live vault: AGENT.md placed; warning injected into 61 files (notes +
  inbox + templates). Verified: validate/health/wake/index all tolerate the
  unknown field. Stated honestly in the note: a sign, not a lock.

### 6. Project briefing (docs/project-briefing.md, this session)
Standing intro/system-prompt for new build sessions: what the project is,
the dual workspace, **Eric's explicit standing authorization for direct
vault access by build sessions** (with the two disciplines: prefer the
tool surface when it buys backup/audit; record every direct write), Eric's
working rules with their scar-tissue examples, the non-breakable contracts,
session protocol, traps, known defects, and the queue (pointing at the
vault map as the live source).

## Session-end ritual completed (through the tool surface)
Map Current State overwritten twice during the day (after roots commit,
after known-or-ask commit — the last write predates the bypass-defense
work); daily written three times; goals updated once. **NOTE: the final
map/daily update for items 4-6 (known-or-ask details, bypass defense,
briefing) has NOT yet been written — the map's Current State still leads
with the pre-b8a57e4 state. The next session should write that handoff
line first.**

## Vault-side events worth knowing
- Eight overlapping notes were created in a capture reflex, then cleaned:
  six soft-released via forget, two restored after an over-broad
  `--max-forget 4` match released notes that were meant to stay (restored
  same-session by direct status edit + index rebuild; restore provenance
  line in each frontmatter). The consolidated session record is
  `session-record-2026-11-11-the-wake-arc-the-bypass-defense-and-the-over-capture-correction`.
- Three product defects discovered and recorded (see Known Defects in the
  briefing / the forget-machinery note in the vault): forget `released`
  status outside the note schema enum; supersede replacements missing
  `created`; `mnemos status` inboxCount can go stale.
- Live config edited directly (Eric's standing authorization): added
  `wake.project_paths` with the three repo registrations.

## Verification
- 1,197 tests green (83 files) at session end; tsc clean; CHANGELOG gate
  passes; `[Unreleased]` carries all five change sets.
- Commits: `2e1fbc9`, `9913578`, `96c5354`, `f5b41ac`, `b8a57e4`.
- Working tree clean except untracked `.ori/` (runtime state) and
  `docs/project-briefing.md` + this handoff (commit pending Eric's word).
- Physical verifications logged throughout: live-vault wake flows (cwd
  bridge, `--path`, `--ask`, unregistered dir), AGENT.md placement,
  61-file injection, post-injection validate/health/wake.

## Open items (next session)
1. **Write the missing session-end handoff line** into the mnemos map
   (items 4-6 of this handoff) — the map's Current State is one change set
   behind.
2. **Commit the briefing + handoff** (`docs/project-briefing.md`, this
   file) on Eric's word.
3. **Intent-first descriptions for the write-path tools** (add/update/
   forget/suggest_scope — item 1 remainder).
4. **Map-write hardening trio** (from the 2026-11-09 corruption incident):
   whole-note shape check in `updateMapCurrentState`, argument-shape audit,
   `type=moc` validation at map creation.
5. **Forget-machinery schema fixes**: add `released` to the note schema's
   status enum (or align the vocabulary); give supersede replacements a
   `created` field.
6. **`mnemos status` stale inboxCount** (observed once; verify before
   fixing).
7. **npm publish** of 0.9.0+ — blocked only on Eric's npm auth ticket.
8. **Restart MCP server processes** to pick up the new dist (servers do
   not hot-reload; descriptions and roots behavior are stale until then).
9. Horizon: Flutter HTTP sidecar (MCP tools 1:1, app-mediated approval
   gesture); opaque-harness intake — harnesses resolve session names/first
   messages via their own source→project mapping, like project_paths does
   for repos, with no fuzzy logic in wake.

## Where things stand
The wake contract is settled and simple: known-or-ask, roster in the
question, no fuzzy layer. The path bridge works over both CLI (cwd) and
MCP (roots), with three real repos registered. The defense now reaches
the filesystem for bypassing agents. The briefing gives future build
sessions their authorization and rules without Eric repeating them. The
package is 0.9.0+Unreleased, waiting on one npm token to publish.
