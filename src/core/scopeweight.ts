/**
 * Scope-distance weighting — spec session-scope §5 (the no-dilution
 * guarantee), flag-gated upstream (retrieval.session_scope.enabled).
 *
 *   M(n) = L(hops) × P
 *     L: own session 1.0; lineage-adjacent 0.92^hops; unlinked L_FLOOR (0.8)
 *     P: 1.0 same project; 0.75 other scope
 *
 * Applied POST-FUSION, PRE-TRIM: the multiplier reorders the candidate list
 * after fusion/PPR scoring and before the top-N cut. It never hard-filters —
 * the floor design (2026-11-15 decision log) keeps the unlinked mass at a
 * uniform 0.8, so rank order WITHIN the unlinked band is untouched; the
 * cross-scope band (0.8 × 0.75 = 0.6) is what must fall below own-scope
 * context, and lineage adjacency (0.92, 0.846…) is what rises above it.
 *
 * Anchor waiver (the no-miss guarantee): a candidate matched by the forget
 * matcher's anchoring machinery (the same IDF-weighted rare-token insight
 * that makes "Grace paella" an exact address) whose fused score sits in the
 * top decile gets its penalty waived (multiplier raised to ≥ 0.95) and
 * surfaces in the reach band, labeled with its origin. Rare evidence crosses
 * any boundary.
 *
 * Every result carries its scope trace: { band, hops, multiplier, waived }.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { readFrontmatterFile } from "./frontmatter.js";
import { slugify } from "./slug.js";
import { matchForForget, richTokens, type ForgetMatch } from "./forget.js";
import type { AnchorIndex } from "./anchortokens.js";
import type { EngineConfig } from "./config.js";

export const SCOPE_DECAY = 0.92;
export const SCOPE_FLOOR = 0.8;
export const SCOPE_OTHER = 0.75;
export const WAIVE_FLOOR = 0.95;

/** The §5 constants as configured — spec starting values by default, tunable
 * by the benchmark (config retrieval.session_scope.*; the measured baseline
 * showed the starting P cannot reorder real topical gaps, so the sweep in
 * bench/session-scope-bench.ts drives the flip decision). */
export type ScopeConstants = {
  decay: number;
  floor: number;
  other: number;
  waiveFloor: number;
  /** Pair-exclusivity cap (the "Grace paella" refinement): the waiver fires
   * on a token anchor only when the matched tokens' JOINT document frequency
   * is at most this — two words rare TOGETHER are an address; a pair shared
   * by many notes is a topic, and topics don't cross scopes. Identifier
   * anchors (anchor >= 2) are exempt — an identifier is an address at any
   * frequency. Default 3. */
  waiveJointDf: number;
};

export function scopeConstantsFrom(sessionScope: {
  lineage_decay?: number;
  unlinked_floor?: number;
  other_scope_multiplier?: number;
  waive_floor?: number;
  waive_joint_df?: number;
} | undefined): ScopeConstants {
  return {
    decay: sessionScope?.lineage_decay ?? SCOPE_DECAY,
    floor: sessionScope?.unlinked_floor ?? SCOPE_FLOOR,
    other: sessionScope?.other_scope_multiplier ?? SCOPE_OTHER,
    waiveFloor: sessionScope?.waive_floor ?? WAIVE_FLOOR,
    waiveJointDf: sessionScope?.waive_joint_df ?? 3,
  };
}

export type ScopeBand = "own" | "lineage" | "project" | "other" | "reach";

export type ScopeTrace = {
  band: ScopeBand;
  /** Lineage hops from the reading session; null when no lineage association. */
  hops: number | null;
  multiplier: number;
  waived: boolean;
  /** For cross-scope results: the note's own project — the "relevant from
   * roust" label (spec §6: tiered answers are labeled with origin). */
  origin?: string;
};

export type ReadingScope = {
  /** The bound session id, when the reader has one. */
  session?: string;
  /** The reader's project tag (from wake scoping or the caller). */
  project?: string;
};

