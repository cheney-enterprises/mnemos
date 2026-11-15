/**
 * Unit tests for the §5 scope-distance weighting (scopeweight.ts), run
 * against the probe fixture — the same hostile-but-fair vault the probe
 * suite uses, so the ladder's semantics are pinned independently of the
 * end-to-end gate numbers.
 *
 * Pinned here: lineage BFS distances (own 0, continuation 1, sibling branch
 * 2, unrelated → floor), the full multiplier ladder read from the ACTIVE
 * config (constants are tunable — the tests must not hardcode yesterday's
 * numbers), cross-scope origin labeling (§6), and the anchor waiver's two
 * conditions (matcher match AND top-decile fused score — one alone is not
 * enough).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProbeVault } from "../../src/probe/fixture.js";
import { computeScopeWeights, type ScopeTrace } from "../../src/core/scopeweight.js";
import { loadConfig } from "../../src/core/config.js";

let vault: string;
let config: Awaited<ReturnType<typeof loadConfig>>;
let floor: number;
let pOther: number;

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-scope-unit-"));
  await buildProbeVault(vault);
  config = await loadConfig(path.join(vault, "mnemos.config.yaml"));
  // The fixture ships the flag off; the weighting needs it on + scope.
  config.retrieval.session_scope.enabled = true;
  floor = config.retrieval.session_scope.unlinked_floor ?? 0.8;
  pOther = config.retrieval.session_scope.other_scope_multiplier ?? 0.75;
}, 120000);

afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

const ROOT_NOTE = "lineage-root-session-note-the-lantern-backlight-flicker";
const BRANCH_NOTE = "lineage-branch-session-note-the-lantern-thermal-cap";
const UNRELATED_NOTE = "lineage-unrelated-session-note-the-terra-misting-schedule";
const KAPPA7 = "helios-kappa7-panel-protocol-quirks";
// A real unlinked fixture note (no lineage ownership, project helios).
const UNLINKED_HELIOS = "helios-dashboard-refresh-cadence";
// No textual overlap with the lantern notes and no rare tokens — the ladder
// must be observable without the waiver firing on top of it.
const NEUTRAL_QUERY = "gardening toolshed inventory paperwork";

async function weights(
  query: string,
  scope: { session?: string; project?: string },
  candidates: Array<{ title: string; score: number }>,
): Promise<Map<string, ScopeTrace>> {
  return computeScopeWeights({
    notesDir: path.join(vault, "notes"),
    sessionsDir: path.join(vault, "ops", "sessions"),
    query,
    scope,
    engineConfig: config.engine,
    candidates,
    constants: {
      decay: config.retrieval.session_scope.lineage_decay ?? 0.92,
      floor,
      other: pOther,
      waiveFloor: config.retrieval.session_scope.waive_floor ?? 0.95,
    },
  });
}

describe("§5 lineage BFS distances", () => {
  it("continuation root = hop 1, band lineage, decay applied", async () => {
    const traces = await weights(
      NEUTRAL_QUERY,
      { session: "ses_probe_child", project: "helios" },
      [{ title: ROOT_NOTE, score: 1.0 }],
    );
    const root = traces.get(ROOT_NOTE);
    expect(root?.hops).toBe(1);
    expect(root?.band).toBe("lineage");
    expect(root?.multiplier).toBeCloseTo(Math.pow(config.retrieval.session_scope.lineage_decay ?? 0.92, 1), 5);
  });

  it("the sibling branch is 2 hops from the child — decay compounds", async () => {
    const traces = await weights(
      NEUTRAL_QUERY,
      { session: "ses_probe_child", project: "helios" },
      [{ title: BRANCH_NOTE, score: 1.0 }],
    );
    const branch = traces.get(BRANCH_NOTE);
    expect(branch?.hops).toBe(2);
    expect(branch?.multiplier).toBeCloseTo(
      Math.pow(config.retrieval.session_scope.lineage_decay ?? 0.92, 2),
      5,
    );
  });

  it("the unrelated session's note: no hops, cross-scope — floor × P_other", async () => {
    const traces = await weights(
      NEUTRAL_QUERY,
      { session: "ses_probe_child", project: "helios" },
      [{ title: UNRELATED_NOTE, score: 1.0 }],
    );
    const unrelated = traces.get(UNRELATED_NOTE);
    expect(unrelated?.hops).toBeNull();
    expect(unrelated?.band).toBe("other");
    expect(unrelated?.multiplier).toBeCloseTo(floor * pOther, 5);
    expect(unrelated?.origin).toBe("terra");
  });

  it("unlinked same-project notes sit at the floor with band project", async () => {
    const traces = await weights(
      NEUTRAL_QUERY,
      { session: "ses_probe_child", project: "helios" },
      [{ title: UNLINKED_HELIOS, score: 1.0 }],
    );
    const t = traces.get(UNLINKED_HELIOS);
    expect(t?.hops).toBeNull();
    expect(t?.band).toBe("project");
    expect(t?.multiplier).toBeCloseTo(floor, 5);
  });
});

describe("§5 project band", () => {
  it("same project at the floor, other scope below it — even with no session bound", async () => {
    const candidates = [
      { title: ROOT_NOTE, score: 1.0 },
      { title: UNRELATED_NOTE, score: 1.0 },
    ];
    const heliosTraces = await weights("seeds winter cold", { project: "helios" }, candidates);
    expect(heliosTraces.get(ROOT_NOTE)?.multiplier).toBeCloseTo(floor, 5);
    expect(heliosTraces.get(UNRELATED_NOTE)?.multiplier).toBeCloseTo(floor * pOther, 5);
    expect(heliosTraces.get(UNRELATED_NOTE)?.origin).toBe("terra");

    const terraTraces = await weights("seeds winter cold", { project: "terra" }, candidates);
    expect(terraTraces.get(UNRELATED_NOTE)?.multiplier).toBeCloseTo(floor, 5);
    expect(terraTraces.get(ROOT_NOTE)?.multiplier).toBeCloseTo(floor * pOther, 5);
  });

  it("no scope at all → an empty trace map (weighting never guesses)", async () => {
    const traces = await weights("anything", {}, [{ title: ROOT_NOTE, score: 1.0 }]);
    expect(traces.size).toBe(0);
  });
});

describe("§5 anchor waiver — both conditions, or nothing", () => {
  it("a matched rare token in the top decile waives across scopes (reach band)", async () => {
    const traces = await weights(
      "helios-kappa7 telemetry frames dropped",
      { project: "terra" },
      [
        { title: KAPPA7, score: 0.9 }, // top decile of this tiny set
        { title: "terra-vernalization-the-winter-memory-of-seeds", score: 0.1 },
      ],
    );
    const kappa = traces.get(KAPPA7);
    expect(kappa?.waived).toBe(true);
    expect(kappa?.band).toBe("reach");
    expect(kappa?.multiplier).toBeGreaterThanOrEqual(config.retrieval.session_scope.waive_floor ?? 0.95);
    expect(kappa?.origin).toBe("helios");
  });

  it("a matched rare token OUTSIDE the top decile does not waive", async () => {
    const traces = await weights(
      "helios-kappa7 telemetry frames dropped",
      { project: "terra" },
      [
        { title: "terra-vernalization-the-winter-memory-of-seeds", score: 1.0 },
        { title: KAPPA7, score: 0.01 }, // bottom of the set
      ],
    );
    const kappa = traces.get(KAPPA7);
    // Matched by the matcher but not in the top decile → no waiver.
    expect(kappa?.waived).toBe(false);
    expect(kappa?.band).toBe("other");
  });

  it("top decile WITHOUT a matcher match does not waive (common words never cross)", async () => {
    const traces = await weights(
      "the and of a common words query",
      { project: "terra" },
      [{ title: "terra-vernalization-the-winter-memory-of-seeds", score: 1.0 }],
    );
    const v = traces.get("terra-vernalization-the-winter-memory-of-seeds");
    expect(v?.waived).toBe(false);
    expect(v?.band).toBe("project"); // same scope anyway — no penalty to waive
  });
});
