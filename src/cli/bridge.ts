import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "yaml";
import {
  installWindowsTerminalProfile,
  uninstallWindowsTerminalProfile,
} from "../core/windows-terminal.js";
import {
  buildGenericInstallOutput,
  getClaudeGlobalPaths,
  getClaudeProjectPaths,
  getCodexGlobalPaths,
  getCursorGlobalPaths,
  getCursorProjectPaths,
  getHermesGlobalPaths,
  getHermesProjectPaths,
  getOriGlobalPaths,
  getOpenCodeGlobalPaths,
  getOpenCodeProjectPaths,
  resolveBridgePlan,
  type BridgeActivation,
  type BridgePlan,
  type BridgeRequest,
} from "../core/bridge.js";

const BRIDGE_SENTINEL = "<!-- mnemos-bridge:claude-code -->";
const MNEMOS_MCP_SENTINEL = "mnemos";
const MNEMOS_HOOK_SCRIPT_NAMES = ["status.mjs", "validate.mjs", "capture.mjs"] as const;
// status.mjs was named orient.mjs before the orient tool was superseded by
// mnemos_wake. The old name is detection-only: uninstalls of pre-rename
// installs must still find and remove its hooks. It is never copied.
const MNEMOS_LEGACY_HOOK_SCRIPT_NAMES = ["orient.mjs"] as const;

function claudeSnippet(activation: BridgeActivation): string {
  const hookLine =
    activation === "auto"
      ? "- Hooks in `.claude/hooks/`: `status.mjs` prints vault status at session start, `capture.mjs` writes a session insight at Stop, `validate.mjs` validates vault-note writes."
      : "- Manual activation: only `validate.mjs` is installed — automatic session hooks are disabled.";

  return `# Mnemos — Claude Code Bridge

Mnemos is attached as the \`mnemos\` MCP server. Its server instructions carry the complete
usage doctrine (session boot, retrieval, capture, forgetting) — this block records only what
this client adds.

${hookLine}
- Boot: call \`mnemos_wake\` at session start.${activation === "auto" ? " The status hook prints raw counts; wake returns the actual briefing." : " No hook loads it for you."}
`;
}

function localSettings(activation: BridgeActivation) {
  const hooks: Record<string, unknown[]> = {
    PostToolUse: [
      {
        matcher: "Write",
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/validate.mjs",
            timeout: 5,
          },
        ],
      },
    ],
  };

  if (activation === "auto") {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/status.mjs",
            timeout: 10,
          },
        ],
      },
    ];
    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: "node .claude/hooks/capture.mjs",
            timeout: 10,
          },
        ],
      },
    ];
  }

  return { hooks };
}

function globalSettings(hooksDir: string, activation: BridgeActivation) {
  const statusCmd = `node "${path.join(hooksDir, "status.mjs")}"`;
  const validateCmd = `node "${path.join(hooksDir, "validate.mjs")}"`;
  const captureCmd = `node "${path.join(hooksDir, "capture.mjs")}"`;
  const hooks: Record<string, unknown[]> = {
    PostToolUse: [
      {
        matcher: "Write",
        hooks: [{ type: "command", command: validateCmd, timeout: 5 }],
      },
    ],
  };

  if (activation === "auto") {
    hooks.SessionStart = [
      {
        hooks: [{ type: "command", command: statusCmd, timeout: 10 }],
      },
    ];
    hooks.Stop = [
      {
        hooks: [{ type: "command", command: captureCmd, timeout: 10 }],
      },
    ];
  }

  return { hooks };
}

function hookEntryHasMnemosMarker(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as Record<string, unknown>).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h: unknown) => {
    if (!h || typeof h !== "object") return false;
    const cmd = (h as Record<string, unknown>).command;
    return (
      typeof cmd === "string" &&
      (cmd.replace(/\\/g, "/").includes("hooks/mnemos/") ||
        [...MNEMOS_HOOK_SCRIPT_NAMES, ...MNEMOS_LEGACY_HOOK_SCRIPT_NAMES].some((scriptName) =>
          cmd.replace(/\\/g, "/").includes(`.claude/hooks/${scriptName}`),
        ))
    );
  });
}

type SettingsShape = {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
};

type McpShape = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

type BridgeMutationKind = "installed" | "updated" | "uninstalled" | "noop";
type BridgeInstallStatus = {
  installed: boolean;
  scope: "project" | "global";
  client: "claude-code" | "cursor" | "codex" | "hermes" | "opencode" | "ori";
  configPaths: string[];
  mcpPath?: string;
  configPath?: string;
  settingsPath?: string;
  instructionsPath?: string;
  hooksDir?: string;
  pluginDir?: string;
  activation: BridgeActivation | "unknown" | null;
  resolvedVault: string | null;
  details: string[];
};

export function mergeSettings(existing: SettingsShape, incoming: SettingsShape): SettingsShape {
  const merged: SettingsShape = {
    ...existing,
    hooks: { ...(existing.hooks ?? {}) },
  };

  const incomingHooks = incoming.hooks ?? {};
  for (const [event, entries] of Object.entries(incomingHooks)) {
    const current = (merged.hooks![event] ?? []) as unknown[];
    const alreadyInstalled = current.some(hookEntryHasMnemosMarker);
    if (!alreadyInstalled) {
      merged.hooks![event] = [...current, ...entries];
    }
  }

  if (incoming.hooks) {
    for (const event of Object.keys(merged.hooks ?? {})) {
      if (!(event in incoming.hooks) && (merged.hooks?.[event] ?? []).some(hookEntryHasMnemosMarker)) {
        delete merged.hooks![event];
      }
    }
  }

  return merged;
}

export function mergeMcpConfig(existing: McpShape, plan: BridgePlan): McpShape {
  const next: McpShape = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}) },
  };

  next.mcpServers![MNEMOS_MCP_SENTINEL] = {
    command: plan.server.command,
    args: plan.server.args,
    ...(Object.keys(plan.server.env).length > 0 ? { env: plan.server.env } : {}),
  };

  return next;
}

