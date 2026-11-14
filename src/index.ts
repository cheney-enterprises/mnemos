#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./core/version.js";
import { checkForUpdate } from "./core/update-check.js";
import { disposeEmbedder } from "./core/engine.js";
import { runForget, runRequestsList, runRequestDecide } from "./cli/forget.js";
import { readFileSync } from "node:fs";
import path from "node:path";

import { runInitInteractive } from "./cli/init.js";
import { runStatus } from "./cli/status.js";
import { runHealth } from "./cli/health.js";
import { runProbe } from "./probe/run.js";
import {
  runQueryBacklinks,
  runQueryDangling,
  runQueryOrphans,
  runQueryCrossProject,
  runQueryImportant,
  runQueryFading,
} from "./cli/query.js";
import { runValidate } from "./cli/validate.js";
import { runSql } from "./cli/sqlcmd.js";
import { runAdd } from "./cli/add.js";
import { runPromote } from "./cli/promote.js";
import { runArchive } from "./cli/archive.js";
import { runBridgeClaudeCode, runBridgeClaudeCodeGlobal, runBridgeCodex, runBridgeCursor, runBridgeGeneric, runBridgeHermes, runBridgeOpenCode, runBridgeOri, runBridgeProjects, runBridgeStatus } from "./cli/bridge.js";
import { runServeMcp } from "./cli/serve.js";
import { runQueryRanked, runQuerySimilar, runQueryWarmthAudit } from "./cli/search.js";
import { runWake } from "./cli/wake.js";
import { runIndexBuild, runIndexStatus, runIndexExportLearned, runIndexImportLearned } from "./cli/indexcmd.js";
import { runGraphMetrics, runGraphCommunities } from "./cli/graphcmd.js";
import { runPrune } from "./cli/prune.js";
import { runExplore, runExploreStartCli, runExploreExpandCli, runExploreConcludeCli, runExploreExtendCli } from "./cli/explore.js";

const program = new Command();

function assertBridgeScope(value: string | undefined): "project" | "global" | undefined {
  if (!value) return undefined;
  if (value !== "project" && value !== "global") {
    throw new Error(`Unknown bridge scope: ${value}`);
  }
  return value;
}

function assertBridgeActivation(value: string | undefined): "auto" | "manual" | undefined {
  if (!value) return undefined;
  if (value !== "auto" && value !== "manual") {
    throw new Error(`Unknown bridge activation: ${value}`);
  }
  return value;
}

program
  .name("mnemos")
  .description(
    "Mnemos - markdown-native cognitive harness for persistent agent memory"
  )
  .version(VERSION)
  .addHelpText(
    "after",
    `

First time? Setup is four commands:
  1. mnemos init ~/my-memory              scaffold the vault (markdown, config, ops/)
  2. mnemos boot ~/my-memory              optional: interactive identity setup
  3. mnemos bridge <client> --vault ~/my-memory
                                          register the MCP server in your agent client
                                          clients: claude-code | cursor | codex | hermes | opencode | ori
                                          any other MCP client: mnemos bridge generic
  4. start using it — agents call wake first; from a shell: cd ~/my-memory && mnemos wake

  Not sure where you stand?  mnemos status   (reports vault health AND which
  clients are registered, with the next command to run)

Vault resolution (where your memory is found):
  1. MNEMOS_VAULT env var                  explicit - wins over everything
  2. walk up from the current directory    a dir with a .mnemos marker or mnemos.config.yaml
  3. mnemos serve --mcp only: falls back to the global vault (~/.mnemos-memory)

The vault IS a directory - cd into it and every command works:
  cd ~/ori-memory-vault && mnemos wake

MCP note: agents connect through the registered server (its config carries
--vault), so MCP sessions always know the vault. The CLI only knows it if
you stand inside it or set MNEMOS_VAULT.

Guides: mnemos bridge --help (client wiring) | docs/getting-started.md (setup)
        docs/how-it-works.md (the mental model) | docs/library.md (embed without MCP)
        https://github.com/cheney-enterprises/mnemos#readme`
  );

program
  .command("init")
  .description(
    "Scaffold a new vault (notes/, self/, ops/, templates/, mnemos.config.yaml). " +
      "The result carries next_steps — including the bridge command that wires your agent client."
  )
  .addHelpText(
    "after",
    `
  mnemos init ~/my-memory       scaffold
  mnemos boot ~/my-memory       optional interactive identity setup
  mnemos bridge <client> --vault ~/my-memory   then wire an agent client (see: mnemos bridge --help)

The vault is a directory of markdown you own; the index under .mnemos/ is
derived and safe to delete (mnemos index build recreates it).`
  )
  .argument("[dir]", "target directory", ".")
  .option("--json", "output JSON only (skip interactive)")
  .action(async (dir: string, options: { json?: boolean }) => {
    const result = await runInitInteractive({ targetDir: dir, json: options.json });
    if (options.json || !process.stdout.isTTY) {
      await emit({ success: true, data: result, warnings: [] });
    }
  });

