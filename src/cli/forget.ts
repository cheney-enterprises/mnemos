/**
 * mnemos forget — the removal surface, under the capability model.
 *
 * Tier structure (policy.gates in mnemos.config.yaml):
 *   release / supersede   — soft, reversible, dry-run default, blast cap.
 *                           policy gate: soft_removal (allow by default).
 *   purge                 — hard delete. Slug-addressed ONLY (the 2026-11-07
 *                           incident: a query-addressed purge matched 6 notes
 *                           and unlinked them). purge executes ONLY from an
 *                           approved intent; the agent-callable surface can
 *                           propose, never execute.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, type VaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { initDB, removeNoteFromDB } from "../core/engine.js";
import { writeFrontmatterFile } from "../core/frontmatter.js";
import {
  release,
  supersede,
  ForgetBlastRadiusError,
  type ForgetMatch,
} from "../core/forget.js";
import { runIndexBuild } from "./indexcmd.js";
import {
  loadPolicy,
  proposeIntent,
  getIntent,
  listIntents,
  writeIntent,
  audit,
  PolicyError,
  type IntentRecord,
  type RemovalIntent,
} from "../core/policy.js";

export type ForgetOp = "release" | "supersede" | "purge";

export interface ForgetRunOptions {
  startDir: string;
  op: ForgetOp;
  query?: string;
  /** purge only: exact slugs. No matching, ever. */
  slugs?: string[];
  /** purge only: recorded on the intent. */
  reason?: string;
  newText?: string;
  apply?: boolean;
  maxForget?: number;
  project?: string[];
  /** identity of the caller for intents/audit ("mcp" | "cli" | session id). */
  actor?: string;
}

export interface ForgetRunResult {
  success: boolean;
  data?: {
    op: ForgetOp;
    query?: string;
    apply: boolean;
    matched: ForgetMatch[];
    changed: number;
    /** Present when the gate required user approval — execution is the user's. */
    intent?: IntentRecord;
    policy?: { line: string };
  };
  warnings: string[];
}

async function trashCopy(paths: VaultPaths, file: string, slug: string): Promise<void> {
  const dir = path.join(paths.ops, ".trash", slug);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(paths.ops, ".trash", slug, `${stamp}.md`);
  await fs.copyFile(file, dest);
}

/**
 * Execute an approved purge intent: exact slugs, trash copy first, index
 * updated, audit line written. Called only from the user-side approve path.
 */
export async function executeApprovedPurge(
  vaultRoot: string,
  intent: RemovalIntent,
): Promise<{ changed: number; warnings: string[] }> {
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const warnings: string[] = [];
  let changed = 0;

  for (const slug of intent.slugs) {
    const file = path.join(paths.notes, `${slug}.md`);
    try {
      await fs.access(file);
    } catch {
      warnings.push(`skipped (already gone): ${slug}`);
      continue;
    }
    await trashCopy(paths, file, slug);
    await fs.rm(file, { force: true });
    changed++;
  }

  if (changed > 0) {
    const db = initDB(path.resolve(vaultRoot, config.engine.db_path));
    try {
      for (const slug of intent.slugs) removeNoteFromDB(db, slug);
    } finally {
      db.close();
    }
  }

  await audit(vaultRoot, {
    event: "purge_executed",
    by: "user",
    slugs: intent.slugs,
    changed,
    trashed: changed,
  });
  return { changed, warnings };
}

