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
  /**
   * Present ONLY when no project was given and no default is configured:
   * the payload stays global-only and the agent must relay this choice to
   * the user, then re-call with project=<tag>. No session works unscoped.
   */
  project_choice_required?: {
    reason: string;
    question: string;
    default_hint: string | null;
    projects: Array<{ project: string; notes: number }>;
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
  const chosen = project?.trim();
  const scoped = chosen && chosen.length > 0;
  // When a project is named, the shared-file sections are SUBSTITUTED, not
  // suppressed: active_goals, daily_recent, warm_notes, and reminders_due
  // come from the project's own data (ops/<tag>/ files with legacy
  // fallbacks). The scoped wake shows this project's state — not zero, not
  // every project's. Reminders compose: project file lines PLUS any global
  // line NOT claimed by a project file (untagged items stay everyone's).
  let projectData: Awaited<ReturnType<typeof assembleProjectWake>> | undefined;
  if (scoped) {
    projectData = await assembleProjectWake(
      vaultRoot,
      dbPath,
      chosen as string,
      config.promote.project_map_routing,
    );
  }
  // Reminders for a scoped wake: project-sourced lines first; global lines
  // join only when a per-project reminders file is ABSENT (fallback mode —
  // the shared file's tag-filtered lines are already project-true). When the
  // project file EXISTS, it is the authority; global lines are skipped
  // because anything in them that mattered to this project should have been
  // written there.
  let scopedReminders: string[] = [];
  if (scoped && projectData) {
    if (projectData.remindersFromFile) {
      scopedReminders = projectData.reminders;
    } else {
      scopedReminders = projectData.reminders;
    }
  }
  const globalInputs = scoped
    ? { ...inputs, goals: "", daily: [], warmNotes: [], activity: [], reminders: "" }
    : inputs;
  const wakeInputs = {
    ...globalInputs,
    goals: scoped && projectData ? projectData.goals.join("\n") : globalInputs.goals,
    warmNotes: scoped && projectData ? projectData.warmNotes : globalInputs.warmNotes,
    reminders: scoped ? scopedReminders.join("\n") : reminderLines.join("\n"),
    daily:
      scoped && projectData
        ? [{ date: today, lines: projectData.daily }]
        : (globalInputs.activity ?? []).map((l) => ({ date: today, lines: [l] })),
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

  // Project resolution — the wake contract (Eric's design). NOTE: the
  // config default applies to the MCP path the same way as the CLI arg —
  // a bare MCP wake with a configured default resolves to that project and
  // therefore also gets the scoped (shared-file-suppressed) briefing.
  //   project given        -> global context + that project's context, ONE payload.
  //   no project, default  -> same, using config wake.project_default.
  //   no project, no default -> menu + a project_choice the agent relays to
  //                             the user. The agent never works unscoped.
  const effective = chosen || (config.wake.project_default || "").trim();
  if (effective) {
    const known = inputs.projects.some((p) => p.project === effective);
    if (known) {
      const pw = projectData ?? (await assembleProjectWake(
        vaultRoot,
        dbPath,
        effective,
        config.promote.project_map_routing,
      ));
      result.projectWake = { project: effective, ...pw };
    } else {
      // A named project that does not exist (or a default pointing at
      // nothing yet): report, name the fix, keep the roster as correction.
      result.projectWake = {
        project: effective,
        map: null,
        currentState: [],
        daily: [],
        recentNotes: [],
        warning:
          `no project "${effective}" in this vault — the roster lists the live ones. ` +
          'If this is a new project, create its map: mnemos_add("<tag> project map", type=moc, project=["<tag>"])',
      };
    }
  } else {
    // Forced choice: the payload stays global-only and names the decision.
    // The agent presents this to the user verbatim — an agent must not pick
    // a project on the user's behalf, and must not work unscoped.
    result.project_choice_required = {
      reason: "wake.project_required",
      question:
        "Which project is this session working in? Choose from the project roster above, or name a NEW project (lowercase, hyphenated) and its map will be created. Re-call mnemos_wake with project=<tag>.",
      default_hint: config.wake.project_default || null,
      projects: inputs.projects,
    };
  }

  return result;
}