export type ScopeWeightInput = {
  notesDir: string;
  sessionsDir: string;
  query: string;
  scope: ReadingScope;
  engineConfig: EngineConfig;
  /** The full candidate list with fused scores, pre-multiplier. */
  candidates: Array<{ title: string; score: number }>;
  /** §5 constants — defaults to the spec's starting values. */
  constants?: ScopeConstants;
  /** Store-backed anchor index (indexstore.ts storeAnchorInverted) — when
   * present, the waiver's anchor pass is answered by indexed lookup instead
   * of re-reading every note file per weighted query. The matcher's results
   * are identical either way; this is the named debt's fix, not a behavior
   * change. */
  anchorIndex?: AnchorIndex;
};

type SessionRecord = {
  id: string;
  edges: string[];
  linkedSlugs: Set<string>;
};

async function loadSessionGraph(sessionsDir: string): Promise<Map<string, SessionRecord>> {
  const graph = new Map<string, SessionRecord>();
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return graph; // no sessions yet — the weighting layer is a no-op
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const parsed = await readFrontmatterFile(path.join(sessionsDir, entry));
      const id = parsed.data?.session;
      if (typeof id !== "string" || id.trim() === "") continue;
      const edges: string[] = [];
      for (const key of ["continues", "branched_from"]) {
        const v = parsed.data?.[key];
        if (typeof v === "string" && v.trim() !== "") edges.push(v.trim());
      }
      // Session records reference the notes they wrote with [[wiki links]].
      const linked = new Set<string>();
      for (const m of parsed.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
        linked.add(slugify(m[1].trim()));
      }
      graph.set(id, { id, edges, linkedSlugs: linked });
    } catch {
      // A malformed session record must not break retrieval weighting.
    }
  }
  return graph;
}

/** BFS over lineage edges, undirected — a continuation reaches its root and
 * its siblings alike. */
