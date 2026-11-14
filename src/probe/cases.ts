/**
 * The probe case manifest — what "the product works as intended" means,
 * operationalized against the fixture vault.
 *
 * Two levels, by ruling (2026-11-14):
 *  - `hard` — the product must pass TODAY. A failure is a regression; the
 *    run exits nonzero. These guard shipped behavior.
 *  - `gate` — the spec §9 aspirations (dilution ≤ 5%, miss = 0). Reported as
 *    numbers, not required until the benchmark gate passes. These measure the
 *    disease so the Phase 2 cure can show its delta.
 */

export type ProbeLevel = "hard" | "gate";

export type RecallCase = {
  kind: "recall";
  query: string;
  /** Exact note titles that must appear within `topN` results. */
  expect: string[];
  /** Exact note titles that must NOT appear within `topN` results. */
  reject?: string[];
  topN: number;
  /** Optional project hard-filter on the answer set (traversal stays global). */
  project?: string;
};

export type WakeCase = {
  kind: "wake";
  /** Directory to wake from (a repo path bridged in the fixture config). */
  startDir: "repos/helios" | "repos/terra";
  project: string;
  /** This project's state must appear verbatim; the others' must not. */
  stateMarker: string;
  otherMarkers: string[];
};

export type BindCase = {
  kind: "bind";
  session: string;
  parent?: string;
  lineage?: "continues" | "branched_from";
  /** Frontmatter key expected in the written session record. */
  expectEdgeField?: string;
  expectEdgeValue?: string;
};

export type SupersedeCase = {
  kind: "supersede";
  /** Query that uniquely addresses the victim note. */
  matchQuery: string;
  /** Replacement body to write. */
  replacement: string;
  /** Query that used to hit the victim — must now miss it (or hit the new). */
  afterQuery: string;
  victimTitle: string;
};

export type ReleaseCase = {
  kind: "release";
  matchQuery: string;
  afterQuery: string;
  victimTitle: string;
};

export type DilutionCase = {
  kind: "dilution";
  /** The query's intended project — top-N results from others are noise. */
  intendedProject: string;
  query: string;
  topN: number;
};

export type LineageRetrievalCase = {
  kind: "lineage_retrieval";
  /** Session to bind as the query's scope (its record must exist). */
  session: string;
  query: string;
  /** Title that lineage adjacency should surface. */
  expect: string;
  topN: number;
  /** When true the case PASSES if the note is ABSENT from topN (the graph
   * must be honest: no lineage edge, no proximity gain). */
  expectAbsent?: boolean;
};

export type ProbeCase =
  | (RecallCase & CaseCommon)
  | (WakeCase & CaseCommon)
  | (BindCase & CaseCommon)
  | (SupersedeCase & CaseCommon)
  | (ReleaseCase & CaseCommon)
  | (DilutionCase & CaseCommon)
  | (LineageRetrievalCase & CaseCommon);

type CaseCommon = {
  id: string;
  level: ProbeLevel;
  /** One sentence a future reader can use to know what this guards. */
  stresses: string;
};

// The fixture's distinctive titles, named once so cases stay readable.
const HELIOS_LEAK = "helios memory leak on long dashboard sessions";
const TERRA_VERNALIZATION = "terra vernalization the winter memory of seeds";
const DELTADIFF = "helios the deltadiff method for config snapshots";
const KAPPA7 = "helios kappa7 panel protocol quirks";
const TTL_30S = "helios chart data caching with ttl";
const TTL_5S_OLD = "helios old five second chart cache";

