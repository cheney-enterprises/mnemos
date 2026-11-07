import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdateFile } from "../../src/cli/update.js";
import { runAdd } from "../../src/cli/add.js";

// file=map closes the ritual's last gap: the SESSION END step the doctrine
// demanded but no tool could perform. Also pins the gate wiring: self files
// propose at identity_update=approval; daily/goals/reminders/map write at
// state_overwrite=allow (defaults) and refuse at approval/deny.

let dir: string;
let vault: string;

function scaffold(withMap = true): void {
  dir = mkdtempSync(join(tmpdir(), "mnemos-update-"));
  vault = join(dir, "vault");
  for (const sub of ["notes", "ops", "self", "templates", "inbox"]) mkdirSync(join(vault, sub), { recursive: true });
  writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: false\n", "utf8");
  // Real vaults always carry identity.md (init scaffolds it); the gate tests
  // read it back to prove nothing was written.
  writeFileSync(join(vault, "self", "identity.md"), "# Agent\n\nName: TestBot.\n", "utf8");
  if (withMap) {
    writeFileSync(
      join(vault, "notes", "roust-project-map.md"),
      [
        "---",
        'description: "Map of the roust project"',
        "type: moc",
        "project: [roust]",
        "status: active",
        "created: 2026-11-01",
        "---",
        "",
        "# Roust Project Map",
        "",
        "## Key Notes",
        "- [[roust-note-one]] — the identity note",
        "",
        "## Current State (2026-11-01)",
        "- done: old",
        "",
        "## Recent Additions",
      ].join("\n"),
      "utf8",
    );
  }
}

beforeEach(() => scaffold());
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
});

describe("runUpdateFile — self/ops files", () => {
  it("daily/goals/reminders overwrite at the default gate and back up", async () => {
    const first = await runUpdateFile({ startDir: vault, file: "daily", content: "# Daily\n\n- day one" });
    expect(first.success).toBe(true);
    expect(readFileSync(join(vault, "ops", "daily.md"), "utf8")).toContain("day one");

    const second = await runUpdateFile({ startDir: vault, file: "daily", content: "# Daily\n\n- day two" });
    expect(second.success).toBe(true);
    expect(second.data.backed_up).toBe(true);
    expect(readFileSync(join(vault, "ops", "daily.md"), "utf8")).toContain("day two");
    const historyDir = join(vault, "ops", ".history");
    expect(readdirSync(historyDir).some((f) => f.startsWith("daily-"))).toBe(true);
  });

  it("identity at default approval gate proposes — nothing written", async () => {
    const before = readFileSync(join(vault, "self", "identity.md"), "utf8");
    const res = await runUpdateFile({ startDir: vault, file: "identity", content: "# New Self" });
    expect(res.success).toBe(true);
    expect(res.data.intent_proposed).toBe(true);
    expect(String(res.data.approve_command)).toContain("mnemos requests approve");
    expect(readFileSync(join(vault, "self", "identity.md"), "utf8")).toBe(before);
    expect(res.warnings.join(" ")).toContain("REQUIRES USER APPROVAL");
  });

  it("identity at allow gate writes directly with backup", async () => {
    writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: false\npolicy:\n  gates:\n    identity_update: allow\n", "utf8");
    const res = await runUpdateFile({ startDir: vault, file: "identity", content: "# Self v2" });
    expect(res.success).toBe(true);
    expect(res.data.intent_proposed).toBeUndefined();
    expect(readFileSync(join(vault, "self", "identity.md"), "utf8")).toBe("# Self v2");
    expect(res.data.backed_up).toBe(true);
  });

  it("identity at deny gate refuses outright", async () => {
    writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: false\npolicy:\n  gates:\n    identity_update: deny\n", "utf8");
    const res = await runUpdateFile({ startDir: vault, file: "identity", content: "# Self v2" });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("identity_update=deny");
    expect(readFileSync(join(vault, "self", "identity.md"), "utf8")).not.toBe("# Self v2");
  });

  it("state_overwrite=deny blocks daily", async () => {
    writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: false\npolicy:\n  gates:\n    state_overwrite: deny\n", "utf8");
    const res = await runUpdateFile({ startDir: vault, file: "daily", content: "# Daily" });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("state_overwrite=deny");
  });
});

