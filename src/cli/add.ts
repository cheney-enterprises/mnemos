import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { parseFrontmatter, stringifyFrontmatter } from "../core/frontmatter.js";
import { runValidate } from "./validate.js";
import { runPromote } from "./promote.js";
import { stripTemplatePlaceholderLines } from "../core/promote.js";
import { slugify } from "../core/slug.js";
import { initDB, indexNote } from "../core/engine.js";
import { buildGraph } from "../core/graph.js";
import { computeGraphMetrics } from "../core/importance.js";
import { openSyncedIndex, cachedGraphMetrics } from "../core/indexstore.js";
import { detectProjects } from "../core/classify.js";

/** Config-driven keyword detection, isolated so the ask-first gate can use it. */
function detectProjectsSilently(
  title: string,
  body: string,
  config: { promote: { project_keywords: Record<string, string[]> } },
): string[] {
  try {
    return detectProjects(title, body, { known_projects: [], keywords: config.promote.project_keywords });
  } catch {
    return [];
  }
}

export type AddOptions = {
  startDir: string;
  title: string;
  type?: string;
  content?: string;
  /** One sentence adding context beyond the title (#39). */
  description?: string;
  /** Project tags (#39). */
  project?: string[];
};

export type AddResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * The project roster from the live index — what the ask-first refusal shows.
 * Best-effort: a missing/locked db yields an empty list, never an error.
 */
