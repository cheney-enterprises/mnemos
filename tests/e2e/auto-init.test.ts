import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  findVaultRoot,
  findVaultRootWithSource,
  getGlobalVaultPath,
  isVaultRoot,
} from "../../src/core/vault.js";
import { runInit } from "../../src/cli/init.js";
import { scratchBase } from "../scratch-vault.js";

let tmpDir: string;
let fakeHome: string;
let realHomedir: typeof os.homedir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(await scratchBase(), "mnemos-autoinit-"));
  fakeHome = path.join(tmpDir, "fakehome");
  await fs.mkdir(fakeHome, { recursive: true });

  // Mock os.homedir to isolate tests from real home directory
  realHomedir = os.homedir;
  os.homedir = () => fakeHome;
});

afterEach(async () => {
  os.homedir = realHomedir;
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getGlobalVaultPath", () => {
  it("returns ~/.mnemos-memory", () => {
    expect(getGlobalVaultPath()).toBe(path.join(fakeHome, ".mnemos-memory"));
  });
});

describe("findVaultRoot — global fallback", () => {
  it("throws when no vault anywhere and no global vault", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });
    await expect(findVaultRoot(noVaultDir)).rejects.toThrow("No .mnemos marker found");
  });

  it("returns project vault when it exists", async () => {
    const projectDir = path.join(tmpDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".mnemos"), { recursive: true });
    const root = await findVaultRoot(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });

  it("returns global vault when no project vault exists", async () => {
    // Create global vault at fakeHome/.mnemos-memory/
    const globalPath = path.join(fakeHome, ".mnemos-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".mnemos"), { recursive: true });

    // Search from a directory with no vault
    const noVaultDir = path.join(tmpDir, "novault");
    await fs.mkdir(noVaultDir, { recursive: true });
    const root = await findVaultRoot(noVaultDir);
    expect(root).toBe(path.resolve(globalPath));
  });

  it("project vault wins over global vault", async () => {
    // Create global vault
    const globalPath = path.join(fakeHome, ".mnemos-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".mnemos"), { recursive: true });

    // Create project vault
    const projectDir = path.join(tmpDir, "myproject");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".mnemos"), { recursive: true });

    const root = await findVaultRoot(projectDir);
    expect(root).toBe(path.resolve(projectDir));
  });
});

describe("findVaultRootWithSource", () => {
  it("returns source: project for project vault", async () => {
    const projectDir = path.join(tmpDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".mnemos"), { recursive: true });

    const result = await findVaultRootWithSource(projectDir);
    expect(result.source).toBe("project");
    expect(result.path).toBe(path.resolve(projectDir));
  });

  it("returns source: global for global vault", async () => {
    const globalPath = path.join(fakeHome, ".mnemos-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".mnemos"), { recursive: true });

    const noVaultDir = path.join(tmpDir, "novault");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await findVaultRootWithSource(noVaultDir);
    expect(result.source).toBe("global");
    expect(result.path).toBe(path.resolve(globalPath));
  });

  it("throws with clear message when --vault points to nonexistent path", async () => {
    const badPath = path.join(tmpDir, "nonexistent");
    await expect(findVaultRootWithSource(tmpDir, badPath)).rejects.toThrow(
      "Vault not found at specified path",
    );
  });

  it("--vault override never falls back to global", async () => {
    // Create global vault
    const globalPath = path.join(fakeHome, ".mnemos-memory");
    await fs.mkdir(globalPath, { recursive: true });
    await fs.mkdir(path.join(globalPath, ".mnemos"), { recursive: true });

    // Override points to non-vault — should throw, NOT fall back to global
    const badOverride = path.join(tmpDir, "badoverride");
    await fs.mkdir(badOverride, { recursive: true });
    await expect(findVaultRootWithSource(tmpDir, badOverride)).rejects.toThrow(
      "Vault not found at specified path",
    );
  });
});