export function removeMnemosFromSettings(existing: SettingsShape): SettingsShape {
  const next: SettingsShape = {
    ...existing,
    hooks: { ...(existing.hooks ?? {}) },
  };

  for (const [event, entries] of Object.entries(next.hooks ?? {})) {
    const filtered = entries.filter((entry) => !hookEntryHasMnemosMarker(entry));
    if (filtered.length === 0) {
      delete next.hooks![event];
    } else {
      next.hooks![event] = filtered;
    }
  }

  if (next.hooks && Object.keys(next.hooks).length === 0) {
    delete next.hooks;
  }

  return next;
}

export function removeMnemosFromMcpConfig(existing: McpShape): McpShape {
  const next: McpShape = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}) },
  };

  if (next.mcpServers) {
    delete next.mcpServers[MNEMOS_MCP_SENTINEL];
    if (Object.keys(next.mcpServers).length === 0) {
      delete next.mcpServers;
    }
  }

  return next;
}

function classifyMcpMutation(existing: McpShape, next: McpShape, uninstall = false): BridgeMutationKind {
  const hadMnemos = Boolean(existing.mcpServers && MNEMOS_MCP_SENTINEL in existing.mcpServers);
  const hasMnemos = Boolean(next.mcpServers && MNEMOS_MCP_SENTINEL in next.mcpServers);
  if (uninstall) return hadMnemos ? "uninstalled" : "noop";
  if (!hadMnemos && hasMnemos) return "installed";
  if (hadMnemos && hasMnemos) return "updated";
  return "noop";
}

function classifySettingsMutation(existing: SettingsShape, next: SettingsShape, uninstall = false): BridgeMutationKind {
  const hadMnemos = Object.values(existing.hooks ?? {}).some((entries) => entries.some(hookEntryHasMnemosMarker));
  const hasMnemos = Object.values(next.hooks ?? {}).some((entries) => entries.some(hookEntryHasMnemosMarker));
  if (uninstall) return hadMnemos ? "uninstalled" : "noop";
  if (!hadMnemos && hasMnemos) return "installed";
  if (hadMnemos && hasMnemos) return "updated";
  return "noop";
}

async function mergeIntoSettingsFile(settingsPath: string, incoming: SettingsShape, uninstall = false): Promise<BridgeMutationKind> {
  let existing: SettingsShape = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    existing = JSON.parse(raw) as SettingsShape;
  } catch {
    // file missing or unparseable - start fresh
  }

  const merged = uninstall ? removeMnemosFromSettings(existing) : mergeSettings(existing, incoming);
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2));
  return classifySettingsMutation(existing, merged, uninstall);
}

async function mergeIntoMcpFile(mcpPath: string, plan: BridgePlan, uninstall = false): Promise<BridgeMutationKind> {
  let existing: McpShape = {};
  try {
    const raw = await fs.readFile(mcpPath, "utf8");
    existing = JSON.parse(raw) as McpShape;
  } catch {
    // file missing or unparseable - start fresh
  }

  const merged = uninstall ? removeMnemosFromMcpConfig(existing) : mergeMcpConfig(existing, plan);
  await fs.writeFile(mcpPath, JSON.stringify(merged, null, 2));
  return classifyMcpMutation(existing, merged, uninstall);
}

function getClaudeAdaptersDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "adapters", "claude-code");
}

async function copyHooks(adaptersDir: string, hooksDir: string): Promise<void> {
  await fs.mkdir(hooksDir, { recursive: true });
  for (const hook of MNEMOS_HOOK_SCRIPT_NAMES) {
    await fs.copyFile(
      path.join(adaptersDir, "hooks", hook),
      path.join(hooksDir, hook)
    );
  }
}

/**
 * Write or refresh a managed bridge block. The sentinel marks block start;
 * everything from the sentinel to EOF is bridge-managed territory (matching
 * removeClaudeInstructions and friends). Re-bridging replaces the block in
 * place so snippet upgrades propagate instead of freezing at first install.
 */
async function upsertBridgeBlock(
  filePath: string,
  sentinel: string,
  snippet: string,
): Promise<BridgeMutationKind> {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    // file doesn't exist yet
  }
  const block = `\n\n${sentinel}\n${snippet}`;
  let next: string;
  if (existing.includes(sentinel)) {
    next = existing.slice(0, existing.indexOf(sentinel)).replace(/\s*$/, "") + block;
  } else {
    next = existing.length > 0 ? existing.replace(/\s*$/, "") + block : block;
  }
  if (next === existing) return "noop";
  await fs.writeFile(filePath, next, "utf8");
  return existing.length > 0 ? "updated" : "installed";
}

async function appendClaudeInstructions(claudePath: string, activation: BridgeActivation): Promise<BridgeMutationKind> {
  return upsertBridgeBlock(claudePath, BRIDGE_SENTINEL, claudeSnippet(activation));
}

export function removeClaudeInstructions(content: string): string {
  const marker = `\n\n${BRIDGE_SENTINEL}\n`;
  const idx = content.indexOf(marker);
  if (idx >= 0) return content.slice(0, idx);
  return content;
}

async function uninstallClaudeInstructions(claudePath: string): Promise<BridgeMutationKind> {
  try {
    const existing = await fs.readFile(claudePath, "utf8");
    const next = removeClaudeInstructions(existing);
    await fs.writeFile(claudePath, next, "utf8");
    return next === existing ? "noop" : "uninstalled";
  } catch {
    return "noop";
  }
}

function summarizeMutations(kinds: BridgeMutationKind[]): BridgeMutationKind {
  if (kinds.includes("updated")) return "updated";
  if (kinds.includes("installed")) return "installed";
  if (kinds.includes("uninstalled")) return "uninstalled";
  return "noop";
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function extractVaultFromMcpConfig(config: McpShape | null): string | null {
  const entry = config?.mcpServers?.[MNEMOS_MCP_SENTINEL];
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const env = record.env;
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>).MNEMOS_VAULT;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const args = record.args;
  if (Array.isArray(args)) {
    const vaultIndex = args.findIndex((value) => value === "--vault");
    if (vaultIndex >= 0 && typeof args[vaultIndex + 1] === "string") {
      return args[vaultIndex + 1] as string;
    }
  }
  return null;
}

