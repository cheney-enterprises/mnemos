/**
 * #39: mnemos_add / mnemos add can set description and project, the note validates,
 * and no path (auto-promote, later promote, configured LLM) loses them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runPromote } from "../../src/cli/promote.js";
import { runValidate } from "../../src/cli/validate.js";
import { parseFrontmatter } from "../../src/core/frontmatter.js";

let vault: string;
beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-39-"));
  await runInit({ targetDir: vault });
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MNEMOS_TEST_API_KEY;
  await fs.rm(vault, { recursive: true, force: true });
});

const fm = async (p: string) => parseFrontmatter(await fs.readFile(p, "utf8")).data as Record<string, unknown>;
async function setConfig(search: string, replacement: string): Promise<void> {
  const file = path.join(vault, "mnemos.config.yaml");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(search, replacement), "utf8");
}
function mockLlm(): void {
  process.env.MNEMOS_TEST_API_KEY = "test-key";
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        type: "decision", description: "LLM description must not win", project: ["llm-project"],
      }) } }],
    }),
  } as Response);
}

const TITLE = "agents know the description at creation time";
const DESC = "Agents have the context when they write the note, so they should supply it then";

describe("mnemos add with description and project (#39)", () => {
  it("auto-promoted note carries both fields and passes validation", async () => {
    const r = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", description: DESC, project: ["mnemos"] });
    const p = String(r.data.path);
    expect(p).toContain(`${path.sep}notes${path.sep}`);
    expect(await fm(p)).toMatchObject({ description: DESC, project: ["mnemos"] });
    const v = await runValidate({ notePath: p, startDir: vault });
    expect(v.success).toBe(true);
    expect(r.warnings.join("\n")).not.toMatch(/Missing required field: (description|project)/);
  });

  it("with auto-promote off, the inbox note has them and a later promote keeps them", async () => {
    await setConfig("auto: true", "auto: false");
    const r = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", description: DESC, project: ["mnemos"] });
    const p = String(r.data.path);
    expect(p).toContain(`${path.sep}inbox${path.sep}`);
    expect(await fm(p)).toMatchObject({ description: DESC, project: ["mnemos"] });
    await runPromote({ startDir: vault, noteName: path.basename(p) });
    expect(await fm(path.join(vault, "notes", path.basename(p)))).toMatchObject({ description: DESC, project: ["mnemos"] });
  });

  it("a configured LLM does not replace them, on auto-promote or on a later promote", async () => {
    await setConfig("provider: null", "provider: openai");
    await setConfig("api_key_env: null", "api_key_env: MNEMOS_TEST_API_KEY");
    mockLlm();
    const auto = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", description: DESC, project: ["mnemos"] });
    expect(await fm(String(auto.data.path))).toMatchObject({ description: DESC, project: ["mnemos"] });

    await setConfig("auto: true", "auto: false");
    const later = await runAdd({ startDir: vault, title: "a second note written by an agent", content: "More.", description: DESC, project: ["mnemos"] });
    await runPromote({ startDir: vault, noteName: path.basename(String(later.data.path)) });
    expect(await fm(path.join(vault, "notes", path.basename(String(later.data.path))))).toMatchObject({ description: DESC, project: ["mnemos"] });
  });

  it("an explicit promote --description still overrides what the note has", async () => {
    await setConfig("auto: true", "auto: false");
    const r = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", description: DESC });
    await runPromote({ startDir: vault, noteName: path.basename(String(r.data.path)), description: "Explicit wins" });
    expect((await fm(path.join(vault, "notes", path.basename(String(r.data.path))))).description).toBe("Explicit wins");
  });

  it("the LLM still fills a description the note does not have", async () => {
    await setConfig("provider: null", "provider: openai");
    await setConfig("api_key_env: null", "api_key_env: MNEMOS_TEST_API_KEY");
    mockLlm();
    const r = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", project: ["p39"] });
    expect((await fm(String(r.data.path))).description).toBe("LLM description must not win");
  });

  it("without a description (but with a project), description stays empty and the project lands", async () => {
    const r = await runAdd({ startDir: vault, title: TITLE, content: "Real content.", project: ["p39"] });
    const fmData = await fm(String(r.data.path));
    expect(fmData.description).toBe("");
    expect(fmData.project).toEqual(["p39"]);
  });
});
