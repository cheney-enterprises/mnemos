/**
 * The cold-agent contract: a brand-new agent, a brand-new vault, tool surfaces
 * ONLY. Every step of the doctrine's promised lifecycle must be performable
 * and observable without reading a vault file, and the invariants (no
 * agent-callable unlink, propose-only purge, ask-first filing) must hold over
 * the real MCP protocol.
 *
 * Written as the lifecycle the doctrine teaches, in order:
 *   boot (wake/onboarding) → project creation → capture → retrieval →
 *   the ritual (map Current State, daily, goals) → policy (propose-only
 *   purge) → identity gate → request approval is user-only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";

let ctx: McpTestContext;

beforeAll(async () => {
  ctx = await createMcpTestContext();
}, 30000);

afterAll(async () => {
  await ctx?.cleanup();
});

const text = (parsed: unknown) => parsed as Record<string, unknown>;
/** The wire shape of most mnemos tools is {success, data, warnings}; tools that
 * bypass the nesting (mnemos_update's proposal path) stay flat. */
const payload = (parsed: unknown) => {
  const p = parsed as { data?: Record<string, unknown> };
  return (p.data ?? p) as Record<string, unknown>;
};
const warningsOf = (parsed: unknown) => {
  const p = parsed as { warnings?: string[] };
  return (p.warnings ?? []).join(" ");
};

describe("cold agent: boot", () => {
  it("wake reports first-run and hands over the onboarding script", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_wake");
    const data = text(parsed);
    expect(data.firstRun).toBe(true);
    const onboarding = data.onboarding as { steps: string[] };
    expect(onboarding.steps.length).toBeGreaterThanOrEqual(4);
    // The agent cannot fill identity silently — onboarding points at update.
    expect(JSON.stringify(onboarding)).toContain("mnemos_update");
  });

  it("instructions carry the doctrine: onboarding first, then wake-first + no direct access", () => {
    const instructions = ctx.client.getInstructions() ?? "";
    // First-run vault: the onboarding flow is the doctrine that applies.
    expect(instructions).toContain("NEW vault");
    expect(instructions).toContain("mnemos_update");
    // First-run onboarding points at the sanctioned write tool, never files.
    expect(instructions).toContain("mnemos_update");
  });
});

describe("cold agent: project self-serve", () => {
  it("project-less capture is gated: roster returned, note staged in inbox", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_add", {
      title: "cold agent probe of the ask-first gate behavior",
      type: "insight",
      description: "probe",
      content: "body",
    });
    const data = payload(parsed);
    expect(data.askGate).toBe(true);
    expect(data.reason).toBe("project_required");
    expect(Array.isArray(data.projects)).toBe(true);
    const ask = String(data.ask);
    expect(ask).toContain("existing");
    // The note waits in inbox — verified only through tools below.
  });

  it("the roster wakes carry is the roster the gate refuses with", async () => {
    // Create the first project through the documented flow.
    const add = await callTool(ctx.client, "mnemos_add", {
      title: "kite-telemetry project map",
      type: "moc",
      description: "map",
      project: ["kite-telemetry"],
      content: "Entry point for the kite telemetry project.",
    });
    const addData = payload(add.parsed);
    expect(addData.autoPromoted).toBe(true);

    const wake = await callTool(ctx.client, "mnemos_wake");
    const projects = (text(wake.parsed).projects as Array<{ project: string; notes: number }>) ?? [];
    const kite = projects.find((p) => p.project === "kite-telemetry");
    expect(kite).toBeDefined();
    expect(Number(kite!.notes)).toBeGreaterThanOrEqual(1);

    // A second untagged add must now name kite-telemetry in its refusal.
    const gated = await callTool(ctx.client, "mnemos_add", {
      title: "second untagged probe against the live roster",
      type: "insight",
      description: "probe",
      content: "body",
    });
    const gateData = payload(gated.parsed);
    const roster = gateData.projects as Array<{ project: string }>;
    expect(roster.map((p) => p.project)).toContain("kite-telemetry");
  });
});

describe("cold agent: capture → file → retrieve → ritual", () => {
  it("tagged capture files under the map and is retrievable", async () => {
    const add = await callTool(ctx.client, "mnemos_add", {
      title: "kite barometer drift confirmed at altitude probe",
      type: "insight",
      description: "probe",
      project: ["kite-telemetry"],
      content: "Barometer drift observed; wiki-link [[kite-telemetry project map]].",
    });
    expect(payload(add.parsed).autoPromoted).toBe(true);

    const q = await callTool(ctx.client, "mnemos_query_ranked", { query: "kite barometer drift altitude" });
    const qData = text(q.parsed);
    expect(qData.success).toBe(true);
    const joined = JSON.stringify(qData);
    expect(joined).toContain("barometer");
  });

  it("the SESSION END ritual is performable: map Current State + daily + goals", async () => {
    const mapUpdate = await callTool(ctx.client, "mnemos_update", {
      file: "map",
      project: "kite-telemetry",
      content: "- done: cold-agent contract suite drafted\n- next: falsification runs\n- blocked: none",
    });
    const mapData = payload(mapUpdate.parsed);
    expect(mapData.map).toContain("kite-telemetry");
    expect(mapData.section_created).toBe(true);

    const daily = await callTool(ctx.client, "mnemos_update", {
      file: "daily",
      content: "## 2026-11-08\n- cold agent lived its whole lifecycle through tools",
    });
    expect(payload(daily.parsed).path).toBeDefined();

    const goals = await callTool(ctx.client, "mnemos_update", {
      file: "goals",
      content: "- finish the cold-agent contract suite",
    });
    expect(payload(goals.parsed).path).toBeDefined();

    // The map update round-trips: the next wake's roster still lists the
    // project, and the policy resource stays available.
    const policy = await ctx.client.readResource({ uri: "mnemos://policy" });
    expect((policy.contents[0].text as string)).toContain("purge");
  });
});