function detectClaudeActivation(settings: SettingsShape | null): BridgeActivation | "unknown" | null {
  const hooks = settings?.hooks ?? {};
  const hasMnemosent = (hooks.SessionStart ?? []).some(hookEntryHasMnemosMarker);
  const hasValidate = (hooks.PostToolUse ?? []).some(hookEntryHasMnemosMarker);
  if (hasMnemosent) return "auto";
  if (hasValidate) return "manual";
  return null;
}

function buildCodexTable(plan: BridgePlan): string {
  const lines = ["[mcp_servers.mnemos]", `command = ${JSON.stringify(plan.server.command)}`];

  if (plan.server.args.length > 0) {
    lines.push(`args = [${plan.server.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
  }

  const envEntries = Object.entries(plan.server.env);
  if (envEntries.length > 0) {
    lines.push("[mcp_servers.mnemos.env]");
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }

  return lines.join("\n");
}

function codexTableRegex(): RegExp {
  return /^\[mcp_servers\.mnemos\]\r?\n(?:.*\r?\n)*?(?=^\[|$(?![\r\n]))/m;
}

function mergeCodexConfig(existing: string, plan: BridgePlan): string {
  const table = buildCodexTable(plan);
  const regex = codexTableRegex();
  if (regex.test(existing)) {
    return existing.replace(regex, table);
  }

  const trimmed = existing.trimEnd();
  if (trimmed.length === 0) return `${table}\n`;
  return `${trimmed}\n\n${table}\n`;
}

function removeMnemosFromCodexConfig(existing: string): string {
  const next = existing.replace(codexTableRegex(), "").replace(/\n{3,}/g, "\n\n").trimEnd();
  return next.length > 0 ? `${next}\n` : "";
}

function classifyCodexMutation(existing: string, next: string, uninstall = false): BridgeMutationKind {
  const hadMnemos = codexTableRegex().test(existing);
  const hasMnemos = codexTableRegex().test(next);
  if (uninstall) return hadMnemos ? "uninstalled" : "noop";
  if (!hadMnemos && hasMnemos) return "installed";
  if (hadMnemos && hasMnemos && existing !== next) return "updated";
  return "noop";
}

async function mergeIntoCodexConfigFile(configPath: string, plan: BridgePlan, uninstall = false): Promise<BridgeMutationKind> {
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf8");
  } catch {
    // file missing - start fresh
  }

  const next = uninstall ? removeMnemosFromCodexConfig(existing) : mergeCodexConfig(existing, plan);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, next, "utf8");
  return classifyCodexMutation(existing, next, uninstall);
}

function extractVaultFromCodexConfig(content: string | null): string | null {
  if (!content) return null;
  const match = content.match(/\[mcp_servers\.mnemos\][\s\S]*?args\s*=\s*\[(.*?)\]/m);
  if (!match) return null;
  const vaultMatch = match[1].match(/"--vault"\s*,\s*"([^"]+)"/);
  if (!vaultMatch) return null;
  try {
    return JSON.parse(`"${vaultMatch[1]}"`) as string;
  } catch {
    return vaultMatch[1];
  }
}

async function inspectClaudeInstall(startDir: string, scope: "project" | "global"): Promise<BridgeInstallStatus> {
  const paths = scope === "global" ? getClaudeGlobalPaths() : getClaudeProjectPaths(startDir);
  const [settings, mcp, instructions] = await Promise.all([
    readJsonFile<SettingsShape>(paths.settingsPath),
    readJsonFile<McpShape>(paths.mcpPath),
    fs.readFile(paths.instructionsPath, "utf8").catch(() => null),
  ]);

  const hasSettings = Object.values(settings?.hooks ?? {}).some((entries) => entries.some(hookEntryHasMnemosMarker));
  const hasMcp = Boolean(mcp?.mcpServers?.[MNEMOS_MCP_SENTINEL]);
  const hasInstructions = typeof instructions === "string" && instructions.includes(BRIDGE_SENTINEL);
  const installed = hasSettings || hasMcp || hasInstructions;
  const details: string[] = [];

  if (hasMcp) details.push(`MCP config present at ${paths.mcpPath}.`);
  if (hasSettings) details.push(`Mnemos hook entries present at ${paths.settingsPath}.`);
  if (hasInstructions) details.push(`Mnemos bridge instructions present at ${paths.instructionsPath}.`);
  if (!installed) details.push("No Mnemos-managed Claude bridge config detected.");

  return {
    installed,
    client: "claude-code",
    scope,
    configPaths: [paths.settingsPath, paths.mcpPath, paths.instructionsPath],
    mcpPath: paths.mcpPath,
    settingsPath: paths.settingsPath,
    instructionsPath: paths.instructionsPath,
    hooksDir: paths.hooksDir,
    activation: detectClaudeActivation(settings),
    resolvedVault: extractVaultFromMcpConfig(mcp),
    details,
  };
}

async function inspectCursorInstall(startDir: string, scope: "project" | "global"): Promise<BridgeInstallStatus> {
  const paths = scope === "global" ? getCursorGlobalPaths() : getCursorProjectPaths(startDir);
  const mcp = await readJsonFile<McpShape>(paths.mcpPath);
  const hasMcp = Boolean(mcp?.mcpServers?.[MNEMOS_MCP_SENTINEL]);
  const details = hasMcp
    ? [`MCP config present at ${paths.mcpPath}.`]
    : ["No Mnemos-managed Cursor MCP config detected."];

  return {
    installed: hasMcp,
    client: "cursor",
    scope,
    configPaths: [paths.mcpPath],
    mcpPath: paths.mcpPath,
    activation: hasMcp ? "unknown" : null,
    resolvedVault: extractVaultFromMcpConfig(mcp),
    details,
  };
}

async function inspectCodexInstall(): Promise<BridgeInstallStatus> {
  const paths = getCodexGlobalPaths();
  const content = await fs.readFile(paths.configPath, "utf8").catch(() => null);
  const installed = content ? codexTableRegex().test(content) : false;
  const details = installed
    ? [`MCP config present at ${paths.configPath}.`]
    : ["No Mnemos-managed Codex MCP config detected."];

  return {
    installed,
    client: "codex",
    scope: "global",
    configPaths: [paths.configPath],
    configPath: paths.configPath,
    activation: installed ? "unknown" : null,
    resolvedVault: extractVaultFromCodexConfig(content),
    details,
  };
}

export async function runBridgeStatus(startDir: string) {
  const [claudeProject, claudeGlobal, cursorProject, cursorGlobal, codexGlobal, hermesGlobal, opencodeProject, opencodeGlobal, oriGlobal] = await Promise.all([
    inspectClaudeInstall(startDir, "project"),
    inspectClaudeInstall(startDir, "global"),
    inspectCursorInstall(startDir, "project"),
    inspectCursorInstall(startDir, "global"),
    inspectCodexInstall(),
    inspectHermesInstall(),
    inspectOpenCodeInstall(startDir, "project"),
    inspectOpenCodeInstall(startDir, "global"),
    inspectOriInstall(),
  ]);

  return {
    success: true,
    data: {
      clients: {
        "claude-code": {
          project: claudeProject,
          global: claudeGlobal,
          active: claudeProject.installed ? claudeProject : claudeGlobal.installed ? claudeGlobal : null,
        },
        cursor: {
          project: cursorProject,
          global: cursorGlobal,
          active: cursorProject.installed ? cursorProject : cursorGlobal.installed ? cursorGlobal : null,
        },
        codex: codexGlobal,
        hermes: hermesGlobal,
        opencode: {
          project: opencodeProject,
          global: opencodeGlobal,
          active: opencodeProject.installed ? opencodeProject : opencodeGlobal.installed ? opencodeGlobal : null,
        },
        ori: oriGlobal,
      },
      precedence: "project-over-global",
      instructions: [
        "Project installs override global installs when both exist for the same client.",
        "Cursor activation is reported as unknown because the adapter currently stores MCP wiring only, not startup behavior.",
        "Codex stores MCP servers in ~/.codex/config.toml only.",
        "Hermes stores MCP servers in ~/.hermes/config.yaml. Auto activation installs a native plugin at ~/.hermes/plugins/mnemos/.",
        "OpenCode uses .opencode/plugins/lifecycle.js for lifecycle hooks (onboarding, capture, validate).",
        "Ori stores MCP servers in ~/.ori/mcp.json. Global only — the harness is single-user and carries its own session lifecycle.",
      ],
      warnings: [],
    },
  };
}

export type ClientInstallSummary = {
  registered: Array<{ client: string; scope: string; vault: string | null }>;
};

/**
 * One-call "which clients already point at mnemos?" — the raw install map
 * (runBridgeStatus) reduced to a flat registered list. Used by the
 * onboarding hints in status and init: the tool telling the human the next
 * step instead of the human reading docs to find it.
 */
export async function inspectClientInstalls(startDir: string): Promise<ClientInstallSummary> {
  const status = await runBridgeStatus(startDir);
  const registered: ClientInstallSummary["registered"] = [];
  for (const [client, entry] of Object.entries(
    status.data.clients as Record<string, unknown>,
  )) {
    // claude-code/cursor/opencode wrap { project, global, active }; codex,
    // hermes, ori are the install object directly.
    const active =
      (entry as { active?: { installed?: boolean } }).active ?? entry;
    if ((active as { installed?: boolean })?.installed) {
      registered.push({
        client,
        scope: (active as { scope?: string }).scope ?? "unknown",
        vault: (active as { resolvedVault?: string | null }).resolvedVault ?? null,
      });
    }
  }
  return { registered };
}

/**
 * The onboarding hint, pure and testable: what a human should do next about
 * client wiring, given what is already registered. Zero registered clients
 * gets the full walk-through (the new-user moment); any registration gets a
 * one-line acknowledgment with the command to add more — a nudge, never a nag.
 */
export function buildOnboardingNextSteps(registered: ClientInstallSummary["registered"]): string[] {
  if (registered.length === 0) {
    return [
      "No MCP client is registered with this vault yet — agents reach memory through a client (MCP), the CLI, or the library.",
      "Wire a known client (one command): mnemos bridge claude-code|cursor|codex|hermes|opencode|ori --vault <vault-dir>",
      "Any other MCP client: mnemos bridge generic --vault <vault-dir> — prints the config block to paste.",
      "CLI-only start (no client): run mnemos wake from the vault directory.",
    ];
  }
  return [
    `Registered clients: ${registered.map((r) => `${r.client} (${r.scope})`).join(", ")}. ` +
      "Add or re-wire: mnemos bridge <client> --vault <vault-dir>; for any other MCP client: mnemos bridge generic.",
  ];
}

export async function runBridgeClaudeCode(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "claude-code", startDir });
  const paths = plan.scope === "global" ? getClaudeGlobalPaths() : getClaudeProjectPaths(startDir);
  const adaptersDir = getClaudeAdaptersDir();

  let settingsMutation: BridgeMutationKind = "noop";
  let mcpMutation: BridgeMutationKind = "noop";
  let instructionsMutation: BridgeMutationKind = "noop";

  if (request.uninstall) {
    settingsMutation = await mergeIntoSettingsFile(paths.settingsPath, {}, true);
    mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan, true);
    instructionsMutation = await uninstallClaudeInstructions(paths.instructionsPath);
    await uninstallWindowsTerminalProfile();
  } else {
    await copyHooks(adaptersDir, paths.hooksDir);
    settingsMutation = await mergeIntoSettingsFile(
      paths.settingsPath,
      plan.scope === "global" ? globalSettings(paths.hooksDir, plan.activation) : localSettings(plan.activation),
    );
    mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan);
    instructionsMutation = await appendClaudeInstructions(paths.instructionsPath, plan.activation);
  }

  const mutation = summarizeMutations([settingsMutation, mcpMutation, instructionsMutation]);

  // Install Windows Terminal profile with Mnemos icon (non-fatal, Windows only)
  const wtResult = request.uninstall
    ? await uninstallWindowsTerminalProfile()
    : await installWindowsTerminalProfile();

  const warnings = [...plan.warnings];
  if (wtResult.error) {
    warnings.push(`Windows Terminal profile: ${wtResult.error}`);
  }

  return {
    success: true,
    data: {
      ...plan,
      operation: request.uninstall ? "uninstall" : "install",
      mutation,
      hooksDir: paths.hooksDir,
      settingsPath: paths.settingsPath,
      mcpPath: paths.mcpPath,
      instructionsPath: paths.instructionsPath,
      windowsTerminal: wtResult,
    },
    warnings,
  };
}

export async function runBridgeClaudeCodeGlobal(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  return runBridgeClaudeCode(startDir, { ...request, scope: "global" });
}

export async function runBridgeGeneric(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "generic", startDir });
  const data = buildGenericInstallOutput(plan);
  if (request.uninstall) {
    data.instructions = [
      "Generic uninstall is manual: remove the `mnemos` MCP server entry from your client config.",
      ...data.instructions,
    ];
  }
  return {
    success: true,
    data: {
      ...data,
      operation: request.uninstall ? "uninstall" : "install",
      mutation: request.uninstall ? "manual" : "noop",
    },
    warnings: plan.warnings,
  };
}

export async function runBridgeCursor(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "cursor", startDir });
  const paths = plan.scope === "global" ? getCursorGlobalPaths() : getCursorProjectPaths(startDir);

  await fs.mkdir(path.dirname(paths.mcpPath), { recursive: true });
  const mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan, request.uninstall === true);

  const warnings = [...plan.warnings];
  if (!request.uninstall && plan.activation === "auto") {
    warnings.push(
      "Cursor adapter currently installs MCP config only. Auto activation still requires client-side startup instructions or prompts.",
    );
  }

  const instructions = [...plan.instructions];
  instructions.push(
    request.uninstall
      ? `Removed Mnemos MCP config from ${paths.mcpPath}.`
      : `Cursor MCP config written to ${paths.mcpPath}.`,
  );
  if (!request.uninstall) {
    instructions.push(
      "Cursor has no hook wiring in this adapter — the MCP server instructions carry the wake-first doctrine. Optionally add a `.cursor/rules` entry: \"At session start, call mnemos_wake.\"",
    );
  }

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      operation: request.uninstall ? "uninstall" : "install",
      mutation: mcpMutation,
      mcpPath: paths.mcpPath,
    },
    warnings,
  };
}

export async function runBridgeCodex(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "codex", startDir });
  const paths = getCodexGlobalPaths();
  const configMutation = await mergeIntoCodexConfigFile(paths.configPath, plan, request.uninstall === true);

  const warnings = [...plan.warnings];
  const instructions = [...plan.instructions];
  instructions.push(
    request.uninstall
      ? `Removed Mnemos MCP config from ${paths.configPath}.`
      : `Codex MCP config written to ${paths.configPath}.`,
  );

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      client: "codex",
      operation: request.uninstall ? "uninstall" : "install",
      mutation: configMutation,
      configPath: paths.configPath,
    },
    warnings,
  };
}

// ── Hermes adapter ──────────────────────────────────────────────────────────

const HERMES_BRIDGE_SENTINEL = "<!-- mnemos-bridge:hermes -->";
const HERMES_PLUGIN_MARKER = "plugin.yaml";

type HermesConfig = {
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
};

function hermesSnippet(activation: BridgeActivation): string {
  const pluginLine =
    activation === "auto"
      ? "- Lifecycle plugin at `~/.hermes/plugins/mnemos/`: prints vault health at session start, captures a session insight at session end."
      : "- Manual activation: no plugin installed — no automatic session capture.";

  return `# Mnemos — Hermes Bridge

Mnemos is attached as the \`mnemos\` MCP server. Its server instructions carry the complete
usage doctrine (session boot, retrieval, capture, forgetting) — this block records only what
this client adds.

${pluginLine}
- Boot: call \`mnemos_wake\` at session start.
`;
}

export function mergeHermesConfig(existing: HermesConfig, plan: BridgePlan): HermesConfig {
  const next: HermesConfig = { ...existing };
  if (!next.mcp_servers || typeof next.mcp_servers !== "object") {
    next.mcp_servers = {};
  } else {
    next.mcp_servers = { ...next.mcp_servers };
  }

  const entry: Record<string, unknown> = {
    command: plan.server.command,
    args: plan.server.args,
  };
  if (Object.keys(plan.server.env).length > 0) {
    entry.env = plan.server.env;
  }
  next.mcp_servers[MNEMOS_MCP_SENTINEL] = entry;
  return next;
}

export function removeMnemosFromHermesConfig(existing: HermesConfig): HermesConfig {
  const next: HermesConfig = { ...existing };
  if (next.mcp_servers && typeof next.mcp_servers === "object") {
    next.mcp_servers = { ...next.mcp_servers };
    delete next.mcp_servers[MNEMOS_MCP_SENTINEL];
    if (Object.keys(next.mcp_servers).length === 0) {
      delete next.mcp_servers;
    }
  }
  return next;
}

function classifyHermesConfigMutation(existing: HermesConfig, next: HermesConfig, uninstall = false): BridgeMutationKind {
  const hadMnemos = Boolean(existing.mcp_servers && MNEMOS_MCP_SENTINEL in existing.mcp_servers);
  const hasMnemos = Boolean(next.mcp_servers && MNEMOS_MCP_SENTINEL in next.mcp_servers);
  if (uninstall) return hadMnemos ? "uninstalled" : "noop";
  if (!hadMnemos && hasMnemos) return "installed";
  if (hadMnemos && hasMnemos) return "updated";
  return "noop";
}

async function mergeIntoHermesConfigFile(configPath: string, plan: BridgePlan, uninstall = false): Promise<BridgeMutationKind> {
  let existing: HermesConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = yaml.parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed as HermesConfig;
    }
  } catch {
    // file missing or unparseable
  }

  const merged = uninstall ? removeMnemosFromHermesConfig(existing) : mergeHermesConfig(existing, plan);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml.stringify(merged, { lineWidth: 120 }), "utf8");
  return classifyHermesConfigMutation(existing, merged, uninstall);
}

