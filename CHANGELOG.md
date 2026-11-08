# Changelog

## [Unreleased]

### Fixed — scoped wake still carried the global dump; bare `project=<tag>` was silently ignored
- **The scoped wake layered project context ON TOP of the global dump
  instead of replacing it.** `wake --project mnemos` returned the mnemos
  scoped layer *plus* the Flutter goals, the shared daily tail, and mixed
  warm notes — the pollution was still there, now wearing a scope. When a
  project is named, the shared-file sections (goals, daily, warm notes,
  activity) are suppressed from the global part — a scoped wake's global
  half carries only true-global content (identity, roster, policy,
  vitals); the project's own goals/daily/warm come through the scoped
  layer. Bare wake keeps the full global sections (it is the menu).
- **`mnemos wake project=mnemos` was silently ignored.** Commander stashed
  the bare positional in cmd.args; wake ran unscoped and the user believed
  they had scoped. Now refused loudly: "'mnemos wake' takes no positional
  argument — use --project <tag>".

### Fixed — the CLI `mnemos wake` never exposed the scoped-wake contract
- **`mnemos wake --help` showed only `--budget`.** The scoped wake and the
  forced-choice design were built into the MCP tool and the engine — but
  the CLI command still called `runWake(cwd, budget)` with no project
  plumbing and printed only the global briefing lines. `--project <tag>`
  added (one call, global + scoped); `--json` added (the full
  projectWake/project_choice_required payloads for scripts); human output
  renders the scoped sections and the project-choice prompt. `--help` now
  teaches the whole contract.

### Changed — forced project choice on wake (Eric's design, refined)
- **`mnemos_wake` alone no longer carries project context at all.** No
  project arg and no configured default → the payload is global-only
  (identity, roster, policy) plus `project_choice_required`: the question
  the agent relays to the user verbatim, with the roster inline. The agent
  re-calls with `project=<tag>`; one call, global + scoped, merged.
