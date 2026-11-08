import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadWakeSources, assembleWakeInputs, assembleProjects, assembleProjectWake } from "../../src/core/wake-sources.js";

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
    // The map counts (a map-only project is the documented first step and the
    // gate's roster includes it — the two rosters must agree); forgotten
    // statuses do not.
    expect(roster).toEqual([
      { project: "kite", notes: 3 },
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

describe("assembleProjectWake — the scoped context layer", () => {
  it("resolves the map, extracts Current State, scopes daily and notes to the project", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { initIndexStore, syncIndex } = await import("../../src/core/indexstore.js");
    const { mkdir, writeFile } = await import("node:fs/promises");

    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-pwake-"));
    const notesDir = path.join(idxRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    await mkdir(path.join(idxRoot, "ops"), { recursive: true });
    await fs.writeFile(path.join(idxRoot, "ops", "daily.md"), [
      "- 2026-11-08: kite line about telemetry and barometers",
      "- 2026-11-08: roust line about alarms and snooze",
      "- 2026-11-08: another kite budget line",
    ].join("\n"), "utf8");
    const note = (name: string, fm: string, body = "") =>
      writeFile(path.join(notesDir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`, "utf8");

    await note("kite project map", "type: moc\nproject: [kite]\nstatus: active", [
      "# Kite Map",
      "",
      "## Key Notes",
      "- [[ktelemetry]]",
      "",
      "## Current State (2026-11-08)",
      "- done: scoped wake designed",
      "- next: land it",
      "",
      "## Recent Additions",
    ].join("\n"));
    await note("ktelemetry", "type: insight\nproject: [kite]\nstatus: active");
    await note("roust-alarm-note", "type: insight\nproject: [roust]\nstatus: active");

    const db = new Database(path.join(idxRoot, "index.db"));
    initIndexStore(db);
    await syncIndex(db, notesDir);

    const pw = await assembleProjectWake(idxRoot, path.join(idxRoot, "index.db"), "kite", {});
    expect(pw.map).toBe("kite project map");
    expect(pw.currentState).toContain("- done: scoped wake designed");
    expect(pw.currentState).toContain("- next: land it");
    // Daily lines scoped by tag-in-line (current shared-file convention)
    expect(pw.daily.length).toBe(2);
    expect(pw.daily.every((l) => l.includes("kite"))).toBe(true);
    // Recent notes: only kite's, not roust's
    expect(pw.recentNotes).toContain("ktelemetry");
    expect(pw.recentNotes).toContain("kite project map");
    expect(pw.recentNotes).not.toContain("roust-alarm-note");

    db.close();
    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("config routing resolves the map (same chain as the ritual)", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-pwake2-"));
    await mkdir(path.join(idxRoot, "notes"), { recursive: true });
    await writeFile(
      path.join(idxRoot, "notes", "custom-map-name.md"),
      "---\ntype: moc\nproject: [zx]\nstatus: active\n---\n\n# Zx\n\n## Current State\n- routed via config\n",
      "utf8",
    );
    const pw = await assembleProjectWake(idxRoot, "/nonexistent/db", "zx", { zx: "custom-map-name" });
    expect(pw.map).toBe("custom-map-name");
    expect(pw.currentState).toContain("- routed via config");
    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("a project with no map degrades to empty fields, not an error", async () => {
    const pw = await assembleProjectWake("/nonexistent/root", "/nonexistent/db", "ghost", {});
    expect(pw.map).toBeNull();
    expect(pw.currentState).toEqual([]);
    expect(pw.daily).toEqual([]);
    expect(pw.recentNotes).toEqual([]);
  });
});

describe("wake.project_default config contract", () => {
  it("defaults to empty (wake alone forces a choice) and accepts an override", async () => {
    const { loadConfig, applyConfigDefaults } = await import("../../src/core/config.js");
    const d = applyConfigDefaults({});
    expect(d.wake.project_default).toBe("");
    expect(d.wake.budget_lines).toBe(96);
    // YAML round-trip
    const osmod = await import("node:os");
    const fsp = await import("node:fs/promises");
    const dir = await fsp.mkdtemp(path.join(osmod.tmpdir(), "wake-cfg-"));
    await fsp.writeFile(path.join(dir, "mnemos.config.yaml"), "wake:\n  project_default: mnemos\n  budget_lines: 64\n", "utf8");
    const c = await loadConfig(path.join(dir, "mnemos.config.yaml"));
    expect(c.wake.project_default).toBe("mnemos");
    expect(c.wake.budget_lines).toBe(64);
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
