/**
 * The CLI's human rendering contract (debt: "help is supposed to be
 * helpful" — and so is the output). Every read/diagnostic verb renders for
 * humans by default with --json preserved. These pin the formatters:
 * verdicts that say "none" explicitly (silence in a diagnostic is a field
 * you'd otherwise have to check the JSON for), previews that are never a
 * heading, and refusals that keep their structure.
 */
import { describe, it, expect } from "vitest";
import { formatStatus } from "../../src/cli/status.js";
import { formatHealth, formatDoctorExtras } from "../../src/cli/health.js";
import { formatQuery } from "../../src/cli/query.js";
import { formatValidate } from "../../src/cli/validate.js";
import { formatGraphMetrics } from "../../src/cli/graphcmd.js";
import { formatPrune } from "../../src/cli/prune.js";
import { formatIndexStatus } from "../../src/cli/indexcmd.js";
import { formatForgetPreview } from "../../src/cli/forget.js";
import { formatRankedRows, bulletList } from "../../src/cli/render.js";

describe("formatStatus", () => {
  it("renders the counts and clients as lines, not a wire dump", () => {
    const out = formatStatus({
      vaultRoot: "/v", noteCount: 88, inboxCount: 0, orphanCount: 36,
      clients_registered: [{ client: "opencode", scope: "global", vault: "/v" }],
      next_steps: ["Registered clients: opencode (global)."],
    });
    expect(out).toContain("Vault:   /v");
    expect(out).toContain("Notes:   88   Inbox: 0   Orphans: 36");
    expect(out).toContain("Clients: opencode (global)");
    expect(out).toContain("Next:    Registered clients");
  });
});

describe("formatHealth / formatDoctorExtras", () => {
  it("empty sections say none explicitly; learning renders as one line", () => {
    const out = formatHealth(
      {
        noteCount: 88, orphanCount: 0, danglingCount: 0, orphans: [], dangling: [],
        schemaViolations: [], fading: [],
        learning: { trackedNotes: 62, totalUpdates: 16, forwardCitations: 0, exposureQCorrelation: 0.21 },
      },
      [],
    );
    expect(out).toContain("Vault health — 88 notes");
    expect(out).toContain("Orphans (0):\n  none");
    expect(out).toContain("Dangling links (0):\n  none");
    expect(out).toContain("Learning: 62 tracked · 16 updates · 0 forward citations · exposure/Q corr 0.21");
  });

  it("violations and warnings render with their detail", () => {
    const out = formatHealth(
      {
        noteCount: 2, orphanCount: 0, danglingCount: 1, orphans: [], dangling: ["missing-note"],
        schemaViolations: [{ note: "bad-note", errors: ["missing description"] }],
        fading: [{ note: "old-note", vitality: 0.12 }],
      },
      ["something is off"],
    );
    expect(out).toContain("bad-note: missing description");
    expect(out).toContain("- old-note (vitality 0.120)");
    expect(out).toContain("⚠ something is off");
  });

  it("the doctor extras name locks, coverage, migration, and config", () => {
    const out = formatDoctorExtras({
      doctor: {
        locks: [{ slug: "stale", ageSeconds: 3600 }],
        indexDrift: { indexExists: true, vaultNotes: 88, indexedNotes: 87, coverage: "DRIFT: 87/88 notes covered", longsMarker: true, embeddingsRows: 79, longRows: 2375 },
        configSanity: {
          projectPaths: { total: 3, unresolvable: 0 },
          sessionScope: { enabled: true, invalidConstants: [] },
          dbPath: "/v/.mnemos/embeddings.db",
        },
      },
    });
    expect(out).toContain("Locks: stale (3600s)");
    expect(out).toContain("DRIFT: 87/88 notes covered");
    expect(out).toContain("longs 2375 · migration ok");
    expect(out).toContain("project paths 3 (0 unresolvable)");
    expect(out).toContain("§5 constants ok");
  });
});

describe("formatQuery", () => {
  it("orphans: empty says why it is good news; non-empty wraps as bullets", () => {
    expect(formatQuery("orphans", { orphans: [] })).toContain("every note is linked from somewhere");
    const out = formatQuery("orphans", { orphans: ["a", "b"] });
    expect(out).toContain("Orphans (2) — notes nothing links to:");
    expect(out).toContain("- a, b");
  });

  it("important and fading render scores", () => {
    const imp = formatQuery("important", { results: [{ title: "index", score: 0.0277 }] });
    expect(imp).toContain("1. index  (0.028)");
    const fade = formatQuery("fading", { results: [{ title: "old", score: 0.25 }] });
    expect(fade).toContain("1. old  (vitality 0.250)");
  });
});

