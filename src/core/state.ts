import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./frontmatter.js";
import { getVaultPaths } from "./vault.js";

export interface MnemosState {
  onboarded: boolean;
  version: string;
}

const DEFAULT_STATE: MnemosState = {
  onboarded: false,
  version: "0.0.0",
};

function statePath(vaultDir: string): string {
  return path.join(getVaultPaths(vaultDir).marker, "state.json");
}

export async function readState(vaultDir: string): Promise<MnemosState> {
  try {
    const raw = await fs.readFile(statePath(vaultDir), "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeState(vaultDir: string, updates: Partial<MnemosState>): Promise<void> {
  const current = await readState(vaultDir);
  const merged = { ...current, ...updates };
  const fp = statePath(vaultDir);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await writeFileAtomic(fp, JSON.stringify(merged, null, 2) + "\n");
}

export function isOnboarded(state: MnemosState): boolean {
  return state.onboarded === true;
}
