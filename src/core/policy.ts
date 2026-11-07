/**
 * Policy layer — the capability model behind every removal-class operation.
 *
 * Principle: the AI proposes; the user executes. Nothing the model can call
 * unlinks a file, rewrites the self-model, or touches a protected note without
 * an approval record. Enforcement lives HERE — in the transport-neutral core —
 * so MCP today and the HTTP/app transports of the Flutter era inherit identical
 * behavior.
 *
 * Gates (policy.gates in mnemos.config.yaml), each allow | approval | deny:
 *   purge            — hard delete (slug-addressed only)
 *   identity_update  — self/identity.md, self/methodology.md rewrites
 *   protected_removal — release/supersede/archive on pinned/protected notes
 *   bulk_effect      — any op addressing more than bulk_threshold notes
 *   soft_removal     — release/supersede/archive on normal notes
 *   state_overwrite  — daily/goals/reminders/map Current State (the ritual)
 *
 * The AI learns the effective policy from wake / mnemos://policy. Every gate
 * refusal cites the policy and names the exact approve command.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type GateName =
  | "purge"
  | "identity_update"
  | "protected_removal"
  | "bulk_effect"
  | "soft_removal"
  | "state_overwrite";

export type GateLevel = "allow" | "approval" | "deny";

export interface PolicyConfig {
  gates: Record<GateName, GateLevel>;
  bulk_threshold: number;
  intent_ttl_days: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  gates: {
    purge: "approval",
    identity_update: "approval",
    protected_removal: "approval",
    bulk_effect: "approval",
    soft_removal: "allow",
    state_overwrite: "allow",
  },
  bulk_threshold: 5,
  intent_ttl_days: 7,
};

export type PolicySource = "config" | "default";

/** Deep-merge the policy block from a parsed mnemos.config.yaml. */
export function loadPolicy(config: unknown): { policy: PolicyConfig; source: PolicySource } {
  const raw = (config as { policy?: Partial<PolicyConfig> })?.policy;
  if (!raw || typeof raw !== "object") {
    return { policy: structuredClone(DEFAULT_POLICY), source: "default" };
  }
  const policy = structuredClone(DEFAULT_POLICY);
  if (raw.gates) {
    for (const [k, v] of Object.entries(raw.gates)) {
      // Only known gate names, only known levels. An unknown gate (a typo'd
      // key like "purges") must be ignored, never fabricated onto gates —
      // otherwise a misspelled override silently no-ops and the vault runs
      // on defaults while the user believes they hardened it.
      if (
        (Object.keys(DEFAULT_POLICY.gates) as string[]).includes(k) &&
        (v === "allow" || v === "approval" || v === "deny")
      ) {
        policy.gates[k as GateName] = v;
      }
    }
  }
  if (typeof raw.bulk_threshold === "number" && raw.bulk_threshold > 0) {
    policy.bulk_threshold = Math.floor(raw.bulk_threshold);
  }
  if (typeof raw.intent_ttl_days === "number" && raw.intent_ttl_days > 0) {
    policy.intent_ttl_days = Math.floor(raw.intent_ttl_days);
  }
  return { policy, source: "config" };
}

export function policyLine(policy: PolicyConfig): string {
  const g = policy.gates;
  return `purge=${g.purge} · identity=${g.identity_update} · protected=${g.protected_removal} · bulk=${g.bulk_effect} · soft=${g.soft_removal} · state=${g.state_overwrite}`;
}

/**
 * The full policy sheet — what mnemos://policy serves and what an agent reads
 * to PREDICT refusals instead of discovering them by trial. Configured truth,
 * rendered transport-neutral so the MCP resource today and the HTTP/Flutter
 * transports later serve identical text.
 */
export function renderPolicySheet(policy: PolicyConfig, source: PolicySource): string {
  const g = policy.gates;
  const origin =
    source === "config"
      ? "mnemos.config.yaml (policy block)"
      : "defaults — mnemos.config.yaml has no policy block";
  return [
    "# Mnemos policy (effective)",
    "",
    `Source: ${origin}`,
    "",
    "Removal-class operations are gated. The AI proposes; the user executes.",
    "",
    "## Gates",
    `- purge = ${g.purge} — hard delete. Slug-addressed only; the agent can only PROPOSE (an intent is recorded; the user approves).`,
    `- identity_update = ${g.identity_update} — rewriting self/identity.md and self/methodology.md.`,
    `- protected_removal = ${g.protected_removal} — release/supersede/archive on pinned or protected notes.`,
    `- bulk_effect = ${g.bulk_effect} — any operation affecting more than ${policy.bulk_threshold} notes.`,
    `- soft_removal = ${g.soft_removal} — release/supersede/archive on normal notes (dry-run by default).`,
    `- state_overwrite = ${g.state_overwrite} — overwriting daily, goals, reminders, or a map's Current State.`,
    "",
    "## Removal law",
    "- You (the agent) can never delete a note yourself and cannot approve your own proposals.",
    "- purge proposals execute only via: mnemos requests approve <id> — a user-only CLI command, never an agent tool.",
    `- Pending intents expire after ${policy.intent_ttl_days} days.`,
    "- Every executed purge copies the notes to ops/.trash/ first; ops/forget-audit.jsonl records every intent, approval, and execution.",
    "- If an action is refused, the refusal names the gate and the approve command — display it to the user verbatim.",
    "- You cannot change policy; mnemos.config.yaml is the user's file. Re-read this resource any time you need the effective gates.",
    "",
  ].join("\n");
}

