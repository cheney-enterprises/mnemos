/**
 * Mnemos — MCP Server Integration Tests
 *
 * Tests the MCP server end-to-end over stdio JSON-RPC 2.0.
 * Each test suite creates a fresh vault, spawns the server, runs operations,
 * and tears everything down.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VERSION } from "../../src/core/version.js";
import { promises as fs } from "node:fs";

import path from "node:path";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";

let ctx: McpTestContext;

beforeAll(async () => {
  ctx = await createMcpTestContext();
}, 30000); // Server startup + embedding model download can be slow

afterAll(async () => {
  await ctx?.cleanup();
});

// ---------------------------------------------------------------------------
// 1. SERVER INITIALIZATION
// ---------------------------------------------------------------------------

describe("server initialization", () => {
  it("reports correct server name and version", () => {
    const info = ctx.client.getServerVersion();
    expect(info?.name).toBe("mnemos");
    expect(info?.version).toBe(VERSION);
  });

  it("provides instructions string", () => {
    const instructions = ctx.client.getInstructions();
    expect(instructions).toBeDefined();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
  });

  it("detects first-run on fresh vault and includes onboarding in instructions", () => {
    const instructions = ctx.client.getInstructions();
    // Fresh vault = first run, so instructions should mention onboarding
    expect(instructions).toMatch(/NEW vault|onboarding|AGENT NAME/i);
  });
});

// ---------------------------------------------------------------------------
// 2. TOOLS LISTING
// ---------------------------------------------------------------------------

describe("tools listing", () => {
  it("lists all exposed tools", async () => {
    const result = await ctx.client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    // 21 -> 14. Removed: the three navigated-exploration tools (zero sessions in
    // six months, heaviest descriptions in the surface, still reachable via
    // `mnemos explore-start/-expand/-conclude` and covered by
    // tests/cli/explore-steering.test.ts); mnemos_orient, whose onboarding moved
    // into mnemos_wake; and mnemos_status, mnemos_query, mnemos_query_important,
    // mnemos_query_fading, which were SQL queries wearing a tool costume.
    expect(toolNames).toEqual([
      "memory_sql",
      "mnemos_add",
      "mnemos_explore",
      "mnemos_forget",
      "mnemos_health",
      "mnemos_index_build",
      "mnemos_learning_reset",
      "mnemos_promote",
      "mnemos_prune",
      "mnemos_query_ranked",
      "mnemos_query_similar",
      "mnemos_suggest_scope",
      "mnemos_update",
      "mnemos_update_decision",
      "mnemos_validate",
      "mnemos_wake",
      "mnemos_warmth",
      "mnemos_whats_new",
    ]);
  });

  it("every tool has a description", async () => {
    const result = await ctx.client.listTools();
    for (const tool of result.tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
    }
  });

  it("every tool has an input schema", async () => {
    const result = await ctx.client.listTools();
    for (const tool of result.tools) {
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
    }
  });
});

describe("mnemos_warmth", () => {
  it("returns an empty warmth field on a fresh vault", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_warmth", {
      context: "token incentives and memory resonance",
      limit: 5,
    });
    const data = parsed as {
      success: boolean;
      data: { results: unknown[]; count: number };
    };

    expect(data.success).toBe(true);
    expect(Array.isArray(data.data.results)).toBe(true);
    expect(data.data.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. RESOURCES
// ---------------------------------------------------------------------------

describe("resources", () => {
  it("lists all 7 resources", async () => {
    const result = await ctx.client.listResources();
    const uris = result.resources.map((r) => r.uri).sort();

    expect(uris).toEqual([
      "mnemos://daily",
      "mnemos://goals",
      "mnemos://identity",
      "mnemos://manual",
      "mnemos://methodology",
      "mnemos://policy",
      "mnemos://reminders",
    ]);
  });

  it("serves the operating manual (intended use, scopes, naming, workflows)", async () => {
    const result = await ctx.client.readResource({ uri: "mnemos://manual" });
    const text = result.contents[0].text as string;
    // The load-bearing sections a cold agent needs.
    expect(text).toContain("Intended use");
    expect(text).toContain("GLOBAL / PROJECT / SESSION");
    expect(text).toContain("Every entry carries its project");
    expect(text).toContain("Project naming");
    expect(text).toContain("Command workflows");
    expect(text).toContain("lowercase, hyphenated");
  });

  it("reads identity resource", async () => {
    const result = await ctx.client.readResource({ uri: "mnemos://identity" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("reads goals resource", async () => {
    const result = await ctx.client.readResource({ uri: "mnemos://goals" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("reads the policy resource — the effective gates, not the config file", async () => {
    const result = await ctx.client.readResource({ uri: "mnemos://policy" });
    const text = result.contents[0].text as string;
    // The six gates must all be present — the sheet exists so the agent can
    // predict refusals; a missing gate is a silent capability claim.
    for (const gate of ["purge", "identity_update", "protected_removal", "bulk_effect", "soft_removal", "state_overwrite"]) {
      expect(text).toContain(gate);
    }
    // The removal law the doctrine teaches, rendered from the same source.
    expect(text).toContain("mnemos requests approve");
    expect(text).toContain("You cannot change policy");
  });

  it("resource content updates after mnemos_update", async () => {
    // Write new identity
    await callTool(ctx.client, "mnemos_update", {
      file: "identity",
      content: "# My Agent\n\nI am a test agent named TestBot.",
    });

    // Read it back via resource
    const result = await ctx.client.readResource({ uri: "mnemos://identity" });
    const text = result.contents[0].text as string;
    expect(text).toContain("TestBot");
  });
});

// ---------------------------------------------------------------------------
// 4. mnemos_status
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 5. mnemos_orient
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 6. mnemos_add
// ---------------------------------------------------------------------------

describe("mnemos_add", () => {
  it("creates a note successfully", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_add", {
      title: "test note created via mcp server integration test",
      type: "insight",
      content: "This note was created through the MCP protocol.",
    });
    const data = parsed as { success: boolean; data: Record<string, unknown> };

    expect(data.success).toBe(true);
    expect(data.data.path).toBeDefined();
  });

  it("accepts description and project, and the note validates (#39)", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_add", {
      title: "mcp agents can supply the schema fields at creation",
      type: "insight",
      content: "Created over MCP with description and project.",
      description: "Agents pass description and project to mnemos_add so notes validate",
      project: ["mnemos"],
    });
    const data = parsed as { success: boolean; data: { path: string } };
    expect(data.success).toBe(true);
    const { parsed: v } = await callTool(ctx.client, "mnemos_validate", { path: data.data.path });
    expect((v as { success: boolean; errors: string[] }).success).toBe(true);
  });

  it("rejects invalid titles", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_add", {
      title: "x",
      type: "insight",
    });
    const data = parsed as { success: boolean };

    expect(data.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. mnemos_update
// ---------------------------------------------------------------------------

describe("mnemos_update", () => {
  it("updates identity file", async () => {
    const newContent = "# Agent Identity\n\nName: IntegrationTestBot\nStyle: Direct and concise.";
    const { parsed } = await callTool(ctx.client, "mnemos_update", {
      file: "identity",
      content: newContent,
    });
    const data = parsed as { success: boolean; backed_up: boolean };

    expect(data.success).toBe(true);

    // Verify file was written
    const filePath = path.join(ctx.vaultDir, "self", "identity.md");
    const written = await fs.readFile(filePath, "utf8");
    expect(written).toBe(newContent);
  });

  it("creates backup before overwrite", async () => {
    // First write
    await callTool(ctx.client, "mnemos_update", {
      file: "goals",
      content: "# Goals v1\n\nFirst version.",
    });

    // Second write — should create backup of v1
    const { parsed } = await callTool(ctx.client, "mnemos_update", {
      file: "goals",
      content: "# Goals v2\n\nSecond version.",
    });
    const data = parsed as { success: boolean; backed_up: boolean };

    expect(data.backed_up).toBe(true);

    // Verify backup exists
    const historyDir = path.join(ctx.vaultDir, "self", ".history");
    const backups = await fs.readdir(historyDir);
    const goalsBackups = backups.filter((f) => f.startsWith("goals-"));
    expect(goalsBackups.length).toBeGreaterThan(0);
  });

  it("rejects unknown file names via zod validation", async () => {
    // Zod enum validation rejects invalid values at the protocol level,
    // throwing an MCP error before the handler runs. This is correct behavior.
    await expect(
      callTool(ctx.client, "mnemos_update", {
        file: "nonexistent",
        content: "should fail",
      })
    ).rejects.toThrow();
  });

  it("file=map overwrites the project map's Current State section (the ritual)", async () => {
    // A project map via the documented flow (add + promote happen in other
    // suites; here the map is written directly to keep this test focused on
    // the update path).
    const mapPath = path.join(ctx.vaultDir, "notes", "test-project-map.md");
    await fs.writeFile(
      mapPath,
      [
        "---",
        'description: "Map of the test project"',
        "type: moc",
        "project: [test-project]",
        "status: active",
        "created: 2026-11-08",
        "---",
        "",
        "# Test Project Map",
        "",
        "## Key Notes",
        "- [[test-note-one]] — the anchor note",
        "",
        "## Current State (2026-11-01)",
        "- done: old state",
      ].join("\n"),
      "utf8",
    );

    const { parsed } = await callTool(ctx.client, "mnemos_update", {
      file: "map",
      project: "test-project",
      content: "- done: ritual performable\n- next: cold-agent suite",
    });
    const data = parsed as { success: boolean; map: string; section_created: boolean };
    expect(data.success).toBe(true);
    expect(data.map).toBe("test-project-map");
    expect(data.section_created).toBe(false);

    const written = await fs.readFile(mapPath, "utf8");
    expect(written).toContain("## Current State (");
    expect(written).toContain("- done: ritual performable");
    expect(written).not.toContain("old state");
    expect(written).toContain("- [[test-note-one]] — the anchor note");
    expect(written).toContain("type: moc");
    // A backup exists — overwrite is reversible
    const historyDir = path.join(ctx.vaultDir, "notes", ".history");
    const backups = await fs.readdir(historyDir);
    expect(backups.some((f) => f.startsWith("test-project-map-"))).toBe(true);
  });

  it("file=map without project is refused with the roster pointer", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_update", {
      file: "map",
      content: "- done: x",
    });
    const data = parsed as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toContain("requires project");
  });
});

// ---------------------------------------------------------------------------
// 8. mnemos_query
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 9. mnemos_health
// ---------------------------------------------------------------------------

describe("mnemos_health", () => {
  it("returns health diagnostic", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_health");
    const data = parsed as { success: boolean; data: Record<string, unknown> };

    expect(data.success).toBe(true);
    expect(typeof data.data.noteCount).toBe("number");
    expect(typeof data.data.orphanCount).toBe("number");
    expect(typeof data.data.danglingCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 10. mnemos_promote
// ---------------------------------------------------------------------------

describe("mnemos_promote", () => {
  it("promotes an inbox note to notes/", async () => {
    // First, disable auto-promote so add goes to inbox
    const configPath = path.join(ctx.vaultDir, "mnemos.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      config.replace("auto: true", "auto: false"),
      "utf8"
    );

    // Add a note (goes to inbox because auto=false)
    const addResult = await callTool(ctx.client, "mnemos_add", {
      title: "promotable note about retrieval via mcp test",
      type: "insight",
      content: "This note will be promoted through the MCP protocol.",
    });
    const addData = addResult.parsed as {
      success: boolean;
      data: { path: string };
    };
    expect(addData.success).toBe(true);

    // Extract filename from path
    const filename = path.basename(addData.data.path);

    // Promote it
    const promoteResult = await callTool(ctx.client, "mnemos_promote", {
      path: filename,
    });
    const promoteData = promoteResult.parsed as {
      success: boolean;
      data: { promoted: Array<{ to: string }> };
    };

    expect(promoteData.success).toBe(true);
    expect(promoteData.data.promoted).toHaveLength(1);

    // Verify file is in notes/
    const notesFiles = await fs.readdir(path.join(ctx.vaultDir, "notes"));
    expect(
      notesFiles.some((f) =>
        f.includes("promotable-note-about-retrieval-via-mcp-test")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. mnemos_validate
// ---------------------------------------------------------------------------

describe("mnemos_validate", () => {
  it("validates a note against schema", async () => {
    // Add a note first (auto-promotes with default config)
    await callTool(ctx.client, "mnemos_add", {
      title: "note for validation test via mcp server harness",
      type: "insight",
      content: "Content for validation testing.",
    });

    // Find the note
    const notesDir = path.join(ctx.vaultDir, "notes");
    const files = await fs.readdir(notesDir);
    const noteFile = files.find((f) => f.includes("validation-test"));

    if (noteFile) {
      const { parsed } = await callTool(ctx.client, "mnemos_validate", {
        path: path.join(notesDir, noteFile),
      });
      expect(parsed).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. mnemos_query_important (PageRank)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 13. mnemos_query_fading
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 14. IDENTITY FLOW — First run → populated → no longer first run
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// first-run onboarding (migrated from mnemos_orient to mnemos_wake)
// ---------------------------------------------------------------------------

describe("first-run onboarding", () => {
  it("wake reports firstRun and an onboarding script on an unwritten vault", async () => {
    // Drive the vault into the unwritten state rather than assuming the
    // fixture is in it: a headers-only identity is what the scaffold leaves
    // behind and is exactly what first-run detection keys on.
    await callTool(ctx.client, "mnemos_update", { file: "identity", content: "# Identity\n\n" });

    const { parsed } = await callTool(ctx.client, "mnemos_wake");
    const data = parsed as Record<string, unknown>;
    expect(data.firstRun).toBe(true);
    expect(data).toHaveProperty("onboarding");
  });

  it("after writing a real identity, wake no longer reports firstRun", async () => {
    await callTool(ctx.client, "mnemos_update", {
      file: "identity",
      content: "# Aries\n\nI am Aries, a memory-sovereign agent. Direct, opinionated, proactive.",
    });

    const { parsed } = await callTool(ctx.client, "mnemos_wake");
    const data = parsed as Record<string, unknown>;
    expect(data.firstRun).toBe(false);
    expect(data).not.toHaveProperty("onboarding");
  });
});
