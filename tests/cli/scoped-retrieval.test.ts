import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runQueryRanked, runQuerySimilar } from "../../src/cli/search.js";
import { runExplore } from "../../src/cli/explore.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";

// The scoped-read contract (Eric's design): a named project hard-filters the
// answer set to that project's notes — no bleed from other projects, no
// exploration-slot resurrection of filtered-out notes. An UNSET project
// searches the whole vault: cross-project learning is the unscoped default,
// never behind a flag. Scoped results name the other projects so the agent
// knows the scope was a choice, not the world.

let vault: string;

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-retrieval-"));
  await runInit({ targetDir: vault });
  // Two projects with distinct vocabularies.
  await runAdd({
    startDir: vault,
    title: "alpha telemetry barometer drift confirmed at altitude",
    type: "insight",
    description: "alpha project fact",
    project: ["alpha"],
    content: "Barometer drift on the alpha transmitter; wiki [[alpha project map]].",
  });
  await runAdd({
    startDir: vault,
    title: "alpha project map",
    type: "moc",
    description: "alpha map",
    project: ["alpha"],
    content: "Entry point for alpha.",
  });
  await runAdd({
    startDir: vault,
    title: "beta composer animation curve timing structure",
    type: "insight",
    description: "beta project fact",
    project: ["beta"],
    content: "Animation curves in the beta composer; wiki [[beta project map]].",
  });
  await runAdd({
    startDir: vault,
    title: "beta project map",
    type: "moc",
    description: "beta map",
    project: ["beta"],
    content: "Entry point for beta.",
  });
  await runIndexBuild(vault, false);
}, 60000);

afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
});

const projectOf = (title: string): string => {
  if (title.startsWith("alpha")) return "alpha";
  if (title.startsWith("beta")) return "beta";
  return "other";
};

describe("scoped retrieval (ranked)", () => {
  it("hard-filters: an alpha-scoped query returns zero beta notes", async () => {
    const r = await runQueryRanked(vault, "composer animation curve timing", 10, undefined, undefined, undefined, undefined, undefined, "alpha");
    for (const n of r.data.results) {
      expect(projectOf(n.title), `leak: ${n.title}`).toBe("alpha");
    }
    // The notice names beta.
    expect(r.data.project_scope?.project).toBe("alpha");
    expect(r.data.project_scope?.others.map((o) => o.project)).toContain("beta");
  });

  it("hard-filters even when the query matches ONLY the other project", async () => {
    const r = await runQueryRanked(vault, "composer animation curve timing structure", 10, undefined, undefined, undefined, undefined, undefined, "alpha");
    for (const n of r.data.results) {
      expect(projectOf(n.title)).toBe("alpha");
    }
  });

  it("unscoped (no project) returns the whole vault — cross-project by default", async () => {
    const r = await runQueryRanked(vault, "project map entry point", 10);
    const seen = new Set(r.data.results.map((n) => projectOf(n.title)));
    expect(seen.has("alpha")).toBe(true);
    expect(seen.has("beta")).toBe(true);
    expect(r.data.project_scope).toBeUndefined();
  });
});

describe("scoped retrieval (similar)", () => {
  it("hard-filters semantic results to the project", async () => {
    const r = await runQuerySimilar(vault, "animation curve timing", 10, undefined, undefined, "alpha");
    for (const n of r.data.results) {
      expect(projectOf(n.title), `leak: ${n.title}`).toBe("alpha");
    }
    expect(r.data.project_scope?.project).toBe("alpha");
  });
});

describe("scoped exploration (explore)", () => {
  it("filters RESULTS to the project while traversal ran globally", async () => {
    const r = await runExplore(vault, "animation curve timing composer", {
      limit: 10,
      project: "alpha",
      recursive: false,
    });
    for (const n of r.data.results) {
      expect(projectOf(n.title), `leak: ${n.title}`).toBe("alpha");
    }
    expect(r.data.project_scope?.project).toBe("alpha");
  });
});

describe("degenerate scopes", () => {
  it("an unknown project degrades to unscoped WITH a warning, never a silent empty answer", async () => {
    const r = await runQueryRanked(vault, "barometer drift", 10, undefined, undefined, undefined, undefined, undefined, "ghost");
    expect(r.data.results.length).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toContain("UNSCOPED");
    expect(r.data.project_scope).toBeUndefined();
  });
});
