/**
 * The probe runner — measures whether the shipped product actually behaves
 * as intended on a hostile-but-fair fixture vault (Eric's ruling, 2026-11-14:
 * operational tests must be runnable by ANYONE who installs mnemos — no
 * dependence on any user's live vault).
 *
 * Shape: build the fixture twice in a temp directory (flag off / flag on),
 * run the case manifest through the same library entries a client goes
 * through (recall, runWake, supersede, release), and report per-case results
 * plus the two §9 headline numbers. Hard-case failures exit nonzero at the
 * CLI layer; gate cases are numbers by design until the flip.
 *
 * Black-box principle: every case observes only what surfaces — recall
 * results, wake payloads, and the files the product itself writes. No case
 * reads internal ranking state.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProbeVault } from "./fixture.js";
import { PROBE_CASES, type ProbeCase, type ProbeLevel } from "./cases.js";
import { recall } from "../lib.js";
import { runWake } from "../cli/wake.js";
import { supersede, release } from "../core/forget.js";
import { loadConfig } from "../core/config.js";
import { getVaultPaths } from "../core/vault.js";
import { readFrontmatterFile, writeFrontmatterFile } from "../core/frontmatter.js";

// The noteindex keys results by slug (the markdown filename). Fixture titles
// are prose; compare in slug space with the same rule the fixture uses to
// name files.
function toSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
}

export type ProbeCaseResult = {
  id: string;
  level: ProbeLevel;
  kind: ProbeCase["kind"];
  stresses: string;
  /** null when the case reports a number rather than pass/fail (gate). */
  passed: boolean | null;
  detail: string;
  /** Gate metrics: dilution % for dilution cases, 0/100 for lineage misses. */
  value?: number;
};

export type ProbeReport = {
  fixture: { notes: number; sessions: number };
  cases: ProbeCaseResult[];
  headline: {
    hard_passed: number;
    hard_total: number;
    hard_all_passed: boolean;
    /** Mean other-project fraction inside top-N across dilution cases. */
    gate_dilution_pct: number;
    /** % of gate expect-cases where the target missed top-N (§9: target 0). */
    gate_miss_pct: number;
  };
};

export type ProbeOptions = {
  /** Run only one level (default: all). */
  level?: ProbeLevel | "all";
  /** Run a single case by id (for debugging one probe). */
  only?: string;
  /** Keep the temp fixture copies for inspection. */
  keep?: boolean;
};

