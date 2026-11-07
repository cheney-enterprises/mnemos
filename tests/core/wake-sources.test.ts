import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadWakeSources, assembleWakeInputs, assembleProjects } from "../../src/core/wake-sources.js";

// Blind tests — manifest contract from design v2. Author never sees these.
// loadWakeSources(config) -> ordered sources with defaults when config.wake?.sources missing.
// assembleWakeInputs(vaultRoot, sources) -> WakeInputs-shaped object reading real files.

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-wake-mf-"));
  await fs.mkdir(path.join(tmp, "self"), { recursive: true });
  await fs.mkdir(path.join(tmp, "ops"), { recursive: true });
  await fs.writeFile(path.join(tmp, "self", "identity.md"), "# id\nName: TestBot. Tester.\n");
  await fs.writeFile(path.join(tmp, "self", "goals.md"), "- goal one\n- goal two\n");
  await fs.writeFile(path.join(tmp, "ops", "reminders.md"), "- [ ] 2026-04-06: old thing\n");
  await fs.writeFile(path.join(tmp, "ops", "daily.md"), Array.from({length: 40}, (_, i) => `line ${i}`).join("\n"));
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe("manifest defaults", () => {
  it("no config -> scaffold defaults with daily.md tail as activity", () => {
    const sources = loadWakeSources({});
    const roles = sources.map((s) => s.role);
    expect(roles).toContain("identity");
    expect(roles).toContain("goals");
    expect(roles).toContain("due");
    expect(roles).toContain("activity");
    const activity = sources.find((s) => s.role === "activity")!;
    // The default activity source is ops/daily.md — the file
    // `mnemos_update file=daily` writes and every scaffold ships. The old
    // default (ops/today.md) matched no file any code path creates.
    expect(activity.path).toContain("daily.md");
    expect(activity.mode).toBe("tail");
  });

  it("user config overrides defaults entirely", () => {
    const sources = loadWakeSources({ wake: { sources: [{ path: "x.md", role: "activity", cap: 5, mode: "tail" }] } } as never);
    expect(sources.length).toBe(1);
    expect(sources[0].path).toBe("x.md");
  });
});

describe("assembly against a real vault dir", () => {
  it("reads files per manifest; missing files become empty, no crash", async () => {
    const inputs = await assembleWakeInputs(tmp, loadWakeSources({}));
    expect(inputs.identity).toContain("TestBot");
    expect(inputs.goals).toContain("goal one");
    expect(typeof inputs.reminders).toBe("string");
  });

  it("tail mode respects cap: activity holds LAST lines, bounded", async () => {
    const inputs = await assembleWakeInputs(tmp, loadWakeSources({}));
    const acts = (inputs as { activity?: string[] }).activity ?? [];
    expect(acts.length).toBeLessThanOrEqual(10);
    if (acts.length > 0) expect(acts[acts.length - 1]).toBe("line 39");
  });
});

describe("assembleProjects — the roster the briefing and the ask-first gate share", () => {
  it("reads a real index: active project notes counted, maps and forgotten notes excluded", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { initIndexStore, syncIndex } = await import("../../src/core/indexstore.js");
    const { mkdir } = await import("node:fs/promises");

    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-roster-"));
    const notesDir = path.join(idxRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    const note = (name: string, fm: string, body = "") =>
      fs.writeFile(path.join(notesDir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`, "utf8");

    await note("kite project map", "type: moc\nproject: [kite]\nstatus: active");
    await note("kite telemetry note", "type: insight\nproject: [kite]\nstatus: active");
    await note("kite barometer note", "type: insight\nproject: [kite]\nstatus: active");
    await note("roust insight one", "type: insight\nproject: [roust]\nstatus: active");
    // archived project notes left retrieval — they must not count.
    await note("kite archived note", "type: insight\nproject: [kite]\nstatus: archived");
    await note("roust superseded note", "type: insight\nproject: [roust]\nstatus: superseded");

    const db = new Database(path.join(idxRoot, "index.db"));
    initIndexStore(db);
    await syncIndex(db, notesDir);

    const roster = await assembleProjects(path.join(idxRoot, "index.db"));
    expect(roster).toEqual([
      { project: "kite", notes: 2 },
      { project: "roust", notes: 1 },
    ]);

    db.close();
    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("missing db degrades to an empty list, never an error", async () => {
    const roster = await assembleProjects("/nonexistent/path/index.db");
    expect(roster).toEqual([]);
  });
});
