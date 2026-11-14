import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProbeVault } from "../../src/probe/fixture.js";
import { PROBE_CASES } from "../../src/probe/cases.js";
import { runProbe } from "../../src/probe/run.js";
import { runValidate } from "../../src/cli/validate.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

describe("probe fixture", () => {
  it("is a real vault: every generated note passes the product's own schema", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-fixture-test-"));
    try {
      await buildProbeVault(dir);
      const notes = await fs.readdir(path.join(dir, "notes"));
      expect(notes.length).toBeGreaterThanOrEqual(40); // realistic mass, not a toy
      for (const note of notes) {
        const result = await runValidate({ notePath: path.join(dir, "notes", note), startDir: dir });
        expect(result.success, `${note}: ${result.errors.join("; ")}`).toBe(true);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("ships the scaffold templates and maps moc to the map schema", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-fixture-test-"));
    try {
      await buildProbeVault(dir);
      const note = await fs.readFile(path.join(dir, "templates", "note.md"), "utf8");
      const map = await fs.readFile(path.join(dir, "templates", "map.md"), "utf8");
      expect(note).toContain("_schema:");
      expect(map).toContain("entity_type: \"map\"");
      const config = await fs.readFile(path.join(dir, "mnemos.config.yaml"), "utf8");
      expect(config).toContain("moc: templates/map.md");
      expect(config).toContain("enabled: false"); // flag OFF by default (§10)
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("carries the lineage graph: root → continues-child / branched-child, unrelated apart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-fixture-test-"));
    try {
      await buildProbeVault(dir);
      const sessionsDir = path.join(dir, "ops", "sessions");
      // Filenames are slugified (underscores deleted); raw ids live in
      // frontmatter — assert on the raw ids.
      const files = await fs.readdir(sessionsDir);
      const byId: Record<string, Record<string, unknown>> = {};
      for (const f of files) {
        const parsed = await readFrontmatterFile(path.join(sessionsDir, f));
        const id = parsed.data?.session as string;
        byId[id] = parsed.data ?? {};
      }
      expect(Object.keys(byId).sort()).toEqual([
        "ses_probe_branch",
        "ses_probe_child",
        "ses_probe_root",
        "ses_probe_unrelated",
      ]);
      expect(byId["ses_probe_child"].continues).toBe("ses_probe_root");
      expect(byId["ses_probe_branch"].branched_from).toBe("ses_probe_root");
      expect(byId["ses_probe_unrelated"].continues).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("probe case manifest", () => {
  it("is well-formed: unique ids, every case documents what it stresses", () => {
    const ids = PROBE_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of PROBE_CASES) {
      expect(c.stresses.length).toBeGreaterThan(20);
      expect(["hard", "gate"]).toContain(c.level);
    }
    // The suite must always carry its guard set: at least one case per
    // designed dimension, and hard cases present (regression guard).
    expect(PROBE_CASES.filter((c) => c.level === "hard").length).toBeGreaterThanOrEqual(5);
    expect(PROBE_CASES.filter((c) => c.level === "gate").length).toBeGreaterThanOrEqual(2);
  });

  it("gate cases are declared as gate, hard cases as hard — never swapped", () => {
    for (const c of PROBE_CASES) {
      if (c.level === "gate") {
        // Gate cases measure §9 targets — dilution, lineage weighting.
        expect(["dilution", "lineage_retrieval"]).toContain(c.kind);
      }
    }
  });
});

describe("runProbe", () => {
  it("passes every hard case and reports gate numbers", async () => {
    const report = await runProbe({ level: "hard" });
    expect(report.fixture.notes).toBeGreaterThanOrEqual(40);
    expect(report.headline.hard_total).toBeGreaterThan(0);
    expect(report.headline.hard_all_passed).toBe(true);
    for (const c of report.cases) {
      if (c.level === "hard") expect(c.passed, `${c.id}: ${c.detail}`).toBe(true);
    }
  }, 300_000);

  it("gate cases produce numeric §9 metrics, not pass/fail", async () => {
    const report = await runProbe({ level: "gate" });
    const dilution = report.cases.filter((c) => c.kind === "dilution");
    expect(dilution.length).toBeGreaterThanOrEqual(2);
    for (const c of dilution) {
      expect(c.passed).toBeNull(); // numbers, not verdicts, until the flip
      expect(c.value).toBeGreaterThanOrEqual(0);
    }
    expect(report.headline.gate_dilution_pct).toBeGreaterThanOrEqual(0);
    expect(report.headline.gate_miss_pct).toBeGreaterThanOrEqual(0);
  }, 300_000);

  it("is deterministic: two runs agree on the headline", async () => {
    const a = await runProbe({ level: "hard" });
    const b = await runProbe({ level: "hard" });
    expect(a.headline).toEqual(b.headline);
    expect(a.cases.map((c) => [c.id, c.passed])).toEqual(b.cases.map((c) => [c.id, c.passed]));
  }, 600_000);
});
