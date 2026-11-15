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
import { promises as fs, type Stats as FsStats } from "node:fs";
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

/**
 * §7 session stream: append lines to a session's record, creating the record
 * on first capture — "a session record created on first capture (the Phase 3
 * automatic stream), never by wake itself". Append-only, zero gates: the
 * machinery nobody sees. The record lives outside `notes/` and the index
 * (spec §7), so appends touch nothing derived.
 *
 * Concurrency (§8.3): appends are serialized PER RECORD with a mkdir-based
 * lock (atomic on POSIX and Windows; stale locks are stolen after a
 * deadline). The lock is load-bearing — the first race test lost 10 of 12
 * concurrent lines to read-modify-write clobbering, exactly the failure §8.3
 * exists to catch. Known narrow window, documented: a re-bind or adoption
 * (wholesale record rewrites) does not take the lock; a capture appending in
 * that exact window can be lost — the stream is best-effort machinery, and
 * the capture itself is never affected.
 */
export async function appendToSessionRecord(
  vaultRoot: string,
  config: MnemosConfig,
  sessionId: string,
  lines: string[],
): Promise<string | null> {
  if (!config.retrieval.session_scope.enabled) return null;
  const trimmedId = sessionId.trim();
  if (!trimmedId || lines.length === 0) return null;

  const paths = getVaultPaths(vaultRoot);
  const dir = path.join(paths.ops, "sessions");
  await fs.mkdir(dir, { recursive: true });
  const slug = slugify(trimmedId);
  const filePath = path.join(dir, `${slug}.md`);
  return withRecordLock(dir, slug, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const block = lines.map((line) => `- ${stamp} ${line}`).join("\n") + "\n";

    const existing = await fs.readFile(filePath, "utf8").catch(() => null);
    if (existing === null) {
      // First capture: create the record with the standard header.
      const data: Record<string, unknown> = { session: trimmedId, created: today };
      await writeFileAtomic(filePath, stringifyFrontmatter(data, `${RECORD_HEADER(trimmedId)}${block}`));
      return filePath;
    }

    const parsed = parseFrontmatter(existing);
    const data = { ...(parsed.data ?? {}), session: trimmedId } as Record<string, unknown>;
    const body = `${(parsed.body || RECORD_HEADER(trimmedId)).replace(/\s*$/, "\n")}${block}`;
    await writeFileAtomic(filePath, stringifyFrontmatter(data, body));
    return filePath;
  });
}

/** Per-record mkdir lock: atomic acquisition on every platform, 5s deadline
 * with stale-lock stealing (a crashed holder must not deadlock the stream). */