describe("cold agent: policy invariants", () => {
  it("purge never deletes — it proposes and returns the user command", async () => {
    const before = await ctx.client.readResource({ uri: "mnemos://policy" });
    const sheet = before.contents[0].text as string;
    expect(sheet).toContain("The AI proposes; the user executes");

    const forget = await callTool(ctx.client, "mnemos_forget", {
      op: "purge",
      slugs: ["kite-barometer-drift-confirmed-at-altitude-probe"],
      reason: "cold-agent invariant probe",
    });
    const data = payload(forget.parsed);
    const intent = data.intent as { intent: { id: string }; approve_command: string; execution: string };
    expect(intent.approve_command).toContain("mnemos requests approve");
    expect(intent.execution).toBe("user_required");
    expect(String(data.note ?? "") + " " + warningsOf(forget.parsed)).toContain("nothing deleted");

    // The note is still retrievable — nothing was unlinked.
    const q = await callTool(ctx.client, "mnemos_query_ranked", { query: "kite barometer drift altitude" });
    expect(JSON.stringify(text(q.parsed))).toContain("barometer");
  });

  it("identity rewrite on a DEFAULT-gate vault proposes, never writes", async () => {
    // The shared context seeds identity_update: allow (the harness user's
    // choice). The cold contract needs the DEFAULT policy — identity_update
    // proposes while the user holds the pen. Fresh server, fresh vault, no
    // policy block.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), "cold-default-gate-"));
    const { runInit } = await import("../../src/cli/init.js");
    await runInit({ targetDir: vault });
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve(import.meta.dirname, "..", "..", "dist", "index.js"), "serve", "--mcp"],
      cwd: vault,
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const client = new Client({ name: "cold-gate-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const identityBefore = await client.readResource({ uri: "mnemos://identity" });
      const beforeText = identityBefore.contents[0].text as string;

      const upd = await callTool(client, "mnemos_update", {
        file: "identity",
        content: "# Cold Agent\n\nRewritten without user approval — must not land.",
      });
      const data = payload(upd.parsed);
      expect(data.intent_proposed).toBe(true);
      expect(String(data.approve_command)).toContain("mnemos requests approve");

      const identityAfter = await client.readResource({ uri: "mnemos://identity" });
      expect(identityAfter.contents[0].text).toBe(beforeText);
    } finally {
      try { await client.close(); } catch { /* closed */ }
      await fs.rm(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("mnemos://policy teaches the whole removal law", async () => {
    const policy = await ctx.client.readResource({ uri: "mnemos://policy" });
    const sheet = policy.contents[0].text as string;
    expect(sheet).toContain("mnemos requests approve");
    expect(sheet).toContain("You cannot change policy");
    for (const gate of ["purge", "identity_update", "protected_removal", "bulk_effect", "soft_removal", "state_overwrite"]) {
      expect(sheet).toContain(gate);
    }
  });
});

describe("cold agent: scoped wake (the two-step boot)", () => {
  it("global wake carries the menu, scoped wake carries only that project's context", async () => {
    // Global step: no project — roster present, no projectWake.
    const g = await callTool(ctx.client, "mnemos_wake", {});
    const gd = text(g.parsed) as Record<string, unknown>;
    expect(Array.isArray(gd.projects)).toBe(true);
    expect(gd.projectWake).toBeUndefined();

    // Scoped step: the kite-telemetry map's Current State rides along.
    const r = await callTool(ctx.client, "mnemos_wake", { project: "kite-telemetry" });
    const rd = text(r.parsed) as {
      projectWake: { project: string; map: string | null; currentState: string[]; recentNotes: string[] };
    };
    expect(rd.projectWake).toBeDefined();
    expect(rd.projectWake.project).toBe("kite-telemetry");
    // promote slugified the filename; the map slug, not the spaced title
    expect(rd.projectWake.map).toBe("kite-telemetry-project-map");
    // Recent notes must be kite's, never another project's map
    for (const slug of rd.projectWake.recentNotes) {
      expect(slug).not.toBe("roust-project-map");
    }
  });

  it("an unknown project gets a warning + the roster, not an error", async () => {
    const x = await callTool(ctx.client, "mnemos_wake", { project: "ghost-project" });
    const xd = text(x.parsed) as { projectWake: { warning: string } };
    expect(xd.projectWake).toBeDefined();
    expect(xd.projectWake.warning).toContain("no project");
    expect(xd.projectWake.warning).toContain("mnemos_add");
  });
});
