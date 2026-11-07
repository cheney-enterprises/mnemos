import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdd, projectAskResponse } from "../../src/cli/add.js";

// The ask-first contract: a note without a project must NEVER silently file
// under the hub. The add refuses with the roster + the question, so the agent
// asks the USER (existing project, or new one + its name) and re-calls.

let dir: string;
let vault: string;

function scaffold(): void {
  dir = mkdtempSync(join(tmpdir(), "project-ask-"));
  vault = join(dir, "vault");
  for (const sub of ["notes", "ops", "self", "templates", "inbox"]) mkdirSync(join(vault, sub), { recursive: true });
  mkdirSync(join(vault, ".mnemos"), { recursive: true });
  writeFileSync(join(vault, "mnemos.config.yaml"), "promote:\n  auto: true\n", "utf8");
  // Minimal note template — the ask gate fires before the template read, but
  // the pass-path tests promote and need it.
  writeFileSync(
    join(vault, "templates", "note.md"),
    '---\ndescription: ""\ntype: insight\nproject: []\nstatus: active\ncreated: YYYY-MM-DD\n---\n\n# {title}\n',
    "utf8",
  );
}

beforeEach(scaffold);
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows */ }
});

describe("ask-first gate", () => {
  it("untagged note is gated at the filing boundary — staged in inbox, never auto-promoted", async () => {
    const res = await runAdd({
      startDir: vault,
      title: "an untagged note that has no project at all",
      type: "insight",
      description: "probe",
      content: "body text",
    });
    // The add itself succeeds: the note is staged in inbox/ (harmless — a
    // stub harms nothing). The GATE refuses auto-promotion.
    expect(res.success).toBe(true);
    expect(res.data.askGate).toBe(true);
    expect(res.data.autoPromoted).toBe(false);
    expect(res.data.reason).toBe("project_required");
    expect(res.data.ask).toContain("new one");
    // Staged in inbox, never filed into notes/.
    expect(existsSync(join(vault, "inbox"))).toBe(true);
  });

  it("the refusal includes roster and names both resolutions", async () => {
    const res = await runAdd({
      startDir: vault,
      title: "another untagged note needing a project decision",
      description: "probe",
      content: "body",
    });
    const warnings = res.warnings.join(" ");
    expect(warnings).toContain("Do NOT guess");
    expect(warnings).toContain("Current projects:");
    expect(warnings).toContain("re-call mnemos_add with project");
    expect(warnings).toContain("type=moc");
    expect(warnings).toContain("mnemos_update file=goals");
  });

  it("explicit project passes the gate and promotes", async () => {
    const res = await runAdd({
      startDir: vault,
      title: "a properly tagged note that sails through the gate",
      type: "insight",
      description: "probe",
      project: ["kite"],
      content: "body",
    });
    expect(res.success).toBe(true);
    expect(res.data.autoPromoted).toBe(true);
    // The project tag lands in the note's frontmatter; the path is the
    // note's slug, not the project. The tag surfaces via the promote
    // warnings ("project set to: kite").
    expect(res.warnings.join(" ")).toContain("kite");
  });

  it("config keyword detection satisfies the gate without an explicit tag", async () => {
    writeFileSync(
      join(vault, "mnemos.config.yaml"),
      "promote:\n  auto: true\n  project_keywords:\n    kite: [telemetry, barometer]\n",
      "utf8",
    );
    const res = await runAdd({
      startDir: vault,
      title: "telemetry reading note detected via configured keywords",
      type: "insight",
      description: "probe",
      content: "barometer drift observed",
    });
    expect(res.success).toBe(true);
    expect(res.warnings.join(" ")).toContain("project detected");
  });

  it("roster rendering handles the empty-vault case (first project ever)", () => {
    const res = projectAskResponse([]);
    expect(res.warnings.join(" ")).toContain("no projects established yet");
    expect(res.data.projects).toEqual([]);
  });

  it("roster entries carry numeric note counts", () => {
    const res = projectAskResponse([
      { project: "roust", notes: 3 },
      { project: "kite", notes: 1 },
    ]);
    const projects = res.data.projects as Array<{ project: string; notes: number }>;
    expect(projects[0]).toEqual({ project: "roust", notes: 3 });
    expect(Number.isInteger(projects[0].notes)).toBe(true);
    expect(res.warnings.join(" ")).toContain("roust (3 notes)");
  });
});
