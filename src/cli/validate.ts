import path from "node:path";
import { loadConfig, resolveTemplatePath } from "../core/config.js";
import { findVaultRoot, getVaultPaths, resolveVaultPath } from "../core/vault.js";
import { validateNoteAgainstSchema } from "../core/schema.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { promises as fs } from "node:fs";

export type ValidateOptions = {
  notePath: string;
  startDir?: string;
};

export async function runValidate(
  options: ValidateOptions
): Promise<{ success: boolean; errors: string[]; warnings: string[] }>
{
  const vaultRoot = path.isAbsolute(options.notePath)
    ? await findVaultRoot(path.dirname(path.resolve(options.notePath)))
    : await findVaultRoot(options.startDir ?? process.cwd());
  const absoluteNotePath = resolveVaultPath(vaultRoot, options.notePath);
  const vaultPaths = getVaultPaths(vaultRoot);
  const config = await loadConfig(vaultPaths.config);

  const content = await fs.readFile(absoluteNotePath, "utf8");
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

  const result = await validateNoteAgainstSchema(absoluteNotePath, templatePath);
  const normalizedNotePath =
    process.platform === "win32" ? absoluteNotePath.toLowerCase() : absoluteNotePath;
  const normalizedInboxPrefix =
    (process.platform === "win32"
      ? path.resolve(vaultPaths.inbox).toLowerCase()
      : path.resolve(vaultPaths.inbox)) + path.sep;
  const isInbox = normalizedNotePath.startsWith(normalizedInboxPrefix);
  if (isInbox && result.errors.length > 0) {
    return {
      success: true,
      errors: [],
      warnings: [...result.warnings, ...result.errors],
    };
  }
  return {
    success: result.valid,
    errors: result.errors,
    warnings: result.warnings,
  };
}

/** Human rendering of `mnemos validate` — a verdict, then the details. */
export function formatValidate(
  notePath: string,
  result: { success: boolean; errors: string[]; warnings: string[] },
): string {
  const lines = result.success
    ? [`✓ ${notePath} — valid`]
    : [`✗ ${notePath} — ${result.errors.length} schema violation(s):`];
  for (const e of result.errors) lines.push(`  error: ${e}`);
  for (const w of result.warnings) lines.push(`  warn:  ${w}`);
  if (result.success && result.warnings.length > 0) {
    lines[0] = `✓ ${notePath} — valid (with warnings)`;
  }
  return lines.join("\n");
}