program
  .command("wake")
  .description("OPEN the memory vault — the session-start verb. One call: identity, roster, policy, project briefing")
  .addHelpText(
    "after",
    `
Project scoping (how wake knows which project this session is):
  --project <tag>      the user named it — always pass it when they do
  bare wake            scopes itself when the session directory is registered
                       in wake.project_paths (or wake.project_default is set);
                       every silent scoping carries a resolution note
  otherwise            it ASKS: a project_choice_required question (roster +
                       new-project option) to relay to the user, then re-call
                       with --project

One payload: identity, roster, policy, and — when the project is known — the
project's full briefing. Run from inside a vault (or set MNEMOS_VAULT).
Session intake: --session/--parent/--lineage (deterministic; flag-gated).`
  )
  .option("--budget <n>", "max lines (default 96)", "96")
  .option("--project <tag>", "the project this session works in (global + scoped context in one payload)")
  .option("--path <dir>", "the repository directory to resolve to a project (overrides wake.project_paths matching)")
  .option("--ask", "force the project-choice question even when the project could be resolved silently")
  .option("--session <id>", "the harness session id (deterministic intake; binds a session record in ops/sessions/ when retrieval.session_scope is enabled)")
  .option("--parent <id>", "the parent session id when this session continues or branches from one (writes the lineage edge)")
  .option("--lineage <edge>", "which lineage edge --parent is: continues (default) or branched_from")
  .option("--json", "machine-readable payload (includes the full projectWake / project_choice_required objects)")
    .action(async (options: { budget: string; project?: string; path?: string; ask?: boolean; session?: string; parent?: string; lineage?: string; json?: boolean }, cmd?: { remainingArgs?: string[]; args?: string[] }) => {
    // Doctrine syntax alias. The MCP tool takes named arguments (project="<tag>"),
    // and the doctrine teaches that convention — but bare text on the CLI is a
    // positional. Accept the doctrine form here so the two surfaces can never
    // disagree about how to scope a wake (Eric was TOLD 'Re-call
    // mnemos_wake with project=<tag>', typed it, and got the unscoped dump).
    const strays = [...(cmd?.remainingArgs ?? []), ...(cmd?.args ?? [])].filter((a) => typeof a === "string" && a.length > 0);
    for (const stray of strays) {
      const alias = stray.match(/^project=(\S+)$/);
      if (alias) {
        options.project = alias[1];
        continue;
      }
      console.error(
        `Error: 'mnemos wake' takes no positional argument (got "${stray}"). ` +
          "Scope with --project <tag> (CLI) or project=<tag> (MCP): mnemos wake --project mnemos",
      );
      process.exit(1);
    }
    const result = await runWake(process.cwd(), parseInt(options.budget, 10), options.project, options.path, options.ask === true, {
      session: options.session,
      parent: options.parent,
      lineage: options.lineage,
    });
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.lines.join("\n"));
      if (result.session_binding) {
        const sb = result.session_binding;
        console.log(
          `\n[session] ${sb.id}${sb.ephemeral ? " (ephemeral — no record until first capture)" : sb.record ? ` (record: ${path.relative(process.cwd(), sb.record)})` : ""}`,
        );
      }
      if (result.projectWake) {
        const pw = result.projectWake;
        if (pw.warning) console.log(`\n[project] ${pw.warning}`);
        else {
          console.log(`\n## ${pw.project} (map: ${pw.map ?? "none"})`);
          for (const l of pw.currentState) console.log(l);
          if (pw.daily.length > 0) {
            console.log("\n## Recent daily (scoped)");
            for (const l of pw.daily.slice(-6)) console.log(l);
          }
          if (pw.recentNotes.length > 0) {
            console.log("\n## Recent notes (scoped)");
            for (const n of pw.recentNotes.slice(0, 8)) console.log(`- ${n}`);
          }
        }
      }
      console.log(`\n[manual] ${result.manual.note} → ${result.manual.resource} (${result.manual.path})`);
      if (result.project_choice_required) {
        const c = result.project_choice_required;
        console.log(`\n## PROJECT CHOICE REQUIRED\n${c.question}`);
        console.log("CLI: mnemos wake --project <tag>");
        console.log("Roster: " + c.projects.map((p) => `${p.project} (${p.notes})`).join(", ") + (c.default_hint ? `\nDefault configured: ${c.default_hint}` : ""));
      }
    }
  });

program
  .command("status")
  .description("Vault overview: note counts, index state")
  .action(async () => {
    const result = await runStatus(process.cwd());
    await emit(result);
  });

program
  .command("health")
  .description("Full diagnostics: orphans, dangling links, schema violations, index health")
  .action(async () => {
    const result = await runHealth(process.cwd());
    await emit(result);
  });

program
  .command("whats-new [version]")
  .description("Release notes for the installed Mnemos version, or the one given")
  .action(async (version?: string) => {
    const { whatsNew } = await import("./core/whats-new.js");
    console.log(whatsNew(version));
  });