export async function runForget(options: ForgetRunOptions): Promise<ForgetRunResult> {
  const warnings: string[] = [];
  const apply = options.apply === true;

  if (options.op === "supersede" && !options.newText?.trim()) {
    return { success: false, warnings: ["supersede requires --new-text (the replacement content)"] };
  }

  try {
    const vaultRoot = await findVaultRoot(options.startDir);
    const paths = getVaultPaths(vaultRoot);
    const config = await loadConfig(paths.config);
    const { policy } = loadPolicy(config);

    // ---- PURGE: slug-addressed, approval-gated, never agent-executed ----
    if (options.op === "purge") {
      if (options.query) {
        return {
          success: false,
          warnings: [
            "purge no longer accepts a query — query-addressed hard delete was removed " +
              "after a fuzzy match unlinked 6 unintended notes (2026-11-07). Purge is " +
              "slug-addressed only, and requires user approval. Propose with --slugs, or " +
              "use release/supersede for soft removal.",
          ],
        };
      }
      if (!options.slugs?.length) {
        return { success: false, warnings: ["purge requires --slugs <slug,slug,...> (exact note slugs)"] };
      }

      // Normalize + verify existence so the proposal shows reality.
      const missing: string[] = [];
      const existing: string[] = [];
      for (const raw of options.slugs) {
        const slug = raw.trim();
        try {
          await fs.access(path.join(paths.notes, `${slug}.md`));
          existing.push(slug);
        } catch {
          missing.push(slug);
        }
      }
      if (missing.length) warnings.push(`slugs not found on disk: ${missing.join(", ")}`);

      const gate = policy.gates.purge;
      if (gate === "deny") {
        throw new PolicyError("purge", gate, "policy: purge=deny — agent-initiated purge is disabled on this vault. Ask the user to run it themselves or change policy.");
      }

      // Propose only. Even policy=allow proposes: execution is the user's.
      const intent = await proposeIntent({
        opRoot: vaultRoot,
        kind: "purge",
        slugs: existing,
        reason: options.newText?.trim() || `purge requested via ${options.actor ?? "agent"}`,
        sessionId: options.actor ?? "agent",
        policy,
      });

      return {
        success: true,
        data: {
          op: "purge",
          apply,
          matched: [],
          changed: 0,
          intent,
          policy: { line: `purge=${gate}` },
        },
        warnings: [
          ...warnings,
          "nothing deleted — purge requires user approval",
          `approve: ${intent.approve_command}`,
        ],
      };
    }

    // ---- RELEASE / SUPERSEDE: soft tier ----
    if (!options.query) {
      return { success: false, warnings: [`${options.op} requires <query>`] };
    }

    // Blast cap for soft ops: explicit option wins; default from policy.
    void policy;

    const forgetOpts = { apply, maxForget: options.maxForget ?? 10 };
    let matched: ForgetMatch[] = [];
    let changed = 0;

    if (options.op === "release") {
      const r = await release(paths.notes, options.query, config.engine, forgetOpts);
      matched = r.matched;
      changed = r.count;
    } else {
      const r = await supersede(
        paths.notes,
        options.query,
        options.newText ?? "",
        config.engine,
        async (slug, text, fm) => {
          const frontmatter = options.project?.length ? { ...fm, project: options.project } : fm;
          await writeFrontmatterFile(path.join(paths.notes, `${slug}.md`), frontmatter, text);
        },
        forgetOpts,
      );
      matched = r.matched;
      changed = r.count;
      if (changed > 0) {
        const built = await runIndexBuild(vaultRoot, false);
        warnings.push(`index updated: ${built.data.indexed} embedded, ${built.data.skipped} unchanged`);
      }
    }

    if (!apply) warnings.push("dry run (default) — re-run with apply to mutate");

    return {
      success: true,
      data: { op: options.op, query: options.query, apply, matched, changed },
      warnings,
    };
  } catch (err) {
    if (err instanceof ForgetBlastRadiusError) {
      return { success: false, warnings: [err.message] };
    }
    if (err instanceof PolicyError) {
      return { success: false, warnings: [err.detail] };
    }
    throw err;
  }
}

// ---- user-side intent management (never exposed as agent tools) ----

export interface RequestListResult {
  success: boolean;
  data: { intents: RemovalIntent[] };
  warnings: string[];
}

export async function runRequestsList(startDir: string): Promise<RequestListResult> {
  const vaultRoot = await findVaultRoot(startDir);
  return {
    success: true,
    data: { intents: await listIntents(vaultRoot) },
    warnings: [],
  };
}

export type RequestDecision = "approved" | "denied";

/**
 * Provenance of the deciding process, recorded on every audit line. An agent
 * shell (non-interactive stdin/stdout) must never be able to write a
 * "by: user" approval — on 2026-11-07 exactly that happened: a session shell
 * approved its own purge through the non-TTY fallthrough and the audit line
 * lied. The TTY gate below is what makes the record honest AND the refusal
 * mechanical.
 */
function decideProvenance(confirmSource: string): Record<string, unknown> {
  return {
    stdin_tty: process.stdin.isTTY === true,
    stdout_tty: process.stdout.isTTY === true,
    actor_env: process.env.MNEMOS_ACTOR ?? null,
    confirm_source: confirmSource,
  };
}

/**
 * The default confirmation: refuse without a genuine interactive terminal,
 * prompt [y/N] with a 30s timeout when there is one. The 2026-11-07 hole was
 * the inverted form of this guard — the TTY check ADDED a prompt but the
 * non-TTY case fell through to execution. Now the non-TTY case is refused at
 * the call site before this is ever reached.
 *
 * Honest ceiling: `script`/PTY wrappers can hand an automated caller a TTY.
 * That is outside the CLI era's threat model; the complete fix is
 * transport-side (app-mediated user gesture in the Flutter era), which this
 * seam (injectable confirm) is built for.
 */
