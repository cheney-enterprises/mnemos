import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { bulletList, plural, score as fmtScore } from "./render.js";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import {
  buildGraph,
  findDanglingLinks,
  findOrphans,
  type LinkGraph,
} from "../core/graph.js";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { validateNoteAgainstSchema } from "../core/schema.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { computeVitality } from "../core/vitality.js";
import { initDB } from "../core/engine.js";
import { getLearningHealth, migrateRuleColumn } from "../core/qvalue.js";
import { llmKeyProblem } from "../core/llm.js";
import { TEMPLATE_PLACEHOLDER_LINKS } from "../core/promote.js";
import { slugify } from "../core/slug.js";

export type HealthResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runHealth(
  startDir: string,
  linkGraph?: LinkGraph,
): Promise<HealthResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const allNotes = await listNoteTitles(paths.notes);
  const graph = linkGraph ?? await buildGraph(paths.notes);
  const orphans = findOrphans(graph, allNotes);
  const dangling = findDanglingLinks(graph, allNotes);

  // #38: name the cause and the notes instead of leaving mystery dangling
  // links. Notes are the user's; health explains, it does not edit them.
  const placeholderSlugs = new Set(TEMPLATE_PLACEHOLDER_LINKS.map((t) => slugify(t)));
  const templateWarnings: string[] = [];
  for (const d of dangling) {
    if (!placeholderSlugs.has(slugify(d))) continue;
    const sources = [...(graph.incoming.get(d) ?? [])].sort();
    const shown = sources.slice(0, 10).join(", ");
    const more = sources.length > 10 ? ` and ${sources.length - 10} more` : "";
    templateWarnings.push(
      `[[${d}]] is likely a placeholder link from an older version of the note template, not a ` +
        `missing note. Found in ${sources.length} note(s): ${shown}${more}. If you did not write it, ` +
        "delete that link line (and from templates/note.md if it is still there). New notes no longer get it.",
    );
  }

  const schemaViolations: { note: string; errors: string[] }[] = [];
  const fading: { note: string; vitality: number }[] = [];

  for (const note of allNotes) {
    const filePath = path.join(paths.notes, `${note}.md`);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    const type =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)["type"]
        : null;

    const templatePath = resolveTemplatePath(
      config,
      vaultRoot,
      typeof type === "string" ? type : null
    );
    const validation = await validateNoteAgainstSchema(filePath, templatePath);
    if (!validation.valid) {
      schemaViolations.push({ note, errors: validation.errors });
    }

    const dataObj =
      parsed.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : null;
    const lastAccessedRaw =
      typeof dataObj?.["last_accessed"] === "string"
        ? dataObj["last_accessed"]
        : typeof dataObj?.["created"] === "string"
          ? dataObj["created"]
          : null;
    if (typeof lastAccessedRaw === "string") {
      const last = new Date(lastAccessedRaw);
      if (!isNaN(last.getTime())) {
        const decayDays =
          typeof type === "string" && config.vitality.decay[type]
            ? config.vitality.decay[type]
            : 30;
        const vitality = computeVitality(
          { base: config.vitality.base, decayDays },
          last,
          new Date()
        );
        if (vitality < 0.2) {
          fading.push({ note, vitality });
        }
      }
    }
  }

  // Learning-signal health. Added 2026-08-28: a per-query reward proxy ran for
  // five months and inverted every Q-value, and nothing in `mnemos health` would
  // have shown it. These four numbers are the ones that would have.
  let learning: Record<string, unknown> | undefined;
  const learningWarnings: string[] = [];
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  try {
    await fs.access(dbPath);
    const db = initDB(dbPath);
    try {
      // health can be the first command after upgrading; its queries need
      // note_q.rule, and a failure here was reported as "No index yet".
      migrateRuleColumn(db);
      const h = getLearningHealth(db);
      learning = { ...h };

      // Negative correlation between exposure and learned value is the
      // signature of the degenerate feedback loop. Measured at -0.537 during
      // the incident; anything below -0.1 warrants investigation.
      if (h.exposureQCorrelation < -0.1) {
        learningWarnings.push(
          `exposure/Q correlation is ${h.exposureQCorrelation.toFixed(3)} — ` +
            `frequently-used notes are being scored LOWER, which indicates a ` +
            `reward-signal defect, not a ranking preference.`,
        );
      }
      // Forward citation is the strongest signal in reward.ts. Zero of them
      // alongside real update traffic means key matching has broken again.
      if (h.totalUpdates > 200 && h.forwardCitations === 0) {
        learningWarnings.push(
          `0 forward citations across ${h.totalUpdates} Q-updates — the ` +
            `strongest reward signal is not firing; check note-key ` +
            `normalization in reward.ts buildOutcome().`,
        );
      }
      // >1 key shape means slug/title drift returned.
      if (h.distinctKeyShapes > 1) {
        learningWarnings.push(
          `note_q holds ${h.distinctKeyShapes} distinct key shapes — slug and ` +
            `raw-title ids have diverged, so Q-values are split per note.`,
        );
      }
      // Any source outside the sanctioned two means an unaudited writer.
      const unexpected = Object.keys(h.bySource).filter(
        (s) => s !== "session_batch" && s !== "explore_conclude",
      );
      if (unexpected.length > 0) {
        learningWarnings.push(
          `unexpected Q-update sources: ${unexpected.join(", ")}`,
        );
      }
      // The old "most notes never credited" check is gone (#37): CLI queries
      // record exposure without credit and neutral / dead-end outcomes write
      // nothing, so uncredited notes and sessions are normal. The outage it
      // guarded against (session-end flush never running) is reported per
      // session on stderr by serve.ts ("[mnemos] session learning: ...").
    } finally {
      db.close();
    }
  } catch {
    // No index yet — learning health is simply unavailable, not an error.
  }

  // Configured-but-unusable LLM (#42). Promote falls back to the deterministic
  // path, so the only downstream symptom is empty descriptions weeks later;
  // health is where people look when that happens.
  const configWarnings: string[] = [];
  const keyProblem = llmKeyProblem(config.llm);
  if (keyProblem) configWarnings.push(keyProblem);

  return {
    success: true,
    data: {
      noteCount: allNotes.length,
      orphanCount: orphans.length,
      danglingCount: dangling.length,
      orphans,
      dangling,
      schemaViolations,
      fading,
      ...(learning ? { learning } : {}),
    },
    warnings: [...templateWarnings, ...configWarnings, ...learningWarnings],
  };
}

