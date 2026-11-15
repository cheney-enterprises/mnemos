import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import {
  buildGraph,
  findBacklinks,
  findDanglingLinks,
  findOrphans,
  type LinkGraph,
} from "../core/graph.js";
import { parseFrontmatter } from "../core/frontmatter.js";
import { computeGraphMetrics } from "../core/importance.js";
import { rankByImportance, rankByFading } from "../core/ranking.js";
import { loadConfig } from "../core/config.js";
import { computeAllVitality } from "../core/noteindex.js";
import { initDB } from "../core/engine.js";
import { loadBoosts } from "../core/activation.js";
import { bulletList, score as fmtScore } from "./render.js";

export type QueryResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/** Human rendering of the simple query kinds (orphans/dangling/backlinks/
 * cross-project/important/fading). `ranked`/`similar` render through
 * formatRankedRows in the CLI wiring — their result shape is search.ts's. */
export function formatQuery(kind: string, data: Record<string, unknown>): string {
  const asTitles = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  switch (kind) {
    case "orphans": {
      const items = asTitles(data.orphans);
      return items.length === 0
        ? "No orphans — every note is linked from somewhere."
        : [`Orphans (${items.length}) — notes nothing links to:`, ...bulletList(items)].join("\n");
    }
    case "dangling": {
      const items = asTitles(data.dangling);
      return items.length === 0
        ? "No dangling links — every [[wiki-link]] resolves."
        : [`Dangling links (${items.length}) — [[targets]] that don't exist:`, ...bulletList(items)].join("\n");
    }
    case "backlinks": {
      const items = asTitles(data.backlinks);
      return items.length === 0
        ? "No backlinks found."
        : [`Backlinks (${items.length}):`, ...bulletList(items)].join("\n");
    }
    case "cross-project": {
      const items = asTitles(data.notes);
      return items.length === 0
        ? "No notes tagged with 2+ projects."
        : [`Multi-project notes (${items.length}):`, ...bulletList(items)].join("\n");
    }
    case "important": {
      const rows = (data.results as Array<{ title: string; score: number }>) ?? [];
      if (rows.length === 0) return "No scored notes.";
      return [
        "Most important (PageRank):",
        ...rows.map((r, i) => `${i + 1}. ${r.title}  (${fmtScore(r.score)})`),
      ].join("\n");
    }
    case "fading": {
      const rows = (data.results as Array<{ title: string; score: number }>) ?? [];
      if (rows.length === 0) return "Nothing is fading past the threshold.";
      return [
        `Fading (${rows.length}) — vitality below threshold:`,
        ...rows.map((r, i) => `${i + 1}. ${r.title}  (vitality ${fmtScore(r.score)})`),
      ].join("\n");
    }
    default:
      return JSON.stringify(data);
  }
}

export async function runQueryOrphans(
  startDir: string,
  linkGraph?: LinkGraph,
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = linkGraph ?? await buildGraph(notes);
  const orphans = findOrphans(graph, allNotes);

  return {
    success: true,
    data: { orphans },
    warnings: [],
  };
}

export async function runQueryDangling(
  startDir: string,
  linkGraph?: LinkGraph,
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = linkGraph ?? await buildGraph(notes);
  const dangling = findDanglingLinks(graph, allNotes);

  return {
    success: true,
    data: { dangling },
    warnings: [],
  };
}

export async function runQueryBacklinks(
  startDir: string,
  note: string,
  linkGraph?: LinkGraph,
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const graph = linkGraph ?? await buildGraph(notes);
  const backlinks = findBacklinks(graph, note);

  return {
    success: true,
    data: { backlinks },
    warnings: [],
  };
}

export async function runQueryCrossProject(startDir: string): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(notes, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { success: true, data: { notes: [] }, warnings: [] };
    }
    throw err;
  }
  const results: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(notes, entry.name);
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseFrontmatter(content);
    if (!parsed.data) continue;
    const project = (parsed.data as Record<string, unknown>)["project"];
    if (Array.isArray(project) && project.length >= 2) {
      results.push(entry.name.replace(/\.md$/, ""));
    }
  }

  return {
    success: true,
    data: { notes: results },
    warnings: [],
  };
}

export async function runQueryImportant(
  startDir: string,
  limit?: number,
  linkGraph?: LinkGraph,
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const { notes } = getVaultPaths(vaultRoot);
  const allNotes = await listNoteTitles(notes);
  const graph = linkGraph ?? await buildGraph(notes);
  const metrics = computeGraphMetrics(graph);
  const results = rankByImportance(allNotes, metrics.pagerank, limit ?? 10);

  return {
    success: true,
    data: { results },
    warnings: [],
  };
}

export async function runQueryFading(
  startDir: string,
  threshold?: number,
  limit?: number,
  linkGraph?: LinkGraph,
): Promise<QueryResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const allNotes = await listNoteTitles(paths.notes);
  const graph = linkGraph ?? await buildGraph(paths.notes);
  const metrics = computeGraphMetrics(graph);

  // Load spreading activation boosts from SQLite
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let boostScores: Map<string, number> | undefined;
  try {
    await fs.access(dbPath);
    const db = initDB(dbPath);
    boostScores = config.activation?.enabled !== false ? loadBoosts(db) : undefined;
    db.close();
  } catch {
    // DB doesn't exist yet -- no boosts
  }

  const vitalityScores = await computeAllVitality(
    paths.notes,
    allNotes,
    graph,
    metrics.bridges,
    config,
    boostScores,
  );

  const all = rankByFading(allNotes, vitalityScores, threshold ?? 0.3);
  const results = limit != null ? all.slice(0, limit) : all;

  return {
    success: true,
    data: { results },
    warnings: [],
  };
}
