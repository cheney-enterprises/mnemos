/**
 * mnemos wake — bounded session boot runner (manifest -> engine).
 */
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import path from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../core/config.js";
import { loadPolicy, policyLine } from "../core/policy.js";
import { loadWakeSources, assembleWakeInputs, assembleProjectWake } from "../core/wake-sources.js";
import { buildWakePayload } from "../core/wake.js";
import { parseTemporal, classifyReminder } from "../core/temporal.js";

/**
 * The repo→project bridge (feedback item 2): resolve the session's working
 * directory to a project tag via config `wake.project_paths` — exact match
 * first, then nested (a repo subdirectory belongs to the repo's project).
 * Longest path wins on nested overlap. Pure so it is unit-testable.
 */
export function resolveProjectByPath(
  cwd: string,
  prefixMatch: boolean,
  projectPaths: Record<string, string>,
): string | null {
  const expanded: Array<{ path: string; project: string }> = Object.entries(projectPaths)
    .map(([p, tag]) => ({ path: expandTilde(p), project: tag.trim() }))
  .filter((e) => e.path.length > 0 && e.project.length > 0);
  // Longest match wins: ~/dev/mnemos beats ~/dev for the same session dir.
  expanded.sort((a, b) => b.path.length - a.path.length);
  for (const { path: base, project } of expanded) {
    if (cwd === base || (prefixMatch && cwd.startsWith(base + "/"))) {
      return project;
    }
  }
  return null;
}