program
  .command("sql")
  .description("Read-only SQL over the memory index")
  .argument("[query]", "a single SELECT/WITH/EXPLAIN/VALUES statement; omit with --schema")
  .option("--limit <n>", "max rows returned", "1000")
  .option("--timeout <ms>", "abort after this many milliseconds", "2000")
  .option("--schema", "describe tables and views instead of running a query")
  .option("--stdin", "read the query from stdin")
  .action(async (query, options) => {
    let sql = query;
    if (options.stdin === true) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      sql = Buffer.concat(chunks).toString("utf8");
    }
    const result = await runSql(process.cwd(), sql, {
      limit: Number(options.limit),
      timeoutMs: Number(options.timeout),
      schema: options.schema === true,
    });
    // Write, flush, then exit explicitly.
    //
    // A query that times out leaves a worker parked inside one synchronous
    // SQLite call. It ignores terminate(), and unref() was not enough to let
    // the process go: the correct JSON appeared at ~1.5 s and the CLI then
    // sat forever burning a core, which hangs any script or CI job that
    // shells out. Exiting from the write callback guarantees stdout is
    // drained first -- process.exit() on its own can truncate a pending pipe
    // write on Windows.
    const code = result.success ? 0 : 1;
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(code));
  });

program
  .command("query")
  .description("Vault queries: orphans | dangling | backlinks | cross-project | ranked | similar | important | fading")
  .argument("<kind>", "orphans | dangling | backlinks | cross-project | ranked | similar | important | fading | warmth-audit")
  .argument("[note]", "note title for backlinks, query text for ranked/similar, or query filter for warmth-audit")
  .option("--limit <n>", "max results", "10")
  .option("--threshold <n>", "vitality threshold for fading", "0.3")
  .option("--project <tag>", "hard-filter ranked/similar results to one project's notes (omit = whole vault; scoped results name the other projects)")
  .action(async (kind: string, note: string | undefined, options: { limit?: string; threshold?: string; project?: string }) => {
    let result;
    switch (kind) {
      case "orphans":
        result = await runQueryOrphans(process.cwd());
        break;
      case "dangling":
        result = await runQueryDangling(process.cwd());
        break;
      case "backlinks":
        if (!note) {
          throw new Error("backlinks requires a note title");
        }
        result = await runQueryBacklinks(process.cwd(), note);
        break;
      case "cross-project":
        result = await runQueryCrossProject(process.cwd());
        break;
      case "ranked":
        if (!note) {
          throw new Error("ranked requires a query text");
        }
        result = await runQueryRanked(process.cwd(), note, options.limit ? parseInt(options.limit, 10) : undefined, undefined, undefined, undefined, undefined, undefined, options.project);
        break;
      case "similar":
        if (!note) {
          throw new Error("similar requires a query text");
        }
        result = await runQuerySimilar(process.cwd(), note, options.limit ? parseInt(options.limit, 10) : undefined, undefined, undefined, options.project);
        break;
      case "important":
        result = await runQueryImportant(process.cwd(), options.limit ? parseInt(options.limit, 10) : undefined);
        break;
      case "fading":
        result = await runQueryFading(process.cwd(), options.threshold ? parseFloat(options.threshold) : undefined);
        break;
      case "warmth-audit":
        result = await runQueryWarmthAudit(
          process.cwd(),
          note,
          options.limit ? parseInt(options.limit, 10) : undefined,
        );
        break;
      default:
        throw new Error(`Unknown query kind: ${kind}`);
    }
    await emit(result);
  });

program
  .command("validate")
  .description("Schema-validate one note (frontmatter, types, description limits)")
  .argument("<note>", "path to note")
  .action(async (note: string) => {
    const result = await runValidate({ notePath: note });
    await emit(result);
  });

program
  .command("add")
  .description("REMEMBER — capture a note into the vault's inbox (auto-promotes when configured)")
  .argument("<title>", "note title")
  .option("-t, --type <type>", "note type", "insight")
  .option("-c, --content <content>", "note body content (replaces template placeholder)")
  .option("-f, --content-file <path>", "path to file containing note body content")
  .option("--content-stdin", "read note body content from stdin")
  .option("-d, --description <desc>", "one sentence adding context beyond the title")
  .option("-p, --project <projects...>", "project tags")
  .action(async (title: string, options: { type: string; content?: string; contentFile?: string; contentStdin?: boolean; description?: string; project?: string[] }) => {
    let content = options.content;
    if (options.contentFile) {
      content = readFileSync(options.contentFile, "utf8");
    }
    if (options.contentStdin && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      content = Buffer.concat(chunks).toString("utf8");
    }
    const result = await runAdd({ startDir: process.cwd(), title, type: options.type, content, description: options.description, project: options.project });
    await emit(result);
  });

program
  .command("promote")
  .description("Promote inbox note(s) into the knowledge graph: classification, links, project routing")
  .argument("[note]", "inbox note filename or slug")
  .option("--all", "promote all inbox notes")
  .option("--dry-run", "preview without making changes")
  .option("--no-auto", "skip LLM enhancement even if configured")
  .option("-t, --type <type>", "override type classification")
  .option("-d, --description <desc>", "override description")
  .option("-l, --links <links...>", "additional wiki-links")
  .option("-p, --project <projects...>", "project tags")
  .action(
    async (
      note: string | undefined,
      options: {
        all?: boolean;
        dryRun?: boolean;
        noAuto?: boolean;
        type?: string;
        description?: string;
        links?: string[];
        project?: string[];
      }
    ) => {
      const result = await runPromote({
        startDir: process.cwd(),
        noteName: note,
        all: options.all,
        dryRun: options.dryRun,
        noAuto: options.noAuto,
        type: options.type,
        description: options.description,
        links: options.links,
        project: options.project,
      });
      await emit(result);
    }
  );