export type DoctorResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * Human rendering of `mnemos health` / `mnemos doctor`. Sections that are
 * empty say "none" — silence in a diagnostic must be explicit, not a field
 * you have to go check the JSON for.
 */
export function formatHealth(data: Record<string, unknown>, warnings: string[]): string {
  const fmt = fmtScore;
  const lines: string[] = [`Vault health — ${plural(Number(data.noteCount ?? 0), "note")}`, ""];

  const orphans = (data.orphans as string[]) ?? [];
  lines.push(`Orphans (${orphans.length}):`);
  lines.push(...(orphans.length > 0 ? bulletList(orphans) : ["  none"]));

  const dangling = (data.dangling as string[]) ?? [];
  lines.push(`Dangling links (${dangling.length}):`);
  lines.push(...(dangling.length > 0 ? dangling.map((d) => `  - ${d}`) : ["  none"]));

  const violations = (data.schemaViolations as Array<{ note: string; errors: string[] }>) ?? [];
  lines.push(`Schema violations (${violations.length}):`);
  lines.push(
    ...(violations.length > 0
      ? violations.map((v) => `  - ${v.note}: ${v.errors.join("; ")}`)
      : ["  none"]),
  );

  const fading = (data.fading as Array<{ note: string; vitality: number }>) ?? [];
  lines.push(`Fading (${fading.length}):`);
  lines.push(
    ...(fading.length > 0
      ? fading.map((f) => `  - ${f.note} (vitality ${fmt(f.vitality)})`)
      : ["  none"]),
  );

  const learning = data.learning as Record<string, unknown> | undefined;
  if (learning) {
    lines.push(
      `Learning: ${String(learning.trackedNotes ?? 0)} tracked · ` +
        `${String(learning.totalUpdates ?? 0)} updates · ` +
        `${String(learning.forwardCitations ?? 0)} forward citations · ` +
        `exposure/Q corr ${Number(learning.exposureQCorrelation ?? 0).toFixed(2)}`,
    );
  } else {
    lines.push("Learning: no index yet");
  }

  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join("\n");
}