function extractVaultFromHermesConfig(config: HermesConfig | null): string | null {
  const entry = config?.mcp_servers?.[MNEMOS_MCP_SENTINEL];
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const env = record.env;
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>).MNEMOS_VAULT;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const args = record.args;
  if (Array.isArray(args)) {
    const vaultIndex = args.findIndex((value) => value === "--vault");
    if (vaultIndex >= 0 && typeof args[vaultIndex + 1] === "string") {
      return args[vaultIndex + 1] as string;
    }
  }
  return null;
}

function getHermesAdaptersDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "adapters", "hermes");
}

async function copyHermesPlugin(adaptersDir: string, pluginDir: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  for (const file of ["plugin.yaml", "__init__.py", "hooks.py"]) {
    await fs.copyFile(
      path.join(adaptersDir, "plugin", file),
      path.join(pluginDir, file),
    );
  }
}

async function removeHermesPlugin(pluginDir: string): Promise<BridgeMutationKind> {
  try {
    const stat = await fs.stat(path.join(pluginDir, HERMES_PLUGIN_MARKER));
    if (stat.isFile()) {
      await fs.rm(pluginDir, { recursive: true, force: true });
      return "uninstalled";
    }
  } catch {
    // plugin dir doesn't exist
  }
  return "noop";
}