async function withRecordLock<T>(
  dir: string,
  slug: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = path.join(dir, ".locks", slug);
  const deadline = Date.now() + 5000;
  // The parent is created recursively; the LOCK DIR must be created with the
  // plain form — recursive mkdir never throws EEXIST, which would make the
  // lock a no-op. Plain mkdir throws EEXIST exactly when the lock is held.
  await fs.mkdir(path.join(dir, ".locks"), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        // Steal: a holder that held the lock for 5s is presumed dead.
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// §8.2 lineage-stream decay — coverDaily's compression, applied to session
// records: recent streams stay raw, old streams compress into their capture
// links, ancient streams archive out of the way. "Never miss" must survive
// year three: the capture LINKS (the [[provenance]]) always survive; the
// prose between them is what decays.
// ---------------------------------------------------------------------------

export type StreamCompressionResult = {
  raw: number;
  compressed: string[];
  archived: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function recordAgeDays(created: unknown, fallbackMtimeMs: number, now: number): number {
  const createdStr = typeof created === "string" ? created : "";
  const parsed = createdStr ? Date.parse(createdStr) : NaN;
  const startMs = Number.isNaN(parsed) ? fallbackMtimeMs : parsed;
  return Math.max(0, (now - startMs) / DAY_MS);
}

/**
 * Compress old session records (§8.2). Bands, from the default constants:
 *   raw       ≤ 14 days  — untouched
 *   compressed ≤ 90 days — body reduced to the capture links (the
 *                         [[provenance]] survives, prose decays), a
 *                         compression line records what happened
 *   archived  > 90 days  — the record MOVES to ops/sessions/archive/
 *
 * Lineage edges (continues/branched_from) are PRESERVED in every band —
 * the lineage graph is the §5 gradient's backbone and never decays in v1
 * (edge decay is a future tunable). Zero gates; dry-run by default
 * (house style: prune-like), --apply to mutate.
 */
export async function compressSessionStreams(
  vaultRoot: string,
  config: MnemosConfig,
  options: {
    rawDays?: number;
    compressDays?: number;
    apply?: boolean;
    now?: number;
  } = {},
): Promise<StreamCompressionResult & { dryRun: boolean }> {
  const result: StreamCompressionResult & { dryRun: boolean } = {
    raw: 0,
    compressed: [],
    archived: [],
    dryRun: options.apply !== true,
  };
  if (!config.retrieval.session_scope.enabled) return result;

  const rawDays = options.rawDays ?? 14;
  const compressDays = options.compressDays ?? 90;
  const now = options.now ?? Date.now();

  const paths = getVaultPaths(vaultRoot);
  const dir = path.join(paths.ops, "sessions");
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((e) => e.endsWith(".md"));
  } catch {
    return result; // no stream yet
  }

  const archiveDir = path.join(dir, "archive");
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    let stat: FsStats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    const ageDays = recordAgeDays(data.created, stat.mtimeMs, now);

    // Idempotency: an already-compressed record has nothing left to decay
    // (its prose is gone; the links remain). Count it as raw/skip.
    if (ageDays > rawDays && parsed.body.includes("prose compressed")) {
      result.raw += 1;
      continue;
    }

    if (ageDays <= rawDays) {
      result.raw += 1;
      continue;
    }

    // The band decision is a pre-lock hint; the links are re-derived inside
    // the lock (an appender may have added captures since this read).
    const ageBucket = ageDays > compressDays ? "archived" : "compressed";

    if (result.dryRun) {
      (ageBucket === "archived" ? result.archived : result.compressed).push(entry);
      continue;
    }

    await withRecordLock(dir, entry.replace(/\.md$/, ""), async () => {
      // Re-read inside the lock — the pre-lock read only decided the band;
      // an appender may have appended between that read and the lock
      // acquisition, and writing the stale read back would eat its lines
      // (the same §8.3 window the bind/adoption closure covers).
      const fresh = parseFrontmatter(await fs.readFile(filePath, "utf8"));
      const freshData = (fresh.data ?? {}) as Record<string, unknown>;
      const freshLinks = [
        ...new Set([...fresh.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim())),
      ];
      if (ageBucket === "archived") {
        await fs.mkdir(archiveDir, { recursive: true });
        // Compress THEN archive: the archived record carries the summary.
        const summary =
          `# Session stream (compressed ${new Date(now).toISOString().slice(0, 10)})\n\n` +
          `Captured ${freshLinks.length} notes:\n` +
          freshLinks.map((l) => `- [[${l}]]`).join("\n") +
          "\n";
        await fs.writeFile(path.join(archiveDir, entry), summary, "utf8");
        await fs.rm(filePath, { force: true });
        result.archived.push(entry);
      } else {
        const compressedBody =
          `Captured ${freshLinks.length} notes (prose compressed §8.2):\n` +
          freshLinks.map((l) => `- [[${l}]]`).join("\n") +
          "\n";
        await writeFileAtomic(filePath, stringifyFrontmatter(freshData, compressedBody));
        result.compressed.push(entry);
      }
    });
  }
  return result;
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
  const explicitSlug = slugify(explicit);
  const filePath = path.join(dir, `${explicitSlug}.md`);

  const parent = intake.parent?.trim() || null;
  const lineage: LineageEdge | null = parent ? normalizeLineage(intake.lineage) : null;

  // §8.3, the narrow-window debt closed: the re-bind rewrite below is a
  // read-modify-write of the record an appender may be appending to RIGHT
  // NOW, so it holds the same per-record lock the appender holds. The
  // adoption is wrapped too — it rewrites the named record (outer lock) and
  // the provisional record (inner lock; reentrancy on the same slug would
  // self-deadlock into the 5s steal, so the two locks are distinct slugs).
  // No cycle is possible: an appender holds at most one lock, and the
  // adoption's second-level acquisitions are always provisional/repoint
  // targets, never another binder's named record.
  const provisional = intake.ephemeralId?.trim();
  const shouldAdopt = Boolean(provisional && provisional !== explicit);

  return withRecordLock(dir, explicitSlug, async () => {
    let adopted = false;
    if (shouldAdopt && provisional) {
      adopted = await withRecordLock(dir, slugify(provisional), () =>
        adoptRecord(dir, provisional, explicit, parent, lineage),
      );
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
  });
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
  //
  // Each repoint takes the target's own record lock and RE-READS the file
  // inside it: the pre-lock read above is only a decision hint, and an
  // appender may have appended between that read and the lock acquisition
  // (writing the stale read back would eat the appender's lines — the exact
  // §8.3 window this closure exists for).
  for (const entry of await fs.readdir(dir)) {
    if (!entry.endsWith(".md")) continue;
    if (entry === `${slugify(provisionalId)}.md` || entry === `${slugify(explicit)}.md`) continue;
    const filePath = path.join(dir, entry);
    const targetSlug = entry.replace(/\.md$/, "");
    await withRecordLock(dir, targetSlug, async () => {
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
    });
  }

  // The provisional record is absorbed — remove it. Session records are
  // outside the note schema and index (spec §7); removal touches nothing
  // derived, and the absorption is recorded in the surviving record.
  await fs.rm(provisionalPath, { force: true });
  return true;
}
