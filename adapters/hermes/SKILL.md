---
name: mnemos
description: Persistent agent memory with learning retrieval. Knowledge graph on markdown files — capture insights, decisions, research, and learnings during work, then retrieve them weeks or months later. Use when knowledge is too valuable to lose but too much to inject into every prompt.
version: 1.0.0
author: Mnemos
license: Apache-2.0
metadata:
  hermes:
    tags: [Memory, Knowledge Graph, MCP, Persistent, Identity, Session, Retrieval]
    homepage: https://github.com/aayoawoyemi/Mnemos
    related_skills: [native-mcp]
prerequisites:
  commands: [node, npm]
---

# Mnemos

Durable memory that compounds over time. A knowledge graph on markdown files with learning retrieval — capture what you find, decide, or learn during work, and retrieve it when the same problem comes up weeks or months later. The system gets better at finding things the more you use it.

## When to Use

Use this skill when:

- you learn something worth retrieving a week, a month, or a year from now
- you make a decision and want to remember why (not just what)
- you find research, references, or technical details during work that would be expensive to rediscover
- you need to maintain persistent identity, goals, or methodology across sessions
- you want to search across everything you have ever captured, not just what fits in context

The core question: **would losing this hurt if the same situation comes up again?** If yes, capture it.

### Mnemos vs Hermes built-in memory

Hermes has `MEMORY.md` and `USER.md` — a frozen snapshot injected into every system prompt. That is the right place for always-on context: user preferences, environment facts, communication style, things the agent needs on every turn.

Mnemos is a searchable knowledge graph. It scales to thousands of notes because you retrieve on demand, not inject everything. Use Mnemos for durable knowledge that is too much to carry in every prompt but too valuable to lose — research findings, architectural decisions, project history, lessons learned, accumulated insights.

Do not use Mnemos for ephemeral task state: current file being edited, intermediate reasoning steps, temporary paths, things that only matter in this conversation.

## Prerequisites

Install Mnemos globally:

```bash
npm install -g mnemos
mnemos --version
```

## Setup

### One-command bridge install

```bash
mnemos init ~/brain
mnemos bridge hermes --vault ~/brain
```

This writes the MCP server config to `~/.hermes/config.yaml` and installs a native lifecycle plugin at `~/.hermes/plugins/mnemos/`. Restart Hermes after running.

### What the bridge installs

| Component | Location | Purpose |
|-----------|----------|---------|
| MCP server | `~/.hermes/config.yaml` → `mcp_servers.mnemos` | 16 tools for memory operations |
| Lifecycle plugin | `~/.hermes/plugins/mnemos/` | Vault health at session start, capture at session end |

### Manual setup (if you prefer)

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  mnemos:
    command: mnemos
    args: ["serve", "--mcp", "--vault", "/path/to/brain"]
    env:
      MNEMOS_VAULT: "/path/to/brain"
```

## Core Concepts

### The vault

A vault is a directory of markdown files. Every file is human-readable, git-friendly, and portable. The vault has three spaces:

```
vault/
├── self/           # Agent identity — who you are, what you're working on
│   ├── identity.md
│   ├── goals.md
│   └── methodology.md
├── notes/          # Knowledge graph — durable insights, decisions, learnings
│   └── index.md    # Hub entry point
├── inbox/          # Capture buffer — raw ideas waiting to be processed
└── ops/            # Operations — daily state, reminders, session logs
    ├── daily.md
    └── reminders.md
