import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../core/version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runAdd } from "./add.js";
import { runValidate } from "./validate.js";
import { runHealth } from "./health.js";
import { runPromote } from "./promote.js";
import { runQueryRanked, runQuerySimilar, runQueryWarmth } from "./search.js";
import { runExplore } from "./explore.js";
import { runIndexBuild } from "./indexcmd.js";
import { runPrune } from "./prune.js";
import { runForget } from "./forget.js";
import { runUpdateFile } from "./update.js";
import { findVaultRootWithSource, getGlobalVaultPath, getVaultPaths, type VaultPaths } from "../core/vault.js";
import { runInit } from "./init.js";
import { runWake } from "./wake.js";
import { GraphCache } from "../core/graph.js";
import { initDB } from "../core/engine.js";
import { loadConfig } from "../core/config.js";
import { loadPolicy, renderPolicySheet } from "../core/policy.js";
import { renderDoctrine, renderOnboarding, stripFrontmatter, isFirstRunIdentity as isFirstRun } from "../core/doctrine.js";
// Retrieval intelligence
import { initQValueTables, batchUpdateQ } from "../core/qvalue.js";
import { runReadOnlySql, describeSchema } from "../core/sqlquery.js";
import { SessionRewardAccumulator } from "../core/reward.js";
import {
  initCoOccurrenceTables,
  recordCoRetrieval,
  recomputeAllNPMI,
  runHomeostasis,
} from "../core/cooccurrence.js";
import {
  initStageTables,
  loadStage,
  saveStage,
  computeStageReward,
  STAGE_CONFIGS,
} from "../core/stage-learner.js";
import { StageTracker } from "../core/stage-tracker.js";
import type Database from "better-sqlite3";
import { checkForUpdate, buildAgentNotice, SessionNoticeGate, writeUpdateDecision } from "../core/update-check.js";
import { takeWhatsNewNotice, whatsNew } from "../core/whats-new.js";
import {
  getLearningResetStatus,
  buildLearningResetNotice,
  applyLearningResetDecision,
  recordLearningResetShown,
  MAX_RESET_REMINDERS,
} from "../core/learning-reset.js";

let vaultDir: string;
const graphCache = new GraphCache();

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

// --- Identity helpers ---

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

// stripFrontmatter / isFirstRun moved to core/doctrine.ts — single source of
// truth; wake and future transports consume the same helpers.

// Doctrine lives in core/doctrine.ts — the transport-neutral source of truth.
// This wrapper keeps the vault glue (reading identity.md, first-run detection)
// beside the MCP server that consumes it.
async function buildInstructions(paths: VaultPaths, autoCreated = false): Promise<string> {
  const identity = await safeReadFile(path.join(paths.self, "identity.md"));

  if (isFirstRun(identity)) {
    return renderOnboarding(autoCreated);
  }

  const summary = stripFrontmatter(identity).slice(0, 1000);
  return renderDoctrine({
    vaultRoot: paths.root,
    identitySummary: summary,
    autoCreated,
  });
}

// Updatable file routing moved to cli/update.ts (phase 3 — transport-neutral).

// --- MCP Server ---