/** The doctor's extra sections, appended to the health rendering. */
export function formatDoctorExtras(data: Record<string, unknown>): string {
  const doctor = data.doctor as
    | {
        locks: Array<{ slug: string; ageSeconds: number }>;
        indexDrift: {
          indexExists: boolean; vaultNotes: number; indexedNotes: number | null;
          coverage: string; longsMarker: boolean; embeddingsRows: number | null; longRows: number | null;
        };
        configSanity: {
          projectPaths: { total: number; unresolvable: number };
          sessionScope: { enabled: boolean; invalidConstants: string[] };
          dbPath: string | null;
        };
      }
    | undefined;
  if (!doctor) return "";
  const lines: string[] = ["", "Doctor:"];
  lines.push(
    `  Locks: ${doctor.locks.length === 0 ? "none" : doctor.locks.map((l) => `${l.slug} (${l.ageSeconds}s)`).join(", ")}`,
  );
  const d = doctor.indexDrift;
  if (!d.indexExists) {
    lines.push("  Index: none — run mnemos index build");
  } else {
    lines.push(
      `  Index: ${d.coverage} · embeddings ${d.embeddingsRows ?? "?"}` +
        (d.longRows !== null ? ` · longs ${d.longRows} · migration ${d.longsMarker ? "ok" : "MISSING"}` : ""),
    );
  }
  const c = doctor.configSanity;
  lines.push(
    `  Config: project paths ${c.projectPaths.total} (${c.projectPaths.unresolvable} unresolvable) · ` +
      `§5 ${c.sessionScope.enabled ? (c.sessionScope.invalidConstants.length === 0 ? "constants ok" : `INVALID: ${c.sessionScope.invalidConstants.join(", ")}`) : "disabled"}`,
  );
  return lines.join("\n");
}

/**
 * `mnemos doctor` — the deep sweep (debt #7). Everything `health` checks,
 * plus the three diagnostics health cannot see:
 *
 *   - session-record LOCKS: ops/sessions/.locks/ residue. The mkdir lock
 *     self-heals on contention (5s steal), so residue is never fatal — but
 *     it IS visible, and a lock dir that persists across a quiet vault is a
 *     crashed holder's fingerprint. Reported with ages; never removed here
 *     (a doctor that deletes things silently is a new way to lose data, and
 *     the steal already handles the recovery).
 *
 *   - INDEX DRIFT: the derived index answering queries vs the vault on
 *     disk. Read-only: count coverage (note table vs notes dir), the
 *     note_long migration marker, embeddings rowcount, and note_term
 *     coverage. Reports the openSyncedIndex repair only as ADVICE — doctor
 *     never syncs (a diagnostic that writes is a surprise, not a tool).
 *
 *   - CONFIG SANITY: paths that don't resolve (wake.project_paths entries,
 *     engine.db_path), and §5 constants that are mathematically nonsense
 *     (decay/other/floor outside (0,1], waive floor above 1) — a typo in a
 *     tunable silently changes retrieval order, and health's llm-key check
 *     was the only config watchman.
 */
