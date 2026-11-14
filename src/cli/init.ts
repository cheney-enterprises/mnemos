import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVaultPaths } from "../core/vault.js";
import { readState, isOnboarded } from "../core/state.js";
import { runBootSequence } from "./boot.js";
import { inspectClientInstalls, buildOnboardingNextSteps } from "./bridge.js";

export type InitOptions = {
  targetDir: string;
};

export type InitResult = {
  created: string[];
  skipped: string[];
  /** What to do next (client wiring) — the new-user moment, post-scaffold. */
  next_steps?: string[];
};

async function copyDir(src: string, dest: string, result: InitResult): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, result);
    } else {
      try {
        await fs.access(destPath);
        result.skipped.push(destPath);
      } catch {
        await fs.copyFile(srcPath, destPath);
        result.created.push(destPath);
      }
    }
  }
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const target = path.resolve(options.targetDir);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const scaffoldRoot = path.resolve(__dirname, "..", "..", "scaffold");
  const result: InitResult = { created: [], skipped: [] };

  await copyDir(scaffoldRoot, target, result);

  // Ensure .mnemos marker exists (as a directory — engine stores embeddings.db here)
  const paths = getVaultPaths(target);
  try {
    const stat = await fs.stat(paths.marker);
    if (!stat.isDirectory()) {
      // Migrate: .mnemos was a file in older versions, now it's a directory
      await fs.unlink(paths.marker);
      await fs.mkdir(paths.marker, { recursive: true });
      result.created.push(paths.marker);
    } else {
      result.skipped.push(paths.marker);
    }
  } catch {
    await fs.mkdir(paths.marker, { recursive: true });
    result.created.push(paths.marker);
  }

  return withNextSteps(result, target);
}

async function withNextSteps(result: InitResult, target: string): Promise<InitResult> {
  // Post-scaffold is THE new-user moment: the vault exists, no client points
  // at it, and nothing else in the product mentions `bridge`. Detection
  // failure is non-fatal — a hint is a courtesy, never a blocker.
  try {
    const installs = await inspectClientInstalls(target);
    result.next_steps = buildOnboardingNextSteps(installs.registered);
  } catch {
    result.next_steps = [
      "Wire an agent client: mnemos bridge claude-code|cursor|codex|hermes|opencode|ori --vault <vault-dir>",
      "Any other MCP client: mnemos bridge generic --vault <vault-dir>",
    ];
  }
  return result;
}

export async function runInitInteractive(options: InitOptions & { json?: boolean }): Promise<InitResult> {
  const result = await runInit(options);

  // Silent JSON for agents, pipes, CI, or explicit --json
  if (options.json || !process.stdout.isTTY) {
    return result;
  }

  const target = path.resolve(options.targetDir);
  const state = await readState(target);
  if (!isOnboarded(state)) {
    await runBootSequence(result, target);
  }

  return result;
}
