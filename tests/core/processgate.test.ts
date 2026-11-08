import { describe, it, expect } from "vitest";
import { inspectAncestry, ancestryVerdict } from "../../src/core/processgate.js";
import { execFileSync } from "node:child_process";

// Windows has no `ps`; the ancestry walk there goes through PowerShell and
// runner images differ. These tests pin POSIX behavior; the Windows walk is
// exercised indirectly by the gate's tests (refusals work under both walks).
const isPosix = process.platform !== "win32";
const posixIt = isPosix ? it : it.skip;

// The second user-only-gate layer: a TTY is forgeable (script/PTY —
// demonstrated 2026-11-08: agent wrapped the CLI, answered its own prompt,
// deleted the note), but the process tree is set by the kernel. An approval
// executed under the agent's runtime carries that runtime in the PPID chain.

describe("inspectAncestry", () => {
  posixIt("walks the real process tree to completion and classifies it honestly", () => {
    // Environment-independent: CI runners and dev machines differ in what is
    // above this process, so the pin is on the WALK (completes, real images)
    // and on the verdict logic — not on the developer's specific harness.
    const f = inspectAncestry();
    // Every entry must be a lowercase image token, no empties.
    expect(f.chain.length).toBeGreaterThan(1);
    for (const image of f.chain) expect(image).toMatch(/^[a-z0-9_./-]+$/i);
    // The verdict must be one of the three honest outcomes — never undefined.
    expect(["agent_tree", "clean_tree", "unknown"]).toContain(ancestryVerdict(f));
    // Consistency: agentAncestor iff verdict is agent_tree.
    expect(ancestryVerdict(f) === "agent_tree").toBe(f.agentAncestor);
    expect(ancestryVerdict(f) === "unknown").toBe(!f.agentAncestor && !f.complete);
  });

  posixIt("a detached process re-parented to init has a clean chain", async () => {
    // nohup + shell exit re-parents the child to launchd — the same shape as
    // a daemonized (chain-forging) process, and coincidentally the same
    // terminal-state shape as a genuine detached session.
    const pid = execFileSync("/bin/sh", ["-c", "nohup sleep 30 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
    }).trim().split("\n").pop()!.trim();
    try {
      await new Promise((r) => setTimeout(r, 500));
      const f = inspectAncestry(Number(pid));
      expect(ancestryVerdict(f)).toBe("clean_tree");
    } finally {
      try { execFileSync("kill", [pid]); } catch { /* already gone */ }
    }
  });

  posixIt("a nonexistent pid yields an incomplete walk, not a false clean", () => {
    const f = inspectAncestry(999_999_999);
    expect(f.complete).toBe(false);
    // No agent found AND no chain walked — the caller must treat incomplete
    // as unknown, not clean. The finding carries no false "agentAncestor".
    expect(f.agentAncestor).toBe(false);
    expect(f.chain.length).toBe(0);
  });

  posixIt("walks are bounded — a cycle cannot hang the gate", () => {
    // The 64-guard is internal; this only verifies termination within a sane
    // time and a complete=false on synthetic absurdity is not reachable
    // without a real cycle, so just prove the call returns quickly.
    const start = Date.now();
    inspectAncestry();
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