async function appendHermesInstructions(instructionsPath: string, activation: BridgeActivation): Promise<BridgeMutationKind> {
  return upsertBridgeBlock(instructionsPath, HERMES_BRIDGE_SENTINEL, hermesSnippet(activation));
}

export function removeHermesInstructions(content: string): string {
  const marker = `\n\n${HERMES_BRIDGE_SENTINEL}\n`;
  const idx = content.indexOf(marker);
  if (idx >= 0) return content.slice(0, idx);
  return content;
}

async function uninstallHermesInstructions(instructionsPath: string): Promise<BridgeMutationKind> {
  try {
    const existing = await fs.readFile(instructionsPath, "utf8");
    const next = removeHermesInstructions(existing);
    await fs.writeFile(instructionsPath, next, "utf8");
    return next === existing ? "noop" : "uninstalled";
  } catch {
    return "noop";
  }
}

async function inspectHermesInstall(): Promise<BridgeInstallStatus> {
  const paths = getHermesGlobalPaths();
  let config: HermesConfig | null = null;
  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    const parsed = yaml.parse(raw);
    if (parsed && typeof parsed === "object") {
      config = parsed as HermesConfig;
    }
  } catch {
    // missing
  }

  const hasMcp = Boolean(config?.mcp_servers?.[MNEMOS_MCP_SENTINEL]);
  let hasPlugin = false;
  try {
    const stat = await fs.stat(path.join(paths.pluginDir, HERMES_PLUGIN_MARKER));
    hasPlugin = stat.isFile();
  } catch {
    // no plugin
  }

  const installed = hasMcp || hasPlugin;
  const details: string[] = [];
  if (hasMcp) details.push(`MCP config present at ${paths.configPath}.`);
  if (hasPlugin) details.push(`Mnemos plugin installed at ${paths.pluginDir}.`);
  if (!installed) details.push("No Mnemos-managed Hermes bridge config detected.");

  return {
    installed,
    client: "hermes",
    scope: "global",
    configPaths: [paths.configPath],
    configPath: paths.configPath,
    pluginDir: paths.pluginDir,
    activation: hasPlugin ? "auto" : hasMcp ? "manual" : null,
    resolvedVault: extractVaultFromHermesConfig(config),
    details,
  };
}

