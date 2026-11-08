/**
 * Process-ancestry gate — the second layer under the TTY requirement.
 *
 * The 2026-11-08 PTY demonstration: an agent proposed a purge, wrapped its
 * own `mnemos requests approve` in `script` to obtain a TTY, answered its own
 * [y/N] prompt, and deleted the note — with the audit line recording
 * "interactive-tty". The TTY check alone cannot distinguish a human's
 * terminal from an agent-forged one.
 *
 * What CAN distinguish them is the process tree. The kernel sets a process's
 * parent; a process cannot choose its ancestry. An approval executed under
 * the agent's own runtime carries the agent runtime in its PPID chain —
 * demonstrated: `sh -> script -> sh -> node (agent) -> bash -> ori`. A
 * genuine terminal session chains to login/sshd/Terminal.app, never to the
 * agent harness.
 *
 * Honest limits, stated because a security module that overclaims is worse
 * than one that states its ceiling:
 *  - The chain is walkable until it ends; on macOS/Linux it terminates at
 *    PID 1 (or a launchd/exe ancestor). Double-fork daemonization re-parents
 *    to PID 1 and hides everything above it, so a determined agent can forge
 *    a clean chain. This layer raises the bar from "any agent with script"
 *    to "an agent that deliberately re-parents itself" and keeps the audit
 *    provably clean for every non-forged path. The absolute fix remains
 *    transport-side: an approval gesture that originates in the human's app,
 *    which no process ancestry can simulate. The confirm seam in
 *    cli/forget.ts is where that wires.
 *  - Anything that looks like a shell wrapper (sh, bash, zsh, script, sudo)
 *    is skipped, not treated as an agent — a human's interactive session is
 *    full of these. Only agent-runtime images in AGENT_RUNTIME_PATTERNS
 *    trigger refusal.
 */

import { execFileSync } from "node:child_process";

/**
 * Process-image fragments that identify an agent runtime. Matched against
 * each ancestor's command line, case-insensitively. Extend as new harnesses
 * appear; the gate refuses ONLY on these, never on shells or unknown
 * processes (a false positive would lock a real user out of their own
 * approval queue).
 */
const AGENT_RUNTIME_PATTERNS: readonly string[] = [
  "/.local/bin/ori",
  "/.ori/", // the harness and anything it spawns from its home
  "claude", // Anthropic's agent runtime binary
  "codex", // OpenAI's agent runtime binary
  "aider",
  "cline",
  "cursor-agent",
  "goose",
  "mnemos-agent", // self-reference guard: an agent built ON mnemos
];

/** Command images that are transparent wrappers, never evidence of an agent. */
const WRAPPER_IMAGES = new Set([
  "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh",
  "script", "sudo", "su", "env", "nice", "nohup", "timeout", "setsid",
  "node", "nodejs", "deno", "bun", "python", "python3", "pwsh", "powershell",
]);

export interface AncestryFinding {
  /** True when an agent runtime was found among the ancestors. */
  agentAncestor: boolean;
  /** The command image of the offending ancestor, for the audit trail. */
  agentImage: string | null;
  /** The full walked chain: "ori -> bash -> sh -> script -> sh" (root first). */
  chain: string[];
  /** True when the walk completed to the root (vs stopped early on error). */
  complete: boolean;
}

/**
 * The gate's decision for the current process, computed once:
 *   - agent_tree: an agent runtime is among the ancestors (forged or not).
 *   - clean_tree: walk completed to the root with no agent found.
 *   - unknown: the walk could not complete (sandboxed runner, ps denied,
 *     exotic init) — the caller treats unknown as NOT clean and layers its
 *     other gates (TTY + injected confirm) accordingly. Never assume.
 */
export type AncestryVerdict = "agent_tree" | "clean_tree" | "unknown";

export function ancestryVerdict(finding: AncestryFinding): AncestryVerdict {
  if (finding.agentAncestor) return "agent_tree";
  return finding.complete ? "clean_tree" : "unknown";
}

