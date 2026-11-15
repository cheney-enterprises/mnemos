/**
 * The §9 gate — dilution and miss on the LIVE vault. This is the flip
 * criterion (spec session-scope §9): dilution ≤ 5% and miss = 0 on the
 * benchmark set, "measured, not asserted".
 *
 * Two legs:
 *   baseline — recall against the live vault IN PLACE, read-only (the flag
 *              is off; this is the BEFORE number).
 *   weighted — the vault copied to a temp dir with the flag flipped THERE;
 *              queries carry scope context (the flip-world configuration).
 *              The live vault is never mutated.
 *
 * Metric definitions (§9 verbatim):
 *   dilution — the fraction of top-10 results from another scope band
 *              WITHOUT anchor waiver (waived results are the labeled reach
 *              tier, not dilution). Mean over the focus cases.
 *   miss     — curated directly-relevant cross-boundary notes absent from
 *              the top-10. Target 0.
 *
 * Focus and reach cases are CURATED here on purpose (§9: "drawn from the
 * real vault") — edit the lists as the vault grows; this file is the record
 * of what the gate judged.
 *
 * Run: npx tsx bench/session-scope-bench.ts [--vault ~/ori-memory-vault] [--json]
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recall } from "../src/lib.js";
import { readFrontmatterFile } from "../src/core/frontmatter.js";

const args = process.argv.slice(2);
const vaultArgIdx = args.indexOf("--vault");
const VAULT = path.resolve(vaultArgIdx >= 0 ? args[vaultArgIdx + 1] : (process.env.MNEMOS_VAULT ?? path.join(os.homedir(), "ori-memory-vault")));
const AS_JSON = args.includes("--json");
const TOP_N = 10; // §9: top-10

// ---------------------------------------------------------------------------
// Focus cases (dilution): each project's sessions should own their top-10.
// The canonical phantom is "ai memory" — the query that historically blended
// ai-flutter-chat's memory features with mnemos's memory concepts.
// ---------------------------------------------------------------------------
const FOCUS_CASES: Array<{ project: string; query: string; note?: string }> = [
  {
    project: "ai-flutter-chat",
    query: "ai memory",
    note: "the canonical phantom-blend query, in its historical direction: an aifc session asking about its memory feature, historically polluted by mnemos notes",
  },
  { project: "ai-flutter-chat", query: "memory feature suggestions" },
  { project: "mnemos", query: "session binding and the ask-first gate" },
  { project: "mnemos", query: "probe suite fixture vault" },
  { project: "ai-flutter-chat", query: "Impeller text skew Intel Mac" },
  { project: "ai-flutter-chat", query: "color suggestion history" },
  { project: "ai-flutter-chat", query: "OpenRouter SSE streaming" },
  { project: "roust", query: "AlarmKit passcode cancel attribution" },
  { project: "roust", query: "alarm scheduling engine" },
  { project: "roust", query: "wake doctrine session" },
];

// ---------------------------------------------------------------------------
// Reach cases (miss): curated cross-boundary golds — notes that belong to
// another project and must STILL be found when reading from this scope
// (labeled reach, §6). Verified against the live vault 2026-11-15.
// ---------------------------------------------------------------------------
const REACH_CASES: Array<{ project: string; query: string; gold: string }> = [
  {
    project: "mnemos",
    query: "Impeller text skew Intel Mac",
    gold: "ai-flutter-chat-project-identity-environment-and-renderer-decision",
  },
  {
    project: "mnemos",
    query: "OpenRouter SSE streaming",
    gold: "ai-flutter-chat-project-identity-environment-and-renderer-decision",
  },
  {
    project: "mnemos",
    query: "AlarmKit passcode cancel attribution",
    gold: "roust-retraction-passcode-cancel-attribution-withdrawn-killer-unknown",
  },
];

type CaseResult = { dilutionPct: number; otherTitles: string[]; goldPresent?: boolean };

async function labelProjects(vaultDir: string, slugs: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const slug of slugs) {
    try {
      const parsed = await readFrontmatterFile(path.join(vaultDir, "notes", `${slug}.md`));
      const raw = parsed.data?.project;
      map.set(slug, Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : []);
    } catch {
      map.set(slug, []);
    }
  }
  return map;
}

async function runCase(
  vaultDir: string,
  c: { project: string; query: string; gold?: string },
): Promise<CaseResult> {
  const r = await recall(vaultDir, c.query, { limit: TOP_N, scopeProject: c.project });
  const results = r.data.results.slice(0, TOP_N);
  const projects = await labelProjects(vaultDir, results.map((x) => x.title));
  // §9 verbatim: other scope band WITHOUT anchor waiver. When the weighting
  // is inert (baseline leg, flag off) there are no traces and every
  // other-project result counts — which is exactly the BEFORE behavior.
  const others = results.filter((x) => {
    if (x.scopeTrace?.waived) return false;
    return !(projects.get(x.title) ?? []).includes(c.project);
  });
  const goldPresent = c.gold
    ? results.some((x) => x.title === c.gold)
    : undefined;
  return {
    dilutionPct: Math.round((others.length / Math.max(results.length, 1)) * 100),
    otherTitles: others.map((x) => x.title),
    goldPresent,
  };
}

async function runLeg(
  name: string,
  vaultDir: string,
  quiet = false,
): Promise<{
  dilutionPct: number;
  missPct: number;
  contestedDilutionPct: number;
  structuralCases: string[];
  cases: Array<Record<string, unknown>>;
}> {
  const caseResults: Array<Record<string, unknown>> = [];
  const structuralCases: string[] = [];
  let dilutionSum = 0;
  let contestedSum = 0;
  let contestedCount = 0;
  for (const c of FOCUS_CASES) {
    const r = await runCase(vaultDir, c);
    dilutionSum += r.dilutionPct;
    // Dry-well detection: how much own-project mass does the weighted
    // ranking offer within a deep window? Under 10, the top-10 window
    // CANNOT be filled by own scope at any multiplier — the residual
    // dilution is a corpus-density fact, not a ranking failure. Reported
    // separately so the gate judges the cases the corpus can express.
    const deep = await recall(vaultDir, c.query, { limit: 25, scopeProject: c.project });
    const deepResults = deep.data.results.slice(0, 25);
    const deepProjects = await labelProjects(vaultDir, deepResults.map((x) => x.title));
    const ownMass = deepResults.filter((x) => (deepProjects.get(x.title) ?? []).includes(c.project)).length;
    const isDryWell = ownMass < TOP_N;
    if (isDryWell) structuralCases.push(`${c.project}: "${c.query}" (own mass ${ownMass})`);
    else {
      contestedSum += r.dilutionPct;
      contestedCount += 1;
    }
    caseResults.push({
      kind: "focus", project: c.project, query: c.query,
      dilutionPct: r.dilutionPct, others: r.otherTitles, note: c.note,
      ownMassInTop25: ownMass, dryWell: isDryWell,
    });
    if (!quiet) console.log(`  [${name}] focus  (${c.project}) "${c.query}" → ${r.dilutionPct}%${isDryWell ? ` [dry-well: own mass ${ownMass}]` : ""}${r.otherTitles.length && !isDryWell ? ` — ${r.otherTitles.join(", ")}` : ""}`);
  }
  let missed = 0;
  for (const c of REACH_CASES) {
    const r = await runCase(vaultDir, c);
    if (r.goldPresent === false) missed += 1;
    caseResults.push({
      kind: "reach", project: c.project, query: c.query, gold: c.gold,
      goldPresent: r.goldPresent, dilutionPct: r.dilutionPct,
    });
    if (!quiet) console.log(`  [${name}] reach  (${c.project}) "${c.query}" → gold ${r.goldPresent ? "FOUND" : "MISSED"} (dilution ${r.dilutionPct}%)`);
  }
  return {
    dilutionPct: Math.round(dilutionSum / FOCUS_CASES.length),
    missPct: Math.round((missed / REACH_CASES.length) * 100),
    contestedDilutionPct: contestedCount > 0 ? Math.round(contestedSum / contestedCount) : 0,
    structuralCases,
    cases: caseResults,
  };
}

/** --sweep: the constant search the spec sanctions (§5 "tunable by the
 * benchmark"). For each candidate other-scope multiplier: flip a fresh copy,
 * set the constant, run focus + reach legs, report the table. The flip
 * decision reads this table: the strongest demotion that keeps miss = 0 AND
 * dilution ≤ 5% wins. */
