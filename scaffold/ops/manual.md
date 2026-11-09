---
description: The operating manual — intended use, global vs project vs session, naming, and command workflows
type: manual
---

# Mnemos Operating Manual

This vault is one agent's memory serving one human across many projects.
This file is the operating manual: what the system is for, how the layers
divide, and how to run every command. The MCP server instructions teach
the same rules in compact form; this file is the deeper reference.

---

## 1. Intended use

**Use mnemos for:** decisions and their rationale, confirmed bugs with root
causes, probe-proven platform/environment facts, test plans and pass bars,
policies and doctrine rulings, lessons from failure, session handoffs.

**The test:** *if a fresh session had to rediscover this expensively, it
belongs in the vault.*

**Do not store:** ephemeral task state (the file currently being edited,
temp paths), things relevant only to the current conversation, raw session
transcripts. The durable residue goes in — not the narrative.

**Time horizon:** `notes/` holds knowledge measured in weeks-to-forever.
The `ops/` files hold state measured in days. If a note would be stale in
a week, it probably belongs in a daily log, not the graph.

---

## 2. The three scopes: GLOBAL / PROJECT / SESSION

Everything you write lands in exactly one of three scopes. Choose
deliberately:

| Scope | What it is | Lives in | Wake reads it |
|---|---|---|---|
| **GLOBAL** | True across every project — the agent's identity, umbrella goals, cross-project obligations | `self/*.md`, `ops/daily.md`, `ops/reminders.md` | always |
| **PROJECT** | Belongs to one project — its goals, its session log, its reminders, its knowledge | `notes/` (tagged), `ops/<tag>/*.md` | when woken with that project |
| **SESSION** | Ephemeral — dies with the conversation, never written down | nowhere (that is the point) | never |

**Decision rules:**

