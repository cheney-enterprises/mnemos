# Getting Started — install, wire, verify

Everything here is doable in under five minutes. If you get stuck, `mnemos status`
now tells you what state your setup is in and what the next command is (see
"Onboarding hints" below).

## 1. Install

```bash
npm install -g @cheney-enterprises/mnemos     # or use npx, no install
```

Requires Node 20+. No database, no cloud account, no daemon — a mnemos vault is
a directory of markdown files plus a derived local index (SQLite, created for
you).

## 2. Create a vault

```bash
mnemos init ~/my-memory        # scaffolds the vault
mnemos boot ~/my-memory        # optional: interactive identity setup (name, purpose)
```

The vault is yours: plain markdown you can read in any editor, wiki-links as
graph edges, git-friendly. The index under `.mnemos/` is derived — deleting it
is safe (rebuild with `mnemos index build`); the markdown is the truth.

## 3. Wire a client (the bridge)

Agents reach the vault through the MCP server. The bridge registers it in your
client's own config — one command, no hand-editing:

```bash
mnemos bridge claude-code --vault ~/my-memory   # hooks + MCP + CLAUDE.md
mnemos bridge cursor      --vault ~/my-memory   # .cursor/mcp.json
mnemos bridge codex       --vault ~/my-memory   # ~/.codex/config.toml
mnemos bridge hermes      --vault ~/my-memory   # ~/.hermes/config.yaml + plugin
mnemos bridge opencode    --vault ~/my-memory   # plugin (lifecycle: capture, onboarding, validate) + MCP + AGENTS.md
mnemos bridge ori         --vault ~/my-memory   # ~/.ori/mcp.json (global only)
```

Each bridge is idempotent (re-running never duplicates) and reversible
(`--uninstall`).

**Using a client that isn't on the list?** Any MCP-compatible client works over
stdio:

```bash
mnemos bridge generic --vault ~/my-memory       # prints the config block to paste
```

Tested manual configurations for common clients live in
[`docs/cross-client-configs.md`](./cross-client-configs.md). The pattern is
always the same: register `{ command: "npx", args: ["-y", "@cheney-enterprises/mnemos", "serve", "--mcp", "--vault", "/path/to/vault"] }`
as an MCP server named `mnemos`.

**No client at all?** The CLI works standalone:

```bash
cd ~/my-memory && mnemos wake --project my-tag   # open a session
mnemos explore "what did we decide about caching?"   # retrieval
```

## 4. Verify

```bash
mnemos status
```

Reports vault health (notes, inbox, orphans) **and** which clients are
registered:

- Nothing registered → the output names every bridge command and the generic
  escape hatch. That's your next step.
- Something registered → one line acknowledging it, with the command to add
  or re-wire.

One more check, and it needs no vault at all:

```bash
mnemos probe
```

Runs the operational probe suite against a hostile fixture vault that ships
with the package — vocabulary-collision projects, a superseded-note trap, a
session lineage graph. It answers "does the product behave as intended, not
just compile": recall finds the right notes across projects, wake carries only
the scoped project's state, supersede/release round-trips hold. Hard cases
must pass (a failure exits 1); gate cases report the benchmark numbers the
roadmap is measured against. Your own vault is never touched — everything runs
in a temp copy of the fixture.

## 5. The config (when you want to tune, not before)

`mnemos.config.yaml` sits at the vault root and is scaffolded fully commented —
every block explains itself. It is a **tuning** surface: a vault works with the
scaffolded file untouched. The blocks that matter first:

| Block | What it tunes | When you'd touch it |
|---|---|---|
| `wake` | How sessions scope: `project_default`, and `project_paths` (repo directory → project tag, so a session in `~/dev/myrepo` scopes silently) | When you want silent scoping per repo |
| `promote` | Capture behavior: auto-promotion from inbox, map routing | When capture feels too manual or too eager |
| `policy` | The approval gates: what the agent may do freely vs. what asks first (`purge=approval`, `identity_update=approval`…) | When you trust the agent more or less |
| `retrieval` | Search tuning: signal weights, limits — plus feature flags like `session_scope.enabled` (off by default; see the session-scope spec) | Rarely; flags ship off until proven |
| `vitality` / `bm25` / `warmth` | Decay model, ranking mechanics | Almost never |

**Where users learn what changed:** `CHANGELOG.md` is maintained per release,
and the in-product hint layer (above) keeps setup knowledge in the tool
instead of in docs.

## Onboarding hints

`mnemos init` and `mnemos status` both carry a `next_steps` field: the tool
tells you the next command instead of you reading docs to find it. A fresh
init, for example, ends with:

```
next_steps:
  - No MCP client is registered with this vault yet — agents reach memory through a client (MCP), the CLI, or the library.
  - Wire a known client (one command): mnemos bridge claude-code|cursor|codex|hermes|opencode|ori --vault <vault-dir>
  - Any other MCP client: mnemos bridge generic --vault <vault-dir> — prints the config block to paste.
  - CLI-only start (no client): run mnemos wake from the vault directory.
```

## Where to go next

- **How the system works** — the mental model: [docs/how-it-works.md](./how-it-works.md)
- **Embedding mnemos in your own harness** (no MCP, no CLI — library use): [docs/library.md](./library.md)
- Full command reference: `mnemos --help`, and `docs/cross-client-configs.md` for client wiring details.
