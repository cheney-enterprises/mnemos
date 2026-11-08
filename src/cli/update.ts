/**
 * mnemos update — the write path for self/, ops/, and map Current State.
 *
 * Extracted from serve.ts so the doctrine's ritual is transport-neutral: the
 * MCP tool today, the HTTP sidecar and Flutter transports later, all behave
 * identically. file=map is the phase-3 addition that made the SESSION END
 * ritual performable without breaking the direct-access ban.
 *
 * Policy: the identity_update and state_overwrite gates apply to the files
 * this function can overwrite. A refusal is a PolicyError; callers surface it
 * verbatim. Auto-backup keeps every overwrite reversible for the user.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles, type VaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { loadPolicy, PolicyError, audit } from "../core/policy.js";
import { readFrontmatterFile, writeFrontmatterFile } from "../core/frontmatter.js";
import { replaceCurrentStateSection } from "../core/mapstate.js";
import { slugify } from "../core/slug.js";

export type UpdatableFile =
  | "identity" | "goals" | "methodology" | "daily" | "reminders" | "map";

export const UPDATABLE_FILES: Record<Exclude<UpdatableFile, "map">, (p: VaultPaths) => string> = {
  identity: (p) => path.join(p.self, "identity.md"),
  goals: (p) => path.join(p.self, "goals.md"),
  methodology: (p) => path.join(p.self, "methodology.md"),
  daily: (p) => path.join(p.ops, "daily.md"),
  reminders: (p) => path.join(p.ops, "reminders.md"),
};

/**
 * Per-project state files: when `project` is given with file=daily|goals,
 * the write lands in ops/<tag>/<file>.md — the structural scoping the
 * scoped wake reads FIRST. Bare writes stay global (the doctrine's
 * unscoped meaning is unchanged). Omitting for identity/methodology:
 * the self-model is one agent, not per-project.
 */
function perProjectStatePath(project: string, file: "daily" | "goals" | "reminders", paths: VaultPaths): string {
  return path.join(paths.ops, project, `${file}.md`);
}

/** The gates each file's overwrite passes through. */
export function gateForFile(file: UpdatableFile): "identity_update" | "state_overwrite" {
  return file === "identity" || file === "methodology" ? "identity_update" : "state_overwrite";
}

export interface UpdateFileOptions {
  startDir: string;
  file: UpdatableFile;
  content: string;
  /** file=map only: the project whose map's Current State to overwrite. */
  project?: string;
}

