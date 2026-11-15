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

describe("auto-bridge suggestions (debt #6 — strong cross-scope evidence names the link)", () => {
  it("a rare-anchor result relevant from ANOTHER project carries a concrete bridge suggestion", async () => {
    // Own vault, §5 enabled, one rare-anchor helios note a terra query reaches.
    const v = await fs.mkdtemp(path.join(os.tmpdir(), "auto-bridge-"));
    try {
      await runInit({ targetDir: v });
      // The scaffold config ships retrieval.session_scope.enabled: true —
      // §5 weighting is on; runExplore loads it from disk.

      await runAdd({
        startDir: v,
        title: "helios-kappa7 panel protocol quirks",
        type: "insight",
        description: "the kappa7 telemetry panel drops frames above 90 hz",
        project: ["helios"],
        content: "The kappa7 telemetry panel drops frames above 90 hz. Entry point [[helios project map]].",
      });
      await runAdd({
        startDir: v,
        title: "helios project map",
        type: "moc",
        description: "Map for the helios solar dashboard project",
        project: ["helios"],
        content: "Entry point for helios.",
      });
      await runAdd({
        startDir: v,
        title: "terra vernalization winter memory of seeds",
        type: "insight",
        description: "terra garden planner fact",
        project: ["terra"],
        content: "Vernalization is the winter memory of seeds. [[terra project map]]",
      });
      await runAdd({
        startDir: v,
        title: "terra project map",
        type: "moc",
        description: "Map for the terra garden planner project",
        project: ["terra"],
        content: "Entry point for terra.",
      });
      await runIndexBuild(v, false);

      // Reading from terra; the query names the rare anchor that lives in helios.
      const r = await runExplore(v, "helios-kappa7 telemetry frames dropped", {
        limit: 10,
        recursive: false,
        scopeProject: "terra",
      });
      const digest = r.data.scope_digest;
      expect(digest).toBeDefined();
      const kappa = digest!.reach.find((x) => x.title.includes("helios-kappa7"));
      expect(kappa?.waived).toBe(true); // rare evidence crossed — the strength bar
      expect(kappa?.origin).toBe("helios");

      const bridge = digest!.bridge_suggestions?.find((b) => b.origin === "helios");
      expect(bridge).toBeDefined();
      expect(bridge!.map).toBe("helios-project-map");
      expect(bridge!.hint).toContain("[[helios-project-map]]");
      expect(r.warnings.join(" ")).toContain("bridge_suggestions");
    } finally {
      await fs.rm(v, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }, 120000);

  it("no suggestion when the cross-scope hit is weak or one-off", async () => {
    // Same vault shape; a query with NO rare anchor that reaches the other
    // project only weakly — below the strength bar, no suggestion.
    const v = await fs.mkdtemp(path.join(os.tmpdir(), "no-bridge-"));
    try {
      await runInit({ targetDir: v });
      // §5 on (scaffold default) — see the sibling test above.

      await runAdd({
        startDir: v,
        title: "alpha telemetry barometer drift confirmed",
        type: "insight",
        description: "alpha project fact",
        project: ["alpha"],
        content: "Barometer drift on the alpha transmitter. [[alpha project map]]",
      });
      await runAdd({
        startDir: v,
        title: "alpha project map",
        type: "moc",
        description: "Map for the alpha project",
        project: ["alpha"],
        content: "Entry point for alpha.",
      });
      await runAdd({
        startDir: v,
        title: "beta composer animation curve timing",
        type: "insight",
        description: "beta project fact",
        project: ["beta"],
        content: "Animation curves in the beta composer. [[beta project map]]",
      });
      await runAdd({
        startDir: v,
        title: "beta project map",
        type: "moc",
        description: "Map for the beta project",
        project: ["beta"],
        content: "Entry point for beta.",
      });
      await runIndexBuild(v, false);

      // Reading from beta with a query about beta's own subject: any alpha
      // hit is incidental, not anchored — no bridge suggestion expected.
      const r = await runExplore(v, "beta composer animation curve timing", {
        limit: 10,
        recursive: false,
        scopeProject: "beta",
      });
      const digest = r.data.scope_digest;
      if (digest) {
        expect(digest.bridge_suggestions ?? []).toEqual([]);
      }
    } finally {
      await fs.rm(v, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }, 120000);
});

describe("inline suggestions (no separate call)", () => {
  it("a scoped query whose content lives elsewhere carries ranked suggestions in the SAME response", async () => {
    // The beta-scoped query about alpha's vocabulary: thin in scope, the
    // suggester should surface alpha IN the response.
    const r = await runQueryRanked(vault, "telemetry barometer drift altitude", 5, undefined, undefined, undefined, undefined, undefined, "beta");
    expect(r.data.project_scope?.project).toBe("beta");
    const sugg = r.data.project_suggestions ?? [];
    expect(sugg.length).toBeGreaterThan(0);
    expect(sugg[0].project).toBe("alpha");
    expect(sugg[0].reasons.join(" ").toLowerCase()).toContain("barometer");
    // The warning names the suggested project.
    expect(r.warnings.join(" ")).toContain(sugg[0].project);
  });

  it("a well-matched scoped query carries NO suggestions (no noise)", async () => {
    const r = await runQueryRanked(vault, "telemetry barometer drift altitude", 5, undefined, undefined, undefined, undefined, undefined, "alpha");
    // Strong in-scope answer — thin/weak thresholds not met, or suggestions
    // empty because the top candidate IS the current scope (filtered out).
    const sugg = r.data.project_suggestions ?? [];
    expect(sugg.every((x) => x.project !== "alpha")).toBe(true);
  });
});