program
  .command("archive")
  .description("Archive notes (status flip, still on disk) - see also: mnemos forget")
  .option("--dry-run", "preview without making changes")
  .action(async (options: { dryRun?: boolean }) => {
    const result = await runArchive({
      startDir: process.cwd(),
      dryRun: options.dryRun,
    });
    await emit(result);
  });

program
  .command("bridge")
  .description("Connect an agent client to the vault — register the MCP server (full wiring guide: bridge --help)")
  .addHelpText(
    "after",
    `
What each target writes (the client's own config files — mnemos never asks you to hand-edit them):
  claude-code   hooks + MCP registration + CLAUDE.md teaching (project or global scope)
  cursor        .cursor/mcp.json (MCP registration)
  codex         ~/.codex/config.toml (global only)
  hermes        ~/.hermes/config.yaml + a native plugin (auto activation)
  opencode      lifecycle plugin (.opencode/plugins/lifecycle.js: onboarding, capture, validate) + MCP + AGENTS.md
  ori           ~/.ori/mcp.json (global only — Ori carries its own session lifecycle)
  generic       prints the config block to paste — for ANY MCP-compatible client not on this list
  status        report what is registered where, per client and scope

Examples:
  mnemos bridge opencode --vault ~/my-memory        wire OpenCode (plugin + MCP + AGENTS.md)
  mnemos bridge claude-code --vault ~/my-memory     wire Claude Code (project scope by default)
  mnemos bridge claude-code --scope global --vault ~/my-memory
  mnemos bridge generic --vault ~/my-memory         unknown client? print the JSON to paste
  mnemos bridge opencode --uninstall                remove the wiring for that target/scope
  mnemos bridge status                              what is registered, and where

More projects, one vault?  Wire them from wherever you stand:
  mnemos bridge opencode --vault ~/my-memory \
      --project ~/work/app --project ~/work/site
  (full wiring into each dir: MCP config + AGENTS.md; idempotent. Global-only
  clients like codex/ori instead take --scope global — one registration
  covers every project.)

Not sure which client you have, or it's not listed?  'generic' prints the
registration block — any MCP-compatible client works over stdio. 'status'
never modifies anything.

After wiring, agents reach the vault automatically: the session starts with
mnemos_wake, capture/retrieval/forgetting all go through the registered
server. Verify any time with: mnemos status`
  )
  .argument("<target>", "claude-code | cursor | codex | hermes | opencode | ori | generic | status")
  .option("--global", "legacy shorthand for --scope global")
  .option("--scope <scope>", "install scope: project | global")
  .option("--activation <activation>", "activation mode: auto | manual")
  .option("--vault <path>", "explicit vault path")
  .option(
    "--project <dirs...>",
    "wire additional project DIRECTORIES from here (repeatable): full project wiring — the client's MCP config + instructions block — into each dir, no cd needed. Idempotent. Pass --vault explicitly; projects rarely sit near the vault."
  )
  .option("--uninstall", "remove Mnemos bridge config for this target/scope")
  .option("--json", "output JSON for install planning")
  .action(async (
    target: string,
    options: { global?: boolean; scope?: string; activation?: string; vault?: string; project?: string[]; uninstall?: boolean; json?: boolean }
  ) => {
    if (target !== "claude-code" && target !== "cursor" && target !== "codex" && target !== "hermes" && target !== "generic" && target !== "opencode" && target !== "ori" && target !== "status") {
      throw new Error(`Unknown bridge target: ${target}`);
    }

    if (target === "status") {
      const result = await runBridgeStatus(process.cwd());
      if (!options.json) {
        type ScopedInstall = {
          installed: boolean;
          activation: string | null;
          resolvedVault: string | null;
          configPaths: string[];
          details: string[];
        };
        type ScopedClientStatus = {
          project: ScopedInstall;
          global: ScopedInstall;
          active: { scope: string; activation: string | null; resolvedVault: string | null } | null;
        };
        type CodexStatus = ScopedInstall;
        const data = result.data as {
          precedence: string;
          instructions: string[];
          clients: Record<string, ScopedClientStatus | CodexStatus>;
        };

        console.log(`Precedence: ${data.precedence}`);
        for (const [client, status] of Object.entries(data.clients)) {
          console.log("");
          console.log(`Client: ${client}`);
          if (!("active" in status)) {
            const install = status as CodexStatus;
            console.log(`  global: ${install.installed ? "installed" : "not installed"}`);
            console.log(`    activation: ${install.activation ?? "n/a"}`);
            console.log(`    vault: ${install.resolvedVault ?? "(none encoded)"}`);
            console.log(`    checked: ${install.configPaths.join(", ")}`);
            for (const detail of install.details) {
            console.log(`    - ${detail}`);
            }
            continue;
          }
          const scoped = status as ScopedClientStatus;
          console.log(`  Active install: ${scoped.active ? scoped.active.scope : "none"}`);
          if (scoped.active) {
            console.log(`  Active activation: ${scoped.active.activation ?? "unknown"}`);
            console.log(`  Active vault: ${scoped.active.resolvedVault ?? "(runtime discovery)"}`);
          }
          for (const scope of ["project", "global"] as const) {
            const install = scoped[scope];
            console.log(`  ${scope}: ${install.installed ? "installed" : "not installed"}`);
            console.log(`    activation: ${install.activation ?? "n/a"}`);
            console.log(`    vault: ${install.resolvedVault ?? "(none encoded)"}`);
            console.log(`    checked: ${install.configPaths.join(", ")}`);
            for (const detail of install.details) {
              console.log(`    - ${detail}`);
            }
          }
        }
        if (data.instructions.length > 0) {
          console.log("");
          console.log("Notes:");
          for (const instruction of data.instructions) {
            console.log(`- ${instruction}`);
          }
        }
        return;
      }

      await emit(result);
      return;
    }

    const request = {
      global: options.global,
      scope: assertBridgeScope(options.scope),
      activation: assertBridgeActivation(options.activation),
      vault: options.vault,
      uninstall: options.uninstall,
    };

    // --project <dir>: wire OTHER project directories from here. Full project
    // wiring (the client's MCP config + instructions block, and plugin where
    // applicable) against each named dir — exactly what running the bridge
    // from inside that dir does, without the cd. Idempotent. Reason it wires
    // the MCP too: an instructions block pointing at a server the project
    // can't reach is worse than none.
    if (options.project?.length) {
      if (target === "generic") {
        throw new Error(`--project does not apply to "${target}".`);
      }
      if (target === "codex" || target === "ori") {
        throw new Error(
          `--project does not apply to "${target}": it is global-only. ` +
            `One registration covers every project: mnemos bridge ${target} --vault <vault> --scope global`,
        );
      }
      const outcome = await runBridgeProjects(
        target as "opencode",
        options.project,
        request,
      );
      if (!options.json) {
        for (const p of outcome.projects) {
          console.log(`\n${p.project}`);
          console.log(`  ${p.mutation ?? "done"}`);
          if (p.mcpPath) console.log(`  MCP config: ${p.mcpPath}`);
          if (p.instructionsPath) console.log(`  Instructions: ${p.instructionsPath}`);
          if (p.resolvedVault) console.log(`  Vault: ${p.resolvedVault}`);
        }
        console.log(
          `\nWired ${target} into ${outcome.projects.length} project(s). ` +
            "Each agent session in those directories now reaches the vault.",
        );
      }
      if (options.json) {
        await emit({ success: true, data: outcome, warnings: [] });
        return;
      }
      await disposeEmbedder();
      await maybeNotifyUpdate();
      process.stdout.write("", () => {
        setTimeout(() => process.exit(0), 4000).unref();
      });
      return;
    }

    const result = target === "claude-code"
      ? options.global
        ? await runBridgeClaudeCodeGlobal(process.cwd(), request)
        : await runBridgeClaudeCode(process.cwd(), request)
      : target === "cursor"
        ? await runBridgeCursor(process.cwd(), request)
      : target === "codex"
        ? await runBridgeCodex(process.cwd(), request)
      : target === "hermes"
        ? await runBridgeHermes(process.cwd(), request)
      : target === "opencode"
        ? await runBridgeOpenCode(process.cwd(), request)
      : target === "ori"
        ? await runBridgeOri(request)
      : await runBridgeGeneric(process.cwd(), request);

    if ((target === "generic" || target === "cursor" || target === "codex" || target === "hermes" || target === "opencode" || target === "ori") && !options.json) {
      const data = result.data as {
        client: string;
        operation?: string;
        mutation?: string;
        command: string;
        args: string[];
        env: Record<string, string>;
        scope: string;
        activation: string;
        resolvedVault: string | null;
        instructions: string[];
        mcpPath?: string;
        configPath?: string;
      };

      console.log(`Client: ${data.client === "generic" ? "generic MCP client" : data.client}`);
      if (data.operation) {
        console.log(`Operation: ${data.operation}`);
      }
      if (data.mutation) {
        console.log(`Result: ${data.mutation}`);
      }
      console.log(`Scope: ${data.scope}`);
      console.log(`Activation: ${data.activation}`);
      console.log(`Resolved vault: ${data.resolvedVault ?? "(runtime discovery)"}`);
      if (data.mcpPath) {
        console.log(`MCP config path: ${data.mcpPath}`);
      }
      if (data.configPath) {
        console.log(`Config path: ${data.configPath}`);
      }
      console.log("");
      console.log("Server config:");
      console.log(`  command: ${data.command}`);
      console.log(`  args: ${JSON.stringify(data.args)}`);
      console.log(`  env: ${JSON.stringify(data.env)}`);
      if (data.instructions.length > 0) {
        console.log("");
        console.log("Instructions:");
        for (const instruction of data.instructions) {
          console.log(`- ${instruction}`);
        }
      }
      return;
    }

    await emit(result);
  });