```

**`self/`** decays very slowly. Identity persists. **`notes/`** decays normally — used notes stay alive, unused notes fade. **`ops/`** decays fast — operational state clears itself.

### Notes

Every note is an atomic claim with a prose title. The title IS the idea — it reads as a complete sentence.

Good titles:
- `fake money is not sticky because users have nothing to lose`
- `session capture hooks should run before context window clears`
- `redis was chosen over memcached for session caching`

Bad titles:
- `Memory Notes` (topic label, not a claim)
- `Ideas` (not an insight)
- `2026-03-21` (timestamp, not knowledge)

Test: "This note argues that [title]" must work as prose.

Notes have YAML frontmatter:

```yaml
---
description: One sentence adding context beyond the title
type: idea | decision | learning | insight | blocker | opportunity
project: [project-a, project-b]
status: active
created: 2026-03-21
---
```

### Wiki-links

`[[note title]]` creates a graph edge. These are how notes connect.

```markdown
Since [[fake money is not sticky]], the engagement model needs
real incentives. [[token utility drives retention]] suggests
tying rewards to actions, not holdings.
```

Every wiki-link is a directed edge in the knowledge graph. PageRank flows along them. Retrieval follows them. The more connections a note has, the more discoverable it becomes.

### The inbox

Never write directly to `notes/`. Capture to `inbox/` first with `mnemos_add`, then promote with `mnemos_promote`. The promotion step classifies the note, detects links, and assigns it to map areas.

## Session Rhythm

Every session follows three phases.

### 1. Wake

Call `mnemos_wake` at session start. It returns a budget-capped briefing:

- today's completed and pending items
- active goals and threads
- reminders due today
- vault health (orphans, fading notes, inbox queue)
- embedding index freshness

Pass `budget` (max lines, default 96) to control size. On a vault with no identity
written yet, wake also returns a first-run onboarding script.

### 2. Work

While working, use these tools:

| Tool | When |
|------|------|
| `mnemos_query_ranked` | Before creating anything — check if related knowledge exists |
| `mnemos_add` | Capture an insight, decision, or learning to inbox |
| `mnemos_explore` | Deep question that needs multi-hop reasoning across notes |
| `mnemos_query_similar` | Quick semantic search for a specific concept |
| `mnemos_validate` | After writing or editing a note |

**Before you create a new note, always search first.** Call `mnemos_query_ranked` with the core concept. If a related note exists, update it or link to it rather than creating a duplicate.

### 3. Persist

Before the session ends:

| Tool | What to update |
|------|---------------|
| `mnemos_update file=daily` | Mark today's completed items |
| `mnemos_update file=goals` | Update active threads and next steps |
| `mnemos_add` | Capture any insights that surfaced during work |

The lifecycle plugin handles session capture automatically if auto-activation is enabled.

## Tool Reference

### Retrieval tools

**`mnemos_query_ranked`** — Full intelligent retrieval. Fuses semantic search, BM25 keywords, PageRank authority, and associative warmth. Reranked by learned Q-values. This is the primary search tool.

```
mnemos_query_ranked query="how does token incentive design affect user retention"
```

**`mnemos_explore`** — Recursive graph traversal for complex questions. Decomposes the query into sub-questions, retrieves against each, and synthesizes. Use for multi-hop reasoning that spans several notes.

```
mnemos_explore query="what architectural decisions led to the current caching strategy"
```

**`mnemos_query_similar`** — Pure semantic search. Faster than `mnemos_query_ranked` but misses graph structure. Use when you know the concept and want a quick lookup.

```
mnemos_query_similar query="authentication middleware"
```

**`memory_sql`** — Read-only SQL over the retrieval database views (`v_note`, `v_link`, `v_dangling`, …). For questions the other tools cannot express — "top notes by PageRank", "notes with zero incoming links", "retrieval frequency by project".

### Capture tools

**`mnemos_add`** — Capture an insight to inbox. Always provide a prose-as-title claim and a type.
Pass `description` and `project`.

```
mnemos_add title="redis was chosen over memcached because we need pub/sub for real-time updates" type=decision
```

Types: `idea`, `decision`, `learning`, `insight`, `blocker`, `opportunity`

**`mnemos_promote`** — Move a note from inbox to the knowledge graph. Classifies, detects wiki-links, suggests area assignments.

```
mnemos_promote note="redis was chosen over memcached"
```

### State tools

**`mnemos_update`** — Write to identity, goals, methodology, daily, or reminders.

```
mnemos_update file=goals content="## Active\n- Redis migration in progress\n- Auth rewrite blocked on token design"
```

**`mnemos_health`** — Full diagnostics (orphans, dangling links, fading notes, schema compliance).

### Maintenance tools

**`mnemos_validate`** — Schema validation for a note. Run after creating or editing.

**`mnemos_warmth`** — Inspect the associative warmth field around a concept. Shows what's "hot" in the graph.

**`mnemos_prune`** — Analyzes the full activation topology and suggests archive candidates. Notes with low vitality, no incoming links, and no structural importance are candidates.

**`mnemos_index_build`** — Rebuild the embedding index. Run when `mnemos_health` reports a stale index.

### Forgetting

**`mnemos_forget`** — Query-addressed retirement of notes. Dry-run by default; review the match list, then set `apply=true`.

- `op=release` — soft-evict: status becomes `released`, files stay on disk, notes stop being recalled.
- `op=supersede` — retire the best match and write its replacement note (pass `new_text` and `project`).

`purge` (hard delete) is intentionally CLI-only — an agent must never be able to unlink records.

## Workflow Patterns

### Capturing an insight mid-conversation

When something worth remembering surfaces during work:

1. Call `mnemos_query_ranked` with the concept to check for duplicates
2. If no match, call `mnemos_add` with a prose-as-title claim and the right type
3. Move on — promotion happens later

Do not defer capture. If you do not write it down now, it will not exist next session.

### Finding knowledge from a previous session

1. Call `mnemos_query_ranked` with a natural language description of what you need
2. If the top results are relevant, use the information directly
3. If results are partial, call `mnemos_explore` for a deeper multi-hop search
4. If nothing is found, the knowledge was never captured — create it now

### Cross-project discovery

If you work across multiple projects, notes from all of them live in the same graph. A search for "engagement" finds results from every project where engagement matters. When you discover a connection between projects, add wiki-links between the notes — these cross-domain connections are often the most valuable because they surface patterns you would not find searching within a single project.

### Updating stale knowledge

When a decision or learning is outdated:

1. Call `mnemos_query_ranked` to locate the existing note
2. Dry-run `mnemos_forget op=supersede` with a query naming it — check the match list
3. `apply=true` with `new_text` and `project`: the old note flips to `status: superseded`
   and drops out of retrieval; the replacement note is written and linked

Never delete notes. Archive or supersede them so link targets are preserved.

## Quality Gates

Before considering a note complete:

- Title works as prose: "This note argues that [title]" reads naturally
- Description adds information beyond the title (mechanism, scope, or implication)
- Type is correct (idea vs decision vs learning vs insight)
- At least one wiki-link connects to related knowledge
- If it's a decision, the rationale is captured (why this over alternatives)

## Troubleshooting

### `mnemos` command not found

Install globally:

```bash
npm install -g mnemos
```

If installed but not found, check that your npm global bin directory is on PATH:

```bash
npm config get prefix
```

### MCP server not connecting

Verify the server starts:

```bash
mnemos serve --mcp --vault ~/brain
```

If it fails, check that the vault exists and contains a `.mnemos` directory:

```bash
ls ~/brain/.mnemos
```

If missing, initialize:

```bash
mnemos init ~/brain
```

### Search returns no results

The embedding index may need building:

```bash
mnemos index build --force
```

Keyword search (BM25) works without an index. Semantic search requires embeddings.

### Orient shows stale data

The lifecycle plugin reads vault state from disk. If you edited files outside Mnemos, the data is already current — Mnemos reads markdown directly with no cache.

If the embedding index is stale (`mnemos_health` warns), rebuild:

```bash
mnemos index build
```

## Remote and Serverless Environments

If Hermes runs with a remote terminal backend (Docker, SSH, Modal, Daytona), `mnemos` must be installed and on PATH inside that environment. The vault must be on persistent storage — not ephemeral disk. For serverless backends where the environment hibernates, mount the vault on a persistent volume so memory survives between wake cycles.

For local and Docker backends this works out of the box. The entire stack — embeddings, SQLite index, markdown files — runs offline with zero cloud dependencies.