export async function runServeMcp(startDir: string, vaultOverride?: string) {
  let autoCreated = false;

  try {
    const result = await findVaultRootWithSource(startDir, vaultOverride);
    vaultDir = result.path;
  } catch (err) {
    // Auto-create global vault ONLY if no explicit --vault was specified
    if (vaultOverride) throw err;
    const globalPath = getGlobalVaultPath();
    await runInit({ targetDir: globalPath });
    vaultDir = globalPath;
    autoCreated = true;
  }

  const paths = getVaultPaths(vaultDir);
  const instructions = await buildInstructions(paths, autoCreated);

  // ─── Retrieval Intelligence: Session lifecycle ───
  const sessionId = crypto.randomUUID();
  const noticeGate = new SessionNoticeGate();
  const whatsNewGate = new SessionNoticeGate();
  // Separate gate: the #37 reset question must not be swallowed by the update
  // notice (or vice versa) when both are pending in the same session.
  const resetNoticeGate = new SessionNoticeGate();
  const rewardAccumulator = new SessionRewardAccumulator(sessionId);
  const sessionStageTracker = new StageTracker();
  let sessionQueryFeatures: number[] | null = null;

  // Open persistent DB for intelligence layers
  const intelligenceDbPath = path.resolve(vaultDir, ".mnemos", "embeddings.db");
  let intelligenceDb: Database.Database | null = null;
  try {
    await fs.access(intelligenceDbPath);
    intelligenceDb = initDB(intelligenceDbPath);
    initQValueTables(intelligenceDb);
    initCoOccurrenceTables(intelligenceDb);
    initStageTables(intelligenceDb);
  } catch {
    // DB doesn't exist yet — intelligence layers will activate after first mnemos_index_build
  }

  // ─── Crash-safe reward checkpointing ───
  //
  // Measured on this machine 2026-09-13, not assumed. A stdio MCP server on
  // Windows cannot rely on ANY in-process shutdown hook:
  //   - closing stdin does not terminate it (verified: still alive 4s later),
  //     so `stdin.on("end")` never fires;
  //   - Windows has no real SIGTERM, and a host terminating the child calls
  //     TerminateProcess, which is uncatchable exactly like SIGKILL — verified
  //     exit code 1 with an empty stderr and no flush;
  //   - `beforeExit` never fires while the transport holds handles open.
  // The consequence was visible in the data: note_q held 717 rows of which 707
  // had update_count = 0, and `bySource` reported 12 `session_batch` writes in
  // six months. Those 12 are the times this process happened to die politely.
  //
  // So the terminal flush is structurally unreachable and trigger coverage alone
  // cannot fix it. Instead the session periodically writes its CURRENT computed
  // rewards to a single row keyed by session id. The write is an overwrite, not
  // an append, so repeating it cannot double-count — which is what makes this
  // safe despite `computeRewards` being session-scoped and the accumulator
  // having no clear(). If we are killed, the row survives and the next server
  // start applies it. A clean exit applies it directly and deletes the row.
  if (intelligenceDb) {
    intelligenceDb.exec(`
      CREATE TABLE IF NOT EXISTS session_checkpoint (
        session_id TEXT PRIMARY KEY,
        rewards_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  /** Scoring-rule version stamped on checkpoints; see applyAbandonedCheckpoints. */
  const CHECKPOINT_RULE = 37;

  const applyAbandonedCheckpoints = (): void => {
    if (!intelligenceDb) return;
    try {
      // A live server rewrites its checkpoint every 60 s, so one touched in the
      // last 5 minutes may belong to another process still running on this
      // vault; applying it here and again at that process's own flush credited
      // the session twice. It is picked up at a later start once stale.
      const rows = intelligenceDb
        .prepare(
          `SELECT session_id, rewards_json FROM session_checkpoint
            WHERE session_id != ? AND updated_at < datetime('now', '-5 minutes')`,
        )
        .all(sessionId) as { session_id: string; rewards_json: string }[];
      let recovered = 0;
      for (const row of rows) {
        let parsed: { rule?: number; rewards?: Record<string, number> };
        try {
          parsed = JSON.parse(row.rewards_json);
        } catch {
          // Corrupt row: drop it so it cannot block every future start.
          intelligenceDb.prepare("DELETE FROM session_checkpoint WHERE session_id = ?").run(row.session_id);
          continue;
        }
        try {
          // Checkpoints carry the scoring rule they were computed under. A
          // bare map is from a build before the #37 follow-up: its rewards were
          // computed under the defective rules (dead-end penalties, neutral
          // zeros) and replaying them now would stamp them as fixed-rule
          // learning (note_q.rule = 1). Those are discarded, not applied.
          const rewards = new Map<string, number>(
            parsed.rule === CHECKPOINT_RULE ? Object.entries(parsed.rewards ?? {}) : [],
          );
          // Apply and delete in ONE transaction, as the session-end flush does:
          // apart, a crash between them replayed the checkpoint at the next
          // start, and a failed apply followed by a successful delete lost it.
          // The re-check of the row inside the transaction stops two
          // processes recovering the same checkpoint from both applying it.
          const db = intelligenceDb;
          db.transaction(() => {
            const still = db.prepare("DELETE FROM session_checkpoint WHERE session_id = ?").run(row.session_id);
            if (still.changes === 0) return; // another process got it first
            if (rewards.size > 0) {
              batchUpdateQ(db, rewards, row.session_id);
              recovered += rewards.size;
            }
          })();
        } catch {
          // Transient failure: the transaction rolled back and the row is
          // still there for the next start. Never block the server.
        }
      }
      if (recovered > 0) {
        process.stderr.write(
          `[mnemos] recovered ${recovered} note reward(s) from ${rows.length} killed session(s)\n`,
        );
      }
    } catch {
      // Never let recovery stop the server from starting.
    }
  };
  applyAbandonedCheckpoints();

  const checkpointRewards = (): void => {
    if (!intelligenceDb || sessionFlushed || !rewardAccumulator.hasData()) return;
    try {
      const rewards = rewardAccumulator.computeRewards(intelligenceDb);
      if (rewards.size === 0) return;
      intelligenceDb
        .prepare(
          `INSERT INTO session_checkpoint (session_id, rewards_json, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(session_id) DO UPDATE SET
             rewards_json = excluded.rewards_json, updated_at = excluded.updated_at`,
        )
        .run(sessionId, JSON.stringify({ rule: CHECKPOINT_RULE, rewards: Object.fromEntries(rewards) }));
    } catch {
      // Best effort. A failed checkpoint costs this session's learning, not the
      // server.
    }
  };

  // 60s. unref() so an idle checkpoint timer can never be the reason the process
  // stays alive — this exists to survive a kill, not to cause one.
  const checkpointTimer = setInterval(checkpointRewards, 60_000);
  checkpointTimer.unref();

  // Session-end flush: update all 3 intelligence layers
  let sessionFlushed = false;
  const flushSession = () => {
    if (sessionFlushed || !intelligenceDb) return;
    sessionFlushed = true;

    try {
      const db = intelligenceDb;
      const tx = db.transaction(() => {
        // Co-occurrence: pairs already recorded live per-query.
        // Session-end: recompute NPMI weights and run homeostasis normalization.
        try {
          recomputeAllNPMI(db);
          runHomeostasis(db);
        } catch {
          // co_occurrence table may be empty — skip silently
        }

        // Q-values: the ONLY place session credit is assigned. Rewritten
        // 2026-08-28 — this used to be described as a "correction pass" on top
        // of per-query proxy rewards. Those proxies are gone; forward citation,
        // updates, downstream creation and dead ends are all session-scoped
        // outcomes and can only be known here.
        if (rewardAccumulator.hasData()) {
          const rewards = rewardAccumulator.computeRewards(db);
          batchUpdateQ(db, rewards, sessionId);

          // Applied directly, so our checkpoint row must go. Leaving it would
          // make the next server start re-apply this session's rewards a second
          // time — the overwrite discipline only protects repeated CHECKPOINTS,
          // not a checkpoint plus a terminal flush. Same transaction, so either
          // both land or neither does.
          db.prepare("DELETE FROM session_checkpoint WHERE session_id = ?").run(sessionId);

          // Emit the signal mix to stderr. The five-month proxy failure was
          // invisible because nothing ever reported WHICH signals fired — a
          // single line per session would have shown forward_citation stuck at
          // zero within a week. stderr, not stdout: stdout is the MCP channel.
          const counts = rewardAccumulator.getSignalCounts();
          const summary = Object.entries(counts)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          if (summary) {
            process.stderr.write(`[mnemos] session learning: ${summary}\n`);
          }
        }

        // Stage learning: updated per-query in the tool handlers, which is
        // correct — a stage's effect on ranking quality is observable within
        // the query that ran it, unlike note usefulness.
      });
      tx();
    } catch {
      // Best-effort flush — don't crash the process
    }

    try {
      intelligenceDb?.close();
    } catch {
      // Already closed or never opened
    }
  };

  // Register shutdown handlers.
  //
  // Measured 2026-09-13: note_q held 717 rows of which 707 had update_count = 0,
  // and `bySource` reported exactly 12 `session_batch` writes in six months.
  // That is not a policy outcome, it is the number of times this process
  // happened to die politely. The three handlers below were the whole list, and
  // none of them fires for a stdio MCP server in practice:
  //   - `beforeExit` never fires while the stdio transport keeps handles live,
  //     and never fires at all after an explicit process.exit().
  //   - SIGINT/SIGTERM are delivered to an interactive shell's child, not to a
  //     server the host terminates; on Windows SIGTERM is not really deliverable.
  // So the learning loop was structurally unable to close. Same shape as the
  // stage-bandit starvation: wired, correct-looking, never executed.
  //
  // The fix is trigger coverage, not flush frequency. Rewards here are
  // session-scoped by construction — forward citation, downstream creation and
  // dead ends are only knowable at the end — and SessionRewardAccumulator has no
  // clear(), so a periodic flush would recompute over the whole accumulated set
  // and inflate update_count and reward_sum on every pass. One flush per
  // session is right; it just has to happen.
  //
  // `exit` is the important addition: it fires for process.exit() and for a
  // normal return, and better-sqlite3 is synchronous, so a DB write is legal in
  // it. stdin end/close is the real shutdown signal for a stdio MCP server —
  // the host closes the pipe rather than signalling.
  process.on("exit", flushSession);
  process.on("beforeExit", flushSession);

  const flushAndExit = (code: number) => {
    flushSession();
    process.exit(code);
  };
  process.on("SIGINT", () => flushAndExit(0));
  process.on("SIGTERM", () => flushAndExit(0));
  process.on("SIGHUP", () => flushAndExit(0));

  // The host closing the pipe is how this server is normally shut down.
  process.stdin.on("end", () => flushAndExit(0));
  process.stdin.on("close", () => flushAndExit(0));

  // A crash is still a session that happened and still earned its rewards.
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[mnemos] uncaught: ${err?.stack ?? err}\n`);
    flushAndExit(1);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`[mnemos] unhandled rejection: ${String(err)}\n`);
    flushAndExit(1);
  });

  // SIGKILL and a hard power loss still lose the session, and nothing in-process
  // can change that. Surviving those needs delta-checkpointing in
  // SessionRewardAccumulator so a partial flush is safe to repeat — a separate
  // change with its own correctness argument, deliberately not made here.

  const server = new McpServer(
    { name: "mnemos", version: VERSION },
    { instructions },
  );

  // ─── Resources: identity layer (5 resources) ───

  server.resource("identity", "mnemos://identity", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "identity.md")),
    }],
  }));

  server.resource("goals", "mnemos://goals", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "goals.md")),
    }],
  }));

  server.resource("methodology", "mnemos://methodology", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.self, "methodology.md")),
    }],
  }));

  server.resource("daily", "mnemos://daily", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "daily.md")),
    }],
  }));

  server.resource("reminders", "mnemos://reminders", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "reminders.md")),
    }],
  }));

  // The operating manual — intended use, global/project/session scopes,
  // naming, command workflows. Sits in ops/ so the operational layer
  // carries it; every transport serves the same text from the scaffold.
  server.resource("manual", "mnemos://manual", async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: "text/markdown",
      text: await safeReadFile(path.join(paths.ops, "manual.md")),
    }],
  }));

  // The effective policy sheet — the capability model the agent reads to
  // PREDICT refusals instead of discovering them by trial. Rendered from the
  // same loadPolicy the enforcement sites consume, so the sheet cannot drift
  // from what is actually enforced. The agent cannot change policy; this is a
  // read-only window onto the user's config.
  server.resource("policy", "mnemos://policy", async (uri) => {
    const config = await loadConfig(paths.config);
    const { policy, source } = loadPolicy(config);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: renderPolicySheet(policy, source),
      }],
    };
  });

  // ─── #37 learning reset: offered to the agent, never forced ───
  const attachLearningResetNotice = (payload: Record<string, unknown>): void => {
    // One status check per session, whatever it finds: the check scans
    // q_history, and a vault below the offer threshold would otherwise pay
    // that scan on every ranked query forever.
    if (!intelligenceDb || !resetNoticeGate.take()) return;
    try {
      const status = getLearningResetStatus(intelligenceDb);
      if (!status.offer) return;
      // Count first, attach only if counting succeeded: an ask that cannot be
      // counted (read-only or locked db) must not be shown, or the cap leaks.
      // The label uses the atomic count, so concurrent servers agree on it.
      const n = recordLearningResetShown(intelligenceDb);
      if (n > MAX_RESET_REMINDERS) return;
      const notice = buildLearningResetNotice({ ...status, timesShown: n - 1 });
      if (notice) payload.learning_reset_notice = notice;
    } catch {
      // Best effort: a notice must never fail the tool carrying it.
    }
  };

  // ─── What's new after an update: once per machine per update ───
  const attachWhatsNew = async (payload: Record<string, unknown>): Promise<void> => {
    if (!whatsNewGate.take()) return;
    try {
      const notice = await takeWhatsNewNotice();
      if (notice) payload.whats_new = notice;
    } catch {
      // Best effort: a notice must never fail the tool carrying it.
    }
  };

  // ─── Tools ───


  server.tool(
    "mnemos_wake",
    "Session boot, budget-capped. Two steps: (1) call with NO project — get identity, the " +
      "project roster, and policy; (2) call again with project=<tag> — get that project's map " +
      "Current State, its daily lines, and its recent notes. The roster feeds the ask-first " +
      "gate; policy predicts removal refusals. On a vault with no identity yet it returns an " +
      "onboarding script instead.",
    {
      budget: z.number().optional().describe("Max lines (default 96)"),
      project: z.string().optional().describe("Second call: the project tag whose scoped context to load (from the roster the first call returned)"),
    },
    async ({ budget, project }) => {
      const payload: Record<string, unknown> = await runWake(vaultDir, budget ?? 96, project);
      attachLearningResetNotice(payload);
      await attachWhatsNew(payload);

      // First-run detection and onboarding used to live in mnemos_orient, whose
      // own description said "prefer mnemos_wake for session start". Removing
      // orient as superseded would have silently dropped the only path that
      // bootstraps a brand-new vault, because wake never carried this. Moving
      // it here is what makes that supersession true rather than asserted.
      const identity = await safeReadFile(path.join(getVaultPaths(vaultDir).self, "identity.md"));
      payload.firstRun = isFirstRun(identity);
      if (payload.firstRun === true) {
        payload.onboarding = {
          steps: [
            "Ask the user to NAME their agent (default: Mnemos)",
            "Ask the PURPOSE — offer: general-purpose AI agent, personal knowledge, research, work/professional, learning journal, or custom",
            "BRAIN DUMP — ask them to share everything about themselves, projects, goals. More context = better agent from day one",
            "COMMUNICATION STYLE — how should the agent talk? Direct? Formal? Casual? Opinionated?",
          ],
          save_with: "Use mnemos_update to write identity, goals, and methodology based on their answers",
        };
      }
      return textResult(payload);
    }
  );

  // mnemos_update_decision — record the user's answer to the update question (#34 follow-on)
  server.tool(
    "mnemos_update_decision",
    "Record the user's answer to an Mnemos update notice. Call ONLY after the user explicitly answers. " +
      "decision=accepted after a successful update; decision=declined if they want to stay. " +
      "If the user defers, do not call this — the reminder resurfaces next session.",
    {
      version: z.string().describe("The version the user was asked about (from the update notice)"),
      decision: z.enum(["accepted", "declined"]).describe("The user's answer"),
    },
    async ({ version, decision }) => {
      await writeUpdateDecision(version, decision);
      return textResult({ success: true, version, decision, note: "Decision recorded; this version will not be asked again." });
    }
  );

  server.tool(
    "mnemos_whats_new",
    "Release notes for an Mnemos version (default: the installed one). Use when the user asks what changed, " +
      "or to read notes cut short in a whats_new notice.",
    { version: z.string().optional().describe("e.g. 0.8.0; omit for the installed version") },
    async ({ version }) => textResult({ version: version ?? VERSION, notes: whatsNew(version) }),
  );

  // mnemos_learning_reset — record the user's answer to the #37 reset question
  server.tool(
    "mnemos_learning_reset",
    "Record the user's answer to Mnemos's learning-reset question (learning_reset_notice). Call ONLY after the " +
      "user explicitly answers. decision=accepted clears learned ranking scores (notes are untouched; the " +
      "database is backed up first). decision=declined keeps them and permanently stops the question. If " +
      "the user says 'not now', do not call this; the question is raised at most 3 times in total.",
    { decision: z.enum(["accepted", "declined"]).describe("The user's answer") },
    async ({ decision }) => {
      if (!intelligenceDb) return errorResult("no index yet; nothing to reset");
      try {
        const result = applyLearningResetDecision(intelligenceDb, intelligenceDbPath, decision);
        return textResult({ success: true, ...result });
      } catch (err) {
        return errorResult(`learning reset failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // mnemos_update — write self/, ops/, or a map's Current State (phase 3).
  // The transport-neutral engine lives in cli/update.ts; policy gates and
  // backups are enforced there so every future transport inherits them.
  server.tool(
    "mnemos_update",
    "Update agent files: identity, goals, methodology (self/), daily, reminders (ops/), " +
      "or file=map to overwrite a project map's Current State section (the SESSION END ritual; " +
      "requires project; replace semantics — Key Notes and frontmatter untouched). " +
      "Auto-backs up the previous version before writing. Policy gates apply.",
    {
      file: z.enum(["identity", "goals", "methodology", "daily", "reminders", "map"])
        .describe("Which file to update; map = the project map's Current State section"),
      content: z.string().describe("Full new content for the file; for map, the new Current State body (3-5 lines: done, next action, blocked)"),
      project: z.string().optional().describe("file=map: the project whose map to update (from the wake roster). file=daily|goals: land the write in the project's own ops/<tag>/ state files (the scoped wake reads these first). Ignored for identity/methodology/reminders."),
    },
    async ({ file, content, project }) => {
      const result = await runUpdateFile({ startDir: vaultDir, file, content, project });
      if (!result.success) return errorResult(result.warnings.join(" "));
      if (result.data.intent_proposed) return textResult({ success: true, ...result.data });
      rewardAccumulator.logUpdate(file);
      return textResult({ success: true, ...result.data });
    }
  );


  // mnemos_add
  server.tool(
    "mnemos_add",
    "Create a note in inbox. Always pass description and project: you know them now. " +
      "If you cannot determine the project, the response asks you to — present the question " +
      "and the project roster to the user, get an answer (existing project, or a new one and " +
      "its name), then re-call with project set. Never guess a project.",
    {
      title: z.string().describe("Note title (prose-as-title)"),
      type: z.string().optional().describe("Note type (default: insight)"),
      content: z
        .string()
        .optional()
        .describe(
          "Note body content. If omitted, creates a template stub that must be filled before promotion."
        ),
      description: z.string().optional().describe("One sentence adding context beyond the title (max 200 chars)"),
      project: z.array(z.string()).optional().describe("Project tags that apply to this note — ask the user if unsure (the tool refuses with the roster if none given and none detectable)"),
    },
    async ({ title, type, content, description, project }) => {
      const result = await runAdd({
        startDir: vaultDir,
        title,
        type: type ?? "insight",
        content: content ?? undefined,
        description: description ?? undefined,
        project: project ?? undefined,
      });

      // Log to reward accumulator for forward citation detection
      if (result.success) {
        rewardAccumulator.logAdd(title, content ?? "");
      }

      return textResult(result);
    }
  );

  // mnemos_validate
  server.tool(
    "mnemos_validate",
    "Validate a note against schema",
    {
      path: z.string().describe("Path to note file"),
    },
    async ({ path }) => {
      const result = await runValidate({ notePath: path, startDir: vaultDir });
      return textResult(result);
    }
  );

  // mnemos_health
  server.tool("mnemos_health", "Full diagnostic", {}, async () => {
    const result = await runHealth(vaultDir, await graphCache.get(paths.notes));
    return textResult(result);
  });

  // mnemos_promote
  server.tool(
    "mnemos_promote",
    "Promote an inbox note to notes/ with classification, linking, and area assignment. " +
      "YOU are the intelligence layer — read the note, decide its type, write a description, " +
      "identify links to existing notes, and pass your decisions as overrides. " +
      "Heuristics run as fallback for anything you don't specify.",
    {
      path: z.string().describe("Inbox note filename or path"),
      type: z.string().optional().describe("Your classification: idea | decision | learning | insight | blocker | opportunity"),
      description: z.string().optional().describe("One sentence adding context beyond the title (max 200 chars)"),
      links: z.array(z.string()).optional().describe("Existing note titles this note should link to"),
      project: z.array(z.string()).optional().describe("Project tags that apply to this note"),
      dry_run: z.boolean().optional().describe("Preview changes without writing"),
    },
    async ({ path, type, description, links, project, dry_run }) => {
      const result = await runPromote({
        startDir: vaultDir,
        noteName: path,
        dryRun: dry_run === true,
        type: type ?? undefined,
        description: description ?? undefined,
        links: links ?? undefined,
        project: project ?? undefined,
      });
      if (dry_run !== true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // memory_sql
  server.tool(
    "memory_sql",
    "Read-only SQL over your memory index (SQLite). Use for questions the ranking tools " +
      "cannot express. Views: v_note (slug, title, type, modified, access_count, inbound, " +
      "outbound, pagerank, betweenness, q_value, exposure_count), v_link (src, dst edges), " +
      "v_dangling (missing link targets and who cites them), v_retrieval (every note ever " +
      "returned to you: session_id, timestamp, query_text, slug, rank, final_score), " +
      "v_session, v_stage. Also note_project(note_id, project) and co_occurrence. " +
      "Single SELECT/WITH/EXPLAIN/VALUES only, strings in single quotes, 200 rows and 2s max. " +
      "Pass schema=true for full DDL. Examples: notes never retrieved — " +
      "SELECT title FROM v_note WHERE slug NOT IN (SELECT slug FROM v_retrieval); " +
      "surfaced but never useful — SELECT title, exposure_count FROM v_note WHERE " +
      "exposure_count > 20 AND q_updates = 0; who cites X — SELECT src_title FROM v_link " +
      "WHERE dst LIKE '%X%'.",
    {
      sql: z.string().optional().describe("A single read-only statement"),
      limit: z.number().optional().describe("Max rows (default 200, hard cap 500)"),
      schema: z.boolean().optional().describe("Return tables, views, DDL and row counts instead of querying"),
    },
    async ({ sql, limit, schema }) => {
      if (schema === true) {
        try {
          return textResult({ success: true, data: describeSchema(intelligenceDbPath), warnings: [] });
        } catch {
          // A missing index is a state the agent can fix, not a crash.
          return errorResult("no index at " + intelligenceDbPath + "; run mnemos_index_build");
        }
      }
      if (sql === undefined || sql.trim() === "") {
        return errorResult("no SQL given; pass sql, or schema=true to see what is queryable");
      }
      const result = await runReadOnlySql(intelligenceDbPath, sql, {
        rowCap: Math.min(limit ?? 200, 500),
        timeoutMs: 2000,
      });
      const failed = result.columns.length === 0 && result.rows.length === 0 && result.warnings.length > 0;
      return textResult({
        success: !failed,
        data: { columns: result.columns, rows: result.rows, truncated: result.truncated, elapsedMs: result.elapsedMs },
        warnings: result.warnings,
      });
    }
  );

  // mnemos_query_ranked
  server.tool(
    "mnemos_query_ranked",
    "Full ranked retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning. " +
      "4 base signals (composite + keyword + graph + warmth) fused via RRF, then Phase B Q-value reranking. " +
      "Excludes archived notes by default. Triggers spreading activation. " +
      "Pass project to hard-scope to one project (results then name the other projects); omit to search the whole vault.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
      project: z.string().optional().describe("Hard-filter results to one project's notes (from the wake roster). Omit to search the whole vault — cross-project learning is the unscoped default. Scoped results name the other projects so you know the scope was a choice."),
    },
    async ({ query, limit, include_archived, project }) => {
      const result = await runQueryRanked(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
        intelligenceDb ?? undefined,
        sessionId,
        sessionStageTracker,
        project,
      );

      // #37 reset question and what's new, for sessions that skip wake.
      if (result.success) attachLearningResetNotice(result.data as Record<string, unknown>);
      if (result.success) await attachWhatsNew(result.data as Record<string, unknown>);

      // Once-per-session update notice fallback (sessions that skip wake)
      if (result.success) {
        try {
          const update = await checkForUpdate();
          const notice = await buildAgentNotice(update);
          if (notice && noticeGate.take()) {
            (result.data as Record<string, unknown>).update_notice = notice;
          }
        } catch {
          // best effort; ignore failures
        }
      }

      // Log retrievals to reward accumulator for session-end credit assignment
      if (result.success && result.data.results.length > 0) {
        const intent = result.data.intent ?? "semantic";
        for (const [rank, note] of result.data.results.entries()) {
          rewardAccumulator.logRetrieval(note.title, rank, query, intent);
        }
        // Capture query features for stage meta-learning
        const { extractQueryFeatures } = await import("../core/stage-learner.js");
        sessionQueryFeatures = extractQueryFeatures(query, 0, result.data.count, 0);

        // --- Live learning (Constraint 3) ---
        if (intelligenceDb) {
          const titles = result.data.results.slice(0, 9).map((n: { title: string }) => n.title);

          // Live co-occurrence: record pairs for notes co-retrieved in this query
          if (titles.length > 1) {
            for (let i = 0; i < titles.length; i++) {
              for (let j = i + 1; j < titles.length; j++) {
                recordCoRetrieval(intelligenceDb, titles[i], titles[j]);
              }
            }
          }

          // Per-query Q-writes removed 2026-08-28. This block rewarded a
          // note ~0.02 for merely appearing in results this ranker produced —
          // a participation trophy that became 93.4% of all reward history and
          // inverted the learned values (pearson(exposure, Q) = -0.537).
          // Retrievals are logged to rewardAccumulator above; credit is
          // assigned once at session end where outcomes are actually known.
          // `updateQ` now rejects non-session-end sources outright.

          // Live stage learning: update LinUCB per-query with correct features
          if (sessionStageTracker.hasResults() && sessionQueryFeatures) {
            const stages = STAGE_CONFIGS.map((c) => loadStage(intelligenceDb, c));
            for (const sr of sessionStageTracker.drain()) {
              const stage = stages.find((s) => s.config.id === sr.stageId);
              if (!stage) continue;
              const reward = computeStageReward(sr.qualityBefore, sr.qualityAfter, sr.computeMs);
              stage.update(sessionQueryFeatures, reward);
              saveStage(intelligenceDb, stage);
            }
          }
        }
      }

      return textResult(result);
    }
  );

  // mnemos_explore
  server.tool(
    "mnemos_explore",
    "Deep memory exploration via PPR graph traversal. Propagates through wiki-links " +
      "at exploration-tuned parameters (α=0.45), returns ranked notes with content snippets. " +
      "Use for multi-hop questions, connection discovery, and deep recall. " +
      "Heavier than mnemos_query_ranked but finds notes flat retrieval misses. " +
      "Pass project to scope the ANSWER set (traversal crosses the whole graph; results are filtered + the other projects are named); omit to explore the whole vault.",
    {
      query: z.string().describe("Natural language query to explore"),
      limit: z.number().optional().describe("Max notes to return (default 15, max 30)"),
      depth: z.number().optional().describe("1=shallow, 2=standard, 3=deep (default 2)"),
      include_content: z.boolean().optional().describe("Include note snippets (default true)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default false)"),
      recursive: z.boolean().optional().describe(
        "Enable recursive sub-question decomposition via LLM (requires llm config, default true)"
      ),
      project: z.string().optional().describe("Filter RESULTS to one project's notes (traversal stays global — the graph is honest; the answer set is scoped). Omit = whole vault."),
    },
    async ({ query, limit, depth, include_content, include_archived, recursive, project }) => {
      const result = await runExplore(
        vaultDir,
        query,
        {
          project,
          limit: limit ?? undefined,
          depth: depth ?? undefined,
          includeContent: include_content ?? undefined,
          excludeArchived: include_archived ? false : true,
          recursive: recursive ?? undefined,
        },
        await graphCache.get(paths.notes),
        intelligenceDb ?? undefined,
        sessionId,
        sessionStageTracker,
      );

      if (result.success && result.data.results.length > 0) {
        const intent = result.data.intent ?? "semantic";
        for (const [rank, note] of result.data.results.entries()) {
          rewardAccumulator.logRetrieval(note.title, rank, query, intent);
        }

        // --- Live learning (Constraint 3) ---
        if (intelligenceDb) {
          const titles = result.data.results.slice(0, 9).map((n: { title: string }) => n.title);

          // Live co-occurrence
          if (titles.length > 1) {
            for (let i = 0; i < titles.length; i++) {
              for (let j = i + 1; j < titles.length; j++) {
                recordCoRetrieval(intelligenceDb, titles[i], titles[j]);
              }
            }
          }

          // Per-query Q-writes removed 2026-08-28 — second copy of the same
          // proxy, on the explore path. Explore returns more notes per call, so
          // this copy inflated the contamination faster. See the postmortem on
          // the mnemos_query_ranked site above.

          // Live stage learning
          if (sessionStageTracker.hasResults()) {
            const { extractQueryFeatures } = await import("../core/stage-learner.js");
            const features = extractQueryFeatures(query, 0, result.data.count, 0);
            if (features) {
              const stages = STAGE_CONFIGS.map((c) => loadStage(intelligenceDb, c));
              for (const sr of sessionStageTracker.drain()) {
                const stage = stages.find((s) => s.config.id === sr.stageId);
                if (!stage) continue;
                const reward = computeStageReward(sr.qualityBefore, sr.qualityAfter, sr.computeMs);
                stage.update(features, reward);
                saveStage(intelligenceDb, stage);
              }
            }
          }
        }
      }

      return textResult(result);
    }
  );




  // mnemos_warmth
  server.tool(
    "mnemos_warmth",
    "Associative warmth field for the current context. Returns low-token note titles, scores, and sources showing what memory is resonating before and alongside retrieval. " +
      "Pass project to scope the field to one project (the field names the others); omit to feel the whole vault.",
    {
      context: z.string().describe("Current conversation text or retrieval context"),
      limit: z.number().optional().describe("Max warmth signals to return (default 20)"),
      project: z.string().optional().describe("Hard-filter the field to one project's notes. Omit = whole vault."),
    },
    async ({ context, limit, project }) => {
      const result = await runQueryWarmth(
        vaultDir,
        context,
        limit,
        await graphCache.get(paths.notes),
        project,
      );
      return textResult(result);
    }
  );

  // mnemos_query_similar
  server.tool(
    "mnemos_query_similar",
    "Composite vector search only (semantic + metadata, no keyword/graph). Faster but single-signal. Excludes archived notes by default. " +
      "Pass project to hard-scope to one project (results name the other projects); omit to search the whole vault.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_archived: z.boolean().optional().describe("Include archived notes (default: false)"),
      project: z.string().optional().describe("Hard-filter results to one project's notes. Omit = whole vault."),
    },
    async ({ query, limit, include_archived, project }) => {
      const result = await runQuerySimilar(
        vaultDir,
        query,
        limit,
        include_archived ? false : true,
        await graphCache.get(paths.notes),
        project,
      );
      return textResult(result);
    }
  );



  // mnemos_prune
  server.tool(
    "mnemos_prune",
    "Analyze activation topology and identify archive candidates. " +
      "Dry-run by default. Set apply=true to archive.",
    {
      apply: z.boolean().optional().describe("Actually archive (default: dry-run preview)"),
    },
    async ({ apply }) => {
      const result = await runPrune({
        startDir: vaultDir,
        dryRun: apply !== true,
      });
      if (apply === true && result.success) {
        graphCache.invalidate();
      }
      return textResult(result);
    }
  );

  // mnemos_forget — release | supersede. Dry-run by default; blast-radius cap.
  // purge is deliberately NOT exposed as a tool: an agent must not be able to
  // hard-delete vault records — a human types `mnemos forget purge` in a shell.
  server.tool(
    "mnemos_forget",
    "Removal operations. op=release: soft-evict matched notes (status=released, files kept, never recalled) — reversible. " +
      "op=supersede: mark the single best match superseded and write a replacement note (requires new_text). " +
      "Dry-run by default — set apply=true after reviewing the match list. Refuses when the query addresses more than max_forget notes. " +
      "op=purge: HARD DELETE — slug-addressed only (pass slugs, never a query). This tool can only PROPOSE a purge: " +
      "it records a pending intent and returns the command the USER must run to execute it. Never tell the user a purge happened.",
    {
      op: z.enum(["release", "supersede", "purge"]).describe("release = soft-evict; supersede = replace; purge = propose hard delete (user executes)"),
      query: z.string().optional().describe("release/supersede: what to forget — matched by rare-token anchor + embedding similarity"),
      slugs: z.array(z.string()).optional().describe("purge only: exact note slugs (no matching)"),
      reason: z.string().optional().describe("purge only: why these notes should be removed"),
      new_text: z.string().optional().describe("supersede only: the replacement content"),
      project: z.array(z.string()).optional().describe("supersede only: project tags for the replacement note"),
      apply: z.boolean().optional().describe("Actually mutate (default false = dry-run preview)"),
      max_forget: z.number().optional().describe("Blast-radius cap (default 10)"),
    },
    async ({ op, query, slugs, reason, new_text, project, apply, max_forget }) => {
      if ((op === "release" || op === "supersede") && !query?.trim()) {
        return errorResult("release/supersede require query (what to forget)");
      }
      if (op === "supersede" && !new_text?.trim()) {
        return errorResult("supersede requires new_text (the replacement content)");
      }
      if (op === "purge" && query) {
        return errorResult(
          "purge does not accept a query — hard delete is slug-addressed only. Pass slugs (exact note slugs) to propose a purge, or use release/supersede for soft removal.",
        );
      }
      const result = await runForget({
        startDir: vaultDir,
        op,
        query,
        slugs,
        reason,
        newText: new_text,
        project,
        apply: apply === true,
        maxForget: max_forget,
        actor: "mcp",
      });
      if (result.success) graphCache.invalidate();
      return textResult(result);
    }
  );

  // mnemos_index_build
  server.tool(
    "mnemos_index_build",
    "Build or update the embedding index. Only re-embeds changed notes unless force=true. " +
      "Also bootstraps co-occurrence edges from wiki-link structure.",
    {
      force: z.boolean().optional().describe("Rebuild all embeddings (default false)"),
    },
    async ({ force }) => {
      // Embeddings, derived index and the co-occurrence bootstrap all happen
      // inside runIndexBuild now, so the CLI and this tool build the same
      // thing. This handler used to bootstrap co-occurrence itself, inside a
      // bare catch, and the CLI never did.
      const result = await runIndexBuild(vaultDir, force === true);
      graphCache.invalidate();
      return textResult(result);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Update notice at server start (stderr only — stdout is the MCP channel)
  try {
    const update = await checkForUpdate();
    if (update.updateAvailable && update.message) {
      console.error(`[mnemos] ${update.message}`);
    }
  } catch {
    // best effort; ignore failures
  }
}
