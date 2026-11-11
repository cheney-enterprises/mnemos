---
description: The operating manual — intended use, scopes, naming, layout; deep references are pointed to, not restated
type: manual
---

# Mnemos Operating Manual

This vault is one agent's memory serving one human across many projects.

What the CRITICAL rules and tool descriptions do not explain — intended use,
how the layers divide, how to name and layout a project — lives here. The
operating LOOP (boot, retrieve, capture, session end) and the bars for what
makes an entry useful live in the doctrine you already carry; this manual
does not restate them.

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

**Every project gets its own state files at creation.** When a project
comes into existence (its map is captured), `ops/<tag>/goals.md`,
`daily.md`, and `reminders.md` are scaffolded automatically. The scoped
wake reads those files — never the global ones, never grep-the-shared-
file. The only fallback in wake is the global documents themselves.

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

## 6. Where the deep references live

The workflow loop, command syntax, and the bars for useful entries are
doctrine, carried in every session's context — they are not restated here.
What is left here is the detail only needed occasionally:

- **Command reference:** `mnemos --help`, and `mnemos <command> --help`
  for any command (22 commands: init, wake, status, health, whats-new,
  sql, query, validate, add, promote, archive, bridge, serve, index,
  graph, forget, requests, prune, explore, explore-start,
  explore-expand, explore-conclude).
- **Tool inventory and what each is for:** the README's MCP Tools table,
  or the connected server's tool descriptions.
- **The capability model (who may do what, and why):** `mnemos://policy`.
- **The self-model (who you are, how you work):** `mnemos://identity`.
- **CLI fallback:** when the MCP tools are not attached, the `mnemos` CLI
  speaks the same contracts — `mnemos wake`, `mnemos add`, `mnemos query`,
  and the rest. It is the sanctioned fallback ONLY then.
