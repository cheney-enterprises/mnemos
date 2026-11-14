/**
 * MCP wake + session intake — the harness side of session-scope spec §3.
 *
 * The harness knows its own session parentage; mnemos accepts it as
 * deterministic intake (session=, parent=, lineage=). Binding is
 * constructive — never a question. A caller that passes nothing still binds
 * ONE ephemeral identity per MCP connection, not one per call.
 *
 * Server spawn note: these tests exercise dist/, so npm test's build step
 * must have run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

let ctx: McpTestContext;

beforeAll(async () => {
  ctx = await createMcpTestContext();
  // createMcpTestContext seeds a minimal config; layer the session-scope
  // flag on top (runWake loads config per call, so no server restart).
  const configPath = path.join(ctx.vaultDir, "mnemos.config.yaml");
  await fs.writeFile(
    configPath,
    "promote:\n  auto: true\npolicy:\n  gates:\n    identity_update: allow\n" +
      "retrieval:\n  session_scope:\n    enabled: true\n",
    "utf8",
  );
}, 60000);

afterAll(async () => {
  await ctx?.cleanup();
});

type WakePayload = {
  session_binding?: {
    id: string;
    ephemeral: boolean;
    record: string | null;
    lineage: "continues" | "branched_from" | null;
  };
};

describe("wake over MCP with session intake", () => {
  it("session= + parent= binds durably and writes the continues edge", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_wake", {
      session: "ses_mcp_child",
      parent: "ses_mcp_parent",
    });
    const data = parsed as WakePayload;
    expect(data.session_binding?.id).toBe("ses_mcp_child");
    expect(data.session_binding?.ephemeral).toBe(false);
    expect(data.session_binding?.lineage).toBe("continues");
    expect(data.session_binding?.record).toContain(`ops${path.sep}sessions`);

    const record = await readFrontmatterFile(data.session_binding?.record as string);
    expect(record.data?.session).toBe("ses_mcp_child");
    expect(record.data?.continues).toBe("ses_mcp_parent");
  });

  it("lineage=branched_from writes the fork edge", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_wake", {
      session: "ses_mcp_fork",
      parent: "ses_mcp_parent",
      lineage: "branched_from",
    });
    const data = parsed as WakePayload;
    expect(data.session_binding?.lineage).toBe("branched_from");
    const record = await readFrontmatterFile(data.session_binding?.record as string);
    expect(record.data?.branched_from).toBe("ses_mcp_parent");
    expect(record.data?.continues).toBeUndefined();
  });

  it("a bare wake binds an ephemeral identity — the same one next call", async () => {
    const first = (await callTool(ctx.client, "mnemos_wake", {})).parsed as WakePayload;
    expect(first.session_binding?.ephemeral).toBe(true);
    expect(first.session_binding?.record).toBeNull();

    const second = (await callTool(ctx.client, "mnemos_wake", {})).parsed as WakePayload;
    expect(second.session_binding?.id).toBe(first.session_binding?.id);
  });

  it("explicit session= beats the connection's ephemeral id", async () => {
    const { parsed } = await callTool(ctx.client, "mnemos_wake", { session: "ses_mcp_named" });
    const data = parsed as WakePayload;
    expect(data.session_binding?.id).toBe("ses_mcp_named");
    expect(data.session_binding?.ephemeral).toBe(false);
  });
});
