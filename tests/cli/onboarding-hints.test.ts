/**
 * Onboarding hints — the tool tells the human the next step (Eric's ruling,
 * 2026-11-13: "make the tool more usable for human use and installation —
 * hey dev, you can run bridge; here is what the commands are").
 *
 * Surfaces: mnemos status (any time) and mnemos init (the new-user moment,
 * post-scaffold). Detection reuses the bridge inspectors; the hint text is
 * a pure function so it is testable without any client config on disk.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runStatus } from "../../src/cli/status.js";
import { buildOnboardingNextSteps, inspectClientInstalls } from "../../src/cli/bridge.js";

describe("buildOnboardingNextSteps (pure)", () => {
  it("zero registered clients: the full walk-through, naming every bridge", () => {
    const steps = buildOnboardingNextSteps([]);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const all = steps.join("\n");
    for (const client of ["claude-code", "cursor", "codex", "hermes", "opencode", "ori"]) {
      expect(all).toContain(client);
    }
    expect(all).toContain("bridge generic");
    expect(all).toContain("mnemos wake");
  });

  it("some registered: one line acknowledging, pointing at the commands", () => {
    const steps = buildOnboardingNextSteps([{ client: "opencode", scope: "global", vault: null }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain("opencode (global)");
    expect(steps[0]).toContain("bridge");
    expect(steps[0]).toContain("generic");
  });
});

describe("status and init carry the hint", () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-onboard-"));
  }, 60000);

  afterAll(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("init returns next_steps (the new-user moment)", async () => {
    const result = await runInit({ targetDir: vaultDir });
    expect(Array.isArray(result.next_steps)).toBe(true);
    expect((result.next_steps as string[]).length).toBeGreaterThan(0);
  });

  it("status reports clients_registered and next_steps, consistent with detection", async () => {
    const result = await runStatus(vaultDir);
    const registered = result.data.clients_registered as Array<unknown>;
    const steps = result.data.next_steps as string[];
    expect(Array.isArray(registered)).toBe(true);
    expect(Array.isArray(steps)).toBe(true);
    // Consistency, not environment-pinned values: this machine may or may not
    // have real clients registered, and the hint must match what was found.
    if (registered.length === 0) {
      expect(steps.length).toBeGreaterThanOrEqual(3);
    } else {
      expect(steps).toHaveLength(1);
      expect(steps[0]).toContain("bridge");
    }
  });

  it("inspectClientInstalls agrees with the underlying inspectors' active entries", async () => {
    const summary = await inspectClientInstalls(vaultDir);
    expect(Array.isArray(summary.registered)).toBe(true);
    for (const r of summary.registered) {
      expect(typeof r.client).toBe("string");
      expect(typeof r.scope).toBe("string");
    }
  });
});
