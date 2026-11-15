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

describe("assembleResurfaced — the debt #2 mechanism (high-Q, untouched)", () => {
  it("selects rewarded notes idle past the threshold, ranked by decayed q; filters and caps", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { initIndexStore, syncIndex } = await import("../../src/core/indexstore.js");
    const { initQValueTables } = await import("../../src/core/qvalue.js");
    const { mkdir } = await import("node:fs/promises");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-resurface-"));
    const notesDir = path.join(root, "notes");
    await mkdir(notesDir, { recursive: true });
    const note = (name: string, fm: string) =>
      fs.writeFile(path.join(notesDir, `${name}.md`), `---\n${fm}\n---\n\nBody.\n`, "utf8");

    const daysAgo = (n: number) =>
      new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

    await note("kite-old-high-q", "type: insight\nproject: [kite]");
    await note("kite-old-low-q", "type: insight\nproject: [kite]");
    await note("kite-recent", "type: insight\nproject: [kite]"); // accessed 1d ago
    await note("kite-forgotten", "type: insight\nproject: [kite]\nstatus: archived");
    await note("roust-old-high-q", "type: insight\nproject: [roust]");
    await note("kite-never-rewarded", "type: insight\nproject: [kite]"); // no Q row

    const db = new Database(path.join(root, "index.db"));
    initIndexStore(db);
    await syncIndex(db, notesDir);
    initQValueTables(db);

    // Learned value: the loop REWARDED these — update_count > 0 AND a rule
    // stamp (rule = 1 is what updateQ writes). A row without the stamp is
    // LEGACY by definition (pre-#37) and getDecayedQ refuses it.
    const q = (slug: string, value: number, days: number) =>
      db.prepare(
        `INSERT INTO note_q (note_id, q_value, update_count, last_updated, rule)
         VALUES (?, ?, 2, ?, 1)`,
      ).run(slug, value, daysAgo(days));
    q("kite-old-high-q", 0.9, 40);
    q("kite-old-low-q", 0.3, 40);
    q("kite-recent", 0.8, 40);
    q("kite-forgotten", 0.95, 40);
    q("roust-old-high-q", 0.7, 40);
    // "kite never rewarded": no row at all.

    // Access: the anchor for idleness. Recent note touched 1 day ago; the
    // forgotten one touched long ago (its status still excludes it).
    const touch = (slug: string, days: number) =>
      db.prepare(
        `INSERT INTO note_access (slug, access_count, last_accessed) VALUES (?, 3, ?)`,
      ).run(slug, daysAgo(days));
    touch("kite-old-high-q", 30);
    touch("kite-old-low-q", 25);
    touch("kite-recent", 1);
    touch("kite-forgotten", 30);
    touch("roust-old-high-q", 20);
    // "kite never rewarded" also never accessed — but has no Q row anyway.

    // Global wake: whole vault, threshold 14 days.
    const { assembleResurfaced } = await import("../../src/core/wake-sources.js");
    const all = await assembleResurfaced(path.join(root, "index.db"), {
      minIdleDays: 14, cap: 3,
    });
    // kite recent (idle 1d) and kite forgotten (archived) and the never-
    // rewarded note are out; ranked by decayed q desc.
    expect(all.map((r) => r.title)).toEqual(["kite-old-high-q", "roust-old-high-q", "kite-old-low-q"]);
    expect(all[0].daysIdle).toBeGreaterThanOrEqual(30);
    expect(all[0].q).toBeGreaterThan(0);

    // Scoped wake: only the project's members.
    const scoped = await assembleResurfaced(path.join(root, "index.db"), {
      minIdleDays: 14, cap: 3, projectSlugs: new Set(["kite-old-high-q", "kite-old-low-q", "kite-recent"]),
    });
    expect(scoped.map((r) => r.title)).toEqual(["kite-old-high-q", "kite-old-low-q"]);

    // Cap is a hard law.
    const capped = await assembleResurfaced(path.join(root, "index.db"), {
      minIdleDays: 14, cap: 1,
    });
    expect(capped.map((r) => r.title)).toEqual(["kite-old-high-q"]);

    // Tunable threshold: raised past every idleness, the section empties.
    const strict = await assembleResurfaced(path.join(root, "index.db"), {
      minIdleDays: 400, cap: 3,
    });
    expect(strict).toEqual([]);

    // 0 disables.
    const off = await assembleResurfaced(path.join(root, "index.db"), {
      minIdleDays: 14, cap: 0,
    });
    expect(off).toEqual([]);

    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("missing db degrades to an empty list, never an error", async () => {
    const { assembleResurfaced } = await import("../../src/core/wake-sources.js");
    const empty = await assembleResurfaced("/nonexistent/path/index.db", {
      minIdleDays: 14, cap: 3,
    });
    expect(empty).toEqual([]);
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
      "- 2026-11-08: roust line about alarms and snooze",
    ].join("\n"), "utf8");
    await mkdir(path.join(idxRoot, "ops", "kite"), { recursive: true });
    await writeFile(path.join(idxRoot, "ops", "kite", "daily.md"), [
      "- 2026-11-08: kite line about telemetry and barometers",
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
    // Daily lines come from the project's OWN file — never the shared log.
    expect(pw.daily.length).toBe(2);
    expect(pw.daily.every((l) => l.includes("kite"))).toBe(true);
    expect(pw.daily.some((l) => l.includes("roust"))).toBe(false);
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

describe("scoped wake: substituted sections (goals/daily/warm)", () => {
  it("per-project files win when present; scoped wake shows THIS project's goals", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-subst-"));
    await mkdir(path.join(idxRoot, "ops", "roust"), { recursive: true });
    await mkdir(path.join(idxRoot, "self"), { recursive: true });
    await writeFile(path.join(idxRoot, "ops", "roust", "goals.md"), "- roust goal a\n- roust goal b\n", "utf8");
    await writeFile(path.join(idxRoot, "self", "goals.md"), "- flutter performance track\n- other project goal mentioning roust\n", "utf8");

    const { assembleProjectWake } = await import("../../src/core/wake-sources.js");
    const pw = await assembleProjectWake(idxRoot, "/nonexistent/db", "roust", {});
    expect(pw.goalsFromFile).toBe(true);
    expect(pw.goals).toEqual(["- roust goal a", "- roust goal b"]);

    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("NO fallback: a project never reads the shared goals file (Eric's law)", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-subst2-"));
    await mkdir(path.join(idxRoot, "self"), { recursive: true });
    await writeFile(path.join(idxRoot, "self", "goals.md"), "- flutter performance track\n- roust device verification\n", "utf8");

    const { assembleProjectWake } = await import("../../src/core/wake-sources.js");
    const pw = await assembleProjectWake(idxRoot, "/nonexistent/db", "roust", {});
    // No ops/roust/goals.md -> EMPTY section, never the shared file.
    expect(pw.goalsFromFile).toBe(false);
    expect(pw.goals).toEqual([]);

    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("warm notes: boosts intersected with membership, sorted by decay", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { initIndexStore, syncIndex } = await import("../../src/core/indexstore.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-warm-"));
    const notesDir = path.join(idxRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    const note = (name: string, fm: string) =>
      writeFile(path.join(notesDir, `${name}.md`), `---\n${fm}\n---\n\nbody\n`, "utf8");
    await note("kite warm note", "type: insight\nproject: [kite]\nstatus: active");
    await note("roust warm note", "type: insight\nproject: [roust]\nstatus: active");
    const { initDB } = await import("../../src/core/engine.js");
    const db = initDB(path.join(idxRoot, "index.db"));
    initIndexStore(db);
    await syncIndex(db, notesDir);
    // Seed boosts for both (the boosts table belongs to the engine schema).
    db.prepare("INSERT OR REPLACE INTO boosts (title, boost, updated) VALUES (?, ?, ?)").run("kite warm note", 0.9, new Date().toISOString());
    db.prepare("INSERT OR REPLACE INTO boosts (title, boost, updated) VALUES (?, ?, ?)").run("roust warm note", 0.5, new Date().toISOString());
    const { assembleProjectWake } = await import("../../src/core/wake-sources.js");
    const pw = await assembleProjectWake(idxRoot, path.join(idxRoot, "index.db"), "roust", {});
    expect(pw.warmNotes.map((w) => w.title)).toEqual(["roust warm note"]);
    db.close();
    await fs.rm(idxRoot, { recursive: true, force: true });
  });
});

describe("per-project reminders (global + project sets, Eric's design)", () => {
  it("ops/<tag>/reminders.md wins when present; scoped wake reads it as the authority", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-prem-"));
    await mkdir(path.join(idxRoot, "ops", "roust"), { recursive: true });
    await writeFile(path.join(idxRoot, "ops", "roust", "reminders.md"), "- [ ] 2026-11-08: roust-only follow up\n", "utf8");
    await mkdir(path.join(idxRoot, "ops"), { recursive: true });
    await writeFile(path.join(idxRoot, "ops", "reminders.md"), "- flutter release check\n", "utf8");

    const { assembleProjectWake } = await import("../../src/core/wake-sources.js");
    const pw = await assembleProjectWake(idxRoot, "/nonexistent/db", "roust", {});
    expect(pw.remindersFromFile).toBe(true);
    expect(pw.reminders).toEqual(["- [ ] 2026-11-08: roust-only follow up"]);

    await fs.rm(idxRoot, { recursive: true, force: true });
  });

  it("NO fallback: a project never reads the shared reminders file", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const idxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-prem2-"));
    await mkdir(path.join(idxRoot, "ops"), { recursive: true });
    await writeFile(path.join(idxRoot, "ops", "reminders.md"), "- flutter release check\n- roust device verdict follow up\n", "utf8");

    const { assembleProjectWake } = await import("../../src/core/wake-sources.js");
    const pw = await assembleProjectWake(idxRoot, "/nonexistent/db", "roust", {});
    expect(pw.remindersFromFile).toBe(false);
    expect(pw.reminders).toEqual([]);

    await fs.rm(idxRoot, { recursive: true, force: true });
  });
});