- **`wake.project_default` in mnemos.config.yaml** — a vault may name a
  default project for sessionless calls; the config DEFAULT is empty (forced
  choice). This is a per-vault user decision, never a hardcoded project:
  the mnemos repo's own notes are a normal project here, not a privileged
  default (Eric's correction — the tool must not special-case itself).
- **The vault now hosts a `mnemos` project** (map + the tooling session
  records retagged out of roust/ai-flutter-chat), so this repo's own
  development record stops leaking into the app projects' briefings.

### Changed — scoped wake: global menu, per-project context (Eric's design correction)
- **Wake was a global dump; the briefing is now two-layered.** Eric spotted
  the architectural flaw: a shared `goals.md` and a shared `daily.md` meant
  every project's context bled into every other project's briefing — a
  roust session got Flutter goals and mnemos-session daily lines (including
  this repo's own work polluting the app vaults). The design is now what it
  should always have been:
  - **Global wake (`mnemos_wake` with no project):** identity, the project
    roster, policy gates, global reminders. The menu — not the meal.
  - **Scoped wake (`mnemos_wake` with `project=<tag>`):** that project's
    map Current State (the handoff), its daily lines, its recent notes.
    Everything an agent working ON the project needs; nothing from the
    others. The map resolves through the same routing chain as the ritual
    (config routing, then the `<tag>…map` convention).
  - An unknown project returns a warning naming the roster and the
    map-creation flow, not an error.
- Doctrine teaches the two-step boot (call twice: menu, then scope);
  MCP tool description matches. Cold-agent suite pins the contract:
  global wake carries no projectWake, scoped wake carries only that
  project's map and notes.

### Fixed — `mnemos sql --help` was unreachable
- The sql argv guard (which protects leading `--` SQL comments from
  commander) spliced `--` before `--help` too, turning the help flag into
  the query argument: `mnemos sql --help` ran a query and failed with
  "No .mnemos marker found" instead of printing help — the one command
  whose flags were invisible. The guard now exempts `--help`/`-h`; a test
  pins the exemption.

### Changed — CLI help finally explains itself
- **Every CLI command now carries a `--help` description** (wake, status,
  health, add, promote, archive, bridge, serve, index, graph, query,
  validate, prune, explore, init — previously fifteen bare names).
- **Top-level `mnemos --help` documents the vault-resolution contract:**
  `MNEMOS_VAULT` env wins, then the upward directory walk, then (serve
  --mcp only) the global-vault fallback — plus the fact that `cd`-ing into
  the vault makes every command work, and why MCP sessions always know the
  vault while the CLI does not. This is the exact gap Eric hit standing in
  `~` (`mnemos wake` → "No .mnemos marker found" with zero hints).
- **Two new docs tests** pin it: no command may ship bare, and the
  vault-resolution block may not lose its load-bearing lines.

### Fixed — layer 2: agent-forged PTY approvals (2026-11-08 demonstration)
- **The TTY gate alone was bypassable — demonstrated, then closed.** An agent
  wrapped `mnemos requests approve` in `script` (a real PTY), answered its
  own `[y/N]` prompt, and deleted the note; the audit line even recorded
  `interactive-tty`. The process tree is not forgeable in the same way: the
  kernel sets a process's parent. Approvals now walk the PPID chain and are
  REFUSED when an agent runtime (`~/.local/bin/ori`, `claude`, `codex`,
  `aider`, `cline`, `cursor-agent`, `goose`, anything under `~/.ori/`) is
  among the ancestors — refusal audited as `agent_runtime_ancestor` with the
  full ancestry chain and the agent's command image in the provenance.
  Demonstrated live: the exact `script`-wrapped attack that deleted a note
  before this change now refuses with the forged chain recorded
  (`script -> sh -> node -> bash -> ori`). Shells and interpreters are
  never treated as agent evidence (a false positive would lock a real user
  out of their own queue). Stated ceiling: double-fork daemonization
  re-parents to PID 1 and can hide a chain — this layer raises the bar from
  "any agent with `script`" to "an agent that deliberately forges its
  environment" and keeps the audit provably clean for every non-forged
  path; the absolute fix remains the transport-era app-mediated gesture.

### Fixed — the capability model's self-approval hole (found in the audit trail, 2026-11-08)
- **An agent shell could approve its own purge — and on 2026-11-07 one did.**
  The TTY guard added a confirmation prompt for interactive callers but let
  non-interactive callers fall straight through to execution, contradicting
  its own comment ("agent shell calls are ... refused here"). The previous
  mnemos session walked propose → self-approve → purge → restore on the live
  vault as a Phase 0 test, and the audit line recorded `by: "user"`. Eric
  never approved anything; the record lied. The guard is inverted now:
  approval and denial are REFUSED from any process without an interactive
  terminal — with the refusal itself audited (event `decision_refused`,
  provenance: TTY state, `MNEMOS_ACTOR`, confirm source). Real approvals
  keep the `[y/N]` prompt; the audit line records how the decision was
  confirmed (`interactive-tty` vs `injected`), so `by: "user"` can never
  again be written by the agent's own shell. Honest ceiling, stated plainly:
  a PTY wrapper could still hand an automated caller a TTY — the CLI-era
  fix is provenance and refusal-by-default; the complete fix is
  transport-side (app-mediated user gesture in the Flutter era), and the
  new injectable confirm seam is where it wires.

### Changed (phase 6 — per-project guides retired)
- **The two per-project MNEMOS guides are retired.** With phases 2-5 landed,
  the MCP server instructions carry the complete contract the guides taught
  (verified tool-by-tool; `mnemos_query_similar`/`mnemos_warmth` added to the
  RETRIEVE rule to close the last gap). The roust and ai-flutter-chat guides
  are archived at `docs/retired-guides/` for provenance; the project pointer
  files (MEMORY.md, AGENTS.md) now name the MCP instructions as the single
  source. One doctrine, one transport — per-client guides are how text drifts.

### Fixed (phase 5 — the cold-agent suite caught two real bugs)
- **Promoted notes were invisible to memory_sql and wake's roster until the
  next sync.** `mnemos_add`'s embed-on-write synced the derived index while
  the note still lived in `inbox/`; promote then moved the file, and nothing
  re-synced. The promoted note was absent from `note`/`note_project` for the
  whole session — memory_sql (readonly, never syncs) and wake's project
  roster (direct reads) both answered without it. `runAdd` now re-syncs the
  derived index after a successful auto-promote (best-effort, same contract
  as embed-on-write).
- **`type=moc` was silently reclassified to `insight` on auto-promote.**
  add passed description and project as explicit promote overrides but not
  type, so promote fell back to classification and downgraded maps. The map
  convention (routing, wake rosters, the ritual) keys on `type=moc`; a
  downgraded map still resolved by title luck but its type lied in the
  index. The agent's explicit type now reaches promote as an override.
- **`mnemos_forget op=purge` over MCP required a `query` argument** (the zod
  schema demanded the string even though purge is slug-addressed only).
  `query` is optional now; release/supersede refuse a missing query with a
  clear message.
- **Two roster contract fixes from the cold-agent run:** the ask-first
  gate's response shape is `{success, data: {askGate, projects, ask}}` over
  the wire; and the doctrine instructions on a first-run vault carry the
  onboarding flow (the full doctrine lands after identity is written).

### Added (phase 5 — cold-agent contract suite)
- **`tests/mcp/cold-agent.test.ts`.** The doctrine's promised lifecycle,
  executed by a brand-new agent over a real MCP server with tool surfaces
  ONLY: boot (wake/onboarding), project self-serve (ask-first gate → roster
  agreement between wake and the gate), capture → file → retrieve, the
  SESSION END ritual (map Current State + daily + goals through
  `file=map`), and the policy invariants (purge proposes and returns the
  user command; nothing deleted; identity proposes on a default-gate vault
  and the resource never changes). This suite is the regression wall for
  every future transport: if a Flutter-era sidecar breaks the ritual or the
  capability model, this suite's HTTP twin fails the same way.

### Added (phase 4 — one-command Ori wiring)
- **`mnemos bridge ori`.** Registers the mnemos MCP server in `~/.ori/mcp.json` —
  the Ori harness gets the full 17-tool surface with one command. Global-only
  by design: Ori is a single-user harness with its own session lifecycle, so
  the adapter writes the global config and installs no hooks. Preserves
  unrelated servers in the file; re-bridge updates in place; `--uninstall`
  removes only the `mnemos` entry. `mnemos bridge status` reports the Ori
  install. Follows the user's actual wiring (server name `mnemos`,
  `--vault <path>` args).

### Added (phase 3 — the ritual's last gap closed)
- **`mnemos_update file=map project=<tag>`.** Overwrites the project map's
  `## Current State` section — the SESSION END step the doctrine always
  demanded but no tool could perform (the agent would have had to break the
  direct-access ban). Replace semantics, never append: the new content is
  stamped `## Current State (<today>)` and surgically swapped in; Key Notes,
  frontmatter, and surrounding sections survive byte-identical; a `.history`
  backup precedes every write. Map resolution follows promote's chain —
  `project_map_routing` config first, then the `<tag>…map` slug convention —
  so a map that routes adds is a map the ritual finds. `section_created`
  reports a first-ever Current State append.
- **The write path is transport-neutral (`src/cli/update.ts`).** The MCP
  tool is now a thin shim over `runUpdateFile`; the HTTP sidecar and Flutter
  transports inherit identical gate, backup, and map-resolution behavior.
- **Policy gates wired to the write path.** `identity_update` (identity,
  methodology): `allow` writes, `approval` proposes a pending intent the user
  executes via `mnemos requests approve` (execution implemented — an approved
  identity intent now actually writes, with backup), `deny` refuses.
  `state_overwrite` (daily, goals, reminders, map Current State): `allow`
  writes, `approval`/`deny` refuse with the gate named.

### Added (phase 2 — the doctrine's promises made real)
- **Project roster in wake.** `mnemos_wake` (and `mnemos wake`) now carries the
  active-project roster — the same `note_project` rows the ask-first gate's
  refusal shows, so the agent files against what it was shown. Archived,
  superseded, and released notes are excluded, and map notes (`type=moc`) do
  not count toward a project's size. New `projects` section in the briefing
  (cap 8, drops with the low-priority sections), plus a structured `projects`
  array in the MCP payload.
- **`mnemos://policy` resource.** The effective policy sheet: all six gates
  with their configured levels, the removal law (propose/approve split,
  trash, audit, intent expiry), and whether the values came from
  `mnemos.config.yaml` or the defaults. Rendered by `renderPolicySheet` from
  the same `loadPolicy` the enforcement sites consume, so the sheet cannot
  drift from what is actually enforced.
- **Policy line in every briefing.** `policyLine` now covers all six gates;
  wake renders it as a one-line section so the agent can PREDICT refusals
  instead of discovering them by trial. The full detail stays one resource
  read away (`mnemos://policy`).

### Changed (capability model)
- **Ask-first gate for project filing.** `mnemos_add` with no project tag and no
  detectable project no longer silently files under the hub note: it stages the
  note in `inbox/` and returns the live project roster plus the question
  ("existing project, or a new one — and its name?"). The AI must ask the user
  and re-call with `project` set. Doctrine, tool description, and README updated.
- **No agent-callable delete.** The MCP surface has no unlink path: `mnemos_forget op=purge` now
  only records a pending intent (exact slugs, echoed back verbatim) and returns the user's approve
  command. Query-addressed purge was **removed entirely** — hard delete is slug-addressed only,
  after a fuzzy match unlinked 6 unintended notes (2026-11-07).
- **Approval queue:** pending intents live in `ops/requests/`, expire after 7 days, and execute
  only via `mnemos requests approve <id>` — a user-only CLI surface, not a tool the model can call.
  Interactive TTY confirmation on real terminals; no `--yes` bypass. Every executed purge copies
  files to `ops/.trash/` before unlinking, and an append-only audit trail
  (`ops/forget-audit.jsonl`) records every intent, approval, execution, and denial.
- Policy layer (`policy.gates` in mnemos.config.yaml): per-gate `allow | approval | deny` for
  purge, identity_update, protected_removal, bulk_effect, soft_removal, state_overwrite —
  enforced in the transport-neutral core so future transports inherit identical behavior.
- **Doctrine as a module (`src/core/doctrine.ts`).** The agent-facing instruction text — ground
  rules, PROJECT PROTOCOL (project discovery + the `<tag>…map` self-serve convention), CAPTURE
  POLICY (what belongs in memory and what never does), and SESSION END (the persist ritual) —
  renders from one transport-neutral module. The MCP server consumes it today; future transports
  (HTTP sidecar, Flutter app) render the same doctrine from the same source. Promote's "no map
  matched" warning now teaches the agent-legal fixes (create the map with a `<tag>…map` title, or
  fix its title) instead of pointing at config the agent cannot touch.

