/**
 * `mnemos doctor` — the deep sweep (debt #7). Health covers orphans,
 * dangling links, schema, fading, learning. Doctor adds what health cannot
 * see: session-record LOCKS (crashed-holder residue), INDEX DRIFT (the
 * derived index answering queries vs the vault on disk — read-only, advice
 * only), and CONFIG SANITY (unresolvable paths, §5 constants that are
 * mathematically nonsense). Each check pins both sides: quiet when healthy,
 * loud when not.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runDoctor } from "../../src/cli/health.js";

let vault: string;

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-doctor-"));
  await runInit({ targetDir: vault });
});

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

describe("mnemos doctor", () => {
  it("a fresh vault is quiet: no locks, no drift verdict, no crash", async () => {
    const r = await runDoctor(vault);
    expect(r.success).toBe(true);
    const d = r.data.doctor as { locks: unknown[]; indexDrift: { indexExists: boolean } };
    expect(d.locks).toEqual([]);
    expect(d.indexDrift.indexExists).toBe(false);
    expect(d.indexDrift.coverage).toContain("no index");
  });

  it("reports stale session-record locks with their ages", async () => {
    const lockRoot = path.join(vault, "ops", "sessions", ".locks", "stale-slug");
    await fs.mkdir(lockRoot, { recursive: true });
    // Backdate: a lock from an hour ago is crashed-holder residue (the 5s
    // steal would have reclaimed it under any contention).
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(lockRoot, old, old);
    const r = await runDoctor(vault);
    const d = r.data.doctor as { locks: Array<{ slug: string; ageSeconds: number }> };
    const found = d.locks.find((l) => l.slug === "stale-slug");
    expect(found).toBeDefined();
    expect(found!.ageSeconds).toBeGreaterThan(1_000);
    expect(r.warnings.join(" ")).toContain("stale-slug");
    // Doctor never removes — the steal owns recovery.
    await expect(fs.access(lockRoot)).resolves.toBeUndefined();
  });

  it("a healthy index reports full coverage", async () => {
    await runAdd({
      startDir: vault,
      title: "doctor coverage probe note",
      type: "insight",
      description: "indexed before the doctor runs",
      content: "Body.",
      project: ["mnemos"],
    });
    await runIndexBuild(vault, false);
    const r = await runDoctor(vault);
    const drift = (r.data.doctor as {
      indexDrift: { coverage: string; indexedNotes: number | null; vaultNotes: number };
    }).indexDrift;
    // The scaffold ships with its own note (notes/index.md), so compare
    // coverage, not a hardcoded count.
    expect(drift.indexedNotes).toBe(drift.vaultNotes);
    expect(drift.coverage).toBe("full");
    expect(r.warnings.join(" ")).not.toContain("index drift");
  });

  it("reports DRIFT when the vault gained notes the index never saw", async () => {
    await runAdd({
      startDir: vault,
      title: "doctor drift probe note one",
      type: "insight",
      description: "indexed",
      content: "Body.",
      project: ["mnemos"],
    });
    await runIndexBuild(vault, false);
    // A note the index never saw — written directly, no re-index.
    await fs.writeFile(
      path.join(vault, "notes", "doctor-drift-probe-note-two.md"),
      "---\ndescription: never indexed\ntype: insight\n---\n\nBody.\n",
      "utf8",
    );
    const r = await runDoctor(vault);
    const drift = (r.data.doctor as { indexDrift: { coverage: string } }).indexDrift;
    expect(drift.coverage).toContain("DRIFT");
    expect(r.warnings.join(" ")).toContain("index drift");
  });

  it("flags unresolvable project_paths and nonsense session-scope constants", async () => {
    const cfgPath = path.join(vault, "mnemos.config.yaml");
    const raw = await fs.readFile(cfgPath, "utf8");
    // The scaffold has no `wake:` block (project_paths lives in a comment)
    // and session_scope is already enabled with other_scope_multiplier 0.15.
    await fs.writeFile(
      cfgPath,
      raw
        .replace(/other_scope_multiplier: 0\.15/, "other_scope_multiplier: 1.5")
        .replace(
          /^/,
          'wake:\n  project_paths:\n    "/nonexistent/ghost/dir": ghost\n',
        ),
    );
    const r = await runDoctor(vault);
    const joined = r.warnings.join(" ");
    expect(joined).toContain("/nonexistent/ghost/dir");
    expect(joined).toContain("other_scope_multiplier=1.5");
    expect(joined).toContain("AMPLIFIES");
  });
});
