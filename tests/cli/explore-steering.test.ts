/**
 * Mnemos — Manual Steering CLI Tests (v0.5.1)
 *
 * File-backed navigated sessions: explore-start persists to
 * .mnemos/explore-sessions/, explore-expand resumes across invocations
 * (fresh deps each time, like real CLI calls), conclude validates and
 * removes the session file.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import {
  runExploreStartCli,
  runExploreExpandCli,
  runExploreConcludeCli,
} from "../../src/cli/explore.js";

let vaultDir: string;

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-cli-steer-"));
  await runInit({ targetDir: vaultDir });
  const notes: Array<[string, string, string]> = [
    ["court coin origin", "decision", "Started as [[courtshare pivot]]. NBA player stock market."],
    ["courtshare pivot", "decision", "Pivoted after [[rental model failure]]. See [[kalshi inspiration]]."],
    ["rental model failure", "insight", "Bookings never hit volume. Led to [[courtshare pivot]]."],
    ["kalshi inspiration", "insight", "Regulated event markets work. Motivated [[court coin origin]]."],
    ["bench press log", "insight", "Gym distractor."],
  ];
  for (const [title, type, content] of notes) {
    await runAdd({ startDir: vaultDir, title, type, content, project: ["steering-test"] });
  }
  await runIndexBuild(vaultDir);
}, 120000);

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

describe("manual steering via file-backed sessions", () => {
  it("start persists a session file under .mnemos/explore-sessions/", async () => {
    const r = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    expect(r.success).toBe(true);
    const id = (r.data as { exploration_id: string }).exploration_id;
    const file = path.join(vaultDir, ".mnemos", "explore-sessions", `${id}.json`);
    await expect(fs.access(file)).resolves.toBeUndefined();
  }, 60000);

  it("expand resumes from disk in a separate invocation and persists the step", async () => {
    const start = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    const id = (start.data as { exploration_id: string }).exploration_id;

    // Separate invocation: fresh deps built from disk, session loaded from file
    const exp = await runExploreExpandCli(vaultDir, id, { neighbors: "courtshare-pivot" });
    expect(exp.success).toBe(true);
    const data = exp.data as { tree: unknown[]; budget_remaining: number };
    expect(data.tree.length).toBe(2);
    expect(data.budget_remaining).toBe(2);

    // And the persisted state reflects it
    const raw = await fs.readFile(
      path.join(vaultDir, ".mnemos", "explore-sessions", `${id}.json`), "utf8");
    const state = JSON.parse(raw) as { nodes: unknown[]; budgetRemaining: number };
    expect(state.nodes.length).toBe(2);
    expect(state.budgetRemaining).toBe(2);
  }, 60000);

  it("conclude validates usedNotes (display-title tolerant) and deletes the file", async () => {
    const start = await runExploreStartCli(vaultDir, "why did we start court coin", 3);
    const id = (start.data as { exploration_id: string }).exploration_id;

    const done = await runExploreConcludeCli(vaultDir, id, {
      answered: true,
      usedNotes: ["Court Coin Origin", "phantom-note"],
    });
    expect(done.success).toBe(true);
    const summary = done.data as { usedNotes: string[]; rejectedNotes: string[]; rewarded?: number };
    expect(summary.usedNotes).toEqual(["court-coin-origin"]);
    expect(summary.rejectedNotes).toEqual(["phantom-note"]);

    const file = path.join(vaultDir, ".mnemos", "explore-sessions", `${id}.json`);
    await expect(fs.access(file)).rejects.toThrow();

    // Expanding a concluded (deleted) session fails cleanly
    const after = await runExploreExpandCli(vaultDir, id, { subQuestion: "anything" });
    expect(after.success).toBe(false);
    expect(after.warnings.join(" ")).toMatch(/unknown exploration_id/);
  }, 60000);

  it("conclude flushes the learning signal: used notes earn explore_conclude Q credit", async () => {
    // A fresh, isolated vault so the Q rows are this test's own.
    const { default: Database } = await import("better-sqlite3");
    const v = await fs.mkdtemp(path.join(path.dirname(vaultDir), "conclude-flush-"));
    try {
      const notesDir = path.join(v, "notes");
      await fs.mkdir(notesDir, { recursive: true });
      await fs.writeFile(
        path.join(notesDir, "flush-target.md"),
        "---\ndescription: the note that will be reported used\ntype: insight\n---\n\nFlush target body.\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(notesDir, "flush-neighbor.md"),
        "---\ndescription: a second used note\ntype: insight\n---\n\nNeighbor body.\n",
        "utf8",
      );
      const { runInit } = await import("../../src/cli/init.js");
      const { runIndexBuild } = await import("../../src/cli/indexcmd.js");
      await runInit({ targetDir: v });
      await runIndexBuild(v);

      const start = await runExploreStartCli(v, "the flush target probe", 3);
      const id = (start.data as { exploration_id: string }).exploration_id;
      const done = await runExploreConcludeCli(v, id, {
        answered: true,
        usedNotes: ["flush-target", "flush-neighbor"],
      });
      expect(done.success).toBe(true);
      const summary = done.data as { usedNotes: string[]; rewarded: number };
      expect(summary.rewarded).toBe(2);

      // The Q rows exist, written with the explore_conclude source.
      const { default: betterSqlite3 } = await import("better-sqlite3");
      const db = betterSqlite3(path.join(v, ".mnemos", "embeddings.db"), { readonly: true });
      try {
        for (const slug of ["flush-target", "flush-neighbor"]) {
          const q = db.prepare("SELECT q_value, update_count FROM note_q WHERE note_id = ?").get(slug) as
            | { q_value: number; update_count: number }
            | undefined;
          expect(q).toBeDefined();
          expect(q!.update_count).toBeGreaterThan(0);
          expect(q!.q_value).toBeGreaterThan(0);
          const hist = db
            .prepare("SELECT reward_source FROM q_history WHERE note_id = ? ORDER BY rowid DESC LIMIT 1")
            .get(slug) as { reward_source: string } | undefined;
          expect(hist?.reward_source).toBe("explore_conclude");
        }
      } finally {
        db.close();
      }

      // And a conclude with no used notes writes nothing.
      const start2 = await runExploreStartCli(v, "the empty conclude probe", 3);
      const id2 = (start2.data as { exploration_id: string }).exploration_id;
      const done2 = await runExploreConcludeCli(v, id2, { answered: false });
      expect(done2.success).toBe(true);
      expect((done2.data as { rewarded?: number }).rewarded).toBeUndefined();
    } finally {
      await fs.rm(v, { recursive: true, force: true });
    }
  }, 120000);

  it("unknown ids fail with a helpful message", async () => {
    const r = await runExploreExpandCli(vaultDir, "exp-nope", { subQuestion: "x" });
    expect(r.success).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/explore-sessions/);
  }, 60000);
});
