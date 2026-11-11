import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { homedir } from "node:os";

// The operating manual used to duplicate the doctrine's command workflows in
// full. Every doctrine change then implied a coordinated manual edit in two
// places (scaffold + the live vault's copy), nothing failed when someone
// forgot, and the copies drifted (226 vs 221 lines before the 2026-11-11
// dedupe). The contract since: the manual carries what doctrine does not
// (§1-5), and §6 POINTS at the doctrine, policy, and --help instead of
// restating them. These pins keep that shape honest the way the README
// count test does — by failing until the human reads the diff.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const scaffoldManual = read("scaffold/ops/manual.md");
const doctrine = read("src/core/doctrine.ts");
const wake = read("src/cli/wake.ts");

// The live vault copy drifts silently — it is written at scaffold time and
// never updated by `npm run build`. Resolve the same way the CLI does:
// MNEMOS_VAULT, then the known global vault locations on this machine.
const vaultCandidates = [
  process.env.MNEMOS_VAULT,
  path.join(homedir(), "ori-memory-vault"),
  path.join(homedir(), ".mnemos-memory"),
].filter((p): p is string => Boolean(p));
const liveVault = vaultCandidates.find((p) => existsSync(path.join(p, "ops", "manual.md")));

describe("the operating manual stays lean and doctrine-owned", () => {
  it("carries exactly the non-duplicated sections (§1-6), nothing more", () => {
    for (const heading of [
      "## 1. Intended use",
      "## 2. The three scopes: GLOBAL / PROJECT / SESSION",
      "## 3. Every entry carries its project",
      "## 4. Project naming",
      "## 5. The layers: what each area is for",
      "## 6. Where the deep references live",
    ]) {
      expect(scaffoldManual, `missing heading: ${heading}`).toContain(heading);
    }
    // The dedupe removed the command-workflow restatement; a heading with
    // that name returning means the duplication came back.
    expect(scaffoldManual).not.toMatch(/^## 6. Command workflows$/m);
    expect(scaffoldManual).not.toMatch(/^### Session lifecycle/m);
  });

  it("states its own boundary: workflows and quality bars are doctrine, not here", () => {
    expect(scaffoldManual).toContain("they are not restated here");
  });

  it("wake points at sections, never invites a whole-file read", () => {
    expect(wake).toContain("read only the section you need");
    expect(wake).not.toContain("Read it (resource or file) when unsure HOW to act");
  });

  it("doctrine's RESOURCES lines address manual sections, not the whole file", () => {
    // Both carriers (workflow + hygiene) must name the sections; neither may
    // carry the old shotgun-read invitation.
    const resourcesLines = doctrine.match(/RESOURCES: mnemos:/g) ?? [];
    expect(resourcesLines.length).toBe(2);
    const matches = [...doctrine.matchAll(/mnemos:\/\/manual for[^\n"]+/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) expect(m[0]).toContain("§");
    expect(doctrine).not.toContain("read the manual before acting");
  });

  it("onboarding's first-capture read stops at §4 (workflows are already in context)", () => {
    expect(doctrine).toContain("first four sections (mnemos://manual, §1-4)");
    expect(doctrine).toContain("already in your context");
    expect(doctrine).not.toContain("it carries the full contract");
  });
});

describe("the live vault's manual copy does not drift from the scaffold", () => {
  it.skipIf(!liveVault)("scaffold and live copy are byte-identical", () => {
    const live = readFileSync(path.join(liveVault!, "ops", "manual.md"), "utf8");
    expect(live).toBe(scaffoldManual);
  });
});
