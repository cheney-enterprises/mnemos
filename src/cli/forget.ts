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
import { inspectAncestry } from "../core/processgate.js";

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
  data: { intents: RemovalIntent[]; context?: RequestContext };
  warnings: string[];
}

/**
 * What `list` needs so a decision can actually be made: for identity
 * rewrites, the CURRENT file content (the diff is the decision aid); for
 * purges, what the doomed notes ARE (a slug alone doesn't say what dies).
 * `runRequestsList` / `runRequestInteractive` pre-read these from the vault;
 * the formatters stay pure.
 */
export interface RequestContext {
  /** intent.id → current content of self/<selfFile>.md */
  selfCurrent?: Map<string, string>;
  /** slug → the note's description (what the purge would destroy) */
  noteDescriptions?: Map<string, string>;
}

/**
 * Line-level set diff for the identity proposal display. A set diff, not an
 * LCS patch: the decision is about CONTENT presence (what disappears, what
 * appears), not hunk ordering. Order-preserving; whitespace-normalized;
 * capped per side with the true counts reported.
 */
export function summarizeLineDiff(
  current: string,
  proposed: string,
  max = 6,
): { removed: string[]; added: string[]; removedCount: number; addedCount: number } {
  const norm = (s: string) => s.trim();
  const currentLines = current.split("\n").map(norm).filter((l) => l.length > 0);
  const proposedLines = proposed.split("\n").map(norm).filter((l) => l.length > 0);
  const currentSet = new Set(currentLines);
  const proposedSet = new Set(proposedLines);
  const removed = currentLines.filter((l) => !proposedSet.has(l));
  const added = proposedLines.filter((l) => !currentSet.has(l));
  const clip = (arr: string[]) => {
    const out = arr.slice(0, max).map((l) => (l.length > 98 ? `${l.slice(0, 98)}…` : l));
    if (arr.length > max) out.push(`… and ${arr.length - max} more`);
    return out;
  };
  return { removed: clip(removed), added: clip(added), removedCount: removed.length, addedCount: added.length };
}

/**
 * Human rendering of `mnemos requests list`. The raw JSON went straight to
 * the terminal — and the user-only surface's whole job is legibility: you
 * are about to approve the destruction of notes or a rewrite of the agent's
 * identity, and the blob made it easier to approve blind than to read what
 * you were approving. Pending requests render in full (id, what, why, when,
 * the exact commands); decided/expired requests collapse to one line each.
 * `--json` keeps the machine form for scripts. `context` (built by the
 * callers from the vault) carries WHAT CHANGES: the diff against the
 * current self file for rewrites, the doomed notes' descriptions for
 * purges — Eric: list must summarize what it is changing so a decision
 * can be made.
 */
export function formatRequestList(
  intents: RemovalIntent[],
  now = new Date(),
  context?: RequestContext,
): string {
  const pending = intents.filter((i) => i.status === "pending");
  const settled = intents.filter((i) => i.status !== "pending");
  const lines: string[] = [];

  if (pending.length === 0) {
    lines.push(`No pending requests (${settled.length} decided/expired in history — use --json to see them).`);
  } else {
    lines.push(`Pending requests — ${pending.length}. Nothing executes until you approve.`);
    lines.push("");
    for (const intent of pending) {
      lines.push(...formatRequestBlock(intent, now, context));
      lines.push("");
    }
    lines.pop(); // trailing blank
  }

  if (settled.length > 0) {
    lines.push("");
    lines.push("History:");
    for (const intent of settled) {
      lines.push(`  ○ ${intent.id}   ${intent.kind}   ${intent.status}`);
    }
  }
  return lines.join("\n");
}

/** The full block for ONE pending request (shared by list and the bare-id
 * flow). */