program
  .command("serve")
  .description("Run the MCP server (agents talk to the vault through this); --mcp for stdio JSON-RPC")
  .option("--mcp", "run MCP server")
  .option("--vault <path>", "explicit vault root path")
  .action(async (options: { mcp?: boolean; vault?: string }) => {
    if (!options.mcp) {
      throw new Error("Only MCP server is supported: use --mcp");
    }
    await runServeMcp(process.cwd(), options.vault);
  });

program
  .command("index")
  .description("Build/repair the derived index and embeddings (index build [--force])")
  .argument("<action>", "build | status | export-learned | import-learned")
  .option("--force", "rebuild all embeddings")
  .option("--file <path>", "export/import path (default ops/mnemos-learned.ndjson)")
  .action(async (action: string, options: { force?: boolean; file?: string }) => {
    let result;
    switch (action) {
      case "build":
        result = await runIndexBuild(process.cwd(), options.force);
        break;
      case "status":
        result = await runIndexStatus(process.cwd());
        break;
      // The index is only disposable if the learning has somewhere else to
      // live. These two are what make `rm -rf .mnemos/` a safe instruction.
      case "export-learned":
        result = await runIndexExportLearned(process.cwd(), options.file);
        break;
      case "import-learned":
        result = await runIndexImportLearned(process.cwd(), options.file);
        break;
      default:
        throw new Error(`Unknown index action: ${action}`);
    }
    await emit(result);
  });