export interface UpdateFileResult {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
}

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function backupBeforeOverwrite(
  filePath: string,
  label: string,
  existing: string,
): Promise<void> {
  if (!existing) return;
  const historyDir = path.join(path.dirname(filePath), ".history");
  await fs.mkdir(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.writeFile(path.join(historyDir, `${label}-${ts}.md`), existing);
}

/**
 * Overwrite self/identity.md or self/methodology.md — the self-model rewrite
 * gate. At policy level "approval" this proposes only: the intent is recorded
 * and the user executes via `mnemos requests approve`. allow applies at once;
 * deny refuses outright.
 */
async function writeSelfFileWithPolicy(
  vaultRoot: string,
  filePath: string,
  label: "identity" | "methodology",
  content: string,
  gate: "allow" | "approval" | "deny",
  sessionId: string,
): Promise<UpdateFileResult> {
  if (gate === "deny") {
    throw new PolicyError("identity_update", "deny",
      `policy: identity_update=deny — rewriting ${label} is disabled on this vault. Ask the user to write it or change policy.`);
  }
  if (gate === "approval") {
    const { proposeIntent } = await import("../core/policy.js");
    const { policy } = await (async () => {
      const paths = getVaultPaths(vaultRoot);
      const config = await loadConfig(paths.config);
      return loadPolicy(config);
    })();
    const intent = await proposeIntent({
      opRoot: vaultRoot,
      kind: "identity_update",
      selfFile: label,
      content,
      reason: `${label} rewrite requested via agent session`,
      sessionId,
      policy,
    });
    return {
      success: true,
      data: {
        success: true,
        intent_proposed: true,
        approve_command: intent.approve_command,
        note: `policy: identity_update=approval — nothing written. The USER must run: ${intent.approve_command}`,
      },
      warnings: [
        "IDENTITY UPDATE REQUIRES USER APPROVAL — nothing was written.",
        `The user approves by running: ${intent.approve_command}`,
      ],
    };
  }
  // allow
  const existing = await safeReadFile(filePath);
  await backupBeforeOverwrite(filePath, label, existing);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await audit(vaultRoot, { event: "self_file_written", file: label, gate });
  return {
    success: true,
    data: { file: label, path: filePath, backed_up: !!existing, updated: new Date().toISOString() },
    warnings: [],
  };
}

export async function runUpdateFile(options: UpdateFileOptions): Promise<UpdateFileResult> {
  try {
    return await runUpdateFileInner(options);
  } catch (err) {
    if (err instanceof PolicyError) {
      return { success: false, data: { gate: err.gate, level: err.level }, warnings: [err.detail] };
    }
    throw err;
  }
}

async function runUpdateFileInner(options: UpdateFileOptions): Promise<UpdateFileResult> {
  const vaultRoot = await findVaultRoot(options.startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const { policy } = loadPolicy(config);

  if (options.file === "map") {
    return updateMapCurrentState(vaultRoot, paths, config, policy, options);
  }

  const resolver = UPDATABLE_FILES[options.file as Exclude<UpdatableFile, "map">];
  if (!resolver) return { success: false, data: {}, warnings: [`Unknown file: ${options.file}`] };
  const filePath = resolver(paths);

  const gate = policy.gates[gateForFile(options.file)];
  if (options.file === "identity" || options.file === "methodology") {
    return writeSelfFileWithPolicy(vaultRoot, filePath, options.file, options.content, gate, "agent");
  }

  // daily / goals / reminders — per-project files when project is given
  // (structural scoping; the scoped wake reads these first). Reminders in a
  // project file are that project's time-based items; untagged/global items
  // stay in the shared ops/reminders.md. identity/methodology never project
  // (the self-model is one agent).
  if ((options.file === "daily" || options.file === "goals" || options.file === "reminders") && options.project?.trim()) {
    const pTag = options.project.trim();
    const filePath = perProjectStatePath(pTag, options.file, paths);
    const existing = await safeReadFile(filePath);
    await backupBeforeOverwrite(filePath, options.file, existing);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, options.content, "utf8");
    await audit(vaultRoot, { event: "project_state_written", project: pTag, file: options.file });
    return {
      success: true,
      data: {
        file: options.file,
        project: pTag,
        path: filePath,
        scoped: true,
        backed_up: !!existing,
        updated: new Date().toISOString(),
      },
      warnings: [
        `written to ops/${pTag}/${options.file}.md (per-project state; the scoped wake reads this file first)`,
      ],
    };
  }

  // daily / goals / reminders — state_overwrite gate (global files).
  if (gate === "deny") {
    throw new PolicyError("state_overwrite", "deny",
      `policy: state_overwrite=deny — writing ${options.file} is disabled on this vault. Ask the user to write it or change policy.`);
  }
  if (gate === "approval") {
    // Daily/goals/reminders are operational scratch, not the self-model: a
    // pending intent would make the ritual unusable. At approval the write is
    // refused with the reason — the USER can lower the gate or write it
    // themselves.
    return {
      success: false,
      data: { file: options.file },
      warnings: [
        `policy: state_overwrite=approval — writing ${options.file} requires user approval on this vault. Nothing was written.`,
        "The user can write it themselves, or set state_overwrite: allow in mnemos.config.yaml.",
      ],
    };
  }

  const existing = await safeReadFile(filePath);
  await backupBeforeOverwrite(filePath, options.file, existing);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, options.content, "utf8");
  return {
    success: true,
    data: { file: options.file, path: filePath, backed_up: !!existing, updated: new Date().toISOString() },
    warnings: [],
  };
}

