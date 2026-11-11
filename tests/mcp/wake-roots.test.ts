/**
 * MCP wake + roots — the "open memory vault in a repo session" flow
 * (Eric's question, 2026-11-11): the MCP server is vault-bound, so a bare
 * wake over MCP used to always end in the project question. Roots close the
 * gap: clients that advertise the roots capability (Claude Code, Cursor, Ori)
 * hand the server their workspace dirs, and wake resolves the project from
 * them via wake.project_paths — one call, no question, no agent judgment.
 *
 * The repo dir is a PLAIN directory — it does not need to be a vault. The
 * projects live in the server's vault; the bridge only maps paths to tags.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runPromote } from "../../src/cli/promote.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";

let repoDir: string;
let otherRepoDir: string;
let ctx: McpTestContext;

beforeAll(async () => {
  // Plain directories the client's roots will name — NOT vaults.
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-roots-repo-"));
  otherRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-roots-repo2-"));
  // The server's vault: projects live here.
  ctx = await createMcpTestContext({ roots: [repoDir] });
  await runAdd({
    startDir: ctx.vaultDir,
    title: "roots bridge project map",
    type: "moc",
    description: "roots bridge project map: the project reached through client roots",
    content: "Map for the roots-bridge project.",
    project: ["roots-bridge"],
  });
  await runAdd({
    startDir: ctx.vaultDir,
    title: "vault project map",
    type: "moc",
    description: "vault project map: the project reached through an explicit path",
    content: "Map for the vault-project.",
    project: ["vault-project"],
  });
  await runPromote({ startDir: ctx.vaultDir, all: true });
  await runIndexBuild(ctx.vaultDir);
}, 60000);

afterAll(async () => {
  await ctx?.cleanup();
  await fs.rm(repoDir, { recursive: true, force: true });
  await fs.rm(otherRepoDir, { recursive: true, force: true });
});

describe("wake over MCP with client roots", () => {
  it("bare wake scopes silently from the client's roots via project_paths", async () => {
    const configPath = path.join(ctx.vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      original + `\nwake:\n  project_paths:\n    "${repoDir}": roots-bridge\n`,
      "utf8",
    );
    try {
      const { parsed } = await callTool(ctx.client, "mnemos_wake", {});
      const data = parsed as {
        projectWake?: { project: string; warning?: string };
        resolution?: { method: string; note: string };
        project_choice_required?: unknown;
      };
      expect(data.projectWake?.project).toBe("roots-bridge");
      expect(data.projectWake?.warning).toBeUndefined();
      expect(data.resolution?.method).toBe("path");
      expect(data.resolution?.note).toContain(repoDir);
      expect(data.project_choice_required).toBeUndefined();
    } finally {
      await fs.writeFile(configPath, original, "utf8");
    }
  });

  it("an explicit path= argument outranks the client roots", async () => {
    const configPath = path.join(ctx.vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    // Roots name repoDir; the explicit path= names otherRepoDir. Both are
    // registered, to different projects — explicit beats discovered.
    await fs.writeFile(
      configPath,
      original +
        `\nwake:\n  project_paths:\n    "${repoDir}": roots-bridge\n    "${otherRepoDir}": vault-project\n`,
      "utf8",
    );
    try {
      const { parsed } = await callTool(ctx.client, "mnemos_wake", { path: otherRepoDir });
      const data = parsed as { projectWake?: { project: string }; resolution?: { method: string } };
      expect(data.projectWake?.project).toBe("vault-project");
      expect(data.resolution?.method).toBe("path");
    } finally {
      await fs.writeFile(configPath, original, "utf8");
    }
  });

  it("a client WITHOUT roots still gets the question (graceful degradation)", async () => {
    const ctx2 = await createMcpTestContext();
    try {
      const { parsed } = await callTool(ctx2.client, "mnemos_wake", {});
      const data = parsed as { project_choice_required?: { reason: string }; resolution?: unknown };
      expect(data.project_choice_required?.reason).toBe("wake.project_required");
      expect(data.resolution).toBeUndefined();
    } finally {
      await ctx2.cleanup();
    }
  });
});
