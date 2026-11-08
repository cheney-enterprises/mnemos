# Mnemos Memory — Agent Reference (MCP-first)

> **For every agent session working in this repo.** Verified against mnemos 0.8.1 + the live vault, 2026-11-04.
> The vault was rebranded from "Ori Mnemos" (`ori-memory`, CLI `ori`) to **mnemos** — that rename is what ended the collision with the unrelated `ori` agent-harness binary.

---

## 0. The one hard rule

**NEVER touch the vault directory directly.** No reading, writing, moving, or renaming files under `~/ori-memory-vault/`, no shell edits to notes, no direct edits to `.mnemos/`, `mnemos.config.yaml`, `ops/`, or `self/`. Direct file writes skip the schema, the graph, the embedding index, and the learning pipeline — they corrupt the vault invisibly.

**All vault access goes through the MCP tools.** The only sanctioned exception is the `mnemos` CLI (§8), and only when the MCP tools are not attached to your session.

## 1. What mnemos is

Markdown-native persistent memory for agents. Notes carry typed frontmatter; wiki-links (`[[note-title]]`) form a graph; notes have **vitality** that decays on a per-type schedule and revives when retrieved. The vault is the cross-project, cross-session source of truth — repo `MEMORY.md` files are pointers into it, not replacements for it.

## 2. Connect

At session start, check whether the vault MCP tools are attached (`tool-search` for `mnemos`). The server is registered globally (`~/.ori/mcp.json`, server name `mnemos`), so tools appear as `mcp_mnemos__<tool>` in this harness — `mnemos_wake`, `mnemos_add`, `mnemos_query_ranked`, `mnemos_explore`, `memory_sql`, and the rest. If they are missing, fall back to the CLI (§8) and mention it in MEMORY.md per AGENTS §12.

## 3. Session protocol