### Added
- `mnemos forget <op> <query>` CLI command and `mnemos_forget` MCP tool (17th tool) wire the
  query-addressed forgetting engine (`src/core/forget.ts`) into the user surface:
  `release` (soft-evict, files kept, filtered from retrieval), `supersede` (retire the best
  match and write its replacement with forward-declared `supersedes:` frontmatter), and
  `purge` (hard delete, CLI-only by design — an agent must not be able to unlink records).
  Dry-run is the default at both layers; the blast-radius cap (default 10, `Infinity` to
  disable) refuses over-broad queries.

### Changed
- Server instructions are now the single canonical doctrine surface. `buildInstructions`
  gained the capture flow (mnemos_add → inbox → mnemos_promote), state-file routing
  (mnemos_update; daily/goals feed the next wake), and the mnemos:// resource list. The
  bridge adapter snippets (CLAUDE.md / HERMES.md / AGENTS.md) no longer duplicate the
  session rhythm — each is a thin client shim: hook inventory plus the one boot line.
  Re-running a bridge command now refreshes an existing managed block in place instead
  of no-op'ing forever on the sentinel, so doctrine drift cannot freeze at first install.
- All live `mnemos_orient` references updated to `mnemos_wake` (bridge plan instructions,
  Cursor guidance, Hermes SKILL.md, cross-client configs). Dated audit docs and test
  comments recording the orient→wake migration are left as historical record.
