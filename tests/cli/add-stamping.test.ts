/**
 * §3 inferred project stamping at capture — the ask-first gate's
 * replacement (spec session-scope §3, activated 2026-11-15).
 *
 * The precedence ladder, conservative order (existing behavior unchanged):
 *   explicit project > content keyword detection > harness-context stamp
 *   (path bridge / project_default / wake scope) > the gate (roster
 *   question) as the TERMINAL fallback when nothing can name a project.
 *
 * The stamped project is a HINT (§3: "inferred metadata … never a gate"):
 * it files and navigates; the user curates freely — the response says when
 * a stamp happened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runAdd } from "../../src/cli/add.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

let vault: string;
let repoDir: string;

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-stamp-vault-"));
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-stamp-repo-"));
  await runInit({ targetDir: vault });
  // Register the repo dir via the path bridge — the harness source/repo
  // signal the stamping reads.
  const configPath = path.join(vault, "mnemos.config.yaml");
  const { parse, stringify } = await import("yaml");
  const doc = parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  doc.wake = { project_paths: { [repoDir.replace(/\\/g, "/")]: "kite-telemetry" } };
  await fs.writeFile(configPath, stringify(doc));
  await runIndexBuild(vault);
}, 120000);

afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true });
  await fs.rm(repoDir, { recursive: true, force: true });
});

describe("§3 inferred project stamping at capture", () => {
  // The real CLI resolves the vault from MNEMOS_VAULT (or the global
  // fallback) while the REPO cwd feeds the path bridge — the two lookups
  // are independent. The tests mirror that.
  const withVaultEnv = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = process.env.MNEMOS_VAULT;
    process.env.MNEMOS_VAULT = vault;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.MNEMOS_VAULT;
      else process.env.MNEMOS_VAULT = prev;
    }
  };
  it("stamps from the path bridge: a capture run inside a registered repo files silently", async () => {
    await withVaultEnv(async () => {
    const r = await runAdd({
      startDir: repoDir,
      title: "kite telemetry frame drop rule",
      content: "Frames drop above 40C; retry with jitter.",
      description: "The frame-drop retry rule for kite telemetry.",
    });
    expect(r.success).toBe(true);
    expect(r.data.askGate).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("inferred from the path bridge");
    // FILED, not staged: the promoted note lives under the stamped project.
    expect(String(r.data.path)).toContain("kite-telemetry-frame-drop-rule");
    });
  });

  it("stamps from the caller-supplied context (wake scope) when the bridge doesn't map", async () => {
    // startDir = the vault itself (the MCP case — the bridge doesn't map the
    // vault), the wake-scoped project arrives via inferredProject.
    const r = await runAdd({
      startDir: vault,
      title: "scope weighting tuning note",
      content: "P_other tuned to 0.15 after the sweep.",
      description: "The tuning note for the scope sweep.",
      inferredProject: "mnemos",
      inferenceSource: "the wake-scoped session",
    });
    expect(r.data.askGate).toBeUndefined();
    expect(r.warnings.join(" ")).toContain("inferred from the wake-scoped session");
  });

  it("explicit project always wins — no inference, no stamp warning", async () => {
    await withVaultEnv(async () => {
    const r = await runAdd({
      startDir: repoDir,
      title: "explicit project note wins",
      content: "The explicit path is untouched by inference.",
      description: "Testing explicit precedence.",
      project: ["deliberate"],
    });
    expect(r.data.askGate).toBeUndefined();
    expect(r.warnings.join(" ")).not.toContain("inferred from");
    expect(String(r.data.path)).toContain("explicit-project-note-wins");
    });
  });

  it("keyword detection still outranks the context stamp", async () => {
    // Content names roust's AlarmKit world; the bridge says kite-telemetry.
    // Keywords (content) win — the note's own subject beats the context.
    await withVaultEnv(async () => {
    const r = await runAdd({
      startDir: repoDir,
      title: "alarmkit scheduling constraint discovered",
      content: "AlarmKit alarms need the scheduling constraint documented: alarm scheduling cannot fire while the passcode gate is active.",
      description: "An AlarmKit scheduling constraint.",
    });
    expect(r.data.askGate).toBeUndefined();
    // The note must NOT carry the bridge's kite-telemetry stamp.
    const promotedSlug = String(r.data.promoted?.[0]?.slug ?? "");
    const promotedPath = path.join(vault, "notes", `${promotedSlug}.md`);
    let tagged = "unknown";
    try {
      const parsed = await readFrontmatterFile(promotedPath);
      tagged = JSON.stringify(parsed.data?.project);
    } catch {
      tagged = "not-promoted";
    }
    expect(tagged).not.toContain("kite-telemetry");
    });
  });

  it("the gate still fires when nothing can name a project — the terminal fallback", async () => {
    // An unregistered repo dir, no caller context, no keywords.
    const unregistered = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-stamp-none-"));
    await withVaultEnv(async () => {
      try {
        const r = await runAdd({
          startDir: unregistered,
        title: "unattributable fragment",
        content: "A fragment with no project signals at all.",
        description: "Nothing infers here.",
      });
        expect(r.data.askGate).toBe(true);
      } finally {
        await fs.rm(unregistered, { recursive: true, force: true });
      }
    });
  });
});
