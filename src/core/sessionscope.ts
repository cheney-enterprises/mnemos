/**
 * Session binding — Phase 1 of the session-scope spec
 * (docs/specs/session-scope-spec.md §3–§4).
 *
 * Binding is constructive, never interrogative: the harness knows its own
 * session parentage and passes it as deterministic intake (`session=`,
 * `parent=`); mnemos accepts it. A bare invocation binds an EPHEMERAL
 * identity only — its record is created on first capture (the Phase 3
 * automatic stream), never by wake itself.
 *
 * Records live in `ops/sessions/` — outside `notes/` and therefore outside
 * the note schema and the note index (spec §7: the session stream is the
 * machinery nobody sees, at the ops 3.0× metabolic rate). Zero migration
 * (§8): a record with no lineage field is retroactively a lineage root, so
 * the live vault needs no re-tagging pass.
 *
 * Flag contract (§10): with `retrieval.session_scope.enabled=false` this
 * module is a no-op and no result field changes — every current contract
 * stays in force until the benchmark gate (§9) passes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MnemosConfig } from "./config.js";
import { getVaultPaths } from "./vault.js";
import { slugify } from "./slug.js";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  writeFileAtomic,
} from "./frontmatter.js";

/** The two lineage edges (spec §4): same thread carried forward, or a fork. */
export type LineageEdge = "continues" | "branched_from";

export type SessionIntake = {
  /** The harness session id (deterministic intake — no inference). */
  session?: string;
  /** The parent session id, when this session continues or branches from one. */
  parent?: string;
  /** Which lineage edge `parent` is. Default: `continues`. */
  lineage?: string;
  /**
   * A previously bound ephemeral id, for continuity across calls within one
   * MCP connection (the harness that gives no metadata still IS a session).
   */
  ephemeralId?: string;
};

export type SessionBinding = {
  /** False when the flag is off: a structural no-op, nothing below is meaningful. */
  enabled: boolean;
  id: string;
  /** True when no harness metadata arrived: identity only, no record. */
  ephemeral: boolean;
  /** Absolute record path, or null for an ephemeral binding. */
  record: string | null;
  /** The lineage edge written by this bind, or null (root / ephemeral). */
  lineage: LineageEdge | null;
  /** True when this bind ADOPTED a provisional record (§3.2): rename +
   * repoint + merge, never fork. */
  adopted?: boolean;
};

const NO_BINDING: SessionBinding = {
  enabled: false,
  id: "",
  ephemeral: false,
  record: null,
  lineage: null,
};

export function normalizeLineage(raw?: string | null): LineageEdge {
  return raw?.trim().toLowerCase() === "branched_from" ? "branched_from" : "continues";
}

/** A fresh constructive identity for an invocation with no harness metadata. */
export function newEphemeralSessionId(): string {
  return `ses-${randomUUID()}`;
}

const RECORD_HEADER = (id: string) =>
  `# Session ${id}\n\n` +
  "Session stream (spec §7): the machinery nobody sees — appended by the\n" +
  "binding path, zero gates, fast ops decay. The user sees only the adds and\n" +
  "the removes.\n";

/**
 * Bind a session. Flag off → NO_BINDING (callers must treat the whole
 * result field as absent). Flag on: explicit `session=` binds durably —
 * the record in `ops/sessions/` is created or updated idempotently; no
 * metadata binds an ephemeral identity and writes nothing.
 *
 * §3.2 late-binding ADOPTION: a named identity arriving while a provisional
 * id is in play (intake.ephemeralId) ADOPTS that id's record — rename +
 * repoint + merge, never fork. One thread of work = one record, always.
 */
