# Embedding Mnemos — universal memory without MCP or CLI

For harness builders: make mnemos your agent's memory by importing it as a
library. No MCP server to register, no CLI to shell out to, no subprocess —
your process owns the vault directly.

The package's main export (`import { … } from "@cheney-enterprises/mnemos"`)
is a **semver contract**: everything reachable from it is stable; everything
else in the codebase is an internal and may move without a major bump. The
contract is deliberately small — see `src/lib.ts` for the rationale.

## What's under contract today

### Retrieval — `recall`

The same wired entry the CLI and the MCP tool both go through: point it at a
vault directory and it handles config load, index sync, embedding, fusion, and
ranking.

```ts
import { recall } from "@cheney-enterprises/mnemos";

const res = await recall("./vault", "what did we decide about caching?", { limit: 5 });
// res.results: ranked notes with scores; res may carry signal breakdowns
```

Low-level parts are exported for harnesses that want control over the
pipeline:

```ts
import { openSyncedIndex, loadLinkGraph, searchComposite, embedText, initDB } from "@cheney-enterprises/mnemos";
import { rankByImportance, rankByFading, rankByVitality } from "@cheney-enterprises/mnemos";
```

The invariant to respect: **the markdown is the truth, the index is derived.**
`openSyncedIndex` brings the index up to date with the markdown — call it (or
`recall`, which does it) before reading.

### Forgetting — query-addressed, governed

```ts
import { matchForForget, supersede, release, purge } from "@cheney-enterprises/mnemos";
```

`matchForForget` finds candidates for a natural-language "forget X" query;
`supersede` replaces a note with a better one (schema-valid, blast-radius
checked); `release` returns knowledge to the user; `purge` is destructive and
refuses without explicit confirmation-shaped options — the same laws the MCP
surface enforces. `ForgetBlastRadiusError` is thrown when a removal would take
too much with it.

### Introspection — read-only SQL

```ts
import { runReadOnlySql, describeSchema } from "@cheney-enterprises/mnemos";

const rows = await runReadOnlySql("./vault", "SELECT title, type FROM notes WHERE project = 'mytag'");
console.log(describeSchema()); // the six stable views
```

### Configuration

```ts
import { loadConfig } from "@cheney-enterprises/mnemos";
const config = await loadConfig("./vault/mnemos.config.yaml");
```

## What's CLI-shaped today (usable, not yet under contract)

Capture and session boot currently live behind CLI-shaped entry points
(`runAdd`, `runUpdateFile`, `runWake` from `@cheney-enterprises/mnemos/cli`).
They work from library code — they take plain option objects — but they are
not yet part of the semver contract, so their signatures may change.

```ts
import { runAdd } from "@cheney-enterprises/mnemos/cli";
await runAdd({
  startDir: "./vault",
  title: "the decision about retry backoff",
  type: "decision",
  description: "Exponential backoff with jitter won over fixed delays",
  content: "…why…",
  project: ["mytag"],
});
```

Treat these as the preview of the coming contract, not a stable API.

## The roadmap to full universal memory in your harness

The session-scope work (`docs/specs/session-scope-spec.md`) is what turns
embedding into the first-class path:

1. **Session binding** (built, behind `retrieval.session_scope.enabled`) —
   your harness passes `session=<id>` / `parent=<id>`; mnemos binds
   constructively, records in `ops/sessions/`, zero questions. Today it
   rides the wake path; a direct library binding call is planned as part of
   the contract expansion.
2. **Two-tier capture** — the invisible session stream (auto-maintained,
   fast-decaying) alongside the curated note pipeline; your harness captures
   what happened without ceremony, and the user sees only the adds and
   removes.
3. **Scope-weighted retrieval** — seeded from the session record, so your
   harness's sessions stay focused on their own context while never missing
   relevant knowledge from elsewhere in the vault.

Each phase lands behind the flag and enters the library contract as it
proves out on the benchmark.

## Which path should you use?

| You are… | Use |
|---|---|
| A human with an existing agent app (Claude Code, Cursor, OpenCode, Ori…) | The bridge → MCP ([docs/getting-started.md](./getting-started.md)) |
| Building a **new** harness and want memory built in | The library (this document) |
| Scripting over the vault by hand | The CLI |
| All of the above at once | Any mix — one vault serves all of them through the same index and the same laws |