/**
 * file=map: overwrite the target map's `## Current State` section.
 * The map is resolved project → config routing → `<slug>…map` convention,
 * exactly promote's chain — one routing truth.
 */
async function updateMapCurrentState(
  vaultRoot: string,
  paths: VaultPaths,
  config: Awaited<ReturnType<typeof loadConfig>>,
  policy: ReturnType<typeof loadPolicy>["policy"],
  options: UpdateFileOptions,
): Promise<UpdateFileResult> {
  const project = options.project?.trim();
  if (!project) {
    return {
      success: false,
      data: {},
      warnings: [
        "file=map requires project (the project whose map to update). The wake briefing's project roster lists the live projects.",
      ],
    };
  }

  const gate = policy.gates.state_overwrite;
  if (gate === "deny") {
    throw new PolicyError("state_overwrite", "deny",
      "policy: state_overwrite=deny — map Current State updates are disabled on this vault. Ask the user to update the map or change policy.");
  }
  if (gate === "approval") {
    return {
      success: false,
      data: { file: "map", project },
      warnings: [
        `policy: state_overwrite=approval — map Current State updates require user approval on this vault. Nothing was written.`,
        "The user can update the map themselves, or set state_overwrite: allow in mnemos.config.yaml.",
      ],
    };
  }

  // Resolve the map: config routing first, then the "<tag>…map" convention —
  // the same chain promote uses, so a map add routes to is a map update finds.
  const routing = config.promote.project_map_routing[project];
  const titles = await listNoteTitles(paths.notes);
  const routingHit = routing && titles.includes(routing) ? routing : undefined;
  const conventionHit = routingHit
    ? undefined
    : titles.find((t) => /(^|[-\s])map$/i.test(t.trim()) && slugify(t).includes(slugify(project)));

  const mapTitle = routingHit ?? conventionHit;
  if (!mapTitle) {
    return {
      success: false,
      data: { file: "map", project },
      warnings: [
        `No map found for project "${project}". Looked for: ${routing ? `${routing} (config routing)` : "config routing (none)"} then "<${project}>…map" titles in notes/.`,
        'Create the map first: mnemos_add("<project> project map", type=moc, project=["<project>"]).',
      ],
    };
  }

  const mapPath = path.join(paths.notes, `${mapTitle}.md`);
  const parsed = await readFrontmatterFile(mapPath);
  if (!parsed.data) {
    return {
      success: false,
      data: { file: "map", project, map: mapTitle },
      warnings: [`Map ${mapTitle} has no readable frontmatter; refusing to edit it.`],
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const replaced = replaceCurrentStateSection(parsed.body, options.content, today);

  await backupBeforeOverwrite(mapPath, mapTitle, await safeReadFile(mapPath));
  await writeFrontmatterFile(mapPath, parsed.data, replaced.content);

  await audit(vaultRoot, {
    event: "map_current_state_written",
    project,
    map: mapTitle,
    section_created: replaced.created,
  });

  return {
    success: true,
    data: {
      file: "map",
      path: mapPath,
      map: mapTitle,
      project,
      section_created: replaced.created,
      previous_heading: replaced.created ? undefined : replaced.heading,
      backed_up: true,
      updated: new Date().toISOString(),
    },
    warnings: [
      "Current State overwritten (never appended) — Key Notes and frontmatter untouched.",
      ...(replaced.created ? ["No Current State section existed — one was created at the end of the map."] : []),
      ...(!/^type:\s*moc/m.test(JSON.stringify(parsed.data)) && parsed.data.type !== "moc"
        ? [`Warning: ${mapTitle} is not a type=moc note; it matched the map convention but may not be a real map.`]
        : []),
    ],
  };
}