- Hermes SKILL.md rewritten to the real MCP surface: mnemos_wake boot, memory_sql,
  mnemos_forget (release/supersede, dry-run default), and the correct tool inventory;
  removed dead mnemos_orient/mnemos_status/mnemos_query_important/mnemos_query_fading
  entries.
- docs/cross-client-configs.md: autoapprove list and verification steps updated to the
  real tool surface.

### Fixed
- Ranked and similar retrieval filtered forgotten statuses with the hardcoded
  `!== 'archived'` literal while indexstore/explore/engine used `isForgotten()` —
  the exact drift `status.ts` exists to prevent. Superseded and released notes
  resurfaced in ranked retrieval; both filter sites now use `isForgotten()`.
- CLI hang: `add`/`promote` could sit forever after printing because the onnxruntime
  embedding session kept the event loop alive, and `process.exit()` mid-session aborted
  with a libc++abi mutex error. Shared `emit()` now disposes the embedder, flushes the
  JSON, and exits from the stdout write callback with an unref'd backstop.

## [0.8.1] - 2026-10-01

Auto-promote fixes, found by adding notes to a real 1,571-note vault.

### Fixed

- **Auto-linking rewrote code and linked common words (#44).** Titles inside
  fenced or inline code are no longer turned into `[[links]]` (a diagram's
  `.mnemos/index.db` became `.mnemos/[[index]].db`). The default area (`index`) and
  hub notes (more than 128 incoming links) are no longer auto-linked from prose.
- **Suggested connections were the first notes alphabetically (#45).** A hub
  is no longer used to find related notes, since every note links it.
  Candidates are ranked by how many of the note's links they share.
- **`mnemos add` with a complete note (#46).** Content with its own `# Title`
  no longer gets a second one from the template. Content with its own
  `Relevant Notes:` / `Areas:` footer is used as-is, with no template
  instructions or empty footer appended. `$&` in content is kept literally.
- **Promote deleted the reasons on related links (#46).** `- [[note]] -- why`
  keeps its `-- why` when footers are merged; this affected every promote.

## [0.8.0] - 2026-09-30

### Breaking

- **MCP tool surface: 21 → 14 tools.** Removed `mnemos_status`, `mnemos_query`,
  `mnemos_query_important`, `mnemos_query_fading` (one `memory_sql` statement each;
  see the README migration table), `mnemos_explore_start/_expand/_conclude`
  (still available as `mnemos explore-start/-expand/-conclude` on the CLI), and
  `mnemos_orient` (first-run onboarding moved into `mnemos_wake`). Tool descriptions
  shrank ~2,500 → ~1,950 tokens per call.
- **Forgetting is a dry run by default.** `release`, `purge` and `supersede`
  only preview until called with `{ apply: true }`, matching `mnemos prune`.

### Added

- **`memory_sql` / `mnemos sql`**: read-only SQL over the index through six
  stable views (`v_note`, `v_link`, `v_dangling`, `v_retrieval`, `v_session`,
  `v_stage`). Writes are blocked by three independent layers.
- **Forgetting**: `supersede`, `release`, `purge`, with a blast-radius cap.
  ForgetEval 0/1000 → 978/1000.
- **Library entry**: `import { recall } from "mnemos"` now works. Every
  earlier version had no `main`/`exports`. `mnemos/cli` resolves the binary.
- **`mnemos index export-learned` / `import-learned`**: `.mnemos/` holds learned state
  (Q-values, co-occurrence, retrieval history) that the markdown cannot
  rebuild. Export it before deleting the index.
- **`mnemos add -d/--description -p/--project`**, and the same fields on
  `mnemos_add` (#39).
- **What's new**: the first session on a new version shows the agent these
  notes once; `mnemos whats-new` and `mnemos_whats_new` read them any time.
- Typed decisions (`decide`) with a trained local head for note type.

### Fixed

- **Learning ranked used notes below unused ones (#37).** Unlearned Q starts
  at 0, only real use (citation, update, re-recall) earns credit, and Q
  reranking now actually runs in the CLI and reaches rankings. Optional,
  ask-once reset for old-rule learning via `mnemos_learning_reset`.
- **Inline code made fake wikilinks (#40).** Bash `` `[[ -t 0 ]]` `` in prose
  no longer counts as a link.
- **Learner rows for notes that do not exist (#41).** Dangling links and
  parser false positives no longer get `note_q` rows; never-credited phantom
  rows are pruned on index sync, so `mnemos health` counts real notes.
- **New notes were born orphaned (#38).** The template no longer ships
  placeholder `[[related note]]` / `[[relevant map]]` links, and `mnemos add`
  strips them from older vault templates.
- **Silent LLM disable (#42).** A configured `api_key_env` that does not
  resolve now warns instead of quietly turning LLM features off.
- **Promotion routed 74% of project notes to the fallback.** Project tags and
  map titles are now compared by slug, and the fallback warns.
- `graph_metric` is actually written; exact-identifier recall reads note
  bodies; 11 `mnemos sql` output-contract defects; the recovery command rebuilt
  the wrong vault.
- Query-type lambda shifts removed and lambda capped at the measured optimum.

## [0.7.0] - 2026-09-16

Correctness release. Every fix below is behaviour reachable on 0.6.1, which is
what `npm` has been serving; the repository had been ahead of the published
build without a release to carry the fixes across.

### Performance — measured on a real 1,538-note vault, not a fixture

| entry point | before | after |
|---|---|---|
| `mnemos query ranked` | 3,344 ms | 350 ms |
| `mnemos query warmth` | 2,487 ms | 231 ms |
| `mnemos explore` | 3,785 ms | 474 ms |

- **Derived index** (`src/core/indexstore.ts`). Notes, links, projects, term
  postings, access counts and graph metrics are persisted in SQLite and synced
  per query, stat-filtered. Every query previously re-read and re-parsed the
  whole vault three to four times: `buildGraph` 2,088 ms + `buildNoteIndex`
  2,031 ms + `buildBM25IndexFromVault` 2,590 ms + `computeGraphMetrics` 388 ms.
  The index is derived and disposable; a missing or stale one degrades to the
  old scans with a warning, never a failure.
- **BM25 from stored postings**, scoped to the query's terms: 2,590 ms → 0.4–11
  ms, bit-identical scores (317,824 postings compared, 0 mismatches). Per-field
  counts are stored, so a `title_boost` change is live on the next query with no
  reindex.
- **Graph metrics cached** on a fingerprint of the graph (note count, edge
  count, latest reparse). An edited note invalidates; nothing else does.
- **`bootstrapFromWikiLinks`** target-inverted: 11,426 ms → 75 ms on the real
  vault. Two unfilled template placeholders (`relevant-map`, `related-note`)
  linked from ~880 notes each had produced 98.2% of all bootstrap rows; poster
  lists over 128 are now skipped, and the cap can only withdraw evidence, never
  invent an edge.
- **`injectExploration`** samples O(k) instead of shuffling all N titles.
- **`loadVectors`** prunes columns whose space weight is zero; warmth loads
  two vector columns instead of five.
- **`mnemos add`** reads the graph from the index instead of scanning the vault.

### Fixed

- **The CLI never learned.** `useIntelligence` required an external database
  and a caller-supplied session id, which only the MCP server passed. So
  `mnemos query ranked` never tracked a stage, wrote `stage_log`, persisted a
  bandit policy, logged exposure, or credited a Q-value. Production:
  717 `note_q` rows, 707 never updated; `stage_log` empty. The same query
  answered differently by transport (#34 §3). Fix-list items 5, 9, 10 were
  one defect.
- **The derived index never invalidated on an edit.** Freshness compared the
  indexed note count to the file count, which sees notes added or removed and
  is blind to a note changed in place. Sync is now unconditional.
- **Warmth and explore bypassed the index entirely** — only the ranked path
  had been wired. One seam, `openSyncedIndex`, now serves all four entry
  points plus `mnemos add`.
- **One of six composite scoring spaces was a constant.** `communityScore`
  returned 0.5 for every note while `community_vec` held 96 distinct patterns.
  It now derives a query community affinity from the top text matches;
  weighting chosen by a sweep of 5 candidates × 10 real queries × 4 metrics.
- **`measureCurrentQuality` could not see exact-identifier recall.** "Resume J"
  scored 0.005 as a success; with the lexical probe it scores −0.246, a
  failure. This is what let `bm25` be learned out of the pipeline while marked
  essential.
- **`getDecayedQ` decayed the initialisation constant** for exposure-created
  rows, and parsed SQLite's `datetime('now')` as local time — west of UTC every
  fresh row had negative age, so decay became growth.
- **Windows rename under a transient lock.** 374 of 480 renames failed with
  `EPERM` in an 8-writer reproduction. Frontmatter writes are now atomic
  (temp sibling + fsync + rename) with a bounded retry; exactly one raw
  `fs.rename` exists in the repository, inside the helper. Promote moves first
  and rolls back, so a note exists exactly once at every instant.
- **A read no longer writes user files.** Access counts accumulate in the index
  and flush to frontmatter explicitly; a query leaves note files byte-identical.
- **`mnemos index build` rebuilt embeddings only.** It now rebuilds all three
  derived stores, and the MCP `mnemos_index_build` calls the same function instead
  of bootstrapping co-occurrence privately inside a bare `catch`. `--force`
  drops and reparses the derived index. The "run `mnemos index build`" hint on a
  coverage warning pointed at a command that would not have touched the store
  complaining.
- **`mnemos health` now warns when learning is absent**: production shows 713 of
  807 tracked notes never credited, all 713 shown to an agent.
- `busy_timeout` and `foreign_keys` with `ON DELETE CASCADE` on the index
  connection; #1 is unrepresentable rather than remembered.
- Two byte-identical private copies of the BM25 defaults (`config.ts`,
  `bm25.ts`) are now one export. Found because a test imported a name that did
  not exist, received `undefined`, and passed anyway through the duplicate.

### Removed

- `computePropensity`, `buildPropensityMap`, `loadAccessLog` and
  `IPSConfig.epsilon`: no callers, and the first was O(events × results) per
  title — an invitation to a quadratic on the query path. The config parser
  ignores unknown keys, so an existing `mnemos.config.yaml` that still sets
  `ips.epsilon` keeps loading. `AccessEvent.results[].propensity` is kept: it is
  the on-disk log format.

### Fixed (earlier)

- **Stage bandit could starve a warm stage permanently** — `getStageDecision`
  evaluated the time-budget cutoff *before* the epsilon re-exploration check,
  so any stage reached after the budget was spent returned `skip` without ever
  passing the escape hatch. A stage that never runs gains no sample, so its UCB
  never moves, so it is never selected again. Measured on the live vault
  2026-09-12: all six non-essential stages frozen since 09-07, with `pagerank`
  holding the highest total reward of any stage (+68.0 over 137 samples,
  ~0.50/sample) while switched off, and `bm25` still running at −0.29/sample
  because it is `essential`. Ranked queries were effectively keyword-only.

  This completes the 0.6.1 fix rather than replacing it. That release moved the
  budget check below the *exploration-phase* gate, which protects cold-start
  stages (`sampleCount < MIN_SAMPLES`). It did not move it below the *epsilon*
  gate, so a stage that went cold after passing `MIN_SAMPLES` had no way back.
  All six frozen stages had 57–137 samples.

  Epsilon is now checked above the budget. Verified against `dist`: a stage with
  57 samples and negative reward at 450ms elapsed returns `run` 4.97% of the
  time over 20,000 trials, against 0.00% before.

- **`EPSILON` raised 0.02 → 0.05.** Recovery rate for a starved arm *is*
  epsilon; at 2% a frozen stage waited ~50 queries per sample. Expected added
  cost is epsilon × summed non-essential stage cost (160ms), so ~8ms per query
  against ~3ms. 5% is the conventional epsilon-greedy floor.

- **Flaky budget test pinned.** `tests/core/blind-34.test.ts` asserted the
  budget skip without pinning `random`, unlike its two siblings, so it failed at
  exactly the new epsilon rate. Pinned, plus a regression test asserting epsilon
  still runs a stage past the time budget.

See [stage-bandit-starvation.md](docs/stage-bandit-starvation.md) for the full
diagnosis, the measurements, and what it deliberately does not fix.

### Repository

- **21 of 57 test files were not in git.** `.gitignore` carried `tests/*` plus a
  hand-maintained allowlist of 36 individual files, so a newly written test was
  invisible by default. The ignored set included `atomic-writes`, `frontmatter`,
  `promote`, `tracking`, `indexstore`, `bm25-store`, `graph-metrics-cache`,
  `cli-learning-wiring` and `health-learning` — the tests that prove the fixes
  in this release. `tests/fixtures/` was ignored too, so the 36 tracked tests
  could not run from a clean clone. `tests/` is now tracked; the suite a
  contributor gets is the suite that runs here: 57 files, 862 tests.


## [0.6.1] - 2026-07-29

### Field-Report Fixes (#34)

Every code-level finding from the 0.5.5 field report, fixed:

- **Update cache moved out of `~/.mnemos`** — the update checker's cache directory doubled as a vault marker, making the walk-up treat `$HOME` as a vault for any process launched outside a real vault (MCP servers, cron). Cache now lives at `~/.cache/mnemos/` (XDG-aware; `%LOCALAPPDATA%\mnemos\Cache` on Windows), with one-time migration and legacy-file cleanup
- **`MNEMOS_VAULT` environment override** — honored by every command via the shared vault resolver; authoritative like `--vault` (fails loudly if the path is not a vault, never silently ignored)
- **Stage learner epsilon re-exploration** — stages disabled by transient failures now get 1-in-50 re-exploration chances instead of permanent abstention; skipped/abstained stages are surfaced in the response envelope as `stages_skipped`
- **Stage time budget configurable** — `retrieval.stage_time_budget_ms` (default 500) and `retrieval.stage_soft_cutoff` (default 0.8); the budget check now runs *below* the exploration-phase gate so cold-start stages are never starved
- **`--limit` honored on `query ranked` / `query similar`** — the CLI flag was parsed but never passed through
- **CLI update notifications** — `checkForUpdate` now runs after CLI commands (stderr only, TTY-gated, suppressed by `MNEMOS_NO_UPDATE_CHECK`/`CI`/`serve`)

Thanks to @wilsonalmeida for the exceptional field report.

## [0.6.0] - 2026-07-21

### Navigated Recursion: The Agent Steers the Graph

`mnemos explore` no longer returns a flat synthesis. The agent sees the decomposition tree — which branches produced results, which hit dead ends — and steers the traversal itself.

- **Navigated exploration sessions** — `explore-start` / `explore-expand` / `explore-conclude` (CLI + MCP tools)
- **Budget as nudge, not wall** — soft exhaustion with explicit extension instead of hard cutoff
- **Cross-encoder reranking stage** — joint query–note scoring on top of four-signal fusion, fully local
- **Dead-end semantics** — narrow pass 0, usedNotes validation, honest branch reporting from journey testing
- **Codebase normalization** — dead code deleted, no-unused enforced, CI test matrix added
- **Community fixes merged** — access_count write-back on retrieval (#33, @maichler), wikilink slug normalization + code-fence skipping (#32, #20), version single-sourced from package.json (#24)

RMH Constraint 2 — "unresolved queries must recurse" — goes from partial to real, with the agent navigating the recursion.

## [0.5.6] - 2026-05-18

### OpenCode Bridge: Full Lifecycle Integration

Complete bridge adapter for [OpenCode](https://opencode.ai) with first-run onboarding, session capture, and note validation.

- **First-run onboarding** — plugin detects blank `identity.md` and injects onboarding prompt via `client.session.prompt()`
- **Session capture** — `session.idle` hook fetches conversation messages via SDK `client.session.messages()` and saves via `mnemos add --content`
- **Note validation** — `mnemos validate` runs silently when writing to vault notes
- **Multi-vault support** — resolves vault path from `opencode.json` MCP config, works with any named MCP entry
- **One-command install** — `mnemos bridge opencode --scope project --activation auto --vault /path/to/vault`
- **Added `--content` flag to `mnemos add`** — allows programmatic note creation with real content (replaces template placeholder)

The OpenCode plugin uses `spawnSync` for silent command execution (matching Claude Code's hook behavior) and `client.session.prompt()` for reliable onboarding injection.

## [0.5.5] - 2026-03-23

### Ebbinghaus Warmth: Memory That Strengthens Through Use

Activation boosts now follow the Ebbinghaus forgetting curve. Notes accessed once fade fast (half-life ~7 days). Notes accessed repeatedly across many sessions become deeply embedded and fade slowly (half-life up to ~28 days).

- **Access count tracking** — each boost increments a per-note access counter
- **Session spread tracking** — tracks which distinct sessions accessed each note (last 20)
- **Adaptive decay rate** — `base_rate / (1 + 0.2 * ln(1 + access_count) + 0.3 * ln(1 + session_spread))`
- **Automatic migration** — existing databases gain the new columns on next open

This is the difference between short-term and long-term memory. Frequently accessed notes across many sessions become part of the agent's resting cognitive state.

## [0.5.4] - 2026-03-23

### Active Memory: Warmth Landscape in Orient

`mnemos_orient` now surfaces the memory activation landscape at session start. The agent sees what's warm before doing any work.

- **Top warm notes** — ranked by combined boost + Q-value score, with project tags
- **Project-level warmth** — aggregated warmth by project (e.g., "ai-agents: 4.2, courtshare: 2.1")
- **Heating/cooling detection** — notes gaining warmth (active <1 day) vs losing warmth (inactive >3 days)

No new infrastructure. Composes existing boosts table, Q-values, and frontmatter into a lightweight landscape (~25ms added to orient). This is the first step toward active memory — the agent starts every session knowing the shape of what's been on its mind.

## [0.5.3] - 2026-03-23

### RMH Constraint 3: Live Learning

The graph now reshapes during work, not at session end. Every retrieval immediately:

- **Co-occurrence edges** recorded per-query (notes retrieved together get wired together live)
- **Q-value proxy rewards** applied per-query based on retrieval rank
- **LinUCB stage learning** updated per-query with correct per-query features (fixes a bug where all stage updates previously used the last query's feature vector)

NPMI recomputation and homeostasis normalization remain at session end (global operations). Everything else is live.

**Why this matters:** For always-on agents with no session end, batch learning means no learning. Live learning is the only option. Cost: ~10-15ms per query (<0.5% overhead).

## [0.5.1] - 2026-03-23

### RMH Constraint 2: Recursive Explore

Unresolved queries now recurse. When `mnemos_explore` doesn't fully answer a query on the first pass, it identifies gaps and searches again — automatically.

**How it works:** An LLM reads the retrieved notes, generates sub-questions about what's missing, and Mnemos re-explores for each sub-question. New notes are accumulated across passes. The system converges when the LLM finds no more gaps, new notes drop below threshold, or the depth budget is reached.

**Multi-provider support:** Works with any OpenAI-compatible API:
- **Groq** (free tier, recommended) — Llama 3.3 70B, 30 req/min
- **Ollama** (fully local) — Qwen 2.5, Phi-3, Llama 3.2
- **OpenAI**, **Anthropic**, **Together AI**, **OpenRouter**, or any `/v1/chat/completions` endpoint

**Graceful degradation:** No LLM configured? `mnemos_explore` falls back to single-pass explore with PPR graph traversal, warmth, and Q-value reranking. No functionality lost — recursion is additive.

**Explore audit logging:** Set `MNEMOS_EXPLORE_AUDIT=true` to capture detailed recursion data locally — what recursion found vs flat retrieval, sub-questions generated, convergence status, per-pass breakdown.

See [docs/recursive-explore.md](docs/recursive-explore.md) for setup and configuration.

### Config

- `llm.base_url` now supported — point to any OpenAI-compatible endpoint (Groq, Ollama, vLLM, etc.)
- New explore config options: `recursive_enabled`, `max_recursion_depth`, `max_total_notes`, `convergence_threshold`, `sub_question_max`

## [0.5.0] - 2026-03-20

### Four-Signal Fusion Retrieval

- `mnemos_explore` — deep graph traversal via Personalized PageRank (α=0.45, HippoRAG-validated)
- Score-weighted Reciprocal Rank Fusion: semantic + BM25 + PageRank + warmth
- Q-value reranking from session learning signals
- Hebbian co-occurrence edge learning
- LinUCB stage meta-learning for retrieval strategy selection
- ACT-R cognitive decay (vitality system)
- 16 MCP tools
- Bridges for Claude Code, Hermes, Cursor, Codex
- HotpotQA multi-hop benchmark suite

## [0.4.0] - 2026-03-18

### Retrieval Intelligence

- 3-layer learning system: Q-value reranking, co-occurrence edges, stage meta-learning
- Gravity dampening (penalizes generic hub notes)
- Hub dampening (prevents map/index notes from dominating)
- Resolution boost (prioritizes decisions and learnings for action queries)
- Exploration injection (epsilon-greedy discovery of unseen notes)
- Update check in `mnemos_orient` — notifies when a newer version is published

## [0.3.5] - 2026-03-08

### Bridge Install Lifecycle

- `mnemos bridge` command for one-command client installation
- Claude Code bridge with hooks (orient, capture, validate)
- Archive SQLite cleanup and MCP graph caching fixes

## [0.3.4] - 2026-03-04

### First-Run Experience

- Interactive first-run boot sequence for `mnemos init`
- MCP directory metadata optimization
- npm registry discoverability improvements

## [0.3.3] - 2026-03-03

### The Emergence Bootstrap

- Graph-aware forgetting — vitality decay respects structural importance
- Bridge notes (graph connectors) decay slower
- Hub degree multiplier for high-connectivity notes
- Auto-init global vault on first MCP connection

## [0.3.2] - 2026-03-03

- Auto-init global vault on first MCP connection
- Token economics benchmarks in README

## [0.3.1] - 2026-02-27

- Fix: prevent empty stub notes from polluting vault
- npm keyword and repository URL cleanup

## [0.3.0] - 2026-02-26

### Identity Layer

- Identity system — agent self-knowledge in `self/` directory
- 3-signal retrieval engine: semantic embeddings + BM25 + graph expansion
- Agent onboarding flow
- MCP registry packaging

## [0.2.0] - 2026-02-26

### Promotion Pipeline

- Inbox → notes promotion pipeline
- LLM-assisted enhancement (description, type, links, project tags)
- Archive workflow with frontmatter preservation