export async function runBridgeHermes(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "hermes", startDir });
  const globalPaths = getHermesGlobalPaths();
  const projectPaths = getHermesProjectPaths(startDir);
  const adaptersDir = getHermesAdaptersDir();

  let configMutation: BridgeMutationKind = "noop";
  let pluginMutation: BridgeMutationKind = "noop";
  let instructionsMutation: BridgeMutationKind = "noop";

  if (request.uninstall) {
    configMutation = await mergeIntoHermesConfigFile(globalPaths.configPath, plan, true);
    pluginMutation = await removeHermesPlugin(globalPaths.pluginDir);
    if (plan.scope === "project") {
      instructionsMutation = await uninstallHermesInstructions(projectPaths.instructionsPath);
    }
  } else {
    configMutation = await mergeIntoHermesConfigFile(globalPaths.configPath, plan);

    if (plan.activation === "auto") {
      await copyHermesPlugin(adaptersDir, globalPaths.pluginDir);
      pluginMutation = "installed";
    }

    if (plan.scope === "project") {
      instructionsMutation = await appendHermesInstructions(projectPaths.instructionsPath, plan.activation);
    }
  }

  const mutation = summarizeMutations([configMutation, pluginMutation, instructionsMutation]);
  const warnings = [...plan.warnings];
  const instructions = [...plan.instructions];

  instructions.push(
    request.uninstall
      ? `Removed Mnemos config from ${globalPaths.configPath}.`
      : `Hermes MCP config written to ${globalPaths.configPath}.`,
  );
  if (!request.uninstall && plan.activation === "auto") {
    instructions.push(`Mnemos lifecycle plugin installed at ${globalPaths.pluginDir}.`);
  }
  if (!request.uninstall && plan.scope === "project") {
    instructions.push(`Bridge instructions appended to ${projectPaths.instructionsPath}.`);
  }

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      client: "hermes",
      operation: request.uninstall ? "uninstall" : "install",
      mutation,
      configPath: globalPaths.configPath,
      pluginDir: globalPaths.pluginDir,
      instructionsPath: plan.scope === "project" ? projectPaths.instructionsPath : undefined,
    },
    warnings,
  };
}