**Start (always, in this order):**
1. `mnemos_wake` — budget-capped boot briefing (identity, goals, reminders, what's new). Call this first; it exists so you never start cold.
2. Your project map's **Current State** — find it via `mnemos_query_ranked query="ai-flutter-chat project map"`, read the map note it returns. That section is the overwritten, always-current "where we are".

**During:** retrieve before you re-derive. Anything probe-proven, decided, or hard-won is probably already in the vault — `mnemos_query_ranked` first, `memory_sql` for questions ranking can't express.

**End (the handoff ritual — §7).**

## 4. Note types (the only valid `type` values)

| type | holds | decays in |
|---|---|---|
| `decision` | rulings, doctrine, locked choices + rationale | 30d |
| `insight` | confirmed bugs, platform facts, test plans, session snapshots | 30d |
| `learning` | process lessons, verification discipline | 30d |
| `blocker` | urgent must-not-forget items (use sparingly) | 14d |
| `idea` | unvalidated proposals | 90d |
| `opportunity` | spotted openings | 30d |
| `moc` | map/hub notes — never fade | — |

There is **no "handoff" type** — handoffs are a ritual (§7), not a kind of memory.

## 5. Writing — `mnemos_add`

```
mnemos_add(
  title:       "prose title with spaces",        # REQUIRED — see gotcha below
  type:        "insight",                        # from §4 (default insight)
  description: "one sentence adding context",    # REQUIRED IN PRACTICE — max 200 chars
  project:     ["ai-flutter-chat"],              # REQUIRED IN PRACTICE — routes to the map
  content:     "full note body …"                # your reasoning, evidence, wiki-links
)
```

- **Titles must be multi-word prose** ("ai flutter chat round13 collapsible editor doctrine reversal"). A hyphenated slug counts as ONE word and the add **silently fails** (`success:false`, exit 0). The tool slugifies the title for you.
- **Always pass `description` and `project`.** Omitting either fails the vault schema. The description is one sentence — it feeds ranking. **Never put history or changelogs in it.**
- Wiki-link inside `content` (`[[another-note-title]]`) is how the graph forms. Link the project map and any related notes.
- Notes auto-promote from inbox to `notes/` and auto-link to the project map (`project_map_routing`). If auto-promotion fails, finish it with `mnemos_promote` — YOU are the intelligence layer there: pass `type`, `description`, `links`, `project` overrides.
- **Updating an existing note beats adding a near-duplicate.** Junk dilutes retrieval.
- Supersession: when a new ruling replaces an old note, the old one should be marked `status: superseded`, `superseded_by: [[new-one]]` — use `mnemos_forget op=supersede` (§6) — it flips the old note and drops it from retrieval. Never delete history.

## 6. Reading — which tool when

| Tool | Use for | Notes |
|---|---|---|
| `mnemos_query_ranked(query, limit?, include_archived?)` | **Default retrieval.** | 4 signals (composite/keyword/graph/warmth) fused via RRF + Q-value rerank; triggers spreading activation |
| `mnemos_query_similar(query, limit?)` | Fast semantic-only lookup | Vector search, no graph — cheap first probe |
| `mnemos_explore(query, depth?, limit?, include_content?, recursive?)` | Multi-hop questions, connection discovery | PPR graph traversal; depth 3 = deep; heavier than ranked |
| `mnemos_warmth(context, limit?)` | "What memory is resonating with this conversation?" | Low-token titles + scores; good mid-session sanity check |
| `memory_sql(sql)` | Questions ranking can't express | Read-only, single SELECT/WITH, single-quoted strings, 200 rows / 2s hard cap. Views: `v_note`, `v_link`, `v_dangling`, `v_retrieval`, `v_session`, `v_stage` |
| `mnemos_forget(op, query, new_text?, project?, apply?, max_forget?)` | Retire knowledge: `release` soft-evicts matched notes (files kept, never recalled); `supersede` marks the single best match superseded and writes the replacement note | **Dry-run by default** — inspect the match list first, then `apply:true`. Refuses above the blast-radius cap (default 10). `purge` (hard delete) is CLI-only and human-only |

SQL recipes:
```sql
SELECT title FROM v_note WHERE slug NOT IN (SELECT slug FROM v_retrieval);        -- never retrieved
SELECT title, exposure_count FROM v_note WHERE exposure_count > 20 AND q_updates = 0;  -- surfaced, never useful
SELECT src_title FROM v_link WHERE dst LIKE '%topic%';                            -- who cites a topic
```
(`memory_sql` with `schema=true` returns full DDL.)

## 7. The handoff ritual (session boundaries)

A handoff is what you **do**, not what you **store**:

**Session end:**
1. **Durable residue → typed notes.** Each decision / confirmed bug / platform fact / lesson becomes its own `mnemos_add` note (§5), wiki-linked to the map and related notes.
2. **"Where we are" → overwrite the map's Current State:** `mnemos_update file=map project=ai-flutter-chat` with the new 3–5 lines + links as `content` (what's done, the next action, what's blocked on Eric). **Never append** — the map is a pointer, not a changelog.
3. **Full snapshot only when worth it:** one dated note (`ai-flutter-chat-handoff-YYYY-MM-DD-<commit>`, type `insight`). To retire the previous snapshot or any replaced ruling, use `mnemos_forget op=supersede` — the old note flips to `status: superseded` and drops out of retrieval automatically.
4. **Never** stuff history into a note's `description` — amendment history lives in the body.

**Session start:** `mnemos_wake` → map Current State. Do not go hunting for "the latest handoff note" — Current State is the living handoff.

> **GAP CLOSED (2026-11-07, phase 3):** `mnemos_update file=map project=ai-flutter-chat` now
> overwrites the map's Current State section through the tool surface — replace semantics, never
> append; Key Notes and frontmatter untouched; previous version backed up to `notes/.history/`.
> The SESSION END map step is performable exactly as written: pass the new 3–5 lines as `content`.

## 8. CLI fallback (only when MCP tools are not attached)

Run from `~/ori-memory-vault/` (or pass `--vault ~/ori-memory-vault`). JSON output; `MNEMOS_NO_UPDATE_CHECK=1` silences the update notice when scripting.

| Command | Purpose |
|---|---|
| `mnemos status` / `mnemos health` | counts / full diagnostic (orphans, dangling, schema violations) |
| `mnemos add "<prose title>" -t insight -d "…" -p ai-flutter-chat -f body.md` | write path (all §5 rules apply) |
| `mnemos query ranked "<text>"` / `mnemos query similar "<text>"` | retrieval |
| `mnemos explore "<question>" --depth 2` | deep recall |
| `mnemos sql "SELECT …"` | precise SQL |
| `mnemos index build --force` | rebuild embeddings (also fixes stale index) |
| `mnemos promote <note>` / `mnemos prune` / `mnemos validate <note>` | inbox promotion / archive candidates / schema check |

The CLI is a *fallback interface to the same engine*, not license to touch files.

## 9. What NOT to do (failure modes already paid for)

1. **Appending session narrative to a map.** A map ballooned to 55KB this way; retrieval drowned. Current State gets overwritten, residue becomes notes.
2. **History in `description`.** One note reached 3,985 chars (limit 200) and poisoned its own retrieval. Descriptions are one sentence.
3. **Unquoted `: ` in frontmatter / missing frontmatter.** Two notes became unreadable to the tool this way. Through MCP tools this can't happen — one more reason to never write files directly.
4. **Inventing note types.** `type: session-handoff` is invalid; the schema rejects it (use `insight`).
5. **Single-word/slug titles via CLI add** — silently fails (`success:false`, exit 0). Prose titles only.
6. **Direct file edits** — see §0.

## 10. Housekeeping tools (call only on user instruction or notice)

- `mnemos_health` — orphans, dangling links, schema violations, fading notes. Run after bulk writes.
- `mnemos_prune(apply?)` — dry-run by default; `apply:true` archives. Ask Eric before applying.
- `mnemos_index_build(force?)` — re-embeds changed notes; `force` rebuilds all. Run after big imports.
- `mnemos_validate(path)` — schema-check one note.
- `mnemos_whats_new(version?)` / `mnemos_update_decision(version, decision)` — update notices; **only record a decision the user explicitly gave** (never on their behalf; deferral = don't call).
- `mnemos_learning_reset(decision)` — same rule; only after an explicit user answer.

## 11. Project-specific anchors

- **Map:** `[[ai-flutter-chat-map]]` — Current State here is the session opener.
- **Project tag:** `ai-flutter-chat` (routing auto-links every `-p ai-flutter-chat` note to the map).
- **Sync rule:** a new decision / confirmed bug / key fact lands in BOTH repo `MEMORY.md` (one line) and a vault note (full note). MEMORY.md points; the vault holds.
- **Plans of record** for the performance track: `RASTERIZATION_LAG_PLAN.md` + `RASTERIZATION_LAG_REPORT.md` (repo) — mirrored into the vault's handoff/state notes.

---

*This guide replaces all earlier "ori" memory instructions. If any instruction elsewhere (including old vault notes) contradicts §0, §0 wins.*
