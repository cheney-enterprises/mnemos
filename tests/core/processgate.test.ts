import { describe, it, expect } from "vitest";
import { inspectAncestry } from "../../src/core/processgate.js";
import { execFileSync } from "node:child_process";

// The second user-only-gate layer: a TTY is forgeable (script/PTY —
// demonstrated 2026-11-08: agent wrapped the CLI, answered its own prompt,
// deleted the note), but the process tree is set by the kernel. An approval
// executed under the agent's runtime carries that runtime in the PPID chain.

describe("inspectAncestry", () => {
  it("detects the agent runtime from inside the agent's process tree", () => {
    // This test process runs under the developer's agent harness (ori), so
    // the walk must find it. If this ever fails, the patterns list is stale
    // or the harness changed — the gate is blind exactly when this is false.
    const f = inspectAncestry();
    expect(f.agentAncestor).toBe(true);
    expect(f.agentImage).toBeTruthy();
    expect(f.chain.length).toBeGreaterThan(1);
    expect(f.complete).toBe(true);
  });

  it("a detached process re-parented to launchd has a clean chain", async () => {
    // nohup + shell exit re-parents the child to launchd — the same shape as
    // a daemonized (chain-forging) process, and coincidentally the same
    // terminal-state shape as a genuine detached session.
    const pid = execFileSync("/bin/zsh", ["-c", "nohup sleep 30 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
    }).trim().split("\n").pop()!.trim();
    try {
      await new Promise((r) => setTimeout(r, 500));
      const f = inspectAncestry(Number(pid));
      expect(f.agentAncestor).toBe(false);
      expect(f.agentImage).toBeNull();
      expect(f.complete).toBe(true);
      expect(f.chain[f.chain.length - 1]).toContain("launchd");
    } finally {
      try { execFileSync("kill", [pid]); } catch { /* already gone */ }
    }
  });

  it("a nonexistent pid yields an incomplete walk, not a false clean", () => {
    const f = inspectAncestry(999_999_999);
    expect(f.complete).toBe(false);
    // No agent found AND no chain walked — the caller must treat incomplete
    // as unknown, not clean. The finding carries no false "agentAncestor".
    expect(f.agentAncestor).toBe(false);
    expect(f.chain.length).toBe(0);
  });

  it("walks are bounded — a cycle cannot hang the gate", () => {
    // The 64-guard is internal; this only verifies termination within a sane
    // time and a complete=false on synthetic absurdity is not reachable
    // without a real cycle, so just prove the call returns quickly.
    const start = Date.now();
    inspectAncestry();
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