async function interactiveConfirm(summary: string): Promise<boolean> {
  process.stdout.write(`\nApprove ${summary}? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.removeListener("data", onData);
      resolve(buf.toString().trim().toLowerCase());
    };
    process.stdin.once("data", onData);
    setTimeout(() => {
      process.stdin.removeListener("data", onData);
      resolve("");
    }, 30000).unref();
  });
  return answer === "y" || answer === "yes";
}

export interface RequestDecideOptions {
  /**
   * Injectable confirmation for tests and future transports (an HTTP sidecar
   * wires an app-mediated gesture here). The CLI passes NOTHING — the agent's
   * only path into this code is `mnemos requests <action>`, which always gets
   * the TTY-required default. Whoever injects a confirm owns its honesty.
   */
  confirm?: (summary: string) => Promise<boolean>;
}

export async function runRequestDecide(
  startDir: string,
  id: string,
  decision: RequestDecision,
  options: RequestDecideOptions = {},
): Promise<{ success: boolean; data?: Record<string, unknown>; warnings: string[] }> {
  const vaultRoot = await findVaultRoot(startDir);
  const intent = await getIntent(vaultRoot, id);
  if (!intent) return { success: false, warnings: [`no such request: ${id}`] };

  void (await loadConfig(getVaultPaths(vaultRoot).config));

  if (intent.status !== "pending") {
    return { success: false, warnings: [`request ${id} is ${intent.status}, not pending`] };
  }

  // The user-only gate, INVERTED from the 2026-11-07 hole: without an
  // interactive terminal AND without an injected confirm, the decision is
  // refused — never fallen through. An agent shell (the process that proposed
  // the intent) can therefore never approve or deny it.
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!options.confirm && !tty) {
    await audit(vaultRoot, {
      event: "decision_refused",
      by: "non_interactive_process",
      id,
      decision,
      kind: intent.kind,
      provenance: decideProvenance("none"),
    });
    return {
      success: false,
      data: { id, refused: "non_interactive" },
      warnings: [
        "REFUSED: approving or denying a request requires an interactive terminal.",
        "This process has no TTY — agent shells cannot approve their own proposals.",
        "Ask the user to run: mnemos requests " + decision + " " + id,
      ],
    };
  }

  if (decision === "denied") {
    const summary = `${intent.kind} (${id})`;
    const confirmed = options.confirm ? await options.confirm(summary) : await interactiveConfirm(summary);
    if (!confirmed) {
      return { success: false, warnings: ["aborted at the interactive confirmation"] };
    }
    intent.status = "denied";
    await writeIntent(vaultRoot, intent);
    await audit(vaultRoot, {
      event: "intent_denied",
      by: "user",
      id,
      provenance: decideProvenance(options.confirm ? "injected" : "interactive-tty"),
    });
    return { success: true, data: { id, status: "denied" }, warnings: [] };
  }

  const summary =
    intent.kind === "identity_update"
      ? `identity_update (rewrite ${intent.selfFile})`
      : `${intent.kind} (${intent.slugs.length} note(s): ${intent.slugs.join(", ")})`;
  const confirmed = options.confirm ? await options.confirm(summary) : await interactiveConfirm(summary);
  if (!confirmed) {
    return { success: false, warnings: ["aborted at the interactive confirmation"] };
  }

  intent.status = "approved";
  await writeIntent(vaultRoot, intent);
  await audit(vaultRoot, {
    event: "intent_approved",
    by: "user",
    id,
    kind: intent.kind,
    provenance: decideProvenance(options.confirm ? "injected" : "interactive-tty"),
  });

  let result: Record<string, unknown> = { id, status: "approved" };
  if (intent.kind === "purge") {
    const exec = await executeApprovedPurge(vaultRoot, intent);
    result = { ...result, ...exec, trashed_in: path.join("ops", ".trash") };
  }
  if (intent.kind === "identity_update") {
    const exec = await executeApprovedIdentityUpdate(vaultRoot, intent);
    result = { ...result, ...exec };
  }

  return { success: true, data: result, warnings: [] };
}

/**
 * Execute an approved identity_update intent: write the proposed content to
 * the self/ file, backing up the previous version first. Called only from the
 * user-side approve path — the proposing surface (runUpdateFile at
 * identity_update=approval) never writes.
 */
export async function executeApprovedIdentityUpdate(
  vaultRoot: string,
  intent: RemovalIntent,
): Promise<{ written: string; backed_up: boolean }> {
  const paths = getVaultPaths(vaultRoot);
  const file =
    intent.selfFile === "methodology"
      ? path.join(paths.self, "methodology.md")
      : path.join(paths.self, "identity.md");
  const label = intent.selfFile === "methodology" ? "methodology" : "identity";

  const existing = await safeReadFileForIdentity(file);
  if (existing) {
    const historyDir = path.join(paths.self, ".history");
    await fs.mkdir(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await fs.writeFile(path.join(historyDir, `${label}-${ts}.md`), existing);
  }

  await fs.mkdir(paths.self, { recursive: true });
  await fs.writeFile(file, intent.content ?? "", "utf8");
  await audit(vaultRoot, { event: "identity_update_executed", by: "user", file: label });

  return { written: file, backed_up: !!existing };
}

async function safeReadFileForIdentity(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