program
  .command("graph")
  .description("Graph analysis over the knowledge graph (communities, metrics)")
  .argument("<action>", "metrics | communities")
  .action(async (action: string) => {
    let result;
    switch (action) {
      case "metrics":
        result = await runGraphMetrics(process.cwd());
        break;
      case "communities":
        result = await runGraphCommunities(process.cwd());
        break;
      default:
        throw new Error(`Unknown graph action: ${action}`);
    }
    await emit(result);
  });

program
  .command("forget")
  .description("FORGET — release (soft-evict) or supersede (replace) what a query addresses; hard delete is user-approved")
  .argument("<op>", "release | supersede | purge")
  .argument("[query]", "release/supersede only — matched by rare-token anchor + embedding similarity")
  .option("--slugs <slugs>", "purge only: comma-separated exact note slugs (no matching)")
  .option("--reason <text>", "purge only: why these notes should be removed (recorded in the intent)")
  .option("--new-text <text>", "supersede only: the replacement content")
  .option("-p, --project <projects...>", "supersede only: project tags for the replacement note")
  .option("--apply", "actually mutate (default: dry-run preview)")
  .option("--max-forget <n>", "refuse if the query addresses more than N notes (default 10; Infinity disables)", "10")
  .action(async (op, query, options: { newText?: string; project?: string[]; apply?: boolean; maxForget?: string; slugs?: string; reason?: string }) => {
    if (!["release", "supersede", "purge"].includes(op)) {
      await emit({ success: false, warnings: [`unknown op "${op}" — release | supersede | purge`] });
      return;
    }
    const cap = options.maxForget === "Infinity" ? Infinity : Number(options.maxForget);
    const result = await runForget({
      startDir: process.cwd(),
      op: op as "release" | "supersede" | "purge",
      query,
      slugs: options.slugs?.split(",").map((s) => s.trim()).filter(Boolean),
      reason: options.reason,
      newText: options.newText,
      project: options.project,
      apply: options.apply === true,
      maxForget: cap,
      actor: "cli",
    });
    await emit(result, result.success ? 0 : 1);
  });

program
  .command("probe")
  .description("Operational probes on a shipped hostile fixture vault — never touches your vault (probe --help for levels)")
  .addHelpText(
    "after",
    `
  mnemos probe                    full suite: hard cases + gate numbers
  mnemos probe --level hard       just the shipped-behavior regression guard
  mnemos probe --case <id>        one case (ids in the JSON report)
  mnemos probe --json             machine-readable report
  mnemos probe --keep             keep the temp fixture copies for inspection

The fixture is generated and shipped with the package — deterministic notes,
vocabulary-collision projects, a superseded-note trap, and a session lineage
graph designed to challenge the machinery. Your vault is never touched.`
  )
  .option("--level <level>", "hard | gate | all (default all)")
  .option("--case <id>", "run a single case by id")
  .option("--json", "machine-readable report")
  .option("--keep", "keep the temp fixture copies for inspection")
  .action(async (options: { level?: string; case?: string; json?: boolean; keep?: boolean }) => {
    const level = options.level === "hard" || options.level === "gate" ? options.level : "all";
    const report = await runProbe({ level, only: options.case, keep: options.keep });
    if (options.json) {
      const code = report.headline.hard_all_passed ? 0 : 1;
      await emit({ success: true, data: report, warnings: [] }, code);
      return;
    }
    const { headline } = report;
    console.log(`mnemos probe — fixture vault (${report.fixture.notes} notes, ${report.fixture.sessions} sessions)\n`);
    for (const c of report.cases) {
      const mark = c.passed === null ? "NUM " : c.passed ? "PASS" : "FAIL";
      console.log(`  [${mark}] ${c.level.padEnd(4)} ${c.id}`);
      if (!c.passed) console.log(`          ${c.detail}`);
    }
    console.log(
      `\n  hard: ${headline.hard_passed}/${headline.hard_total} passed` +
        `   gate dilution: ${headline.gate_dilution_pct}%   gate miss: ${headline.gate_miss_pct}%
  (gate targets, spec §9: dilution <= 5%, miss = 0)\n`,
    );
    await disposeEmbedder();
    await maybeNotifyUpdate();
    // Same exit contract as emit(): a settle window before exit — an
    // immediate process.exit() races the onnx runtime's teardown threads
    // (mutex lock failed) and kills the process after the report printed.
    process.stdout.write("", () => {
      setTimeout(() => process.exit(headline.hard_all_passed ? 0 : 1), 4000).unref();
    });
  });

