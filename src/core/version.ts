/**
 * Single source of truth for the installed version (#24).
 * Reads package.json at runtime so the CLI, MCP server, boot state, and
 * update checker can never drift from the published npm version again.
 *
 * dist layout: dist/core/version.js -> ../../package.json
 * src layout (tests/tsx): src/core/version.ts -> ../../package.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

function resolvePackageJson(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // walk up from this module looking for package.json (max 4 levels)
  let dir = here;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      // Scoped package name (@cheney-enterprises/mnemos) — the strict
      // `parsed.name === "mnemos"` check failed on every level and every
      // install fell back to 0.0.0. Accept any package whose name ends in
      // /mnemos or IS mnemos; the walk-up from dist/core/ only ever finds
      // this package's own manifest (or a parent workspace's, which is
      // still the package being served).
      const name = typeof parsed?.name === "string" ? parsed.name : "";
      if ((name === "mnemos" || name.endsWith("/mnemos")) && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  return null;
}

export const VERSION: string = resolvePackageJson() ?? FALLBACK_VERSION;
