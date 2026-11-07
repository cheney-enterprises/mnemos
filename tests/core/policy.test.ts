import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicy,
  DEFAULT_POLICY,
  proposeIntent,
  listIntents,
  getIntent,
  writeIntent,
  audit,
  policyLine,
} from "../../src/core/policy.js";
import { runForget, runRequestDecide, executeApprovedPurge } from "../../src/cli/forget.js";
import type { RemovalIntent } from "../../src/core/policy.js";

// The capability model's invariants, pinned as tests:
//   1. No agent-callable path unlinks a note file.
//   2. Query-addressed purge does not exist.
//   3. Purge is slug-addressed, propose-only; execution is user-only.
//   4. Executed purges trash before unlink and write an audit line.
//   5. Policy gates default safe; deny refuses even the proposal.

let dir: string;
let vault: string;

function scaffoldVault(): void {
  vault = join(dir, "vault");
  for (const sub of ["notes", "ops", "self", "templates", "inbox"]) mkdirSync(join(vault, sub), { recursive: true });
  mkdirSync(join(vault, ".mnemos"), { recursive: true });
  writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: true\n", "utf8");
  for (const slug of ["alpha-note-one", "alpha-note-two", "beta-note-three"]) {
    writeFileSync(
      join(vault, "notes", `${slug}.md`),
      `---\ndescription: test note\n type: insight\nproject: [test]\nstatus: active\ncreated: 2026-11-07\n---\n\nbody of ${slug}\n`,
      "utf8",
    );
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-"));
  scaffoldVault();
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
});

describe("policy defaults", () => {
  it("defaults safe: destructive gates at approval, workflow gates allow", () => {
    const { policy, source } = loadPolicy({});
    expect(source).toBe("default");
    expect(policy.gates.purge).toBe("approval");
    expect(policy.gates.identity_update).toBe("approval");
    expect(policy.gates.protected_removal).toBe("approval");
    expect(policy.gates.soft_removal).toBe("allow");
    expect(policy.gates.state_overwrite).toBe("allow");
  });

  it("accepts per-gate overrides and rejects invalid levels", () => {
    const { policy, source } = loadPolicy({
      policy: { gates: { purge: "deny", soft_removal: "approval", bogus: "allow" } },
    });
    expect(source).toBe("config");
    expect(policy.gates.purge).toBe("deny");
    expect(policy.gates.soft_removal).toBe("approval");
    // Unknown gate names are ignored — never fabricated onto the gates object.
    expect("bogus" in (policy.gates as Record<string, string>)).toBe(false);
    expect(Object.keys(policy.gates).sort()).toEqual(Object.keys(DEFAULT_POLICY.gates).sort());
  });

  it("policyLine renders the compact briefing form", () => {
    const { policy } = loadPolicy({});
    expect(policyLine(policy)).toContain("purge=approval");
    expect(policyLine(policy)).toContain("soft=allow");
  });
});

describe("intents (propose/execute split)", () => {
  it("propose writes a pending intent with exact slugs and echoes it verbatim", async () => {
    const { policy } = loadPolicy({});
    const rec = await proposeIntent({
      opRoot: vault,
      kind: "purge",
      slugs: ["alpha-note-one", "alpha-note-two"],
      reason: "test",
      sessionId: "sess-1",
      policy,
    });
    expect(rec.execution).toBe("user_required");
    expect(rec.intent.status).toBe("pending");
    expect(rec.intent.slugs).toEqual(["alpha-note-one", "alpha-note-two"]);
    expect(rec.approve_command).toBe(`mnemos requests approve ${rec.intent.id}`);
    const stored = JSON.parse(
      readFileSync(join(vault, "ops", "requests", `${rec.intent.id}.json`), "utf8"),
    ) as RemovalIntent;
    expect(stored.slugs).toEqual(rec.intent.slugs);
  });

  it("intents expire after ttl", async () => {
    const { policy } = loadPolicy({ policy: { intent_ttl_days: 0.001 } });
    const rec = await proposeIntent({
      opRoot: vault, kind: "purge", slugs: ["alpha-note-one"], reason: "t", sessionId: "s", policy,
    });
    // Force expiry by backdating the file.
    const file = join(vault, "ops", "requests", `${rec.intent.id}.json`);
    const intent = JSON.parse(readFileSync(file, "utf8")) as RemovalIntent;
    intent.expires = new Date(Date.now() - 86400000).toISOString();
    writeFileSync(file, JSON.stringify(intent), "utf8");
    const listed = await listIntents(vault);
    expect(listed.find((i) => i.id === rec.intent.id)?.status).toBe("expired");
  });

  it("deny marks the intent denied without touching notes", async () => {
    const { policy } = loadPolicy({});
    const rec = await proposeIntent({
      opRoot: vault, kind: "purge", slugs: ["alpha-note-one"], reason: "t", sessionId: "s", policy,
    });
    const res = await runRequestDecide(vault, rec.intent.id, "denied");
    expect(res.success).toBe(true);
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
  });
});