function loadProjectRoster(dbPath: string): Array<{ project: string; notes: number }> {
  try {
    const db = initDB(dbPath);
    try {
      return db
        .prepare(
          "SELECT project, COUNT(*) as notes FROM note_project GROUP BY project ORDER BY notes DESC",
        )
        .all() as Array<{ project: string; notes: number }>;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * The ask-first contract: a note without a project must not silently file
 * under the hub. The add refuses with the roster + the two resolutions so
 * the agent asks the USER which project applies — an existing one, or a new
 * one and what it should be called — then re-calls with the answer.
 */
export function projectAskResponse(
  roster: Array<{ project: string; notes: number }>,
): AddResult {
  const rosterText = roster.length
    ? roster.map((r) => `${r.project} (${r.notes} notes)`).join(", ")
    : "(no projects established yet — this would be the first)";
  return {
    success: false,
    data: {
      reason: "project_required",
      projects: roster.map((r) => ({ project: r.project, notes: Number(r.notes) })),
      ask: "Which project should this note belong to — an existing one above, or a new one (and its name)?",
    },
    warnings: [
      "PROJECT REQUIRED — this note has no project and none could be detected. Do NOT guess.",
      `Current projects: ${rosterText}`,
      "Ask the user: should this note belong to one of the projects above, or a NEW one? " +
        "If a new project: ask what it should be called (lowercase, hyphenated — e.g. 'kite-telemetry').",
      "Then re-call mnemos_add with project set to the answer. If NEW: the first note for a new " +
        'project is its map — mnemos_add("<tag> project map", type=moc, project=["<tag>"]) — and ' +
        "announce it via mnemos_update file=goals.",
    ],
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateTitle(title: string): { valid: boolean; reason?: string } {
  const trimmed = title.trim();
  if (!trimmed) return { valid: false, reason: "Title is empty" };
  if (UUID_PATTERN.test(trimmed))
    return { valid: false, reason: "Title looks like a UUID, not a prose claim" };
  if (!trimmed.includes(" "))
    return { valid: false, reason: "Title must be multi-word (prose-as-title)" };
  if (trimmed.length < 10)
    return { valid: false, reason: "Title too short for a meaningful claim" };
  return { valid: true };
}

// slugify moved to core/slug.ts — shared with graph normalization (#32)

/**
 * Put caller content into the template (#46). Content that is already a
 * complete note keeps its own structure:
 * - its own H1 replaces the template title instead of sitting under it
 * - its own Relevant Notes / Areas footer means the content IS the body;
 *   wrapping it in the template appended a second, empty footer plus the
 *   template's instructions after the author's footer
 */
export function composeBody(templateBody: string, titleLine: string, content: string): string {
  const ownH1 = /^\s*# \S/.test(content);
  const ownFooter = /^(?:## )?(?:Relevant Notes|Areas):?\s*$/m.test(content);
  if (ownFooter) {
    return ownH1 ? `${content.trim()}\n` : `${titleLine}\n\n${content.trim()}\n`;
  }
  // Function replacers: a "$&" or "$1" in the content is text, not a pattern.
  const titled = ownH1
    ? templateBody.replace(/# \{[^}]+\}[ \t]*\r?\n(?:[ \t]*\r?\n)*/, () => "")
    : templateBody.replace(/# \{[^}]+\}/, () => titleLine);
  return titled.replace(/\{Content[^}]*\}/, () => content);
}

export async function runAdd(options: AddOptions): Promise<AddResult> {
  // Layer 1: Title validation
  const titleCheck = validateTitle(options.title);
  if (!titleCheck.valid) {
    return {
      success: false,
      data: { reason: titleCheck.reason },
      warnings: [titleCheck.reason!],
    };
  }

  const vaultRoot = await findVaultRoot(options.startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const type = options.type ?? "insight";
  const templatePath = resolveTemplatePath(config, vaultRoot, type);
  const templateContent = await fs.readFile(templatePath, "utf8");
  const templateParsed = parseFrontmatter(templateContent);
  // Vaults created before #38 have placeholder links in their own template
  // copy. Strip them from the TEMPLATE text only, before the user's title and
  // content go in, so a line the user wrote is never touched. Unconditional:
  // the line comes from the template, so even if a real note has that name,
  // linking every new note to it would be wrong.
  const templateBody = stripTemplatePlaceholderLines(templateParsed.body);

  const now = new Date();
  const created = now.toISOString().slice(0, 10);

  // #39: the caller (usually an agent over MCP) knows these at creation time.
  // Written into the inbox note so they exist whether or not it auto-promotes.
  const description = options.description?.trim() ?? "";
  const project = (options.project ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  const frontmatter = {
    description,
    type,
    project,
    status: "inbox",
    created,
    last_accessed: created,
    access_count: 0,
  };

  // Layer 2: Content parameter — replace template placeholder when content provided
  const titleLine = `# ${options.title}`;
  let body: string;
  if (options.content) {
    body = composeBody(templateBody, titleLine, options.content);
  } else {
    body = templateBody.replace(/# \{[^}]+\}/, titleLine);
  }

  const content = stringifyFrontmatter(frontmatter, body);
  const rawSlug = slugify(options.title);
  const baseSlug = rawSlug || `note-${Date.now()}`;
  let filename = `${baseSlug}.md`;
  let destPath = path.join(paths.inbox, filename);
  let counter = 2;
  while (true) {
    try {
      await fs.access(destPath);
      filename = `${baseSlug}-${counter}.md`;
      destPath = path.join(paths.inbox, filename);
      counter++;
    } catch {
      break;
    }
  }

  await fs.writeFile(destPath, content, "utf8");

  // Embed on write (2026-09-06). Until now runAdd wrote the file and returned;
  // the vector index only learned about the note at the next manual
  // `mnemos index build`. On 2026-09-06 that gap was 8 days and 34 notes — every
  // note written in a session was invisible to mnemos_query_ranked for the rest
  // of that session. Best-effort: an embedding failure must never lose the
  // write. Zep/Graphiti index each episode on arrival for the same reason.
  const embedWarnings: string[] = [];
  try {
    const dbPath = path.resolve(vaultRoot, config.engine.db_path);
    const db = initDB(dbPath);
    try {
      // The file is already on disk, so the sync inside openSyncedIndex
      // reparses exactly one note and the graph comes from SQL instead of a
      // full vault scan (2,088 ms at 1,538 notes). The metrics cache misses
      // by design - the fingerprint moved - and the recompute it stores is the
      // one the next query would otherwise have paid for.
      const titles = await listNoteTitles(paths.notes);
      const opened = await openSyncedIndex(db, paths.notes, titles.length);
      if (opened.reason) embedWarnings.push(opened.reason);
      const linkGraph = await buildGraph(paths.notes, opened.index);
      const metrics = cachedGraphMetrics(
        opened.index, () => computeGraphMetrics(linkGraph),
      ).metrics;
      const noteTitle = path.basename(destPath, ".md");
      await indexNote(
        db,
        noteTitle,
        frontmatter as Record<string, unknown>,
        body,
        linkGraph,
        metrics.communities,
        metrics.communityStats.size,
        config.engine,
      );
    } finally {
      db.close();
    }
  } catch (err) {
    embedWarnings.push(
      `embed-on-write failed (note saved, run \`mnemos index build\`): ${String(err)}`,
    );
  }

  const validation = await runValidate({ notePath: destPath });
  const warnings = [...validation.warnings, ...embedWarnings];
  if (!frontmatter.description) {
    warnings.push("Description is empty");
  }

  // Layer 3: Smart auto-promote — only if note has real content
  const autoPromote = config.promote?.auto ?? false;
  const hasRealContent = !body.includes("{Content");

  if (autoPromote && hasRealContent) {
    // Ask-first gate lives at the FILING boundary, not the inbox write. A
    // project-less note may rest in inbox/ harmlessly (stubs, human CLI
    // flows); filing it into the knowledge graph (map assignment, retrieval
    // presence) without a project is the harmful act, so auto-promote
    // refuses with the roster + the question for the USER.
    const detected = detectProjectsSilently(options.title, body, config);
    if (project.length === 0 && detected.length === 0) {
      const dbPath = path.resolve(vaultRoot, config.engine.db_path);
      const ask = projectAskResponse(loadProjectRoster(dbPath));
      return {
        success: true,
        data: {
          ...ask.data,
          path: destPath,
          autoPromoted: false,
          askGate: true,
        },
        warnings: [
          ...ask.warnings,
          "note saved to inbox/ pending the project decision",
        ],
      };
    }
    try {
      const promoteResult = await runPromote({
        startDir: options.startDir,
        noteName: filename,
        // Passed as explicit overrides so a configured LLM cannot replace them.
        // type included: the inbox note's frontmatter type is the agent's
        // explicit choice (type=moc for maps is load-bearing — routing,
        // wake rosters, and the ritual resolve on it). Without this, promote
        // reclassified moc → insight and the map convention silently broke.
        description: description || undefined,
        project: project.length > 0 ? project : undefined,
        type: options.type,
      });
      if (promoteResult.success && promoteResult.data.promoted.length > 0) {
        const promoted = promoteResult.data.promoted[0];
        warnings.push(
          ...promoted.warnings,
          ...promoted.changes.map((c) => `auto-promote: ${c}`)
        );
        // Re-sync the derived index AFTER the move. The embed-on-write pass
        // above synced notes/ while the note still lived in inbox/, so the
        // promoted note was absent from note/note_project until some later
        // query path synced — invisible to memory_sql (readonly, never syncs)
        // and to wake's project roster (direct reads) for the whole session.
        // Same best-effort contract as embed-on-write: a failure must never
        // lose the write.
        try {
          const dbPath = path.resolve(vaultRoot, config.engine.db_path);
          const db = initDB(dbPath);
          try {
            const titlesAfter = await listNoteTitles(paths.notes);
            const opened = await openSyncedIndex(db, paths.notes, titlesAfter.length);
            if (opened.reason) warnings.push(opened.reason);
          } finally {
            db.close();
          }
        } catch (err) {
          warnings.push(`post-promote index sync failed (note saved, run \`mnemos index build\`): ${String(err)}`);
        }
        return {
          success: true,
          data: { path: promoted.to, autoPromoted: true },
          warnings,
        };
      }
    } catch {
      warnings.push("Auto-promote failed, note remains in inbox");
    }
  } else if (autoPromote && !hasRealContent) {
    warnings.push(
      "Auto-promote skipped: note has template placeholder body. Add content before promoting."
    );
  }

  return {
    success: true,
    data: { path: destPath },
    warnings,
  };
}