program
  .command("requests")
  .description("Manage pending removal/identity intents (user-only surface)")
  .argument("[action]", "list | approve | deny")
  .argument("[id]", "intent id (approve/deny)")
  .action(async (action, id) => {
    if (!action || action === "list") {
      const result = await runRequestsList(process.cwd());
      await emit(result);
      return;
    }
    if ((action === "approve" || action === "deny") && id) {
      const result = await runRequestDecide(process.cwd(), id, action);
      await emit(result, result.success ? 0 : 1);
      return;
    }
    await emit({ success: false, warnings: ["usage: mnemos requests [list] | approve <id> | deny <id>"] }, 1);
  });

program
  .command("prune")
  .description("Activation topology analysis; archive candidates (dry-run by default)")
  .option("--apply", "actually archive candidates (default: dry-run)")
  .option("--verbose", "show full activation topology")
  .action(async (options: { apply?: boolean; verbose?: boolean }) => {
    const result = await runPrune({
      startDir: process.cwd(),
      dryRun: !options.apply,
      verbose: options.verbose,
    });
    await emit(result);
  });

program
  .command("explore")
  .description("Multi-hop graph exploration (PPR traversal, sub-question decomposition)")
  .argument("<query>", "natural language query to explore")
  .option("--limit <n>", "max notes to return (default 15)")
  .option("--depth <n>", "1=shallow, 2=standard, 3=deep (default 2)")
  .option("--no-recursive", "disable recursive sub-question decomposition")
  .option("--include-archived", "include archived notes")
  .option("--project <tag>", "filter RESULTS to one project's notes (traversal stays global; results name the other projects)")
  .action(async (query: string, options: { limit?: string; depth?: string; recursive?: boolean; includeArchived?: boolean; project?: string }) => {
    const result = await runExplore(
      process.cwd(),
      query,
      {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        depth: options.depth ? parseInt(options.depth, 10) : undefined,
        recursive: options.recursive,
        excludeArchived: options.includeArchived ? false : true,
        project: options.project,
      },
    );
    await emit(result);
  });


program
  .command("explore-start")
  .description("Open a navigated exploration session — you are the navigator")
  .argument("<query>", "natural language question to explore")
  .option("--budget <n>", "max expansions allowed (default: config)")
  .option("--json", "raw JSON output")
  .action(async (query: string, options: { budget?: string; json?: boolean }) => {
    const result = await runExploreStartCli(
      process.cwd(),
      query,
      options.budget ? parseInt(options.budget, 10) : undefined,
    );
    if (options.json) { await emit(result); return; }
    await printNavigated(result);
  });

program
  .command("explore-expand")
  .description("Steer an open exploration one step (one of --ask/--branch/--neighbors)")
  .argument("<exploration_id>", "session id from explore-start")
  .option("--ask <question>", "expand with your own sub-question")
  .option("--branch <nodeId>", "deepen a tree node (e.g. n2)")
  .option("--neighbors <title>", "graph-step to unvisited neighbors of a note")
  .option("--extend <n>", "grant more budget to this session first")
  .option("--json", "raw JSON output")
  .action(async (id: string, options: { ask?: string; branch?: string; neighbors?: string; extend?: string; json?: boolean }) => {
    if (options.extend) {
      const ext = await runExploreExtendCli(process.cwd(), id, parseInt(options.extend, 10));
      if (!ext.success) { await emit(ext); return; }
      console.log(`budget extended: ${(ext.data as { budget_remaining: number }).budget_remaining} remaining`);
      if (!options.ask && !options.branch && !options.neighbors) return;
    }
    let direction: { subQuestion: string } | { branch: string } | { neighbors: string };
    if (options.ask) direction = { subQuestion: options.ask };
    else if (options.branch) direction = { branch: options.branch };
    else if (options.neighbors) direction = { neighbors: options.neighbors };
    else {
      await emit({ success: false, warnings: ["provide exactly one of --ask, --branch, --neighbors (or --extend alone)"] });
      return;
    }
    const result = await runExploreExpandCli(process.cwd(), id, direction);
    if (options.json) { await emit(result); return; }
    await printNavigated(result);
  });

program
  .command("explore-conclude")
  .description("Close an exploration; the notes you used become the learning signal")
  .argument("<exploration_id>", "session id from explore-start")
  .option("--answered", "the exploration answered the question")
  .option("--used <titles>", "comma-separated note titles that contributed")
  .option("--json", "raw JSON output")
  .action(async (id: string, options: { answered?: boolean; used?: string; json?: boolean }) => {
    const result = await runExploreConcludeCli(process.cwd(), id, {
      answered: options.answered ?? false,
      usedNotes: options.used ? options.used.split(",").map((s) => s.trim()) : [],
    });
    await emit(result, 0, options.json ? 0 : 2);
  });