export function formatRequestBlock(
  intent: RemovalIntent,
  now: Date,
  context?: RequestContext,
): string[] {
  const lines: string[] = [];
  lines.push(`● ${intent.id}   ${intent.kind}`);
  lines.push(`  reason: ${intent.reason}`);
  if (intent.kind === "identity_update") {
    const selfFile = intent.selfFile ?? "identity";
    const size = intent.content?.length ?? 0;
    lines.push(`  proposal: rewrite self/${selfFile}.md — ${size} chars`);
    // THE decision aid: the diff against the file as it stands. What
    // disappears and what appears — capped per side, true counts kept.
    const current = context?.selfCurrent?.get(intent.id);
    if (current !== undefined && intent.content) {
      const diff = summarizeLineDiff(current, intent.content);
      lines.push(`  changes: −${diff.removedCount} lines, +${diff.addedCount} lines`);
      for (const l of diff.removed) lines.push(`    − ${l}`);
      for (const l of diff.added) lines.push(`    + ${l}`);
    } else {
      // No current file readable — show the proposal's own description.
      const desc = (intent.content ?? "").match(/^description:\s*(.+)$/m)?.[1]?.trim();
      if (desc) {
        const preview = desc.length > 110 ? `${desc.slice(0, 110)}…` : desc;
        lines.push(`  what:     "${preview}"`);
      }
    }
  } else if (intent.slugs.length > 0) {
    lines.push(`  forgets:  ${intent.slugs.join(", ")}`);
    // What ARE these notes? A slug alone doesn't say what dies.
    for (const slug of intent.slugs.slice(0, 5)) {
      const d = context?.noteDescriptions?.get(slug);
      if (d) {
        const preview = d.length > 98 ? `${d.slice(0, 98)}…` : d;
        lines.push(`      "${preview}"`);
      }
    }
  }
  const days = Math.round((new Date(intent.expires).getTime() - now.getTime()) / 86_400_000);
  const rel = days >= 0 ? `in ${days}d` : `EXPIRED`;
  lines.push(`  created ${intent.created.slice(0, 10)} · expires ${intent.expires.slice(0, 10)} (${rel})`);
  lines.push(`  approve:  mnemos requests approve ${intent.id}`);
  lines.push(`  deny:     mnemos requests deny ${intent.id}`);
  return lines;
}

/** Read the vault-side context the formatters need: the current self file
 * per identity intent, and the descriptions of purge-targeted notes.
 * Best-effort — a missing file just means the formatter falls back to the
 * proposal's own description. */
export async function buildRequestContext(
  vaultRoot: string,
  intents: RemovalIntent[],
): Promise<RequestContext> {
  const { getVaultPaths } = await import("../core/vault.js");
  const { parseFrontmatter } = await import("../core/frontmatter.js");
  const paths = getVaultPaths(vaultRoot);
  const selfCurrent = new Map<string, string>();
  const noteDescriptions = new Map<string, string>();
  for (const intent of intents) {
    if (intent.kind === "identity_update" && intent.status === "pending") {
      const file = path.join(paths.self, `${intent.selfFile ?? "identity"}.md`);
      try {
        selfCurrent.set(intent.id, await fs.readFile(file, "utf8"));
      } catch {
        // No current file — the formatter falls back to the description.
      }
    }
    for (const slug of intent.slugs) {
      if (noteDescriptions.has(slug)) continue;
      try {
        const parsed = parseFrontmatter(
          await fs.readFile(path.join(paths.notes, `${slug}.md`), "utf8"),
        );
        const d = parsed.data && typeof parsed.data === "object"
          ? (parsed.data as Record<string, unknown>)["description"]
          : null;
        if (typeof d === "string" && d.length > 0) noteDescriptions.set(slug, d);
      } catch {
        // Already gone, or unreadable — the slug renders alone.
      }
    }
  }
  return { selfCurrent, noteDescriptions };
}

/** Human rendering of an approve/deny outcome. */
export function formatRequestDecision(
  id: string,
  decision: RequestDecision,
  data: Record<string, unknown>,
): string {
  if (decision === "denied") {
    return `✗ denied ${id} — nothing executed, the intent is closed.`;
  }
  const parts: string[] = [`✓ approved ${id}`];
  if (data.written) {
    parts.push(`  self/${String(data.written)} rewritten with the proposed content.`);
    if (data.backed_up) parts.push("  previous version backed up in self/.history/.");
  } else if (typeof data.changed === "number") {
    parts.push(`  ${data.changed} note(s) moved to ${String(data.trashed_in ?? "ops/.trash")}.`);
  }
  return parts.join("\n");
}

/** Human rendering of a forget dry-run preview (the default op output).
 * The matched set is the contract — it names EXACTLY what the op would
 * touch, because over-matching a forget is the worst failure this module
 * can have. */