describe("formatRankedRows", () => {
  it("rank, score, §6 origin, and a description line that is never a heading", () => {
    const lines = formatRankedRows([
      {
        title: "some-note", score: 0.4567,
        snippet: { description: "A useful description." },
        scopeTrace: { band: "reach", origin: "roust", waived: true },
      },
      { title: "plain", score: 0.1, snippet: { preview: "# A heading first\nBody line." } },
    ]);
    expect(lines[0]).toContain("1. some-note  (0.457 · from roust (waived))");
    expect(lines[1]).toContain("A useful description.");
    // The heading never leaks as the description.
    expect(lines[3]).toContain("Body line.");
    expect(lines[3]).not.toContain("# A heading");
  });

  it("a COLLAPSED single-line preview that begins with '# Title' still renders — hashes stripped, not skipped", () => {
    // search.ts's ranked rows carry exactly this shape: one line, heading
    // prefix, body inline. Skipping every # line returned EMPTY here.
    const lines = formatRankedRows([
      { title: "x", score: 0.5, metadata: { preview: "# The evening pivot Tonight Eric blessed a direction" } },
    ]);
    expect(lines[1]).toContain("The evening pivot Tonight Eric blessed a direction");
    expect(lines[1]).not.toContain("#");
  });
});

describe("formatValidate", () => {
  it("a verdict, then the details", () => {
    expect(formatValidate("notes/x.md", { success: true, errors: [], warnings: [] }))
      .toBe("✓ notes/x.md — valid");
    const out = formatValidate("notes/x.md", { success: false, errors: ["missing description"], warnings: [] });
    expect(out).toContain("✗ notes/x.md — 1 schema violation(s):");
    expect(out).toContain("error: missing description");
  });
});

describe("formatGraphMetrics", () => {
  it("counts first, then the two ranked lists", () => {
    const out = formatGraphMetrics({
      nodeCount: 89, edgeCount: 179, communityCount: 8, bridgeCount: 21,
      topPageRank: [{ title: "map", score: 0.198 }],
      topBetweenness: [{ title: "map", score: 0.314 }],
    });
    expect(out).toContain("Graph: 89 notes · 179 edges · 8 communities · 21 bridges");
    expect(out).toContain("1. map  (0.198)");
    expect(out).toContain("Top betweenness");
  });
});

describe("formatPrune", () => {
  const data = {
    zones: { active: 78, stale: 5, fading: 5, archived: 0 },
    total: 88,
    articulationPoints: ["hub"],
    candidates: [{ title: "old", vitality: 0.25, zone: "fading" as const, isArticulationPoint: false, inDegree: 0, community: 1, reason: "vitality in fading zone (0.1–0.3)" }],
    applied: false,
    archivedCount: 0,
    hotspots: [{ community: 1, size: 3, meanVitality: 0.9, topMembers: ["a", "b", "c"] }],
  };
  it("dry-run is labeled; candidates carry their reason; articulation points are guarded", () => {
    const out = formatPrune(data);
    expect(out).toContain("dry run (--apply to execute)");
    expect(out).toContain("- old  (vitality 0.250, zone fading)");
    expect(out).toContain("vitality in fading zone");
    expect(out).toContain("Articulation points (1)");
  });
  it("--verbose adds the community hotspots", () => {
    const out = formatPrune(data, true);
    expect(out).toContain("Communities (1)");
    expect(out).toContain("#1 — 3 notes, mean vitality 0.900");
  });
});

describe("formatIndexStatus", () => {
  it("missing index says what to run; present index renders counts and size", () => {
    expect(formatIndexStatus({ exists: false, model: "Xenova/all-MiniLM-L6-v2" }))
      .toContain("Index: none — run mnemos index build");
    const out = formatIndexStatus({
      exists: true, noteCount: 80, model: "Xenova/all-MiniLM-L6-v2",
      dbSizeBytes: 2375680, meta: { built_at: "2026-11-14T21:46:38.027Z" },
    });
    expect(out).toContain("Index: 80 notes · model Xenova/all-MiniLM-L6-v2 · 2.3 MB");
    expect(out).toContain("Built: 2026-11-14 21:46:38");
  });
});

describe("formatForgetPreview", () => {
  it("a dry run is labeled and names what would be touched, with why", () => {
    const out = formatForgetPreview({
      op: "release", query: "grace paella preferences", apply: false,
      matched: [{ slug: "grace", anchor: 4.2, similarity: 0.71 }],
    });
    expect(out).toContain('release (DRY RUN — pass --apply to execute): "grace paella preferences"');
    expect(out).toContain("- grace  (anchor 4.20, similarity 0.710)");
  });
  it("no matches says so", () => {
    expect(formatForgetPreview({ op: "release", query: "q", apply: false, matched: [] }))
      .toContain("no notes matched.");
  });
});

describe("bulletList", () => {
  it("wraps long lists across lines instead of one unbroken slug wall", () => {
    const items = Array.from({ length: 40 }, (_, i) => `slug-number-${i}`);
    const lines = bulletList(items);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(102);
      expect(line.startsWith("  - ")).toBe(true);
    }
  });
});