export type IntentKind =
  | "purge"
  | "identity_update"
  | "protected_removal";

export interface RemovalIntent {
  id: string;
  kind: IntentKind;
  /** Exact note slugs for purge/protected_removal; never a fuzzy query. */
  slugs: string[];
  /** For identity_update: the full proposed new content. */
  content?: string;
  /** For identity_update: which self/ file. */
  selfFile?: string;
  reason: string;
  session_id: string;
  created: string;
  expires: string;
  status: "pending" | "approved" | "denied" | "expired";
}

/** A pending intent, echoed back verbatim so the caller sees exactly what is proposed. */
export interface IntentRecord {
  intent: RemovalIntent;
  /** The command the USER runs to execute it. The model can only display this. */
  approve_command: string;
  /** Always true for an approval-level proposal — apply is unreachable from the proposing surface. */
  execution: "user_required";
}

export class PolicyError extends Error {
  constructor(
    readonly gate: GateName,
    readonly level: GateLevel,
    readonly detail: string,
    readonly intent?: IntentRecord,
  ) {
    super(detail);
    this.name = "PolicyError";
  }
}

function randomId(): string {
  return `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ProposeInput {
  opRoot: string; // vault root
  kind: IntentKind;
  slugs?: string[];
  content?: string;
  selfFile?: string;
  reason: string;
  sessionId: string;
  policy: PolicyConfig;
}

/**
 * Create a pending intent. This is the ONLY thing an agent-callable surface
 * can do for gated operations — there is no code path from here to mutation.
 */
export async function proposeIntent(input: ProposeInput): Promise<IntentRecord> {
  const dir = path.join(input.opRoot, "ops", "requests");
  await fs.mkdir(dir, { recursive: true });

  const now = new Date();
  const expires = new Date(now.getTime() + input.policy.intent_ttl_days * 86400000);
  const intent: RemovalIntent = {
    id: randomId(),
    kind: input.kind,
    slugs: input.slugs ?? [],
    content: input.content,
    selfFile: input.selfFile,
    reason: input.reason,
    session_id: input.sessionId,
    created: now.toISOString(),
    expires: expires.toISOString(),
    status: "pending",
  };

  await fs.writeFile(path.join(dir, `${intent.id}.json`), JSON.stringify(intent, null, 2), "utf8");
  await audit(input.opRoot, { event: "intent_created", intent: { ...intent } });

  return {
    intent,
    approve_command: `mnemos requests approve ${intent.id}`,
    execution: "user_required",
  };
}

export async function listIntents(opRoot: string): Promise<RemovalIntent[]> {
  const dir = path.join(opRoot, "ops", "requests");
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const now = new Date();
  const out: RemovalIntent[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const intent = JSON.parse(raw) as RemovalIntent;
      if (intent.status === "pending" && new Date(intent.expires) < now) {
        intent.status = "expired";
        await fs.writeFile(path.join(dir, f), JSON.stringify(intent, null, 2), "utf8");
      }
      out.push(intent);
    } catch {
      // unreadable intent — skip, never crash a listing
    }
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function getIntent(opRoot: string, id: string): Promise<RemovalIntent | null> {
  try {
    const raw = await fs.readFile(path.join(opRoot, "ops", "requests", `${id}.json`), "utf8");
    return JSON.parse(raw) as RemovalIntent;
  } catch {
    return null;
  }
}

export async function writeIntent(opRoot: string, intent: RemovalIntent): Promise<void> {
  const dir = path.join(opRoot, "ops", "requests");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${intent.id}.json`), JSON.stringify(intent, null, 2), "utf8");
}

/** Append-only audit trail. Never throws — audit failure must not block ops. */
export async function audit(
  opRoot: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const file = path.join(opRoot, "ops", "forget-audit.jsonl");
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // best effort
  }
}