async function runRecallCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "recall" }>,
): Promise<ProbeCaseResult> {
  const result = await recall(vaultDir, c.query, { limit: c.topN, project: c.project });
  const titles = result.data.results.map((r) => r.title);
  const missing = c.expect.map(toSlug).filter((e) => !titles.slice(0, c.topN).includes(e));
  const leaked = (c.reject ?? []).map(toSlug).filter((r) => titles.slice(0, c.topN).includes(r));
  const passed = missing.length === 0 && leaked.length === 0;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing from top-${c.topN}: ${missing.join(", ")}`);
  if (leaked.length > 0) parts.push(`must-not-find leaked in: ${leaked.join(", ")}`);
  return {
    id: c.id,
    level: c.level,
    kind: c.kind,
    stresses: c.stresses,
    passed,
    detail: passed
      ? `top-${Math.min(c.topN, titles.length)}: ${titles.slice(0, c.topN).join(" | ")}`
      : parts.join("; ") + ` — got: ${titles.slice(0, c.topN).join(" | ")}`,
  };
}

async function runWakeCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "wake" }>,
): Promise<ProbeCaseResult> {
  const startDir = path.join(vaultDir, c.startDir);
  const result = await runWake(startDir, 200, c.project);
  if (!result.success || !result.projectWake || result.projectWake.project !== c.project) {
    return {
      id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
      detail: `wake did not scope to ${c.project} (got ${result.projectWake?.project ?? "nothing"})`,
    };
  }
  const text = result.lines.join("\n");
  const hasState = text.includes(c.stateMarker);
  const leaked = c.otherMarkers.filter((m) => text.includes(m));
  const passed = hasState && leaked.length === 0;
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed,
    detail: passed
      ? `scoped to ${c.project}; own state present, others absent`
      : hasState
        ? `other-project state leaked into the wake: ${leaked.join(", ")}`
        : `own state marker not found in the wake payload`,
  };
}

async function runBindCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "bind" }>,
): Promise<ProbeCaseResult> {
  const result = await runWake(vaultDir, 200, "helios", undefined, false, {
    session: c.session,
    parent: c.parent,
    lineage: c.lineage,
  });
  // Wake contract: session_binding is Omit<SessionBinding, "enabled"> — the
  // field's PRESENCE is the enabled signal (absent entirely when flag off).
  const binding = (result as unknown as { session_binding?: { id?: string } }).session_binding;
  if (!binding || binding.id !== c.session) {
    return {
      id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
      detail: `session_binding missing or wrong id: ${JSON.stringify(binding)}`,
    };
  }
  // The operational check: the record the product wrote carries the edge.
  // Session record FILENAMES are slugified (slugify deletes underscores —
  // ses_probe_new lands as sesprobenew.md); the raw id lives in frontmatter.
  const recordPath = path.join(getVaultPaths(vaultDir).ops, "sessions", `${toSlug(c.session)}.md`);
  let parsed: { data: Record<string, unknown> | null };
  try {
    parsed = await readFrontmatterFile(recordPath);
  } catch {
    return {
      id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
      detail: `session record not written: ${recordPath}`,
    };
  }
  const edge = c.expectEdgeField ? parsed.data?.[c.expectEdgeField] : undefined;
  const passed = c.expectEdgeValue === undefined || edge === c.expectEdgeValue;
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed,
    detail: passed
      ? `record written with ${c.expectEdgeField}: ${edge}`
      : `edge mismatch: expected ${c.expectEdgeField}: ${c.expectEdgeValue}, got ${String(edge)}`,
  };
}

async function runSupersedeCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "supersede" }>,
): Promise<ProbeCaseResult> {
  const paths = getVaultPaths(vaultDir);
  const config = await loadConfig(paths.config);
  const before = await recall(vaultDir, c.matchQuery, { limit: 5 });
  const wasThere = before.data.results.slice(0, 5).some((r) => r.title === toSlug(c.victimTitle));
  if (!wasThere) {
    return {
      id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
      detail: `precondition failed: victim "${c.victimTitle}" not in top-5 before the supersede`,
    };
  }
  await supersede(paths.notes, c.matchQuery, c.replacement, config.engine, async (slug, text, fm) => {
    await writeFrontmatterFile(path.join(paths.notes, `${slug}.md`), fm, text);
  }, { apply: true });
  // The markdown is the truth — recall re-syncs the index on the next call.
  const after = await recall(vaultDir, c.afterQuery, { limit: 5 });
  const victimGone = !after.data.results.slice(0, 5).some((r) => r.title === toSlug(c.victimTitle));
  const replacement = after.data.results.slice(0, 5).some((r) => r.title.startsWith("the-uptime-report") || r.title.includes("uptime"));
  // The victim file must still exist, status superseded (soft, reversible).
  let fileIntact = false;
  try {
    const entries = await fs.readdir(paths.notes);
    const match = entries.find((e) => e.startsWith(toSlug(c.victimTitle)));
    if (match) {
      const parsed = await readFrontmatterFile(path.join(paths.notes, match));
      fileIntact = parsed.data?.status === "superseded";
    }
  } catch { /* stays false */ }
  const passed = victimGone && replacement && fileIntact;
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed,
    detail: passed
      ? "victim left retrieval, replacement surfaced, file intact with status superseded"
      : `victimGone=${victimGone} replacementSurfaced=${replacement} fileIntact=${fileIntact}`,
  };
}

async function runReleaseCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "release" }>,
): Promise<ProbeCaseResult> {
  const paths = getVaultPaths(vaultDir);
  const config = await loadConfig(paths.config);
  const before = await recall(vaultDir, c.matchQuery, { limit: 5 });
  const wasThere = before.data.results.slice(0, 5).some((r) => r.title === toSlug(c.victimTitle));
  if (!wasThere) {
    return {
      id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
      detail: `precondition failed: victim "${c.victimTitle}" not in top-5 before the release`,
    };
  }
  await release(paths.notes, c.matchQuery, config.engine, { apply: true });
  const after = await recall(vaultDir, c.afterQuery, { limit: 5 });
  const gone = !after.data.results.slice(0, 5).some((r) => r.title === toSlug(c.victimTitle));
  let fileIntact = false;
  try {
    const entries = await fs.readdir(paths.notes);
    const match = entries.find((e) => e.startsWith(toSlug(c.victimTitle)));
    if (match) {
      const parsed = await readFrontmatterFile(path.join(paths.notes, match));
      fileIntact = parsed.data?.status === "released";
    }
  } catch { /* stays false */ }
  const passed = gone && fileIntact;
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed,
    detail: passed
      ? "released note left retrieval; file intact with status released"
      : `goneFromRetrieval=${gone} fileIntact=${fileIntact}`,
  };
}

/**
 * Dilution: fraction of the top-N that belongs to another project. The
 * fixture's convention makes project membership decidable from the result
 * alone: every fixture note title carries its project as the first word —
 * except the lineage session notes, which their owning project filed (and
 * which these queries do not pull). This is a fixture property, not a
 * product assumption.
 */
async function runDilutionCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "dilution" }>,
): Promise<ProbeCaseResult> {
  const result = await recall(vaultDir, c.query, { limit: c.topN });
  const results = result.data.results.slice(0, c.topN);
  const noise = results.filter((r) => !r.title.startsWith(`${c.intendedProject}-`));
  const pct = Math.round((noise.length / Math.max(results.length, 1)) * 100);
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: null,
    value: pct,
    detail: `${noise.length}/${results.length} of top-${c.topN} are other-project (${pct}%): ${noise.map((n) => n.title).join(", ") || "none"}`,
  };
}

async function runLineageCase(
  vaultDir: string,
  c: Extract<ProbeCase, { kind: "lineage_retrieval" }>,
): Promise<ProbeCaseResult> {
  const result = await recall(vaultDir, c.query, { limit: c.topN });
  const titles = result.data.results.slice(0, c.topN).map((r) => r.title);
  const found = titles.includes(toSlug(c.expect));
  const passed = c.expectAbsent ? !found : found;
  const value: number | undefined = c.expectAbsent ? undefined : found ? 0 : 100;
  return {
    id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed, value,
    detail: passed
      ? c.expectAbsent
        ? "unrelated session's note stayed out of top-N (graph is honest)"
        : "lineage-adjacent note surfaced in top-N"
      : c.expectAbsent
        ? `unrelated note leaked into top-N: ${titles.join(" | ")}`
        : `target absent from top-N: ${titles.join(" | ")}`,
  };
}

async function runOneCase(vaultDir: string, c: ProbeCase): Promise<ProbeCaseResult> {
  switch (c.kind) {
    case "recall": return runRecallCase(vaultDir, c);
    case "wake": return runWakeCase(vaultDir, c);
    case "bind": return runBindCase(vaultDir, c);
    case "supersede": return runSupersedeCase(vaultDir, c);
    case "release": return runReleaseCase(vaultDir, c);
    case "dilution": return runDilutionCase(vaultDir, c);
    case "lineage_retrieval": return runLineageCase(vaultDir, c);
  }
}

/**
 * Flip `retrieval.session_scope.enabled` in the copy's config — with a
 * parse-assertion after (a mis-indented YAML child once parsed as a sibling
 * and silently stayed off; generated configs are verified, never trusted).
 */
async function flipSessionScope(vaultDir: string): Promise<void> {
  const configPath = path.join(vaultDir, "mnemos.config.yaml");
  const raw = await fs.readFile(configPath, "utf8");
  const flipped = raw.replace("enabled: false", "enabled: true");
  if (flipped === raw) throw new Error("probe: could not flip session_scope flag in the fixture config");
  await fs.writeFile(configPath, flipped);
  const config = await loadConfig(configPath);
  if (config.retrieval.session_scope.enabled !== true) {
    throw new Error("probe: session_scope flag flip did not parse (still disabled after loadConfig)");
  }
}

export async function runProbe(options: ProbeOptions = {}): Promise<ProbeReport> {
  const level = options.level ?? "all";
  const cases = PROBE_CASES.filter(
    (c) => (options.only ? c.id === options.only : true) && (level === "all" || c.level === level),
  );

  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-probe-"));
  const offDir = path.join(base, "flag-off");
  const onDir = path.join(base, "flag-on");
  try {
    const fixture = await buildProbeVault(offDir);
    await buildProbeVault(onDir);
    await flipSessionScope(onDir);

    const results: ProbeCaseResult[] = [];
    for (const c of cases) {
      // Hard recall/wake/round-trip cases measure shipped flag-off behavior;
      // bind and all gate cases run in the flag-on copy (bindSession is
      // flag-gated; the gate metrics judge the configuration the flip will
      // enable).
      const needsFlag = c.kind === "bind" || c.level === "gate";
      const dir = needsFlag ? onDir : offDir;
      try {
        results.push(await runOneCase(dir, c));
      } catch (err) {
        results.push({
          id: c.id, level: c.level, kind: c.kind, stresses: c.stresses, passed: false,
          detail: `probe case threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const hard = results.filter((r) => r.level === "hard");
    const dilution = results.filter((r) => r.kind === "dilution" && r.value !== undefined);
    const missCases = results.filter(
      (r) => r.kind === "lineage_retrieval" && r.value !== undefined,
    );
    const gateDilution = dilution.length
      ? Math.round(dilution.reduce((s, r) => s + (r.value ?? 0), 0) / dilution.length)
      : 0;
    const gateMiss = missCases.length
      ? Math.round(missCases.reduce((s, r) => s + (r.value ?? 0), 0) / missCases.length)
      : 0;

    return {
      fixture: { notes: fixture.notes, sessions: fixture.sessions },
      cases: results,
      headline: {
        hard_passed: hard.filter((r) => r.passed === true).length,
        hard_total: hard.length,
        hard_all_passed: hard.length > 0 && hard.every((r) => r.passed === true),
        gate_dilution_pct: gateDilution,
        gate_miss_pct: gateMiss,
      },
    };
  } finally {
    if (!options.keep) {
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
    } else {
      process.stderr.write(`probe: fixture copies kept at ${base}\n`);
    }
  }
}