export async function runDoctor(startDir: string, linkGraph?: LinkGraph): Promise<DoctorResult> {
  const base = await runHealth(startDir, linkGraph);
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const doctorWarnings: string[] = [...base.warnings];

  // ── Session-record locks ──────────────────────────────────────────────
  const lockDirRoot = path.join(paths.ops, "sessions", ".locks");
  let locks: Array<{ slug: string; ageSeconds: number }> = [];
  try {
    const entries = await fs.readdir(lockDirRoot);
    const now = Date.now();
    for (const entry of entries) {
      const st = await fs.stat(path.join(lockDirRoot, entry)).catch(() => null);
      if (!st?.isDirectory()) continue;
      locks.push({ slug: entry, ageSeconds: Math.round((now - st.mtimeMs) / 1000) });
    }
    if (locks.length > 0) {
      doctorWarnings.push(
        `${locks.length} session-record lock(s) present: ${locks
          .map((l) => `${l.slug} (${l.ageSeconds}s)`)
          .join(", ")}. Locks older than ~5s are crashed-holder residue (the ` +
          `next writer steals them); if the vault is quiet, they are safe to remove.`,
      );
    }
  } catch {
    // No .locks dir — no locks, no problem.
  }

  // ── Index drift (read-only) ───────────────────────────────────────────
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  type Drift = {
    indexExists: boolean;
    vaultNotes: number;
    indexedNotes: number | null;
    coverage: string;
    longsMarker: boolean;
    embeddingsRows: number | null;
    longRows: number | null;
  };
  let drift: Drift = {
    indexExists: false, vaultNotes: base.data.noteCount as number,
    indexedNotes: null, coverage: "no index — run mnemos index build",
    longsMarker: false, embeddingsRows: null, longRows: null,
  };
  try {
    await fs.access(dbPath);
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });
    try {
      const indexed = (db.prepare("SELECT COUNT(*) AS c FROM note").get() as { c: number }).c;
      const embeddings = (db.prepare("SELECT COUNT(*) AS c FROM embeddings").get() as { c: number }).c;
      let longRows: number | null = null;
      let longsMarker = false;
      try {
        longRows = (db.prepare("SELECT COUNT(*) AS c FROM note_long").get() as { c: number }).c;
        const marker = db
          .prepare("SELECT value FROM index_meta WHERE key = 'anchor_longs_built'")
          .get() as { value: string } | undefined;
        longsMarker = Boolean(marker);
      } catch {
        // note_long/index_meta absent — a pre-anchortokens index.
      }
      const indexedNotes = indexed;
      const covered = indexedNotes === base.data.noteCount;
      drift = {
        indexExists: true,
        vaultNotes: base.data.noteCount as number,
        indexedNotes,
        coverage: covered ? "full" : `DRIFT: ${indexedNotes}/${base.data.noteCount} notes covered`,
        longsMarker,
        embeddingsRows: embeddings,
        longRows,
      };
      if (!covered) {
        doctorWarnings.push(
          `index drift: the derived index covers ${indexedNotes} of ${base.data.noteCount} notes — ` +
            `postings, edges and cached metrics answer from stale content. The next query ` +
            `degrades loudly; a full re-index (delete .mnemos/embeddings.db, mnemos index build) repairs it.`,
        );
      }
      if (longRows !== null && !longsMarker) {
        doctorWarnings.push(
          "the anchor index migration has not run (no anchor_longs_built marker) — " +
            "the §5 waiver's anchor phase is answering from a partially-built note_long; the next synced open backfills it.",
        );
      }
      if (embeddings === 0) {
        doctorWarnings.push("the embeddings table is empty — semantic retrieval will build the index on first use.");
      }
    } finally {
      db.close();
    }
  } catch {
    // No index yet — reported in drift.indexExists, not an error.
  }

  // ── Config sanity ─────────────────────────────────────────────────────
  const configSanity: Record<string, unknown> = {};
  {
    const badPaths: string[] = [];
    for (const [dir, tag] of Object.entries(config.wake.project_paths)) {
      const expanded = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
      try {
        await fs.access(expanded);
      } catch {
        badPaths.push(`${dir} → ${tag}`);
      }
    }
    if (badPaths.length > 0) {
      doctorWarnings.push(
        `wake.project_paths entries that do not resolve on disk: ${badPaths.join(", ")} — ` +
          `the wake resolver silently skips them, so sessions in those directories scope nowhere.`,
      );
    }
    configSanity.projectPaths = {
      total: Object.keys(config.wake.project_paths).length,
      unresolvable: badPaths.length,
    };

    const ss = config.retrieval.session_scope;
    const bad: string[] = [];
    if (ss.enabled) {
      const { lineage_decay: d, unlinked_floor: f, other_scope_multiplier: o, waive_floor: w } = ss;
      if (d !== undefined && (d <= 0 || d > 1)) bad.push(`lineage_decay=${d}`);
      if (f !== undefined && (f <= 0 || f > 1)) bad.push(`unlinked_floor=${f}`);
      if (o !== undefined && (o <= 0 || o > 1)) bad.push(`other_scope_multiplier=${o}`);
      if (w !== undefined && (w <= 0 || w > 1)) bad.push(`waive_floor=${w}`);
      if (bad.length > 0) {
        doctorWarnings.push(
          `retrieval.session_scope constants outside (0,1]: ${bad.join(", ")} — a multiplier ` +
            `above 1 AMPLIFIES out-of-scope notes instead of dampening them; a typo here ` +
            `silently reorders every weighted query.`,
        );
      }
    }
    configSanity.sessionScope = { enabled: ss.enabled, invalidConstants: bad };
    configSanity.dbPath = await fs.access(dbPath).then(() => dbPath, () => null);
  }

  return {
    success: true,
    data: {
      ...base.data,
      doctor: {
        locks,
        indexDrift: drift,
        configSanity,
      },
    },
    warnings: doctorWarnings,
  };
}
