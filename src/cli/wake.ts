/**
 * mnemos wake — bounded session boot runner (manifest -> engine).
 */
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import path from "node:path";
import { loadConfig } from "../core/config.js";
import { loadPolicy, policyLine } from "../core/policy.js";
import { loadWakeSources, assembleWakeInputs, assembleProjectWake } from "../core/wake-sources.js";
import { buildWakePayload } from "../core/wake.js";
import { parseTemporal, classifyReminder } from "../core/temporal.js";

export async function runWake(
  startDir: string,
  budgetLines: number,
  project?: string,
): Promise<{
  success: boolean;
  lines: string[];
  sections: Record<string, number>;
  projects: Array<{ project: string; notes: number }>;
  policy: string;
  /** Present when a project was resolved: the scoped context layer. */
  projectWake?: {
    project: string;
    map: string | null;
    currentState: string[];
    daily: string[];
    recentNotes: string[];
    warning?: string;
  };
}> {
  const vaultRoot = await findVaultRoot(startDir);
  const config = await loadConfig(getVaultPaths(vaultRoot).config);
  const sources = loadWakeSources(config as never);
  // db_path is config-owned (engine.db_path); resolve it the same way the
  // engine does so warm notes read the actual live index.
  const dbPath = path.resolve(
    vaultRoot,
    (config as { engine?: { db_path?: string } }).engine?.db_path ?? ".mnemos/embeddings.db",
  );
  const inputs = await assembleWakeInputs(vaultRoot, sources, dbPath);
  // The doctrine promises the briefing carries policy — the gates an agent
  // needs to PREDICT refusals. One compact line in the briefing; the full
  // sheet is mnemos://policy for sessions that need the detail.
  const { policy } = loadPolicy(config);

  const today = new Date().toISOString().slice(0, 10);

  // Mechanical temporal filter (design v2): only due/upcoming reminders survive.
  // Words like "today" are never trusted — only ISO dates. Undated lines stay
  // (classifyReminder returns "note") so plain reminders are not lost.
  const reminderLines = inputs.reminders
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .filter((l) => {
      const t = parseTemporal(l, null);
      const cls = classifyReminder(t, today);
      if (cls === "due" || cls === "upcoming") return true;
      if (cls !== "note") return false; // expired never surfaces
      // Undated notes: keep only if captured recently (30d) or capture date unknown.
      if (t.capturedAt === null) return true;
      const ageDays = (Date.parse(today) - Date.parse(t.capturedAt)) / 86400000;
      return ageDays <= 30;
    });
  const wakeInputs = {
    ...inputs,
    reminders: reminderLines.join("\n"),
    daily: inputs.activity.map((l) => ({ date: today, lines: [l] })),
    policy: policyLine(policy)
  };

  const out = buildWakePayload(wakeInputs, budgetLines);
  const result: Awaited<ReturnType<typeof runWake>> = {
    success: true,
    lines: out.lines,
    sections: out.sections,
    projects: inputs.projects,
    policy: policyLine(policy),
  };

  // The scoped layer: when a project is named, its map Current State, daily
  // lines, and recent notes ride along — everything an agent working ON that
  // project needs, nothing from the others. An unknown project is reported,
  // not fatal: the roster in the same payload is the correction.
  if (project?.trim()) {
    const tag = project.trim();
    const known = inputs.projects.some((p) => p.project === tag);
    if (known) {
      const pw = await assembleProjectWake(
        vaultRoot,
        dbPath,
        tag,
        config.promote.project_map_routing,
      );
      result.projectWake = { project: tag, ...pw };
    } else {
      result.projectWake = {
        project: tag,
        map: null,
        currentState: [],
        daily: [],
        recentNotes: [],
        warning:
          `no project "${tag}" in this vault — the roster lists the live ones. ` +
          "If this is a new project, create its map: mnemos_add(\"<tag> project map\", type=moc, project=[\"<tag>\"])",
      };
    }
  }

  return result;
}