describe("runForget: the agent-callable surface", () => {
  it("REFUSES query-addressed purge — the incident command cannot delete", async () => {
    const res = await runForget({
      startDir: vault, op: "purge",
      query: "alpha note documentation demo",
      apply: true, actor: "test-agent",
    });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("purge no longer accepts a query");
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
    expect(existsSync(join(vault, "notes", "alpha-note-two.md"))).toBe(true);
  });

  it("slug purge proposes an intent and NEVER deletes — even with apply=true", async () => {
    const res = await runForget({
      startDir: vault, op: "purge",
      slugs: ["alpha-note-one", "alpha-note-two"],
      reason: "test proposal",
      apply: true, actor: "test-agent",
    });
    expect(res.success).toBe(true);
    expect(res.data?.changed).toBe(0);
    expect(res.data?.intent?.execution).toBe("user_required");
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
    expect(existsSync(join(vault, "notes", "alpha-note-two.md"))).toBe(true);
  });

  it("purge with unknown slugs still proposes (verify-then-report), warning about missing", async () => {
    const res = await runForget({
      startDir: vault, op: "purge",
      slugs: ["alpha-note-one", "ghost-note"],
      reason: "t", actor: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data?.intent?.intent.slugs).toEqual(["alpha-note-one"]);
    expect(res.warnings.join(" ")).toContain("ghost-note");
  });

  it("policy deny refuses even the proposal", async () => {
    writeFileSync(
      join(vault, "mnemos.config.yaml"),
      "policy:\n  gates:\n    purge: deny\n",
      "utf8",
    );
    const res = await runForget({
      startDir: vault, op: "purge",
      slugs: ["alpha-note-one"], reason: "t", actor: "test",
    });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("purge=deny");
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
  });

  it("release still works as the soft tier and keeps files on disk", async () => {
    const res = await runForget({
      startDir: vault, op: "release",
      query: "alpha-note-one",
      apply: true, actor: "test",
    });
    expect(res.success).toBe(true);
    expect(res.data?.changed).toBeGreaterThanOrEqual(1);
    // File survives — soft removal flips status, never unlinks.
    const raw = readFileSync(join(vault, "notes", "alpha-note-one.md"), "utf8");
    expect(raw).toContain("status: released");
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
  });
});

describe("user-side execution", () => {
  it("approve executes the purge: trash first, then unlink, audit line", async () => {
    const { policy } = loadPolicy({});
    const rec = await proposeIntent({
      opRoot: vault, kind: "purge", slugs: ["alpha-note-one", "beta-note-three"],
      reason: "t", sessionId: "s", policy,
    });
    const res = await runRequestDecide(vault, rec.intent.id, "approved");
    expect(res.success).toBe(true);
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(false);
    expect(existsSync(join(vault, "notes", "beta-note-three.md"))).toBe(false);
    // Trash copies exist with the full content.
    const trashDir = join(vault, "ops", ".trash", "alpha-note-one");
    const trashFiles = readdirSync(trashDir);
    expect(trashFiles.length).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(trashDir, trashFiles[0]), "utf8")).toContain("body of alpha-note-one");
    // Audit line recorded.
    const auditRaw = readFileSync(join(vault, "ops", "forget-audit.jsonl"), "utf8");
    expect(auditRaw).toContain("purge_executed");
    expect(auditRaw).toContain("alpha-note-one");
    // Intent now marked approved.
    const intent = JSON.parse(readFileSync(join(vault, "ops", "requests", `${rec.intent.id}.json`), "utf8")) as RemovalIntent;
    expect(intent.status).toBe("approved");
  });

  it("approve of an already-decided intent is refused", async () => {
    const { policy } = loadPolicy({});
    const rec = await proposeIntent({
      opRoot: vault, kind: "purge", slugs: ["alpha-note-one"], reason: "t", sessionId: "s", policy,
    });
    await runRequestDecide(vault, rec.intent.id, "denied");
    const second = await runRequestDecide(vault, rec.intent.id, "approved");
    expect(second.success).toBe(false);
    expect(second.warnings.join(" ")).toContain("not pending");
    expect(existsSync(join(vault, "notes", "alpha-note-one.md"))).toBe(true);
  });
});

describe("audit", () => {
  it("is append-only jsonl and never throws on failure", async () => {
    await audit(vault, { event: "test_event", x: 1 });
    const raw = readFileSync(join(vault, "ops", "forget-audit.jsonl"), "utf8");
    expect(raw.trim().split("\n").pop()).toContain("test_event");
  });
});