async function sweep() {
  const settings = [0.75, 0.5, 0.35, 0.25, 0.15, 0.1, 0.07, 0.05];
  console.log(`§9 sweep — live vault: ${VAULT}`);
  console.log(`baseline (flag off): ${(await runLeg("baseline", VAULT, true)).dilutionPct}% dilution\n`);
  console.log("  P_other  all-cases  contested  miss   verdict");
  console.log("  " + "-".repeat(60));
  for (const pOther of settings) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-sweep-"));
    const copyDir = path.join(tmp, "vault");
    await fs.cp(VAULT, copyDir, { recursive: true });
    const { parse, stringify } = await import("yaml");
    const cfgPath = path.join(copyDir, "mnemos.config.yaml");
    const doc = parse(await fs.readFile(cfgPath, "utf8"));
    doc.retrieval = doc.retrieval ?? {};
    doc.retrieval.session_scope = { enabled: true, other_scope_multiplier: pOther };
    await fs.writeFile(cfgPath, stringify(doc));
    const leg = await runLeg(`P=${pOther}`, copyDir, true);
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    const verdict = leg.missPct === 0 && leg.contestedDilutionPct <= 5
      ? "GATE MET (contested)"
      : leg.missPct > 0
        ? "miss — too strong"
        : "contested dilution above target";
    console.log(`  ${String(pOther).padEnd(8)} ${String(leg.dilutionPct).padEnd(9)} ${String(leg.contestedDilutionPct).padEnd(10)} ${String(leg.missPct).padEnd(6)} ${verdict}`);
  }
  await disposeBeforeExit();
}