function lineageDistances(graph: Map<string, SessionRecord>, from: string): Map<string, number> {
  const dist = new Map<string, number>([[from, 0]]);
  let frontier = [from];
  let h = 0;
  while (frontier.length > 0 && h < 32) {
    h += 1;
    const next: string[] = [];
    for (const id of frontier) {
      const record = graph.get(id);
      if (!record) continue;
      for (const edge of record.edges) {
        if (!dist.has(edge)) {
          dist.set(edge, h);
          next.push(edge);
        }
      }
      // Reverse edges: sessions whose edges point AT this session are also
      // lineage-adjacent (the root reaches its continuations).
      for (const [otherId, other] of graph) {
        if (!dist.has(otherId) && other.edges.includes(id)) {
          dist.set(otherId, h);
          next.push(otherId);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function projectsOf(data: Record<string, unknown> | null): string[] {
  const raw = data?.project;
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
  if (typeof raw === "string" && raw.trim() !== "") return [raw.trim()];
  return [];
}

export async function computeScopeWeights(
  input: ScopeWeightInput,
): Promise<Map<string, ScopeTrace>> {
  const out = new Map<string, ScopeTrace>();
  const { scope, candidates } = input;
  if (!scope.session && !scope.project) return out;
  if (candidates.length === 0) return out;

  const graph = await loadSessionGraph(input.sessionsDir);
  const dist = scope.session ? lineageDistances(graph, scope.session) : new Map<string, number>();

  // The reading session's project, when the caller didn't name one: the
  // majority project among the session's own linked notes.
  let readingProject = scope.project;
  if (!readingProject && scope.session) {
    const own = graph.get(scope.session);
    if (own && own.linkedSlugs.size > 0) {
      const tally = new Map<string, number>();
      for (const slug of own.linkedSlugs) {
        try {
          const parsed = await readFrontmatterFile(path.join(input.notesDir, `${slug}.md`));
          for (const p of projectsOf(parsed.data ?? null)) {
            tally.set(p, (tally.get(p) ?? 0) + 1);
          }
        } catch {
          // A linked note that no longer exists simply doesn't vote.
        }
      }
      let best: string | null = null;
      let bestCount = 0;
      for (const [p, n] of tally) {
        if (n > bestCount) {
          best = p;
          bestCount = n;
        }
      }
      readingProject = best ?? undefined;
    }
  }

  // Top-decile threshold over the fused (pre-multiplier) scores — the waiver
  // only lifts candidates whose relevance already earned it.
  const scores = candidates.map((c) => c.score).sort((a, b) => b - a);
  const decileIdx = Math.max(0, Math.floor((scores.length - 1) * 0.1));
  const decileThreshold = scores[decileIdx] ?? 0;

  // The anchor check reuses the forget matcher verbatim — its anchoring is
  // the load-bearing insight (IDF-weighted rare tokens, "Grace paella" as an
  // exact address). One matcher pass per query; the waiver then only fires
  // for candidates that both matched AND sit in the top decile.
  //
  // The pass is bounded two ways: anchorIndex serves the anchor phase from
  // the derived store (O(query), not O(vault) file reads), and onlySlugs
  // bounds the matcher's embedding stage to this candidate list — the waiver
  // never consumes matches outside it, and per-note similarity is
  // independent, so the intersected result is identical to an unrestricted
  // run while a hub-heavy query stops embedding half the vault.
  const anchoredMatches = new Map<string, ForgetMatch>();
  if (decileThreshold > 0) {
    try {
      const matches = await matchForForget(input.notesDir, input.query, input.engineConfig, {
        onlySlugs: new Set(candidates.map((c) => c.title)),
        anchorIndex: input.anchorIndex,
      });
      for (const m of matches) anchoredMatches.set(m.slug, m);
    } catch {
      // a matcher failure degrades to no waiver, never to no retrieval
    }
  }

  const frontmatterCache = new Map<string, Record<string, unknown> | null>();
  const K = input.constants ?? scopeConstantsFrom(undefined);
  const readFrontmatter = async (slug: string) => {
    if (!frontmatterCache.has(slug)) {
      try {
        const parsed = await readFrontmatterFile(path.join(input.notesDir, `${slug}.md`));
        frontmatterCache.set(slug, parsed.data ?? null);
      } catch {
        frontmatterCache.set(slug, null);
      }
    }
    return frontmatterCache.get(slug) ?? null;
  };

  for (const candidate of candidates) {
    const data = await readFrontmatter(candidate.title);
    const projects = projectsOf(data);
    const sameProject = readingProject ? projects.includes(readingProject) : true;

    // L: lineage gradient — 1.0 for the reading session's own notes, 0.92
    // per hop, the floor for everything the lineage graph doesn't know.
    let hops: number | null = null;
    let l = K.floor;
    if (scope.session) {
      let bestHops: number | undefined;
      for (const [sessionId, h] of dist) {
        if (h === 0) continue; // the reading session's own hops are handled below
        if (graph.get(sessionId)?.linkedSlugs.has(candidate.title)) {
          if (bestHops === undefined || h < bestHops) bestHops = h;
        }
      }
      if (bestHops !== undefined) {
        hops = bestHops;
        l = Math.pow(K.decay, bestHops);
      } else if (graph.get(scope.session)?.linkedSlugs.has(candidate.title)) {
        hops = 0;
        l = 1.0;
      }
    } else {
      // Project-scoped reading (no session): no lineage gradient to apply —
      // the project band carries the whole signal.
      l = K.floor;
    }

    const p = sameProject ? 1.0 : K.other;

    let band: ScopeBand;
    let multiplier = l * p;
    let waived = false;
    // The waiver's two conditions plus the pair-exclusivity refinement: a
    // match in the top decile waives when it is an ADDRESS — an identifier
    // hit (anchor >= 2) or a matched term set rare together (joint df ≤
    // the constant). A topic-shared pair ("session scope" across twenty
    // notes) matches the matcher but is not an address, and keeps its
    // band penalty.
    const anchoredMatch = anchoredMatches.get(candidate.title);
    const exclusive =
      anchoredMatch !== undefined &&
      (anchoredMatch.anchor >= 2 || anchoredMatch.jointDf <= K.waiveJointDf);
    if (anchoredMatch && exclusive && candidate.score >= decileThreshold) {
      waived = true;
      multiplier = Math.max(multiplier, K.waiveFloor);
      band = sameProject ? "project" : "reach";
    } else if (hops === 0) {
      band = "own";
    } else if (hops !== null) {
      band = "lineage";
    } else {
      band = sameProject ? "project" : "other";
    }

    const trace: ScopeTrace = { band, hops, multiplier, waived };
    // §6: cross-scope results carry their origin — "relevant from roust".
    if (!sameProject && projects.length > 0) trace.origin = projects[0];
    out.set(candidate.title, trace);
  }
  return out;
}

/** Rare-token helper re-exported for callers that want the raw view. */
export { richTokens };