/** ~/x → $HOME/x; a lone "~" expands to $HOME itself. */
export function expandTilde(p: string): string {
  if (p === "~" || p === "~/") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Rank likely scopes for a fuzzy user reference ("the alarm app snooze
 * stuff"). Gathers per-project footprints from the live index
 * (slugs + descriptions + map + recent daily lines) and runs the pure
 * suggester. Best-effort: empty array on any failure.
 */
export async function suggestScopesForReference(
  startDir: string,
  reference: string,
  currentScope?: string,
  vaultOverride?: string,
): Promise<Array<{ project: string; score: number; reasons: string[] }>> {
  try {
    const vaultRoot = vaultOverride ?? (await findVaultRoot(startDir));
    const config = await loadConfig(getVaultPaths(vaultRoot).config);
    const dbPath = path.resolve(
      vaultRoot,
      (config as { engine?: { db_path?: string } }).engine?.db_path ?? ".mnemos/embeddings.db",
    );
    const { default: Database } = await import("better-sqlite3");
    const { promises: fsp } = await import("node:fs");
    const d = new Database(dbPath, { readonly: true });
    try {
      const tags = d.prepare("SELECT DISTINCT project FROM note_project").all() as Array<{ project: string }>;
      const daily = await fsp.readFile(path.join(vaultRoot, "ops", "daily.md"), "utf8").catch(() => "");
      const candidates: Array<{ project: string; footprint: string; lastActive: string | null; notes: number }> = [];
      for (const { project } of tags) {
        const notes = d
          .prepare("SELECT n.slug, n.description, n.indexed_at FROM note_project p JOIN note n ON n.id=p.note_id WHERE p.project=?")
          .all(project) as Array<{ slug: string; description: string | null; indexed_at: string }>;
        const foot =
          notes.map((n) => `${n.slug} ${n.description ?? ""}`).join(" ") +
          " " +
          daily.split("\n").filter((l) => l.includes(project)).slice(-5).join(" ");
        const last = notes.reduce((m, n) => (n.indexed_at > m ? n.indexed_at : m), "");
        candidates.push({ project, footprint: foot, lastActive: last, notes: notes.length });
      }
      const { suggestScopes } = await import("../core/scopesuggest.js");
      return suggestScopes(reference, candidates, currentScope).slice(0, 3);
    } finally {
      d.close();
    }
  } catch {
    return [];
  }
}

export async function runWake(
  startDir: string,
  budgetLines: number,
  project?: string,
  hint?: string,
  pathArg?: string,
  ask?: boolean,
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
    goals?: string[];
    goalsFromFile?: boolean;
    reminders?: string[];
    remindersFromFile?: boolean;
    warmNotes?: Array<{ title: string; decayed: number }>;
    members?: Set<string>;
    warning?: string;
  };
  /** The operating manual pointer — present on every wake. */
  manual: {
    resource: string;
    path: string;
    note: string;
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
    /** How conversational sessions get scoped: silently, from a description. */
    chat_session_hint?: string;
    /** When a hint was supplied but confidence fell short, the likely projects ride here. */
    suggestions?: Array<{ project: string; score: number; reasons: string[] }>;
    /** Present when the top two suggestions are nearly tied — a genuine ambiguity to relay. */
    race_note?: string;
  };
  /** Present when wake scoped silently: how it decided, for the transcript. */
  resolution?: {
    project: string;
    method: "path" | "default" | "hint";
    note: string;
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
    // The operating manual pointer — one structured line per boot, never the
    // content (9KB in every wake would be the context debt the budget ladder
    // exists to prevent). It points at SECTIONS, not the whole file: the
    // manual is the occasional deep reference; the doctrine above is the
    // always-present contract. An agent unaware of the manual is defeated
    // by it; an agent shotgun-reading it inflates context for nothing.
    manual: {
      resource: "mnemos://manual",
      path: "ops/manual.md",
      note: "Operating manual (deep reference; read only the section you need): §1 what belongs in the vault, §2-4 scope/tagging/naming rules, §5 vault layout. The doctrine above is the always-present contract — command workflows and quality bars live there, not in the manual.",
    },
  };

  // Project resolution — the wake contract (Eric's design). NOTE: the
  // config default applies to the MCP path the same way as the CLI arg —
  // a bare MCP wake with a configured default resolves to that project and
  // therefore also gets the scoped (shared-file-suppressed) briefing.
  // ask=true short-circuits silent resolution: the caller demanded the
  // question. An explicit project= still wins — it IS the answer to the
  // question, not a resolution guess.
  if (ask && !chosen) {
    result.project_choice_required = {
      reason: "wake.project_required",
      question:
        "Which project is this session working in? Choose from the roster, name a NEW project (existing tags or lowercase-hyphenated new ones). For a conversational/chat session, say what it was about and the scope is named and created silently (e.g. 'pirate-adventure'). Re-call mnemos_wake with project=<tag>.",
      default_hint: config.wake.project_default || null,
      projects: inputs.projects,
      chat_session_hint:
        "For a conversational/chat session, just describe what it was about — the agent deduces a name (e.g. 'pirate-adventure'), creates the scope silently, and confirms.",
    };
    return result;
  }
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
      if (!chosen) {
        // Scoped by the configured default, not by an explicit argument —
        // record how, so the transcript can show the provenance.
        result.resolution = {
          project: effective,
          method: "default",
          note: `scoped by config default (wake.project_default = "${effective}")`,
        };
      }
    } else {
      // A named project that does not exist (or a default pointing at
      // nothing yet): report, name the fix, keep the roster as correction.
      // The AGENT creates the project (add the map) — the scaffold then
      // happens in add's promote path. Wake itself never writes.
      result.projectWake = {
        project: effective,
        map: null,
        currentState: [],
        daily: [],
        recentNotes: [],
        goals: [],
        goalsFromFile: false,
        reminders: [],
        remindersFromFile: false,
        warmNotes: [],
        members: new Set(),
        warning:
          `no project "${effective}" in this vault — the roster lists the live ones. ` +
          'If this is a new project, create it: mnemos_add("<tag> project map", type=moc, project=["<tag>"]) — the state files (ops/<tag>/goals|daily|reminders.md) are scaffolded automatically.',
      };
    }
  } else {
    // No explicit project. Resolve-first (Eric: the ask-first gate forced an
    // interaction by design — the friction the tooling exists to remove).
    // Precedence is most-specific-wins: a directory match means the session
    // HAS a project of its own (the config comment's own bar for a default),
    // so path beats default. Then a confident hint, then the question —
    // which carries suggestions when a hint was supplied. Resolve silently
    // when confident; ask only on true ambiguity.
    const effectiveDefault = (config.wake.project_default || "").trim();
    // Explicit path= (MCP) points at the repo the caller means; otherwise
    // the session's own directory is matched. Both go through the same
    // registry — a path alone cannot conjure a project tag.
    const dirForPath = pathArg?.trim() || startDir;
    const byPath = resolveProjectByPath(dirForPath, true, config.wake.project_paths ?? {});
    const byDefault = byPath || effectiveDefault;
    if (byDefault) {
      const known = inputs.projects.some((p) => p.project === byDefault);
      if (known) {
        const pw = await assembleProjectWake(vaultRoot, dbPath, byDefault, config.promote.project_map_routing);
        result.projectWake = { project: byDefault, ...pw };
        result.resolution = {
          project: byDefault,
          method: byPath ? "path" : "default",
          note:
            byPath
              ? `scoped by directory: ${dirForPath} maps to "${byDefault}" (wake.project_paths)`
              : `scoped by config default (wake.project_default = "${effectiveDefault}")`,
        };
      } else {
        // Default/path names a project that does not exist: same repair as
        // an explicit unknown project — report, name the fix. Wake never
        // writes; the agent creates the map.
        result.projectWake = {
          project: byDefault,
          map: null,
          currentState: [],
          daily: [],
          recentNotes: [],
          goals: [],
          goalsFromFile: false,
          reminders: [],
          remindersFromFile: false,
          warmNotes: [],
        members: new Set(),
          warning:
            `no project "${byDefault}" in this vault — the roster lists the live ones. ` +
            'If this is a new project, create it: mnemos_add("<tag> project map", type=moc, project=["<tag>"]) — the state files (ops/<tag>/goals|daily|reminders.md) are scaffolded automatically.',
        };
      }
    } else {
      // True ambiguity — the question is the last resort. When the caller
      // passed a hint (what the session is about), run the suggester on it:
      // a confident match resolves silently; a weak one rides INSIDE the
      // question so the user's next utterance is the only round trip.
      const roster = inputs.projects.map((p) => ({ project: p.project, notes: p.notes }));
      const hintTrim = hint?.trim() ?? "";
      // The repo's directory name is itself a weak reference ("Alarm App" for
      // the roust project): folded into the hint before suggesting. Directory
      // names are circumstantial evidence — they feed suggestions only, and
      // the bar for silent scoping from them stays the same text-backed 0.75.
      // The vault's own directory is NOT a repo name — folding it in would
      // suggest projects from "memory-vault" tokens; only fold a dir that is
      // not the vault root (explicit path=, or a CLI cwd outside the vault).
      const nameSource = pathArg?.trim() || (startDir !== vaultRoot ? startDir : "");
      const dirName = nameSource ? path.basename(nameSource) : "";
      const refText = [hintTrim, dirName].filter((s) => s && s.length >= 3).join(" ");
      let suggestions: Array<{ project: string; score: number; reasons: string[] }> = [];
      if (refText) {
        suggestions = await suggestScopesForReference(vaultRoot, refText, undefined, vaultRoot);
      }
      const CONFIDENT = 0.75;
      const runnerUpGap = 0.2;
      const top = suggestions[0];
      // A sole confident suggestion resolves silently. A close runner-up
      // means real ambiguity — both ride inside the question instead.
      // A sole confident suggestion resolves silently — but ONLY when the
      // hint's TEXT matched the footprint (recency alone must never scope a
      // session; "quantum xylophone" must not land you in the most-recent
      // project). The suggester's reasons name the signals that fired.
      const textBacked = top ? top.reasons.some((r) => r.startsWith("mentions ")) : false;
      // hintTrim gates silent resolution: a directory name folded in is
      // circumstantial (the dir can be named anything — "Alarm App" hosting
      // the roust project); only a caller-supplied hint is intent. Dir-only
      // matches — however strong — stay suggestions inside the question.
      if (top && textBacked && hintTrim && top.score >= CONFIDENT && (suggestions[1] === undefined || suggestions[1].score < top.score - runnerUpGap)) {
        const pw = await assembleProjectWake(vaultRoot, dbPath, top.project, config.promote.project_map_routing);
        result.projectWake = { project: top.project, ...pw };
        result.resolution = {
          project: top.project,
          method: "hint",
          note: `scoped from hint "${hintTrim}" (suggester score ${top.score.toFixed(2)})`,
        };
      } else {
        // A tight top-two race (both near 1.0) is a genuine ambiguity the
        // user must break — say so, or the agent faces two 0.99 scores and
        // guesses.
        const raceNote =
          suggestions.length >= 2 && suggestions[0].score - suggestions[1].score < runnerUpGap
            ? `Close call between ${suggestions[0].project} and ${suggestions[1].project} — ask the user which one this session is for.`
            : undefined;
        result.project_choice_required = {
          reason: "wake.project_required",
          question:
            "Which project is this session working in? Choose from the roster, name a NEW project (existing tags or lowercase-hyphenated new ones). For a conversational/chat session, say what it was about and the scope is named and created silently (e.g. 'pirate-adventure'). Re-call mnemos_wake with project=<tag>.",
          default_hint: null,
          projects: roster,
          chat_session_hint:
            "For a conversational/chat session, just describe what it was about — the agent deduces a name (e.g. 'pirate-adventure'), creates the scope silently, and confirms.",
          ...(suggestions.length > 0 ? { suggestions } : {}),
          ...(raceNote ? { race_note: raceNote } : {}),
        };
      }
    }
  }

  return result;
}