export function formatForgetPreview(data: Record<string, unknown>): string {
  const matched = (data.matched as Array<{ slug: string; anchor?: number; similarity?: number }>) ?? [];
  const lines = [
    `${String(data.op)}${data.apply ? "" : " (DRY RUN — pass --apply to execute)"}: "${String(data.query)}"`,
  ];
  if (matched.length === 0) {
    lines.push("  no notes matched.");
  } else {
    lines.push(`  would touch ${matched.length} note(s):`);
    for (const m of matched) {
      const why = [
        m.anchor !== undefined ? `anchor ${Number(m.anchor).toFixed(2)}` : null,
        m.similarity !== undefined ? `similarity ${Number(m.similarity).toFixed(3)}` : null,
      ].filter(Boolean).join(", ");
      lines.push(`    - ${m.slug}${why ? `  (${why})` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function runRequestsList(
  startDir: string,
  vaultOverride?: string,
): Promise<RequestListResult> {
  const vaultRoot = await findVaultRoot(startDir, vaultOverride);
  const intents = await listIntents(vaultRoot);
  return {
    success: true,
    data: {
      intents,
      // The decision aid, resolved from the vault: current self content for
      // identity diffs, doomed notes' descriptions for purges.
      context: await buildRequestContext(vaultRoot, intents),
    },
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

export interface RequestDecideOptions {
  /**
   * Injectable confirmation for tests and future transports (an HTTP sidecar
   * wires an app-mediated gesture here). The CLI passes NOTHING — the agent's
   * only path into this code is `mnemos requests <action>`, which always gets
   * the TTY-required default. Whoever injects a confirm owns its honesty.
   */
  confirm?: (summary: string) => Promise<boolean>;
  /** Provenance label for an injected confirm's audit line (the bare-id
   * interactive flow passes "interactive-choice": its gates ran upstream).
   * Without a confirm, the explicit command IS the answer — provenance is
   * "explicit-command". */
  confirmSource?: string;
}

export async function runRequestDecide(
  startDir: string,
  id: string,
  decision: RequestDecision,
  options: RequestDecideOptions & { vaultOverride?: string } = {},
): Promise<{ success: boolean; data?: Record<string, unknown>; warnings: string[] }> {
  const vaultRoot = await findVaultRoot(startDir, options.vaultOverride);
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
  //
  // Layer 2 (2026-11-08 PTY demonstration): a TTY alone is forgeable — an
  // agent can wrap this CLI in `script`, obtain a terminal, and answer its
  // own prompt. The process tree cannot be chosen: walk the PPID chain and
  // refuse when the agent's own runtime is among the ancestors. Demonstrated
  // chain for the forged case: sh -> script -> sh -> node (agent) -> bash ->
  // ori. A genuine terminal never chains to the agent harness.
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ancestry = inspectAncestry();
  const forged =
    !options.confirm && tty && ancestry.agentAncestor;
  if (forged) {
    await audit(vaultRoot, {
      event: "decision_refused",
      by: "agent_runtime_ancestor",
      id,
      decision,
      kind: intent.kind,
      provenance: {
        ...decideProvenance("none"),
        ancestry: ancestry.chain,
        agent_image: ancestry.agentImage,
        ancestry_complete: ancestry.complete,
      },
    });
    return {
      success: false,
      data: { id, refused: "agent_runtime_ancestor" },
      warnings: [
        "REFUSED: this approval is running under an agent runtime's process tree.",
        `A terminal was detected, but the process ancestry chains through: ${ancestry.agentImage}`,
        "Ask the user to run the command from THEIR OWN terminal (a shell not started by an agent):",
        `mnemos requests ${decision === "approved" ? "approve" : "deny"} ${id}`,
      ],
    };
  }
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
        `Ask the user to run: mnemos requests ${decision === "approved" ? "approve" : "deny"} ${id}`,
      ],
    };
  }

  if (decision === "denied") {
    // The COMMAND is the answer: `mnemos requests deny <id>` carries the
    // user's decision — re-asking "are you sure?" on an explicit verb is
    // the question in the wrong place. The question lives where the
    // decision is NOT yet stated: the bare `mnemos requests <id>` flow
    // (runRequestInteractive). Injected confirms (tests, future
    // transports) are still honored — whoever injects one owns it.
    if (options.confirm && !(await options.confirm(`${intent.kind} (${id})`))) {
      return { success: false, warnings: ["aborted at the confirmation"] };
    }
    intent.status = "denied";
    await writeIntent(vaultRoot, intent);
    await audit(vaultRoot, {
      event: "intent_denied",
      by: "user",
      id,
      provenance: decideProvenance(options.confirm ? options.confirmSource ?? "injected" : "explicit-command"),
    });
    return { success: true, data: { id, status: "denied" }, warnings: [] };
  }

  if (options.confirm && !(await options.confirm(
    intent.kind === "identity_update"
      ? `identity_update (rewrite ${intent.selfFile})`
      : `${intent.kind} (${intent.slugs.length} note(s): ${intent.slugs.join(", ")})`,
  ))) {
    return { success: false, warnings: ["aborted at the confirmation"] };
  }

  intent.status = "approved";
  await writeIntent(vaultRoot, intent);
  await audit(vaultRoot, {
    event: "intent_approved",
    by: "user",
    id,
    kind: intent.kind,
    provenance: decideProvenance(options.confirm ? options.confirmSource ?? "injected" : "explicit-command"),
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

/** The full detail block for ONE request — the bare `mnemos requests <id>`
 * flow's display, before the question. */
export function formatRequestItem(
  intent: RemovalIntent,
  now = new Date(),
  context?: RequestContext,
): string {
  return formatRequestList([intent], now, context);
}

/**
 * Bare `mnemos requests <id>` — the request is shown in full and the
 * question is asked HERE, because here the decision has not been stated.
 * `approve`/`deny` subcommands never re-ask (Eric: "the command is the
 * answer"); this flow is where a human reads what they're about to decide
 * and then answers. The agent gates are identical: non-TTY refused,
 * agent-runtime ancestry refused.
 */
export async function runRequestInteractive(
  startDir: string,
  id: string,
  options: {
    vaultOverride?: string;
    /** Injectable choose for tests and future transports (mirrors
     * RequestDecideOptions.confirm — whoever injects it owns its honesty). */
    choose?: () => Promise<"approved" | "denied" | "abort">;
  } = {},
): Promise<{ success: boolean; data?: Record<string, unknown>; warnings: string[] }> {
  const vaultRoot = await findVaultRoot(startDir, options.vaultOverride);
  const intent = await getIntent(vaultRoot, id);
  if (!intent) return { success: false, warnings: [`no such request: ${id}`] };
  if (intent.status !== "pending") {
    return { success: false, warnings: [`request ${id} is ${intent.status}, not pending`] };
  }

  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!options.choose && !tty) {
    return {
      success: false,
      data: { id, refused: "non_interactive" },
      warnings: [
        "REFUSED: deciding a request requires an interactive terminal.",
        "State the decision explicitly instead (no question asked):",
        `  mnemos requests approve ${id}    or    mnemos requests deny ${id}`,
      ],
    };
  }

  console.log(formatRequestItem(intent, new Date(), await buildRequestContext(vaultRoot, [intent])));
  const choice = options.choose ? await options.choose() : await interactiveChoose();
  if (choice === "abort") {
    return { success: false, warnings: ["decided nothing — the request stays pending"] };
  }
  // The gates already ran upstream (injected choose, or the TTY check);
  // carry a satisfied confirm through so the delegate doesn't re-refuse,
  // and record the honest provenance for the audit line.
  return runRequestDecide(vaultRoot, id, choice, {
    vaultOverride: options.vaultOverride,
    confirm: async () => true,
    confirmSource: options.choose ? "injected" : "interactive-choice",
  });
}

/** The ask, for the bare-id flow. Enter aborts — the safe default: a
 * fat-fingered Enter on this screen must not execute a purge. */
async function interactiveChoose(): Promise<"approved" | "denied" | "abort"> {
  process.stdout.write(`\nDecide this request? [a]pprove / [d]eny / Enter=abort: `);
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
  if (answer === "a" || answer === "approve") return "approved";
  if (answer === "d" || answer === "deny") return "denied";
  return "abort";
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
