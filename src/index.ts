#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./core/version.js";
import { checkForUpdate } from "./core/update-check.js";
import { disposeEmbedder } from "./core/engine.js";
import { runForget, runRequestsList, runRequestDecide } from "./cli/forget.js";
import { readFileSync } from "node:fs";

import { runInitInteractive } from "./cli/init.js";
import { runStatus } from "./cli/status.js";
import { runHealth } from "./cli/health.js";
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
import { runBridgeClaudeCode, runBridgeClaudeCodeGlobal, runBridgeCodex, runBridgeCursor, runBridgeGeneric, runBridgeHermes, runBridgeOpenCode, runBridgeOri, runBridgeStatus } from "./cli/bridge.js";
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

Vault resolution (where your memory is found):
  1. MNEMOS_VAULT env var                  explicit - wins over everything
  2. walk up from the current directory    a dir with a .mnemos marker or mnemos.config.yaml
  3. mnemos serve --mcp only: falls back to the global vault (~/.mnemos-memory)

The vault IS a directory - cd into it and every command works:
  cd ~/ori-memory-vault && mnemos wake

MCP note: agents connect through the registered server (its config carries
--vault), so MCP sessions always know the vault. The CLI only knows it if
you stand inside it or set MNEMOS_VAULT.

Docs: https://github.com/cheney-enterprises/mnemos#readme`
  );

program
  .command("init")
  .description("Scaffold a new vault (notes/, self/, ops/, templates/, mnemos.config.yaml)")
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
  .description("Session-boot briefing: identity, goals, due reminders, project roster, policy gates. Run from inside a vault (or set MNEMOS_VAULT)")
  .option("--budget <n>", "max lines", "96")
  .action(async (options) => {
    const result = await runWake(process.cwd(), parseInt(options.budget, 10));
    console.log(result.lines.join("\n"));
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
  .description("Vault queries: orphans, dangling, backlinks, cross-project, ranked, similar, important, fading, warmth-audit (see also: memory_sql over MCP)")
  .argument("<kind>", "orphans | dangling | backlinks | cross-project | ranked | similar | important | fading | warmth-audit")
  .argument("[note]", "note title for backlinks, query text for ranked/similar, or query filter for warmth-audit")
  .option("--limit <n>", "max results", "10")
  .option("--threshold <n>", "vitality threshold for fading", "0.3")
  .action(async (kind: string, note: string | undefined, options: { limit?: string; threshold?: string }) => {
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
        result = await runQueryRanked(process.cwd(), note, options.limit ? parseInt(options.limit, 10) : undefined);
        break;
      case "similar":
        if (!note) {
          throw new Error("similar requires a query text");
        }
        result = await runQuerySimilar(process.cwd(), note, options.limit ? parseInt(options.limit, 10) : undefined);
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
  .description("Capture a note to inbox (auto-promotes when configured; a note without a project is staged, not filed - the ask-first gate returns the roster)")
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
  .description("Register the mnemos MCP server for a client: claude-code | cursor | codex | hermes | opencode | ori | generic")
  .argument("<target>", "claude-code | cursor | codex | hermes | opencode | ori | generic | status")
  .option("--global", "legacy shorthand for --scope global")
  .option("--scope <scope>", "install scope: project | global")
  .option("--activation <activation>", "activation mode: auto | manual")
  .option("--vault <path>", "explicit vault path")
  .option("--uninstall", "remove Mnemos bridge config for this target/scope")
  .option("--json", "output JSON for install planning")
  .action(async (
    target: string,
    options: { global?: boolean; scope?: string; activation?: string; vault?: string; uninstall?: boolean; json?: boolean }
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
  .description("Soft removal: release (soft-evict), supersede (replace). Hard delete is slug-addressed and user-approved.")
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
  .action(async (query: string, options: { limit?: string; depth?: string; recursive?: boolean; includeArchived?: boolean }) => {
    const result = await runExplore(
      process.cwd(),
      query,
      {
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        depth: options.depth ? parseInt(options.depth, 10) : undefined,
        recursive: options.recursive,
        excludeArchived: options.includeArchived ? false : true,
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
