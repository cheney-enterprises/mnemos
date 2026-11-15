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
  source: "project" | "global" | "registered";
};

export function getGlobalVaultPath(): string {
  return path.join(os.homedir(), ".mnemos-memory");
}

/**
 * The vault registry — where a vault at a NON-standard path announces itself
 * so the CLI can find it from anywhere.
 *
 * Why this exists: the MCP server is configured with an explicit vault path,
 * but the CLI is a separate process that only knew "cwd, walk up, then
 * ~/.mnemos-memory". A vault at ~/ori-memory-vault was invisible to
 * `mnemos requests` run from ~ — the USER-ONLY surface (the approval gate's
 * whole point) failed unless the user first cd'd into the vault. Backwards:
 * the human is the one caller that should never need to know the internals.
 *
 * NOT ~/.mnemos: a `.mnemos` directory at $HOME would make $HOME itself look
 * like a vault root to the walk-up — the exact home-directory-vault hazard
 * the walk documents below. ~/.config/mnemos/ collides with nothing.
 *
 * Who registers: `mnemos init` (created vaults) and the MCP server boot (the
 * configured vaultDir — MCP-connected vaults must be CLI-discoverable, since
 * the approval gate routes its users to the CLI). Registration is idempotent;
 * reads validate every entry and prune dead ones.
 */
export function getVaultRegistryPath(): string {
  return path.join(os.homedir(), ".config", "mnemos", "vaults.json");
}

export async function registerVault(root: string): Promise<void> {
  // Test opt-out: the suite creates hundreds of throwaway vaults; only the
  // registry tests (which mock homedir) may write.
  if (process.env.MNEMOS_NO_REGISTER === "1") return;
  const resolved = path.resolve(root);
  if (!(await isVaultRoot(resolved))) return; // only real vaults register
  const regPath = getVaultRegistryPath();
  const entries = await readVaultRegistry();
  if (entries.some((e) => e.path === resolved)) return;
  await fs.mkdir(path.dirname(regPath), { recursive: true });
  // Write the PRUNED list: dead entries leave the file on the next write,
  // not just on the next read. One shape end-to-end (objects) — a mixed
  // string/object file is how the first draft lost its second entry.
  await fs.writeFile(
    regPath,
    JSON.stringify(
      [...entries, { path: resolved, registered_at: new Date().toISOString() }],
      null,
      2,
    ),
    "utf8",
  );
}

interface RegistryEntry {
  path: string;
  registered_at?: string;
}

/** Live registered vaults — entries whose directory stopped being a vault
 * are silently pruned on read. */
async function readVaultRegistry(): Promise<RegistryEntry[]> {
  try {
    const raw = await fs.readFile(getVaultRegistryPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const live: RegistryEntry[] = [];
    for (const entry of parsed) {
      const p = typeof (entry as { path?: unknown }).path === "string"
        ? (entry as { path: string }).path
        : null;
      if (!p) continue;
      if (await isVaultRoot(p)) {
        live.push({
          path: p,
          registered_at: typeof (entry as { registered_at?: unknown }).registered_at === "string"
            ? (entry as { registered_at: string }).registered_at
            : undefined,
        });
      }
    }
    return live;
  } catch {
    return []; // no registry yet — nothing registered, not an error
  }
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

  // 3. Check global vault (the long-standing default — preserved priority)
  const globalPath = getGlobalVaultPath();
  if (await isVaultRoot(globalPath)) return { path: globalPath, source: "global" };

  // 3.5 Registered vaults — the gap closer: a vault at a non-standard path
  // (the MCP server's configured vault, an init'd repo anywhere on disk) is
  // discoverable from ANY working directory. Exactly one registered vault
  // is unambiguous — use it. Several would be a guess about whose requests
  // to approve against, and a guess on the user-only approval surface is
  // how the wrong vault gets purged; refuse and name the flag instead.
  const registered = await readVaultRegistry();
  if (registered.length === 1) return { path: registered[0].path, source: "registered" };
  if (registered.length > 1) {
    throw new Error(
      `Multiple registered vaults:\n  ${registered.map((e) => e.path).join("\n  ")}\n` +
        `Pass --vault <path> to choose (or run from inside the vault).`,
    );
  }

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
