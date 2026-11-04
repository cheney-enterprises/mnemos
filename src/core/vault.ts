import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type VaultPaths = {
  root: string;
  marker: string;
  config: string;
  notes: string;
  inbox: string;
  templates: string;
  self: string;
  selfMemory: string;
  ops: string;
  opsSessions: string;
  opsObservations: string;
};

export async function isVaultRoot(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".mnemos"));
    return true;
  } catch {
    return false;
  }
}

/**
 * A vault whose derived index has been deleted still has its config. This is
 * what distinguishes "the user removed .mnemos/ on purpose" from "this directory
 * has nothing to do with Mnemos".
 */
export async function hasVaultConfig(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "mnemos.config.yaml"));
    return true;
  } catch {
    return false;
  }
}

export type VaultRootResult = {
  path: string;
  source: "project" | "global";
};

export function getGlobalVaultPath(): string {
  return path.join(os.homedir(), ".mnemos-memory");
}

export async function findVaultRootWithSource(
  startDir?: string,
  override?: string,
): Promise<VaultRootResult> {
  // 1. Explicit override — validate or throw
  if (override) {
    const resolved = path.resolve(override);
    if (await isVaultRoot(resolved)) return { path: resolved, source: "project" };
    throw new Error(
      `Vault not found at specified path: ${resolved}. Run 'mnemos init ${resolved}' to create one.`,
    );
  }

  // 1.5. Environment override — authoritative, validate or throw
  const envVault = process.env.MNEMOS_VAULT?.trim();
  if (envVault) {
    const resolved = path.resolve(envVault);
    if (await isVaultRoot(resolved)) return { path: resolved, source: "project" };
    throw new Error(
      `Vault not found at MNEMOS_VAULT: ${resolved}. Run 'mnemos init ${resolved}' to create one.`,
    );
  }

  // 2. Walk up from startDir looking for .mnemos
  //
  // A directory holding mnemos.config.yaml is a vault root even when .mnemos/ is
  // absent, and the walk MUST stop there. Before this, `rm -rf .mnemos/ && mnemos
  // index build` — the recovery procedure the README documents — walked past
  // the vault it was run in, found the next .mnemos up the tree (a
  // home-directory vault, in the case that surfaced this), and rebuilt THAT
  // one while reporting {"success":true}. Wrong vault, plausible output, no
  // error. An index deleted on purpose must not silently promote its parent.
  let current = path.resolve(startDir ?? process.cwd());
  while (true) {
    if (await isVaultRoot(current)) return { path: current, source: "project" };
    if (await hasVaultConfig(current)) return { path: current, source: "project" };
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  // 3. Check global vault
  const globalPath = getGlobalVaultPath();
  if (await isVaultRoot(globalPath)) return { path: globalPath, source: "global" };

  // 4. No vault anywhere — throw
  throw new Error(
    "No .mnemos marker found. Run 'mnemos init' to create a vault, or connect via MCP to auto-create one.",
  );
}

// Wrapper — all existing callers unchanged (returns string)
export async function findVaultRoot(startDir: string, override?: string): Promise<string> {
  const result = await findVaultRootWithSource(startDir, override);
  return result.path;
}

export function getVaultPaths(root: string): VaultPaths {
  return {
    root,
    marker: path.join(root, ".mnemos"),
    config: path.join(root, "mnemos.config.yaml"),
    notes: path.join(root, "notes"),
    inbox: path.join(root, "inbox"),
    templates: path.join(root, "templates"),
    self: path.join(root, "self"),
    selfMemory: path.join(root, "self", "memory"),
    ops: path.join(root, "ops"),
    opsSessions: path.join(root, "ops", "sessions"),
    opsObservations: path.join(root, "ops", "observations"),
  };
}

export function resolveVaultPath(vaultRoot: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(vaultRoot, inputPath);
}

export async function listNoteTitles(notesDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(notesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
