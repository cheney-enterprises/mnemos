/**
 * Project scaffolding — every project gets its own state files at creation.
 *
 * Eric's design law: per-project goals/daily/reminders are part of CREATING
 * a project, not an afterthought. The ONLY fallback in wake is the GLOBAL
 * documents — a project that exists never falls back to grep-the-shared-file.
 *
 * Called wherever a project comes into being: the self-serve map flow
 * (mnemos_add of a <tag>…map), promote's first routing into a project, and
 * the wake's unknown-project → create path. Idempotent — re-running on an
 * existing project leaves its files untouched.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { VaultPaths } from "./vault.js";

export interface ProjectScaffoldResult {
  created: string[];
  skipped: string[];
  opsDir: string;
}

const FILES: Array<{ name: string; header: (tag: string) => string; body: string }> = [
  {
    name: "goals.md",
    header: (tag) => `# ${tag} Goals\n\nWhat this project is trying to achieve. Stable — the map's Current State holds the moment-to-moment handoff.\n`,
    body: "- (first goal — replace me)\n",
  },
  {
    name: "daily.md",
    header: (tag) => `# ${tag} Daily Log\n\nSession log. Append per session; the scoped wake reads the tail.\n`,
    body: "",
  },
  {
    name: "reminders.md",
    header: (tag) => `# ${tag} Reminders\n\nTime-bound items for this project. Format: - [ ] YYYY-MM-DD: description\n`,
    body: "",
  },
];

/**
 * Scaffold ops/<tag>/{goals,daily,reminders}.md if missing. Idempotent.
 * Best-effort per file: a failure to create one must not block the others.
 */
export async function scaffoldProjectFiles(
  paths: VaultPaths,
  tag: string,
): Promise<ProjectScaffoldResult> {
  const result: ProjectScaffoldResult = { created: [], skipped: [], opsDir: path.join(paths.ops, tag) };
  const dir = path.join(paths.ops, tag);
  await fs.mkdir(dir, { recursive: true });

  for (const f of FILES) {
    const filePath = path.join(dir, f.name);
    try {
      await fs.access(filePath);
      result.skipped.push(filePath);
      continue;
    } catch {
      // doesn't exist — create below
    }
    const frontmatter = [
      "---",
      `description: ${tag} — ${f.name.replace(".md", "")} (project state)`,
      "type: insight",
      `project: [${tag}]`,
      "status: active",
      `created: ${new Date().toISOString().slice(0, 10)}`,
      "---",
      "",
    ].join("\n");
    const content = `${frontmatter}${f.header(tag)}${f.body ? "\n" + f.body : ""}\n`;
    try {
      await fs.writeFile(filePath, content, "utf8");
      result.created.push(filePath);
    } catch {
      // disk full / permissions: skip this file, keep scaffolding the rest
    }
  }
  return result;
}
