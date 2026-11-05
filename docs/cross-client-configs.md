# Mnemos — Cross-Client MCP Configuration

Mnemos works with any MCP-compatible client over stdio transport. Below are tested configurations.

## Claude Code (Claude Desktop)

Add to your project's `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "npx",
      "args": ["-y", "mnemos", "serve", "--mcp", "--vault", "/path/to/your/vault"],
      "autoapprove": [
        "memory_sql", "mnemos_wake", "mnemos_health", "mnemos_query_ranked",
        "mnemos_query_similar", "mnemos_explore", "mnemos_validate",
        "mnemos_index_build", "mnemos_warmth", "mnemos_whats_new"
      ]
    }
  }
}
```

## OpenCode

Add to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mnemos": {
      "type": "local",
      "command": ["mnemos", "serve", "--mcp", "--vault", "/path/to/your/vault"],
      "environment": {
        "MNEMOS_VAULT": "/path/to/your/vault"
      }
    }
  }
}
```

Or use the one-command install:

```bash
mnemos bridge opencode --scope project --activation auto --vault /path/to/your/vault
```

This installs:
- MCP config in `opencode.json`
- Lifecycle plugin at `.opencode/plugins/lifecycle.js` (first-run onboarding, session capture at idle, note validation on write)
- Bridge instructions in `AGENTS.md`

## Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "npx",
      "args": ["-y", "mnemos", "serve", "--mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "npx",
      "args": ["-y", "mnemos", "serve", "--mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

## Cline (VS Code Extension)

Add to Cline MCP settings (accessible via Cline sidebar → MCP Servers):

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "npx",
      "args": ["-y", "mnemos", "serve", "--mcp", "--vault", "/path/to/your/vault"],
      "disabled": false
    }
  }
}
```

## Generic MCP Client (SDK)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "mnemos", "serve", "--mcp", "--vault", "/path/to/vault"],
});

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);

// List tools
const { tools } = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: "mnemos_query_ranked",
  arguments: { query: "agent memory patterns", limit: 5 },
});
```

## Verification

After configuring, verify Mnemos is connected by asking your AI agent:

> "What tools do you have from Mnemos?"

It should list 17 tools: `memory_sql` plus 16 `mnemos_*` tools such as `mnemos_wake`,
`mnemos_query_ranked`, `mnemos_add`, and `mnemos_forget`.

Then test with:

> "Run mnemos_wake to boot the session"

## Notes

- Replace `/path/to/your/vault` with your actual vault directory
- Mnemos discovers the vault root by looking for `.mnemos/` marker directory
- The `--vault` flag is required when running via npx (no cwd inference)
- All 17 tools and 5 resources are available in every client
- No API keys or cloud services required — everything runs locally