// ── Ori adapter ────────────────────────────────────────────────────────────────
// Ori is a single-user harness: one global mcp.json, no project scope, no
// hook wiring (the harness carries its own lifecycle). MCP-only, like Cursor.

async function inspectOriInstall(): Promise<BridgeInstallStatus> {
  const paths = getOriGlobalPaths();
  const existing = await readJsonFile<McpShape>(paths.mcpPath);
  const hasMcp = Boolean(existing?.mcpServers?.[MNEMOS_MCP_SENTINEL]);
  const details = hasMcp
    ? [`MCP config present at ${paths.mcpPath}.`]
    : ["No Mnemos-managed Ori MCP config detected."];

  return {
    installed: hasMcp,
    client: "ori",
    scope: "global",
    configPaths: [paths.mcpPath],
    mcpPath: paths.mcpPath,
    activation: hasMcp ? "unknown" : null,
    resolvedVault: extractVaultFromMcpConfig(existing),
    details,
  };
}

export async function runBridgeOri(request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const startDir = process.cwd();
  // Ori has no project scope: force global so resolveBridgePlan picks the
  // global default vault when no --vault is passed.
  const plan = await resolveBridgePlan({ ...request, target: "ori", startDir, scope: "global" });
  const paths = getOriGlobalPaths();

  await fs.mkdir(path.dirname(paths.mcpPath), { recursive: true });
  const mcpMutation = await mergeIntoMcpFile(paths.mcpPath, plan, request.uninstall === true);

  const warnings = [...plan.warnings];
  const instructions = [...plan.instructions];
  instructions.push(
    request.uninstall
      ? `Removed Mnemos MCP config from ${paths.mcpPath}.`
      : `Ori MCP config written to ${paths.mcpPath}.`,
  );
  if (!request.uninstall) {
    instructions.push(
      "Ori manages its own session lifecycle — no hooks installed. Restart Ori sessions (or run /mcp) to pick up the server.",
    );
  }

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      client: "ori",
      operation: request.uninstall ? "uninstall" : "install",
      mutation: mcpMutation,
      mcpPath: paths.mcpPath,
    },
    warnings,
  };
}

// ── OpenCode adapter ──────────────────────────────────────────────────────────

const OPENCODE_BRIDGE_SENTINEL = "<!-- mnemos-bridge:opencode -->";

function openCodeSnippet(activation: BridgeActivation): string {
  const pluginLine =
    activation === "auto"
      ? "- Lifecycle plugin at `.opencode/plugins/lifecycle.js`: injects first-run onboarding, auto-captures at context compaction and session end, auto-validates vault-note writes."
      : "- Manual activation: no plugin installed — no automatic onboarding, capture, or validation.";

  return `# Mnemos — OpenCode Bridge

Mnemos is attached as the \`mnemos\` MCP server. Its server instructions carry the complete
usage doctrine (session boot, retrieval, capture, forgetting) — this block records only what
this client adds.

${pluginLine}
- Boot: call \`mnemos_wake\` at session start.
`;
}

type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
};

export function mergeOpenCodeConfig(existing: OpenCodeConfig, plan: BridgePlan): OpenCodeConfig {
  const next: OpenCodeConfig = { ...existing };
  if (!next.mcp || typeof next.mcp !== "object") {
    next.mcp = {};
  } else {
    next.mcp = { ...next.mcp };
  }

  next.mcp[MNEMOS_MCP_SENTINEL] = {
    type: "local",
    command: [plan.server.command, ...plan.server.args],
    ...(Object.keys(plan.server.env).length > 0 ? { environment: plan.server.env } : {}),
  };

  return next;
}

export function removeMnemosFromOpenCodeConfig(existing: OpenCodeConfig): OpenCodeConfig {
  const next: OpenCodeConfig = { ...existing };
  if (next.mcp && typeof next.mcp === "object") {
    next.mcp = { ...next.mcp };
    delete next.mcp[MNEMOS_MCP_SENTINEL];
    if (Object.keys(next.mcp).length === 0) {
      delete next.mcp;
    }
  }
  return next;
}

function classifyOpenCodeConfigMutation(existing: OpenCodeConfig, next: OpenCodeConfig, uninstall = false): BridgeMutationKind {
  const hadMnemos = Boolean(existing.mcp && MNEMOS_MCP_SENTINEL in existing.mcp);
  const hasMnemos = Boolean(next.mcp && MNEMOS_MCP_SENTINEL in next.mcp);
  if (uninstall) return hadMnemos ? "uninstalled" : "noop";
  if (!hadMnemos && hasMnemos) return "installed";
  if (hadMnemos && hasMnemos) return "updated";
  return "noop";
}

async function mergeIntoOpenCodeConfigFile(configPath: string, plan: BridgePlan, uninstall = false): Promise<BridgeMutationKind> {
  let existing: OpenCodeConfig = {};
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      existing = parsed as OpenCodeConfig;
    }
  } catch {
    // file missing or unparseable
  }

  const merged = uninstall ? removeMnemosFromOpenCodeConfig(existing) : mergeOpenCodeConfig(existing, plan);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(merged, null, 2));
  return classifyOpenCodeConfigMutation(existing, merged, uninstall);
}

