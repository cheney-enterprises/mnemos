# Session Handoff — 2026-11-12

Agent: Ori intern (z-ai/glm-5.3-flash), project mnemos. New sessions: read
`docs/project-briefing.md` first — it is the standing system prompt for
build sessions; this handoff is the delta since 2026-11-11.

## What this session accomplished

Eric's direction: "that works" (CLI access; no MCP server running in this
harness — OpenCode has no mnemos MCP configured) and "start on the proposed
working queue." The queue came from the briefing + handoff + the codebase
review; all five actionable items closed, one concern per commit, each
physically verified before its commit was claimed.

### 1. Map handoff debt closed first (vault write, no commit)
The missing session-end line from the 2026-11-11 handoff (bypass defense
b8a57e4 + the briefing f5270e8) was written into the mnemos map's Current
State through `runUpdateFile` (the exact engine the MCP tool calls — same
backup/audit semantics). Verified: section replaced with the 2026-11-12
stamp, Key Notes and frontmatter untouched, `.history/` backup present.

### 2. Forget machinery / note schema agreement (52c31c0)
- `released` joined the status enum — in `scaffold/templates/note.md` AND
  the live vault's `templates/note.md` (recorded repair): validation uses
  the vault-local template (`resolveTemplatePath`), so both must move in
  one change set.
- `supersede` replacements are born schema-valid: `created` is set, and
  the replacement inherits the replaced note's `project` (caller `-p`
  still overrides). First supersede tests the file ever had, plus a
  forget/schema-agreement pin validating `status: released` against the
  scaffold template.

### 3. `mnemos status` inboxCount honest (892e04b)
Counts `.md` only (mirrors `wake-sources.countMd`) — the scaffold's
`inbox/.gitkeep` no longer counts. The two sandbox tests that pinned the
stale behavior were corrected, not weakened. Live check: vault reports
inboxCount 0.

### 4. Intent-first write-path descriptions (487faee)
`mnemos_add` = "REMEMBER this — capture a durable note into the vault…";
`mnemos_update` = "UPDATE the standing state — the session-end ritual's
write verb…"; `mnemos_forget` = "FORGET memory the safe way…";
`mnemos_suggest_scope` = "WHICH PROJECT did the user mean?…". CLI `mnemos
add`/`mnemos forget` match (`update`/`suggest_scope` are MCP-only). No
contract text moved — gates, dry-run defaults, purge propose-only law all
verbatim. This closes item 1 from the wake arc.

### 5. Map-write hardening trio (998bead)
- **Whole-note shape check:** `updateMapCurrentState` refuses Current
  State bodies containing frontmatter delimiters, an H1, or a `## `
  heading (a `##` inside the stamped section becomes the boundary the
  NEXT write matches — the tail of the old state is orphaned as a
  pseudo-section), and refuses an empty body (compress, never wipe).
  Every refusal is audited as `map_write_refused`.
- **Argument-shape audit:** a valid-but-oversized body (>20k chars) still
  writes, with `argument_shape` in the audit and the note in the response
  — success:true never hides how a state came to be.
- **type=moc validation at map creation:** promote refuses a note that
  routes as a project map (routing config, or the resolveAreas
  convention: title ends in "map" AND carries a detected project's slug —
  "user plans a map" is not a map) unless type=moc, with the fix in the
  reason.
- **Root cause found en route:** `moc` was missing from the classifier's
  `VALID_TYPES`, so an inbox map note's explicit `type: moc` was thrown
  away and reclassified `insight` (low confidence) — the exact birth of
  mis-typed maps. `moc` joined `NoteType`; the documented
  `mnemos_add(<project> project map, type=moc)` flow promotes as a map.
- Map-title convention deduped into `mapstate.titleLooksLikeMap` (one
  routing truth shared by update and promote).
- Live verification: a `##`-heading body refused against the real mnemos
  map — refusal fired, map byte-untouched, audit line present. (First run
  of that check reported "map changed" — my script had compared an
  unawaited Promise to a string. The vault was fine; the check wasn't.
  Re-ran properly before claiming.)

## Session-end ritual (all through the tool surface, all backed up)
- Session record note added + auto-promoted under the mnemos map:
  `the-2026-11-12-hardening-session-the-forget-schema-agreed-…`.
- Map Current State overwritten (compressed: 2026-11-12 lead entry, wake
  contract + bypass/briefing condensed, next/blocked updated).
- Daily written to `ops/mnemos/daily.md`; goals updated (item 1 and the
  hardening trio removed; publish/sidecar/rename/honesty/harness remain).
- Briefing updated and committed (76063ec): Known Defects records all
  three fixes; the queue reflects what remains.

## Verification
- 1,206 tests green (83 files) at every commit; tsc clean; CHANGELOG
  [Unreleased] carries all four change sets.
- Commits: `52c31c0`, `892e04b`, `487faee`, `998bead`, `76063ec`.
- Working tree clean except untracked `.ori/` (runtime state) and this
  handoff until committed.

## Open items (next session)
1. **npm publish** of 0.9.0+ — blocked only on Eric's npm auth ticket.
2. **Restart MCP server processes** to pick up the new dist (no
   hot-reload): intent-first descriptions, roots behavior, and the
   map-write shape check are stale until then. Note: no mnemos MCP server
   is registered in the Ori/OpenCode harness itself — wake ran through the
   CLI; if Eric wants MCP-surface testing from this harness, register
   `node ~/dev/mnemos/dist/index.js serve --mcp` there first.
3. **Horizon:** Flutter HTTP sidecar (MCP tools mirrored 1:1, app-mediated
   approval gesture); opaque-harness intake (source→project mapping at the
   harness layer, no fuzzy logic in wake); `project rename` before the
   FORGE rebrand.
4. If a new defect appears: record it in the briefing's Known Defects
   section with the date and live evidence.

## Where things stand
The queue from the 2026-11-11 handoff is empty. The vault's schema agrees
with what the forget machinery writes; status and wake agree on the inbox;
the tool descriptions sell intent first; the map write path refuses to
accept a corrupted state and never lies in its audit. The package is
0.9.0+Unreleased, five change sets deep, waiting on one npm token.
