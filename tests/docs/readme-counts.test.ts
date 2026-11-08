import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The README advertised "16 tools" while serve.ts registered 21, and "17 CLI
// commands" against 18. Nobody noticed across five tool additions. For a repo
// whose README is the product surface, an undercount is not cosmetic -- it is
// a published claim that five capabilities do not exist.
//
// Counted here rather than asserted as literals so adding a tool fails this
// test until the README is updated, which is the only mechanism that has ever
// kept these honest.
//
// Deliberately NOT asserted: the test count. It changes on every commit, so
// pinning it would produce a failure that means nothing and trains people to
// edit the number without reading it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const readme = read("README.md");
const serve = read("src/cli/serve.ts");
const index = read("src/index.ts");

const toolCount = new Set(serve.match(/mnemos_[a-z_]+/g) ?? []).size;
const resourceCount = (serve.match(/server\.resource\(/g) ?? []).length;
const commandCount = (index.match(/^\s*\.command\(/gm) ?? []).length;

// --help is a product surface: an undocumented command invites exactly the
// trial-and-error that burned Eric (bare `mnemos wake` from ~ → "No .mnemos
// marker found" with no hint that the vault is elsewhere or that
// MNEMOS_VAULT exists). These pins keep the help honest as commands change.
describe("CLI --help carries the vault contract and no bare commands", () => {
  it("every registered command has a description", () => {
    const commands = [...index.matchAll(/\.command\("([a-z-]+)[^"]*"/g)].map((m) => m[1]);
    expect(commands.length).toBe(commandCount);
    for (const m of index.matchAll(/\.command\("([a-z-]+)[^"]*"/g)) {
      const c = m[1];
      // Window from the matched .command( line itself — command names may
      // carry argument hints ("whats-new [version]"), so build the window
      // from the match, never from a reconstructed bare-name anchor.
      const after = index.slice(m.index ?? 0, (m.index ?? 0) + 400);
      expect(after, `command '${c}' has no .description()`).toMatch(/\.description\(/);
    }
  });

  it("'mnemos sql --help' is reachable (the argv-munging guard must exempt help)", () => {
    // The sql guard splices '--' before args that look like unknown options;
    // without a --help exemption it turned the help flag into the query
    // argument and help became unreachable on exactly one command.
    expect(index).toContain('!argv.includes("--help") && !argv.includes("-h")');
  });

  it("top-level help documents vault resolution (env, walk, global fallback)", () => {
    // The after-help text lives in src/index.ts; pin its load-bearing lines.
    expect(index).toContain("Vault resolution");
    expect(index).toContain("MNEMOS_VAULT");
    expect(index).toContain("cd into it and every command works");
    expect(index).toContain("~/.mnemos-memory");
  });
});

describe("README advertises the surface that exists", () => {
  it("states the registered MCP tool count everywhere it appears", () => {
    const claims = [...readme.matchAll(/(\d+)\s+(?:MCP\s+)?tools/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(toolCount);
  });

  it("states the registered resource count", () => {
    const claims = [...readme.matchAll(/(\d+)\s+resources/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(resourceCount);
  });

  it("states the registered CLI command count", () => {
    const claims = [...readme.matchAll(/(\d+)\s+CLI commands/g)].map((m) => Number(m[1]));
    expect(claims.length).toBeGreaterThan(0);
    for (const claimed of claims) expect(claimed).toBe(commandCount);
  });

  // A tool the README *offers* but serve.ts does not register is worse than a
  // wrong total: an agent reading the table will call it and get an error.
  //
  // Scoped to table rows, not the whole file. The first version of this test
  // checked every mention and immediately failed on the migration table that
  // documents which tools were removed and what replaced them -- naming a
  // dead tool in order to say it is dead is the opposite of the failure being
  // guarded against. A row is `| \`mnemos_x\` | description |`; prose is prose.
  it("offers no tool in its table that is not registered", () => {
    // The README holds two tables of the same shape: what is offered, and a
    // migration table naming removed tools so readers can find the
    // replacement. Naming a dead tool to say it is dead is the opposite of
    // the failure being guarded against, so the scan stops where the
    // removal section begins.
    const start = readme.indexOf("## MCP Tools");
    const end = readme.indexOf("Five tools were removed", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const registered = new Set(serve.match(/mnemos_[a-z_]+/g) ?? []);
    const offered = [
      ...readme.slice(start, end).matchAll(/^\|\s*`(mnemos_[a-z_]+|memory_sql)`\s*\|/gm),
    ].map((m) => m[1]);

    expect(offered.length).toBeGreaterThan(5);
    const phantom = [...new Set(offered)].filter(
      (t) => t !== "memory_sql" && !registered.has(t),
    );
    expect(phantom).toEqual([]);
  });
});
