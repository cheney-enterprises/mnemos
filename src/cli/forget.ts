/**
 * mnemos forget — query-addressed forgetting wired for CLI and MCP.
 *
 * Thin dispatch over core/forget.ts (release | supersede | purge), which owns
 * the hard part: anchored matching, dry-run-by-default, and the blast-radius
 * cap. `purge` is exposed ONLY through the CLI command, never as an MCP tool —
 * an agent must not be able to hard-delete vault records; a human types it.
 */
import path from "node:path";
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { initDB, removeNoteFromDB } from "../core/engine.js";
import { writeFrontmatterFile } from "../core/frontmatter.js";
import { release, supersede, purge, ForgetBlastRadiusError, type ForgetMatch } from "../core/forget.js";
import { runIndexBuild } from "./indexcmd.js";

export type ForgetOp = "release" | "supersede" | "purge";

export interface ForgetRunOptions {
  startDir: string;
  op: ForgetOp;
  query: string;
  newText?: string;
  apply?: boolean;
  maxForget?: number;
  project?: string[];
}

export interface ForgetRunResult {
  success: boolean;
  data?: {
    op: ForgetOp;
    query: string;
    apply: boolean;
    matched: ForgetMatch[];
    changed: number;
  };
  warnings: string[];
}

export async function runForget(options: ForgetRunOptions): Promise<ForgetRunResult> {
  const warnings: string[] = [];
  const apply = options.apply === true;

  if (options.op === "supersede" && !options.newText?.trim()) {
    return { success: false, warnings: ["supersede requires --new-text (the replacement content)"] };
  }

  try {
    const vaultRoot = await findVaultRoot(options.startDir);
    const paths = getVaultPaths(vaultRoot);
    const config = await loadConfig(paths.config);

    const cap = options.maxForget;
    const forgetOpts = { apply, maxForget: cap };

    let matched: ForgetMatch[] = [];
    let changed = 0;

    if (options.op === "release") {
      const r = await release(paths.notes, options.query, config.engine, forgetOpts);
      matched = r.matched;
      changed = r.count;
    } else if (options.op === "supersede") {
      const r = await supersede(
        paths.notes,
        options.query,
        options.newText ?? "",
        config.engine,
        async (slug, text, fm) => {
          // Route the replacement through the normal note layout; an explicit
          // project flag wins over the core default so the new note lands on
          // the right map like every other note.
          const frontmatter = options.project?.length
            ? { ...fm, project: options.project }
            : fm;
          await writeFrontmatterFile(path.join(paths.notes, `${slug}.md`), frontmatter, text);
        },
        forgetOpts,
      );
      matched = r.matched;
      changed = r.count;
      if (changed > 0) {
        // The replacement note must be retrievable now, not after the next
        // manual index build; incremental build re-embeds only changed notes.
        const built = await runIndexBuild(vaultRoot, false);
        warnings.push(`index updated: ${built.data.indexed} embedded, ${built.data.skipped} unchanged`);
      }
    } else {
      // purge — CLI-only by design. The file is the truth; removing it also
      // requires removing the index rows, which core leaves to the caller.
      if (options.maxForget === undefined) warnings.push("destructive: purge unlinks files — prefer `release` unless the record must be erased");
      const r = await purge(paths.notes, options.query, config.engine, forgetOpts);
      matched = r.matched;
      changed = r.count;
      if (changed > 0) {
        const db = initDB(path.resolve(vaultRoot, config.engine.db_path));
        try {
          for (const m of matched) removeNoteFromDB(db, m.slug);
        } finally {
          db.close();
        }
      }
    }

    if (!apply) {
      warnings.push("dry run (default) — re-run with apply to mutate");
    }
    return { success: true, data: { op: options.op, query: options.query, apply, matched, changed }, warnings };
  } catch (err) {
    if (err instanceof ForgetBlastRadiusError) {
      return { success: false, warnings: [err.message] };
    }
    throw err;
  }
}