export async function bindSession(
  vaultRoot: string,
  config: MnemosConfig,
  intake: SessionIntake,
): Promise<SessionBinding> {
  if (!config.retrieval.session_scope.enabled) return NO_BINDING;

  const explicit = intake.session?.trim();
  const id = explicit || intake.ephemeralId?.trim() || newEphemeralSessionId();
  if (!explicit) {
    return { enabled: true, id, ephemeral: true, record: null, lineage: null };
  }

  const paths = getVaultPaths(vaultRoot);
  const dir = path.join(paths.ops, "sessions");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${slugify(explicit)}.md`);

  const parent = intake.parent?.trim() || null;
  const lineage: LineageEdge | null = parent ? normalizeLineage(intake.lineage) : null;

  // §3.2 ADOPTION: the named identity adopts the provisional id's record.
  const provisional = intake.ephemeralId?.trim();
  let adopted = false;
  if (provisional && provisional !== explicit) {
    adopted = await adoptRecord(dir, provisional, explicit, parent, lineage);
  }

  const today = new Date().toISOString().slice(0, 10);
  const data: Record<string, unknown> = { session: explicit };
  let body = RECORD_HEADER(explicit);

  const existing = await fs.readFile(filePath, "utf8").catch(() => null);
  if (existing !== null) {
    const parsed = parseFrontmatter(existing);
    // Idempotent re-bind: the harness's latest metadata is authoritative
    // (deterministic intake), but nothing else the record carries is lost.
    if (parsed.data) Object.assign(data, parsed.data);
    data.session = explicit;
    if (parsed.body.trim().length > 0) body = parsed.body;
  }
  if (!data.created) data.created = today;
  // Lineage is written only when the harness states it — a re-bind without
  // parent= must not wipe an existing edge (harnesses may pass parentage
  // only on the first call). Clearing is deliberate metadata, not an
  // omission; zero migration (§8) keeps untouched records as roots.
  if (parent && lineage) {
    delete data.continues;
    delete data.branched_from;
    data[lineage] = parent;
  }

  await writeFileAtomic(filePath, stringifyFrontmatter(data, body));
  return { enabled: true, id: explicit, ephemeral: false, record: filePath, lineage, adopted: adopted || undefined };
}

/**
 * §3.2 adoption. The named session adopts the provisional id's record:
 * rename + repoint + merge, NEVER fork. Repoints every other session
 * record's lineage edge that referenced the provisional id, so the thread
 * stays connected under the new name. Returns true when an adoption
 * happened (a provisional record existed).
 *
 * Merge semantics when BOTH records exist: the named record survives (its
 * frontmatter wins; earliest `created` wins), the provisional's body is
 * appended with an absorption line, and the provisional file is removed —
 * the thread is consolidated, not forked. Session records live outside
 * `notes/` (spec §7), so this touches no index.
 */
async function adoptRecord(
  dir: string,
  provisionalId: string,
  explicit: string,
  parent: string | null,
  lineage: LineageEdge | null,
): Promise<boolean> {
  const provisionalPath = path.join(dir, `${slugify(provisionalId)}.md`);
  const provisionalRaw = await fs.readFile(provisionalPath, "utf8").catch(() => null);
  if (provisionalRaw === null) return false; // nothing to adopt — normal bind

  const namedPath = path.join(dir, `${slugify(explicit)}.md`);
  const namedRaw = await fs.readFile(namedPath, "utf8").catch(() => null);

  const provisional = parseFrontmatter(provisionalRaw);
  const provisionalData = (provisional.data ?? {}) as Record<string, unknown>;
  provisionalData.session = explicit;
  delete provisionalData.adopted_from;

  if (namedRaw === null) {
    // Simple rename: the provisional record BECOMES the named record.
    const data = { ...provisionalData };
    if (parent && lineage) {
      delete data.continues;
      delete data.branched_from;
      data[lineage] = parent;
    }
    await writeFileAtomic(namedPath, stringifyFrontmatter(data, provisional.body));
  } else {
    // Both exist: consolidate. Named frontmatter wins; earliest created
    // wins (the thread started when the provisional started); the
    // provisional's body carries over with an absorption line.
    const named = parseFrontmatter(namedRaw);
    const namedData = (named.data ?? {}) as Record<string, unknown>;
    const created =
      [namedData.created, provisionalData.created]
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .sort()[0] ?? undefined;
    const merged: Record<string, unknown> = { ...provisionalData, ...namedData, session: explicit };
    if (created) merged.created = created;
    if (parent && lineage) {
      delete merged.continues;
      delete merged.branched_from;
      merged[lineage] = parent;
    }
    const absorption =
      named.body.trim().length > 0 ? named.body : RECORD_HEADER(explicit);
    const carryOver = provisional.body
      .split(/\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("# "));
    const body =
      absorption.replace(/\s*$/, "\n") +
      (carryOver.length > 0
        ? `\nAbsorbed provisional record ${provisionalId} (spec §3.2 adoption):\n` +
          carryOver.map((line) => `- ${line}`).join("\n") +
          "\n"
        : "");
    await writeFileAtomic(namedPath, stringifyFrontmatter(merged, body));
  }

  // Repoint: every OTHER session record whose lineage edge referenced the
  // provisional id now points at the named id — the thread stays connected.
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith(".md")) continue;
    if (entry === `${slugify(provisionalId)}.md` || entry === `${slugify(explicit)}.md`) continue;
    const filePath = path.join(dir, entry);
    const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    let changed = false;
    for (const key of ["continues", "branched_from"]) {
      if (data[key] === provisionalId) {
        data[key] = explicit;
        changed = true;
      }
    }
    if (changed) await writeFileAtomic(filePath, stringifyFrontmatter(data, parsed.body));
  }

  // The provisional record is absorbed — remove it. Session records are
  // outside the note schema and index (spec §7); removal touches nothing
  // derived, and the absorption is recorded in the surviving record.
  await fs.rm(provisionalPath, { force: true });
  return true;
}
