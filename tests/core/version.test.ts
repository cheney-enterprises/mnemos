import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../src/core/version.js";

// The version must resolve from the repo's own package.json (#24's contract).
// Regression: the resolver required parsed.name === "mnemos" exactly, but the
// package is the scoped @cheney-enterprises/mnemos — the check failed at every
// walk-up level and VERSION fell back to 0.0.0 (reported by Eric 2026-11-09:
// `mnemos --version` printed 0.0.0 while package.json said 0.8.1).
describe("version resolution", () => {
  it("resolves the real package version, never the 0.0.0 fallback", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0");
  });

  it("the resolved version has a CHANGELOG section (the publish gate's requirement)", () => {
    const log = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "CHANGELOG.md"),
      "utf8",
    );
    const escaped = VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(new RegExp(`^## \\[${escaped}\\]`, "m").test(log)).toBe(true);
  });
});