- Will this matter to a different project later? → GLOBAL
- Does this belong to exactly one project's future? → PROJECT
- Will this be irrelevant once the session ends? → SESSION (don't write it)

**Global items are rare.** A reminder is global only if it binds the agent
itself across all work ("keep the vault honest"), not if it mentions
another project ("publish the mnemos package" is the mnemos project's
reminder even though it references tooling).

**Session state stays out.** Current file being edited, intermediate
reasoning, temp paths — these die with the conversation. Writing them
down is how memory rots.

---

## 3. Every entry carries its project

Every note names its project in `project: [tag]` frontmatter — written at
capture, never retrofitted. The ask-first gate enforces it: a note with no
project and none detectable is staged in `inbox/`, not filed, until the
user names one.

- **One note, one primary project** is the norm. Two tags are legal
  (the note appears in both membership sets) but rare — use only when the
  note genuinely serves both.
- **Retrieval follows the tag**: `project=<tag>` on the read paths filters
  to the tag's membership set; dropping the filter searches the whole
  vault (cross-project learning is the unscoped default).
- **Audit it**: `mnemos query cross-project` lists notes tagged with
  multiple projects; `memory_sql` over `note_project` answers anything
  else.

---

## 4. Project naming

Tags are **lowercase, hyphenated, stable, and short**: `roust`,
`ai-flutter-chat`, `mnemos`. The tag becomes:

- the frontmatter tag (`project: [roust]`)
- the map's routing identity (`ops/` state dir + the `<tag>…map` note)
- the wake/retrieval scope parameter

**Rules:**

- Never rename a tag after notes exist — you would orphan every membership
  row. Choose as if permanent.
- The project's map note title MUST start with the tag and end with
  `map` (`roust-project-map`) — routing finds maps by this convention.
- One project = one tag. "Auth" and "auth-work" are two projects to the
  machinery; do not create near-duplicates.

**The default project:** a vault may set `wake.project_default` in
`mnemos.config.yaml` for sessions that have no project of their own — the
canonical case is a **general chat session** (talking with the agent, no
project work) landing on a scratch project instead of being forced to
choose. Default is empty: bare wake forces an explicit choice. Setting a
default is the user's config decision, and it should be a *passive*
project (chat/scratch), never an active workstream — sessions must not
accidentally inherit an active project's context.

---

## 5. The layers: what each area is for

- **`notes/`** — KNOWLEDGE. Durable, cross-session, cross-week. Typed notes
  with wiki-links; each project's map holds `## Current State` — the
  overwritten, always-current handoff.
- **`inbox/`** — the airlock. Everything `mnemos_add` writes lands here
  first; the ask-first gate decides what may proceed to `notes/`.
- **`self/`** — the agent's IDENTITY. One agent, one self-model, global by
  nature. Rewrites are gated (`identity_update`); the user approves.
- **`ops/`** — OPERATIONAL STATE. What the agent is doing now: global
  (`daily.md`, `reminders.md`) and per-project (`ops/<tag>/`). Wake reads
  this layer first. Also the capability model's machinery: `requests/`
  (the approval queue), `.trash/`, `forget-audit.jsonl` (the audit trail).

In one line: **notes/ = knows, self/ = is, ops/ = does, inbox/ = not sure
yet.**

---

## 6. Command workflows

### Session lifecycle (the core loop)

1. **Boot:** `mnemos_wake` with the session's project. Unknown project?
   Bare wake returns the roster + the question — relay it to the user, get
   the answer, re-call. Never work unscoped.
2. **During:** retrieve before re-derive — `mnemos_query_ranked` first
   (scoped to the project when the answer should be project-local; unscoped
   when you want the wide net), `memory_sql` for what ranking cannot
   express, `mnemos_explore` for multi-hop questions.
3. **Capture when it surfaces:** `mnemos_add` (typed, tagged, wiki-linked).
   If you don't write it down, it won't exist next session.
4. **Session end (the ritual):** durable residue → `mnemos_add`; map
   Current State → `mnemos_update file=map project=<tag>` (overwrite,
   3–5 lines: done / next / blocked); the project's daily →
   `mnemos_update file=daily project=<tag>`; goals if they moved →
   `file=goals project=<tag>`. The next session starts cold except for
   what you persisted.

### Removal (the capability model)

- `mnemos_forget op=release` — soft-evict; files kept, reversible.
  Dry-run by default; review the match list, then `--apply`.
- `mnemos_forget op=supersede` — retire the best match, write its
  replacement. Same dry-run discipline.
- `mnemos_forget op=purge --slugs <exact,slugs>` — PROPOSES only: records
  an intent, returns the approve command. Never executes from the agent.
- `mnemos requests approve|deny <id>` — USER ONLY, from a real terminal
  (agent shells and agent-forged PTYs are refused; every decision and
  refusal is audited with process provenance).

### State writes

- `mnemos_update file=daily|goals|reminders project=<tag>` → the project's
  own `ops/<tag>/` files (the scoped wake reads these first).
- Bare (`no project`) → the global files. Global items are rare; be sure
  the item really spans all projects before writing it globally.
- `mnemos_update file=identity|methodology` — the self-model. Gated:
  at `identity_update: approval` the agent proposes and the USER executes
  the pending intent.

### Cross-scope references

When the user says "remember that thing from the pirate chat" — outside
the current scope — do not answer from nothing. Query scoped first; if
thin (a `project_suggestions` field appears, naming likely projects), run
ONE unscoped query or query the named scope directly. When found: cite
the source scope ("from your pirate-adventure chat…"), and if durably
useful here, link it in (`[[the-note]]`) — the link is the memory of the
connection. `mnemos_suggest_scope` ranks fuzzy references ("the alarm
snooze stuff") to likely projects before you search or create.

### Retrieval

- `mnemos_query_ranked query="..."` — default lookup. Add
  `project="<tag>"` to hard-scope (the response names the other projects);
  omit for the whole vault. A thin/weak scoped answer carries
  `project_suggestions` inline — the content likely lives elsewhere.
- `mnemos_query_similar` — fast semantic probe. Same scoping contract.
- `mnemos_explore` — multi-hop traversal; `project` scopes the answer set,
  traversal stays global.
- `mnemos_warmth` — what memory is resonating; scopable.
- `memory_sql` — the global escape hatch; SQL over the index answers
  cross-project and structural questions.

### Health & housekeeping (on user instruction or notice)

- `mnemos_health` after bulk writes; `mnemos_prune` (dry-run first) for
  archive candidates; `mnemos_index_build --force` after writes from
  outside `mnemos_add`.

---

## 7. Who may do what

- **The agent** captures, promotes, retrieves, updates project state,
  proposes removals and identity rewrites.
- **The user** approves removals and identity rewrites (from a real
  terminal), owns `mnemos.config.yaml`, answers the project-choice and
  ask-first questions.
- **Nobody** edits vault files directly — every path through the tools
  maintains schema, links, index, and audit; a direct edit corrupts the
  vault invisibly. The `mnemos` CLI is the sanctioned fallback ONLY when
  MCP tools are not attached.