function extractVaultFromOpenCodeConfig(config: OpenCodeConfig | null): string | null {
  const entry = config?.mcp?.[MNEMOS_MCP_SENTINEL];
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const env = record.environment;
  if (env && typeof env === "object") {
    const value = (env as Record<string, unknown>).MNEMOS_VAULT;
    if (typeof value === "string" && value.length > 0) return value;
  }
  const command = record.command;
  if (Array.isArray(command)) {
    const vaultIndex = command.findIndex((value) => value === "--vault");
    if (vaultIndex >= 0 && typeof command[vaultIndex + 1] === "string") {
      return command[vaultIndex + 1] as string;
    }
  }
  return null;
}

function getOpenCodeAdaptersDir(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, "..", "..", "adapters", "opencode");
}

async function copyOpenCodePlugin(adaptersDir: string, pluginDir: string): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.copyFile(
    path.join(adaptersDir, "plugin", "lifecycle.js"),
    path.join(pluginDir, "lifecycle.js"),
  );
}

async function removeOpenCodePlugin(pluginDir: string): Promise<BridgeMutationKind> {
  const pluginPath = path.join(pluginDir, "lifecycle.js");
  try {
    await fs.stat(pluginPath);
    await fs.rm(pluginPath, { force: true });
    return "uninstalled";
  } catch {
    return "noop";
  }
}

async function appendOpenCodeInstructions(instructionsPath: string, activation: BridgeActivation): Promise<BridgeMutationKind> {
  return upsertBridgeBlock(instructionsPath, OPENCODE_BRIDGE_SENTINEL, openCodeSnippet(activation));
}

export function removeOpenCodeInstructions(content: string): string {
  const marker = `\n\n${OPENCODE_BRIDGE_SENTINEL}\n`;
  const idx = content.indexOf(marker);
  if (idx >= 0) return content.slice(0, idx);
  return content;
}

async function uninstallOpenCodeInstructions(instructionsPath: string): Promise<BridgeMutationKind> {
  try {
    const existing = await fs.readFile(instructionsPath, "utf8");
    const next = removeOpenCodeInstructions(existing);
    await fs.writeFile(instructionsPath, next, "utf8");
    return next === existing ? "noop" : "uninstalled";
  } catch {
    return "noop";
  }
}

async function inspectOpenCodeInstall(startDir: string, scope: "project" | "global"): Promise<BridgeInstallStatus> {
  const paths = scope === "global" ? getOpenCodeGlobalPaths() : getOpenCodeProjectPaths(startDir);
  const [config, instructions] = await Promise.all([
    readJsonFile<OpenCodeConfig>(paths.configPath),
    fs.readFile(paths.instructionsPath, "utf8").catch(() => null),
  ]);

  const hasMcp = Boolean(config?.mcp?.[MNEMOS_MCP_SENTINEL]);
  let hasPlugin = false;
  try {
    const stat = await fs.stat(path.join(paths.pluginDir, "lifecycle.js"));
    hasPlugin = stat.isFile();
  } catch {
    // no plugin
  }
  const hasInstructions = typeof instructions === "string" && instructions.includes(OPENCODE_BRIDGE_SENTINEL);
  const installed = hasMcp || hasPlugin || hasInstructions;
  const details: string[] = [];

  if (hasMcp) details.push(`MCP config present at ${paths.configPath}.`);
  if (hasPlugin) details.push(`Mnemos lifecycle plugin installed at ${paths.pluginDir}.`);
  if (hasInstructions) details.push(`Mnemos bridge instructions present at ${paths.instructionsPath}.`);
  if (!installed) details.push("No Mnemos-managed OpenCode bridge config detected.");

  return {
    installed,
    client: "opencode",
    scope,
    configPaths: [paths.configPath],
    configPath: paths.configPath,
    pluginDir: paths.pluginDir,
    instructionsPath: paths.instructionsPath,
    activation: hasPlugin ? "auto" : hasMcp ? "manual" : null,
    resolvedVault: extractVaultFromOpenCodeConfig(config),
    details,
  };
}

export async function runBridgeOpenCode(startDir: string, request: Omit<BridgeRequest, "target" | "startDir"> = {}) {
  const plan = await resolveBridgePlan({ ...request, target: "opencode", startDir });
  const paths = plan.scope === "global" ? getOpenCodeGlobalPaths() : getOpenCodeProjectPaths(startDir);
  const adaptersDir = getOpenCodeAdaptersDir();

  let configMutation: BridgeMutationKind = "noop";
  let pluginMutation: BridgeMutationKind = "noop";
  let instructionsMutation: BridgeMutationKind = "noop";

  if (request.uninstall) {
    configMutation = await mergeIntoOpenCodeConfigFile(paths.configPath, plan, true);
    pluginMutation = await removeOpenCodePlugin(paths.pluginDir);
    instructionsMutation = await uninstallOpenCodeInstructions(paths.instructionsPath);
  } else {
    configMutation = await mergeIntoOpenCodeConfigFile(paths.configPath, plan);

    if (plan.activation === "auto") {
      await copyOpenCodePlugin(adaptersDir, paths.pluginDir);
      pluginMutation = "installed";
    }

    instructionsMutation = await appendOpenCodeInstructions(paths.instructionsPath, plan.activation);
  }

  const mutation = summarizeMutations([configMutation, pluginMutation, instructionsMutation]);
  const warnings = [...plan.warnings];
  const instructions = [...plan.instructions];

  instructions.push(
    request.uninstall
      ? `Removed Mnemos config from ${paths.configPath}.`
      : `OpenCode MCP config written to ${paths.configPath}.`,
  );
  if (!request.uninstall && plan.activation === "auto") {
    instructions.push(`Mnemos lifecycle plugin installed at ${paths.pluginDir}.`);
  }
  if (!request.uninstall) {
    instructions.push(`Bridge instructions appended to ${paths.instructionsPath}.`);
  }

  return {
    success: true,
    data: {
      ...buildGenericInstallOutput({
        ...plan,
        instructions,
        warnings,
      }),
      client: "opencode",
      operation: request.uninstall ? "uninstall" : "install",
      mutation,
      configPath: paths.configPath,
      pluginDir: paths.pluginDir,
      instructionsPath: paths.instructionsPath,
    },
    warnings,
  };
}
