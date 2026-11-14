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
  return { enabled: true, id: explicit, ephemeral: false, record: filePath, lineage };
}