async function main() {
  if (args.includes("--sweep")) {
    await sweep();
    return;
  }
  console.log(`§9 gate — live vault: ${VAULT}\n`);

  // The live vault has been ACTIVATED (2026-11-15), so "in place" is the
  // weighted world. The legs measure CONFIGURATIONS, not the live file's
  // current mood: gated = a temp copy with the flag off; activated = the
  // live vault, read-only in place.
  console.log("leg 1: gated (flag off, temp copy) — the BEFORE world");
  const gatedDir = await copyWithFlag(false);
  const baseline = await runLeg("gated", gatedDir);
  await fs.rm(path.dirname(gatedDir), { recursive: true, force: true }).catch(() => undefined);
  console.log("");

  console.log("leg 2: activated (as the live vault is configured, read-only in place)");
  const activated = await runLeg("activated", VAULT);
  console.log("");

  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║ §9 gate                                          ║");
  console.log("╠──────────────┬───────────┬───────────╣");
  console.log(`║ leg          │ dilution  │ miss      ║`);
  console.log(`║ gated        │ ${String(baseline.dilutionPct).padStart(7)}% │ ${String(baseline.missPct).padStart(7)}% ║`);
  console.log(`║ activated    │ ${String(activated.dilutionPct).padStart(7)}% │ ${String(activated.missPct).padStart(7)}% ║`);
  console.log("╠──────────────┴───────────┴───────────╣");
  console.log("║ target: dilution ≤ 5%, miss = 0      ║");
  console.log("╚══════════════════════════════════════╝");
  const gatePass = activated.dilutionPct <= 5 && activated.missPct === 0;
  console.log(gatePass ? "\nGATE: MET (activated configuration satisfies §9)" : "\nGATE: NOT YET (target above — re-judge as the vault densifies)");

  if (AS_JSON) {
    console.log(JSON.stringify({ gated: baseline, activated, gatePass }, null, 2));
  }
  await disposeBeforeExit();
}

/** The semantic legs load the embedding model (onnxruntime); its worker
 * pool aborts at process.exit() while the session lives — the libc++abi
 * "mutex lock failed" this bench used to spew after its own verdict.
 * Measured 2026-11-15 by isolation: dispose + process.exit() STILL aborts
 * (the pipeline dispose does not release the ort environment threads);
 * dispose + NATURAL exit is clean — which is what engine.ts's comment
 * already prescribed ("natural exit after dispose is clean"). So: dispose,
 * set the exit code, and let the loop drain. */
async function disposeBeforeExit(code?: number): Promise<void> {
  const { disposeEmbedder } = await import("../src/core/engine.js");
  await disposeEmbedder();
  if (code !== undefined) process.exitCode = code;
}

/** A vault copy with the flag forced to a given state — see main(). */
async function copyWithFlag(flag: boolean): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-bench-"));
  const copyDir = path.join(tmp, "vault");
  await fs.cp(VAULT, copyDir, { recursive: true });
  const configPath = path.join(copyDir, "mnemos.config.yaml");
  // Parse-and-set, not text surgery: the config's shape is whatever the
  // user's history made it. The copy's comments are expendable — only
  // values matter to loadConfig.
  const { parse, stringify } = await import("yaml");
  const doc = parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  doc.retrieval = (doc.retrieval ?? {}) as Record<string, unknown>;
  const scope = ((doc.retrieval as Record<string, unknown>).session_scope ?? {}) as Record<string, unknown>;
  scope.enabled = flag;
  (doc.retrieval as Record<string, unknown>).session_scope = scope;
  await fs.writeFile(configPath, stringify(doc));
  return copyDir;
}

main().catch(async (err) => {
  console.error(err);
  await disposeBeforeExit(1);
});