describe("the vault registry — a vault anywhere is discoverable from anywhere", () => {
  let regVault: string;
  let noRegister: string | undefined;

  beforeEach(async () => {
    // The suite-wide MNEMOS_NO_REGISTER=1 keeps init from writing the (fake)
    // home registry everywhere else; these tests ARE about the registry, so
    // they lift the guard and restore it after.
    noRegister = process.env.MNEMOS_NO_REGISTER;
    delete process.env.MNEMOS_NO_REGISTER;
    regVault = path.join(tmpDir, "registered-vault");
    await runInit({ targetDir: regVault });
  });

  afterEach(() => {
    if (noRegister !== undefined) process.env.MNEMOS_NO_REGISTER = noRegister;
  });

  it("init registers the vault; a non-vault cwd resolves it (source: registered)", async () => {
    // Register by hand (the env guard is on for the whole suite).
    const { registerVault, getVaultRegistryPath } = await import("../../src/core/vault.js");
    await registerVault(regVault);
    // Sanity: the registry file exists under the fake home.
    await expect(fs.access(getVaultRegistryPath())).resolves.toBeUndefined();

    // From a directory that is NOT a vault and NOT inside one.
    const nowhere = path.join(tmpDir, "nowhere");
    await fs.mkdir(nowhere, { recursive: true });
    const result = await findVaultRootWithSource(nowhere);
    expect(result.source).toBe("registered");
    expect(result.path).toBe(path.resolve(regVault));
  });

  it("a dead registry entry is pruned, not served", async () => {
    const { registerVault, getVaultRegistryPath } = await import("../../src/core/vault.js");
    await registerVault(regVault);
    await fs.rm(regVault, { recursive: true, force: true });
    const nowhere = path.join(tmpDir, "nowhere2");
    await fs.mkdir(nowhere, { recursive: true });
    // Reads prune in memory: the dead vault is never served…
    await expect(findVaultRootWithSource(nowhere)).rejects.toThrow("No .mnemos marker found");
    // …and the next registration writes the pruned list, so the file is
    // clean too.
    const second = path.join(tmpDir, "later-vault");
    await runInit({ targetDir: second });
    await registerVault(second);
    const raw = await fs.readFile(getVaultRegistryPath(), "utf8");
    expect(raw.includes("registered-vault")).toBe(false);
    expect(raw.includes("later-vault")).toBe(true);
  });

  it("multiple registered vaults refuse to guess — they name --vault", async () => {
    const { registerVault } = await import("../../src/core/vault.js");
    const second = path.join(tmpDir, "second-vault");
    await runInit({ targetDir: second });
    await registerVault(regVault);
    await registerVault(second);
    const nowhere = path.join(tmpDir, "nowhere3");
    await fs.mkdir(nowhere, { recursive: true });
    await expect(findVaultRootWithSource(nowhere)).rejects.toThrow(/Multiple registered vaults[\s\S]*--vault/);
  });

  it("a vault at cwd still wins over the registry (walk order unchanged)", async () => {
    const { registerVault } = await import("../../src/core/vault.js");
    await registerVault(regVault);
    const result = await findVaultRootWithSource(regVault);
    expect(result.source).toBe("project");
    expect(result.path).toBe(path.resolve(regVault));
  });

  it("the user-only surface works from a NON-vault cwd via the registry (the Eric scenario)", async () => {
    // The failure this closes: `mnemos requests approve rq-…` run from ~ (or
    // any repo) failed with "No .mnemos marker found" because the vault lived
    // at a non-standard path only the MCP server knew. With the registry,
    // the approval resolves from anywhere.
    const { registerVault } = await import("../../src/core/vault.js");
    const { proposeIntent, loadPolicy } = await import("../../src/core/policy.js");
    const { loadConfig } = await import("../../src/core/config.js");
    const { runRequestDecide } = await import("../../src/cli/forget.js");
    const { readFrontmatterFile } = await import("../../src/core/frontmatter.js");

    await registerVault(regVault);

    // A pending identity_update intent in the registered vault.
    const config = await loadConfig(path.join(regVault, "mnemos.config.yaml"));
    const proposed = await proposeIntent({
      opRoot: regVault,
      kind: "identity_update",
      selfFile: path.join(regVault, "self", "identity.md"),
      content: "the proposed identity content",
      reason: "the registry test's proposal",
      sessionId: "ses-registry-test",
      policy: loadPolicy(config).policy,
    });

    // From a directory that is NOT a vault and NOT inside one — no cd needed.
    const nowhere = path.join(tmpDir, "nowhere4");
    await fs.mkdir(nowhere, { recursive: true });
    const decided = await runRequestDecide(nowhere, proposed.intent.id, "approved", {
      confirm: async () => true,
    });
    expect(decided.success).toBe(true);

    // And the identity file actually carries the approved content.
    const identity = await readFrontmatterFile(path.join(regVault, "self", "identity.md"));
    expect(identity.body).toContain("the proposed identity content");
  });
});

describe("serve auto-create simulation", () => {
  // Simulates what serve.ts does: try findVaultRootWithSource, on failure auto-create

  async function serveAutoCreate(startDir: string, vaultOverride?: string) {
    let autoCreated = false;
    let vaultRoot: string;

    try {
      const result = await findVaultRootWithSource(startDir, vaultOverride);
      vaultRoot = result.path;
    } catch (err) {
      if (vaultOverride) throw err;
      const globalPath = getGlobalVaultPath();
      await runInit({ targetDir: globalPath });
      vaultRoot = globalPath;
      autoCreated = true;
    }

    return { vaultRoot, autoCreated };
  }

  it("auto-creates global vault when no vault exists", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await serveAutoCreate(noVaultDir);
    expect(result.autoCreated).toBe(true);
    expect(result.vaultRoot).toBe(path.join(fakeHome, ".mnemos-memory"));

    // Verify scaffold was created
    expect(await isVaultRoot(result.vaultRoot)).toBe(true);
    const identityPath = path.join(result.vaultRoot, "self", "identity.md");
    const identity = await fs.readFile(identityPath, "utf8");
    expect(identity).toContain("<!-- First session:");
  });

  it("auto-created vault triggers isFirstRun", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    const result = await serveAutoCreate(noVaultDir);
    const identityPath = path.join(result.vaultRoot, "self", "identity.md");
    const identity = await fs.readFile(identityPath, "utf8");

    // isFirstRun checks: strip frontmatter, check for scaffold marker or empty content
    expect(identity).toContain("<!-- First session:");
  });

  it("--vault /nonexistent throws, does NOT auto-create", async () => {
    const badPath = path.join(tmpDir, "bad");
    await expect(serveAutoCreate(tmpDir, badPath)).rejects.toThrow(
      "Vault not found at specified path",
    );

    // Global vault should NOT have been created
    const globalPath = path.join(fakeHome, ".mnemos-memory");
    expect(await isVaultRoot(globalPath)).toBe(false);
  });

  it("second call after auto-create returns existing vault, autoCreated false", async () => {
    const noVaultDir = path.join(tmpDir, "empty");
    await fs.mkdir(noVaultDir, { recursive: true });

    // First call — auto-creates
    const first = await serveAutoCreate(noVaultDir);
    expect(first.autoCreated).toBe(true);

    // Second call — finds existing global vault via findVaultRootWithSource
    const second = await serveAutoCreate(noVaultDir);
    expect(second.autoCreated).toBe(false);
    expect(second.vaultRoot).toBe(first.vaultRoot);
  });
});