describe("runUpdateFile — file=map (the ritual)", () => {
  it("overwrites the Current State section, keeping Key Notes and frontmatter", async () => {
    const res = await runUpdateFile({
      startDir: vault,
      file: "map",
      project: "roust",
      content: "- done: phase 3 landed\n- next: cold-agent suite\n- blocked: none",
    });
    expect(res.success).toBe(true);
    expect(res.data.map).toBe("roust-project-map");
    expect(res.data.section_created).toBe(false);

    const written = readFileSync(join(vault, "notes", "roust-project-map.md"), "utf8");
    // Frontmatter survives byte-identical in shape
    expect(written).toContain("type: moc");
    expect(written).toContain("project:");
    expect(written).toContain("- roust");
    // Key Notes untouched
    expect(written).toContain("- [[roust-note-one]] — the identity note");
    // Section replaced, stamped with today, no append
    expect(written).toContain("## Current State (");
    expect(written).toContain("- done: phase 3 landed");
    expect(written).not.toContain("- done: old");
    expect(written).toContain("## Recent Additions");
    expect(written.match(/## Current State/g)?.length).toBe(1);
  });

  it("resolves the map by the <tag>…map convention without config routing", async () => {
    const res = await runUpdateFile({
      startDir: vault,
      file: "map",
      project: "kite",
      content: "- done: map created",
    });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain('No map found for project "kite"');

    // Now create the map via the documented flow and retry.
    writeFileSync(
      join(vault, "notes", "kite-telemetry-map.md"),
      "---\ndescription: \"Kite map\"\ntype: moc\nproject: [kite]\nstatus: active\ncreated: 2026-11-08\n---\n\n# Kite Map\n\n## Key Notes\n",
      "utf8",
    );
    const ok = await runUpdateFile({ startDir: vault, file: "map", project: "kite", content: "- done: map created" });
    expect(ok.success).toBe(true);
    expect(ok.data.map).toBe("kite-telemetry-map");
    expect(ok.data.section_created).toBe(true);
    expect(readFileSync(join(vault, "notes", "kite-telemetry-map.md"), "utf8")).toContain("## Current State (");
  });

  it("config routing (project_map_routing) wins over the convention", async () => {
    writeFileSync(
      join(vault, "mnemos.config.yaml"),
      "promote:\n  auto: false\n  project_map_routing:\n    roust: roust-project-map\n",
      "utf8",
    );
    const res = await runUpdateFile({ startDir: vault, file: "map", project: "roust", content: "- done: routed" });
    expect(res.success).toBe(true);
    expect(res.data.map).toBe("roust-project-map");
  });

  it("requires project", async () => {
    const res = await runUpdateFile({ startDir: vault, file: "map", content: "- done: x" });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("requires project");
  });

  it("state_overwrite=approval refuses the ritual with the reason", async () => {
    writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: false\npolicy:\n  gates:\n    state_overwrite: approval\n", "utf8");
    const res = await runUpdateFile({ startDir: vault, file: "map", project: "roust", content: "- done: x" });
    expect(res.success).toBe(false);
    expect(res.warnings.join(" ")).toContain("state_overwrite=approval");
  });
});

describe("runUpdateFile — map backup", () => {
  it("backs up the map before overwriting", async () => {
    await runUpdateFile({ startDir: vault, file: "map", project: "roust", content: "- done: v2" });
    const historyDir = join(vault, "notes", ".history");
    const backups = readdirSync(historyDir).filter((f) => f.startsWith("roust-project-map-"));
    expect(backups.length).toBeGreaterThan(0);
    expect(readFileSync(join(historyDir, backups[0]), "utf8")).toContain("- done: old");
  });
});