interface PidRow {
  pid: string;
  ppid: string;
  command: string;
}

function readAncestorRow(pid: string): PidRow | null {
  if (process.platform === "win32") {
    // PowerShell: Get-CimInstance Win32_Process for the parent PID; `ps`
    // does not exist on Windows and wmic is deprecated/absent on current
    // runners.
    try {
      const out = execFileSync(
        "powershell",
        ["-NoProfile", "-Command",
         `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1).ParentProcessId`],
        { encoding: "utf8", timeout: 10000 },
      );
      const ppid = out.trim();
      if (!/^\d+$/.test(ppid) || ppid === "0") return null;
      // Image name for the chain; full command line is best-effort (may be
      // denied for protected processes — an empty command degrades the
      // pattern match, recorded honestly in the chain, never fabricated).
      let command = "";
      try {
        command = execFileSync(
          "powershell",
          ["-NoProfile", "-Command",
           `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1).CommandLine`],
          { encoding: "utf8", timeout: 10000 },
        ).trim();
      } catch {
        command = "";
      }
      if (!command) return { pid, ppid, command: "(image-unavailable)" };
      return { pid, ppid, command };
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "pid=,ppid=,command=", "-p", pid], {
      encoding: "utf8",
      timeout: 5000,
    });
    const line = out.trim().split("\n")[0];
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const pidField = parts[0];
    const ppid = parts[1];
    const command = parts.slice(2).join(" ");
    if (!/^\d+$/.test(ppid)) return null;
    return { pid: pidField, ppid, command };
  } catch {
    return null;
  }
}

function imageOf(command: string): string {
  // First token, basename only: "/usr/local/bin/node script.js" -> "node";
  // "node /x/y.js" keeps node as the image — the interpreter is the identity.
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base.toLowerCase();
}

/** The sentinel image appended when the walk reaches the root on this platform. */
function rootImage(): string {
  return process.platform === "win32" ? "system-idle-process" : "launchd/init";
}

/** True when the command line itself (not just the image) names an agent runtime. */
function matchesAgentRuntime(command: string, image: string): string | null {
  for (const pattern of AGENT_RUNTIME_PATTERNS) {
    if (command.toLowerCase().includes(pattern)) return pattern;
  }
  // A bare interpreter image is a wrapper; only flag it when the full command
  // carries an agent marker (handled above). Never flag interpreters alone —
  // every toolchain runs under node/python legitimately.
  return WRAPPER_IMAGES.has(image) ? null : null;
}

/**
 * Walk the PPID chain from the current process to the root. Refuses to walk
 * forever: a cycle or a runaway chain ends the walk with complete=false
 * (recorded in the audit, never silently treated as clean OR dirty).
 */
export function inspectAncestry(startPid?: number): AncestryFinding {
  const chain: string[] = [];
  let current: string | null = String(startPid ?? process.ppid ?? 0);
  let guard = 0;
  let agentAncestor = false;
  let agentImage: string | null = null;
  let selfRow = current === "0" ? null : readAncestorRow(current);

  // Include the starting process itself when a pid was supplied explicitly.
  if (startPid !== undefined && selfRow) {
    const image = imageOf(selfRow.command);
    chain.push(image);
    const hit = matchesAgentRuntime(selfRow.command, image);
    if (hit) {
      agentAncestor = true;
      agentImage = selfRow.command;
    }
  }

  while (current && current !== "0" && guard < 64) {
    guard += 1;
    const row = readAncestorRow(current);
    if (!row) return { agentAncestor, agentImage, chain, complete: false };
    const image = imageOf(row.command);
    chain.push(image);
    const hit = matchesAgentRuntime(row.command, image);
    if (hit && !agentAncestor) {
      agentAncestor = true;
      agentImage = row.command;
    }
    if (row.ppid === current) break; // kernel idle reclaim loop guard
    current = row.ppid;
    if (current === "0") {
      chain.push(rootImage());
      break;
    }
  }

  return { agentAncestor, agentImage, chain, complete: guard < 64 };
}