/** Render a navigated session: tree, then numbered frontier. */
async function printNavigated(result: { success: boolean; data: Record<string, unknown>; warnings: string[] }): Promise<void> {
  if (!result.success) {
    await emit(result);
    return;
  }
  const d = result.data as {
    exploration_id: string;
    budget_remaining: number;
    tree: Array<{ id: string; parent: string | null; kind: string; label: string; depth: number; new_notes: number; dead_end: boolean; exhausted: boolean; notes: Array<{ title: string; score: number; warmth: number | null }> }>;
    new_notes: string[];
    frontier: Array<{ option: number; direction: Record<string, string>; reason: string }>;
  };
  const exhausted = (d as unknown as { budget_exhausted?: boolean }).budget_exhausted;
  if (exhausted) {
    console.log(`budget exhausted — nothing expanded. Conclude, or grant more: mnemos explore-expand ${d.exploration_id} --extend 3 ...`);
  }
  console.log(`exploration: ${d.exploration_id}   budget left: ${d.budget_remaining}`);
  console.log("");
  for (const n of d.tree) {
    const indent = "  ".repeat(n.depth);
    const mark = n.dead_end ? " [DEAD END — vault doesn't know]" : n.exhausted ? " [exhausted — nothing new]" : "";
    console.log(`${indent}${n.id} (${n.kind}) ${n.label}${mark}`);
    for (const note of n.notes.slice(0, 8)) {
      const warm = note.warmth !== null && note.warmth !== undefined ? ` warm=${Number(note.warmth).toFixed(2)}` : "";
      console.log(`${indent}   - ${note.title} (${Number(note.score).toFixed(3)}${warm})`);
    }
    if (n.notes.length > 8) console.log(`${indent}   ... +${n.notes.length - 8} more`);
  }
  if (d.new_notes.length > 0) {
    console.log(`\nnew this step: ${d.new_notes.join(", ")}`);
  }
  console.log("\nfrontier (your options):");
  if (d.frontier.length === 0) console.log("   (none — expand with --ask, or conclude)");
  for (const f of d.frontier) {
    const dir = "subQuestion" in f.direction ? `--ask "${f.direction.subQuestion}"`
      : "branch" in f.direction ? `--branch ${f.direction.branch}`
      : `--neighbors "${f.direction.neighbors}"`;
    console.log(`   ${f.option}. ${dir}   # ${f.reason}`);
  }
  console.log(`\nnext: mnemos explore-expand ${d.exploration_id} <direction>   |   mnemos explore-conclude ${d.exploration_id} --answered --used "titles"`);
}

async function maybeNotifyUpdate(): Promise<void> {
  // Best-effort CLI update notice (issue #34): stderr only, suppressed for
  // scripts (no TTY), CI, opt-out env, and the long-running serve command.
  if (process.env.MNEMOS_NO_UPDATE_CHECK || process.env.CI) return;
  if (process.argv.includes("serve")) return;
  if (!process.stderr.isTTY) return;
  try {
    const update = await checkForUpdate();
    if (update.updateAvailable && update.message) {
      console.error(`\n${update.message}`);
    }
  } catch {
    // Never fail the CLI over an update check
  }
}

// Every command handler ends by printing one JSON document. add/promote touch
// SQLite and the embedding model, whose onnxruntime worker pool both (a) can
// park the event loop forever after printing and (b) aborts with a libc++abi
// mutex error if the process is force-exited while the session lives. So
// emit() disposes the embedder first (natural exit is then clean — verified),
// runs the TTY-gated update notice, flushes the JSON, and returns; the
// unref'd backstop only fires if something ELSE parks the loop, trading the
// old infinite hang for a bounded exit.
async function emit(result: unknown, code = 0, space?: number): Promise<void> {
  await disposeEmbedder();
  await maybeNotifyUpdate();
  process.stdout.write(JSON.stringify(result, null, space) + "\n", () => {
    setTimeout(() => process.exit(code), 4000).unref();
  });
}

// A statement may legitimately begin with a `--` line comment. The spec allows
// it; commander parses it as an unknown option, so the CLI printed a commander
// error to stderr and no JSON at all -- breaking the output contract for a
// documented input, while the same SQL through --stdin worked fine.
//
// Commander treats a bare `--` as end-of-options, but everything after one is
// positional. The first version of this guard inserted the separator before
// the first non-option argument, which silently killed every option written
// *after* the statement -- `mnemos sql "<q>" --limit 1` returned all rows with
// warnings:[] -- and the spec's own synopsis puts them there. So the
// separator goes in only immediately before an argument that actually looks
// like an option and is not one of ours; a plain statement is left alone.
const argv = process.argv.slice();
// --help/-h must reach commander untouched: the munging below would splice a
// '--' before it, turning the help flag into the query argument (observed:
// 'mnemos sql --help' ran a query and failed with 'No .mnemos marker found'
// instead of printing help).
if (argv[2] === "sql" && !argv.includes("--") && !argv.includes("--help") && !argv.includes("-h")) {
  const TAKES_VALUE = new Set(["--limit", "--timeout"]);
  const FLAGS = new Set(["--schema", "--stdin"]);
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (TAKES_VALUE.has(a)) { i++; continue; }
    if (FLAGS.has(a)) continue;
    if (a.startsWith("--limit=") || a.startsWith("--timeout=")) continue;
    // Only an argument that commander would mistake for an unknown option
    // needs protecting. Anything else is already parsed correctly.
    if (a.startsWith("-")) {
      argv.splice(i, 0, "--");
    }
    break;
  }
}

program
  .parseAsync(argv)
  .then(maybeNotifyUpdate)
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
