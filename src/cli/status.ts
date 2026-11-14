import { promises as fs, type Dirent } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findOrphans, type LinkGraph } from "../core/graph.js";
import { inspectClientInstalls, buildOnboardingNextSteps } from "./bridge.js";

export type StatusResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runStatus(
  startDir: string,
  linkGraph?: LinkGraph,
): Promise<StatusResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);

  const allNotes = await listNoteTitles(paths.notes);
  const graph = linkGraph ?? await buildGraph(paths.notes);
  const orphans = findOrphans(graph, allNotes);

  let inboxEntries: Dirent[];
  try {
    inboxEntries = await fs.readdir(paths.inbox, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      inboxEntries = [];
    } else {
      throw err;
    }
  }
  const inboxCount = inboxEntries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;

  // Onboarding hint (the tool tells the human the next step): which clients
  // already point at mnemos, and how to wire one when none do. Detection
  // failure is non-fatal — status must never break because a config file
  // somewhere is unreadable.
  let clientsRegistered: Awaited<ReturnType<typeof inspectClientInstalls>>["registered"] = [];
  let nextSteps: string[] = [];
  try {
    // Detection uses the caller's directory (project-scope installs live in
    // the project, e.g. .mcp.json), not the vault root.
    const installs = await inspectClientInstalls(startDir);
    clientsRegistered = installs.registered;
    nextSteps = buildOnboardingNextSteps(installs.registered);
  } catch {
    nextSteps = ["Client wiring detection unavailable — run `mnemos bridge status` for details."];
  }

  return {
    success: true,
    data: {
      vaultRoot,
      noteCount: allNotes.length,
      inboxCount,
      orphanCount: orphans.length,
      clients_registered: clientsRegistered,
      next_steps: nextSteps,
    },
    warnings: [],
  };
}