export const PROBE_CASES: ProbeCase[] = [
  // ------------------------------------------------------------------
  // HARD — shipped behavior, regression-guarded.
  // ------------------------------------------------------------------
  {
    id: "recall-phantom-blend-gold-find",
    level: "hard",
    kind: "recall",
    query: "memory leak in the dashboard",
    expect: [HELIOS_LEAK],
    topN: 3,
    stresses:
      "A software 'memory leak' query finds the real helios leak note near the top, despite the fixture's vocabulary traps.",
  },
  {
    id: "recall-anchor-cross-scope",
    level: "hard",
    kind: "recall",
    query: "helios-kappa7 telemetry frames dropped",
    expect: [KAPPA7],
    topN: 3,
    stresses:
      "A rare-token anchor (helios-kappa7) surfaces its note regardless of scope — strong identifiers cross any boundary.",
  },
  {
    id: "recall-elegant-method-cross-project",
    level: "hard",
    kind: "recall",
    query: "how to diff two config snapshots without cosmetic reorder noise",
    expect: [DELTADIFF],
    topN: 5,
    stresses:
      "The elegant-method case: a method documented in helios must be findable by a caller who only knows the problem shape (spec §9: miss = 0).",
  },
  {
    id: "recall-stale-trap-replacement-only",
    level: "hard",
    kind: "recall",
    query: "chart data cache ttl",
    expect: [TTL_30S],
    reject: [TTL_5S_OLD],
    topN: 5,
    stresses:
      "A superseded note (the old 5s TTL) is excluded from retrieval; only the replacement surfaces.",
  },
  {
    id: "recall-garden-direction",
    level: "hard",
    kind: "recall",
    query: "how do seeds remember winter cold",
    expect: [TERRA_VERNALIZATION],
    topN: 3,
    stresses: "The garden direction: plant-memory questions find the vernalization note.",
  },
  {
    id: "wake-scoped-state-isolation",
    level: "hard",
    kind: "wake",
    startDir: "repos/helios",
    project: "helios",
    stateMarker: "fixture seed line for helios",
    otherMarkers: ["fixture seed line for terra", "fixture seed line for atlas"],
    stresses:
      "A scoped wake carries THIS project's standing state and none of the others' (contamination defense).",
  },
  {
    id: "bind-continues-edge-recorded",
    level: "hard",
    kind: "bind",
    session: "ses_probe_new",
    parent: "ses_probe_root",
    lineage: "continues",
    expectEdgeField: "continues",
    expectEdgeValue: "ses_probe_root",
    stresses:
      "Asserted lineage round-trips: binding a session as a continuation writes the edge into the session record (Phase 1).",
  },
  {
    id: "roundtrip-supersede-leaves-retrieval",
    level: "hard",
    kind: "supersede",
    matchQuery: "helios panel uptime report whole hours format",
    replacement:
      "The uptime report moved to a structured JSON format with explicit minute precision; support tooling was migrated in the same release.",
    afterQuery: "helios panel uptime report whole hours format",
    victimTitle: "helios panel uptime report format",
    stresses:
      "Operational round-trip: supersede a live note; the victim leaves retrieval and the replacement is findable.",
  },
  {
    id: "roundtrip-release-file-intact",
    level: "hard",
    kind: "release",
    matchQuery: "terra compost temperature turn day logging",
    afterQuery: "terra compost temperature turn day logging",
    victimTitle: "terra compost temperature logging",
    stresses:
      "Operational round-trip: release soft-evicts a note from retrieval while its file stays on disk (reversible).",
  },

  // ------------------------------------------------------------------
  // GATE — spec §9 aspirations, reported as numbers until the flip.
  // ------------------------------------------------------------------
  {
    id: "gate-dilution-phantom-blend",
    level: "gate",
    kind: "dilution",
    intendedProject: "helios",
    query: "memory leak in the dashboard",
    topN: 5,
    stresses:
      "The canonical dilution probe: the software leak query currently pulls terra's 'vernalization memory' into the top-5 (measured 20% in the baseline).",
  },
  {
    id: "gate-dilution-garden",
    level: "gate",
    kind: "dilution",
    intendedProject: "terra",
    query: "how do seeds remember winter cold",
    topN: 5,
    stresses: "Dilution in the garden direction: other-project notes inside the vernalization top-5.",
  },
  {
    id: "gate-lineage-child-reaches-root",
    level: "gate",
    kind: "lineage_retrieval",
    session: "ses_probe_child",
    query: "lantern backlight flicker pwm floor",
    expect: "lineage root session note the lantern backlight flicker",
    topN: 5,
    stresses:
      "§5 weighting: query from a continuation session should reach the root session's note via the lineage graph (M(n) = L(hops) × P).",
  },
  {
    id: "gate-lineage-unrelated-isolated",
    level: "gate",
    kind: "lineage_retrieval",
    session: "ses_probe_child",
    query: "lantern mode brightness stability pwm",
    expect: "lineage unrelated session note the terra misting schedule",
    topN: 5,
    expectAbsent: true,
    stresses:
      "The negative lineage case: a bound helios session must not drag the UNRELATED terra session's content into its results — no edge, no proximity gain. (The earlier draft queried the misting note by its own topic, which legitimately surfaced it — the trap is testing the graph with a query that matches without it.)",
  },
];
