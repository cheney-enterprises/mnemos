/**
 * Session binding — Phase 1 of the session-scope spec
 * (docs/specs/session-scope-spec.md §3–§4, flag §10).
 *
 * The spec's exit criterion (§10 Phase 1 row): "continuation/branch context
 * flows in tests". These tests pin: the flag-off no-op contract, constructive
 * binding (never a question), lineage edges on `ops/sessions/` records,
 * idempotent re-binding, ephemeral identities, and zero migration (a record
 * without lineage fields is a lineage root).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runWake } from "../../src/cli/wake.js";
import { bindSession, normalizeLineage, newEphemeralSessionId } from "../../src/core/sessionscope.js";
import { slugify } from "../../src/core/slug.js";
import { loadConfig } from "../../src/core/config.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

let flagOffVault: string;
let flagOnVault: string;

async function setSessionScopeFlag(vaultDir: string, enabled: boolean) {
  // Parse-and-set, not text surgery: the scaffold's flag is ON by default
  // since the 2026-11-15 activation, so the old commented-block regex can no
  // longer be matched — and a helper must work regardless of the block's
  // shape. The yaml round-trip drops comments; tests read values only.
  const configPath = path.join(vaultDir, "mnemos.config.yaml");
  const { parse, stringify } = await import("yaml");
  const doc = parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  doc.retrieval = (doc.retrieval ?? {}) as Record<string, unknown>;
  const scope = ((doc.retrieval as Record<string, unknown>).session_scope ?? {}) as Record<string, unknown>;
  scope.enabled = enabled;
  (doc.retrieval as Record<string, unknown>).session_scope = scope;
  await fs.writeFile(configPath, stringify(doc));
}

beforeAll(async () => {
  flagOffVault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-sess-off-"));
  flagOnVault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-sess-on-"));
  await runInit({ targetDir: flagOffVault });
  await runInit({ targetDir: flagOnVault });
  // The flag is ON by default since the 2026-11-15 activation — the
  // flag-off vault opts out explicitly.
  await setSessionScopeFlag(flagOffVault, false);
  await setSessionScopeFlag(flagOnVault, true);
  // Binding never touches the index, but runWake assembles wake inputs from
  // it — build once so the integration tests read a live (empty) index.
  await runIndexBuild(flagOffVault);
  await runIndexBuild(flagOnVault);
}, 120000);

afterAll(async () => {
  await fs.rm(flagOffVault, { recursive: true, force: true });
  await fs.rm(flagOnVault, { recursive: true, force: true });
});

describe("bindSession — flag contract (spec §10)", () => {
  it("flag off is a structural no-op: no record, no dir", async () => {
    const config = await loadConfig(path.join(flagOffVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOffVault, config, { session: "ses_abc" });
    expect(b.enabled).toBe(false);
    expect(b.record).toBeNull();
    // The binding path must not write any stream records. (ops/sessions/
    // pre-exists in the scaffold with a .gitkeep — assert on files, not dirs.)
    const streamFiles = await fs.readdir(path.join(flagOffVault, "ops", "sessions"));
    expect(streamFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });
});

describe("bindSession — durable binding (spec §3, §4)", () => {
  it("session= creates an ops/sessions/ record, no question asked", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOnVault, config, { session: "ses_abc123" });
    expect(b.enabled).toBe(true);
    expect(b.ephemeral).toBe(false);
    expect(b.record).toContain(`ops${path.sep}sessions`);
    const parsed = await readFrontmatterFile(b.record as string);
    expect(parsed.data?.session).toBe("ses_abc123");
    expect(typeof parsed.data?.created).toBe("string");
    // Zero migration (§8): a record with no lineage field is a lineage root.
    expect(parsed.data?.continues).toBeUndefined();
    expect(parsed.data?.branched_from).toBeUndefined();
  });

  it("parent= writes the continues edge by default (spec §4)", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOnVault, config, { session: "ses_child", parent: "ses_abc123" });
    expect(b.lineage).toBe("continues");
    const parsed = await readFrontmatterFile(b.record as string);
    expect(parsed.data?.continues).toBe("ses_abc123");
    expect(parsed.data?.branched_from).toBeUndefined();
  });

  it("lineage=branched_from writes the fork edge (spec §4)", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOnVault, config, {
      session: "ses_fork",
      parent: "ses_abc123",
      lineage: "branched_from",
    });
    expect(b.lineage).toBe("branched_from");
    const parsed = await readFrontmatterFile(b.record as string);
    expect(parsed.data?.branched_from).toBe("ses_abc123");
    expect(parsed.data?.continues).toBeUndefined();
  });

  it("re-binding is idempotent: created and body preserved, no duplicate", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const first = await bindSession(flagOnVault, config, { session: "ses_dup" });
    const before = await readFrontmatterFile(first.record as string);
    const created = before.data?.created;
    const afterFirstBindCount = (await fs.readdir(path.join(flagOnVault, "ops", "sessions")))
      .filter((f) => f.endsWith(".md")).length;

    const second = await bindSession(flagOnVault, config, { session: "ses_dup", parent: "ses_abc123" });
    expect(second.record).toBe(first.record);
    const streamFiles = (await fs.readdir(path.join(flagOnVault, "ops", "sessions")))
      .filter((f) => f.endsWith(".md"));
    expect(streamFiles).toHaveLength(afterFirstBindCount);
    const after = await readFrontmatterFile(second.record as string);
    expect(after.data?.created).toBe(created);
    expect(after.data?.continues).toBe("ses_abc123");
  });

  it("re-binding without parent= preserves an existing lineage edge", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    await bindSession(flagOnVault, config, { session: "ses_keep", parent: "ses_abc123" });
    const b = await bindSession(flagOnVault, config, { session: "ses_keep" });
    expect(b.lineage).toBeNull();
    const parsed = await readFrontmatterFile(b.record as string);
    expect(parsed.data?.continues).toBe("ses_abc123");
  });
});

describe("bindSession — constructive binding for the zero-signal session (spec §3)", () => {
  it("no harness metadata binds an ephemeral identity and writes nothing", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOnVault, config, {});
    expect(b.enabled).toBe(true);
    expect(b.ephemeral).toBe(true);
    expect(b.id).toMatch(/^ses-/);
    expect(b.record).toBeNull();
    const dirFiles = (await fs.readdir(path.join(flagOnVault, "ops", "sessions")))
      .filter((f) => f.endsWith(".md"));
    expect(dirFiles).toHaveLength(5); // the durable records from the tests above
  });

  it("ephemeralId gives one identity across calls in one connection", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const first = bindSession(flagOnVault, config, {});
    const b = await bindSession(flagOnVault, config, {
      ephemeralId: (await first).id,
    });
    expect(b.id).toBe((await first).id);
    expect(b.ephemeral).toBe(true);
  });

  it("newEphemeralSessionId never collides", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEphemeralSessionId()));
    expect(ids.size).toBe(50);
  });
});

describe("normalizeLineage", () => {
  it("defaults to continues; only the exact fork word forks", () => {
    expect(normalizeLineage(undefined)).toBe("continues");
    expect(normalizeLineage("")).toBe("continues");
    expect(normalizeLineage("continues")).toBe("continues");
    expect(normalizeLineage("branched_from")).toBe("branched_from");
    expect(normalizeLineage("BRANCHED_FROM")).toBe("branched_from");
    expect(normalizeLineage("anything-else")).toBe("continues");
  });
});

describe("runWake integration (flag contract end to end)", () => {
  it("flag off: wake with session intake changes nothing", async () => {
    const r = await runWake(flagOffVault, 96, undefined, undefined, false, {
      session: "ses_hidden",
      parent: "ses_older",
    });
    expect(r.session_binding).toBeUndefined();
    const streamFiles = await fs.readdir(path.join(flagOffVault, "ops", "sessions"));
    expect(streamFiles.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("flag on: wake binds the session and reports the binding", async () => {
    const r = await runWake(flagOnVault, 96, undefined, undefined, false, {
      session: "ses_wake_bound",
      parent: "ses_abc123",
    });
    expect(r.session_binding).toBeDefined();
    expect(r.session_binding?.id).toBe("ses_wake_bound");
    expect(r.session_binding?.record).toContain(`ops${path.sep}sessions`);
    expect(r.session_binding?.lineage).toBe("continues");
    const parsed = await readFrontmatterFile(r.session_binding?.record as string);
    expect(parsed.data?.continues).toBe("ses_abc123");
  });

  it("flag on, bare wake: ephemeral identity, no record", async () => {
    const r = await runWake(flagOnVault, 96, undefined, undefined, false, {});
    expect(r.session_binding?.ephemeral).toBe(true);
    expect(r.session_binding?.record).toBeNull();
    expect(r.session_binding?.id).toMatch(/^ses-/);
  });

  it("flag on, explicit session= wins over a passed ephemeral id", async () => {
    const r = await runWake(flagOnVault, 96, undefined, undefined, false, {
      session: "ses_explicit",
      ephemeralId: "ses-ephemeral-should-lose",
    });
    expect(r.session_binding?.id).toBe("ses_explicit");
    expect(r.session_binding?.ephemeral).toBe(false);
  });
});

describe("bindSession — §3.2 late-binding record ADOPTION", () => {
  // Record filenames are slugified (underscores deleted) — build every
  // expected path through the same slugify the product uses, never by hand.
  const recordPath = (vault: string, id: string) =>
    path.join(vault, "ops", "sessions", `${slugify(id)}.md`);

  it("adopt: the provisional record becomes the named record — renamed, not forked", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    // The provisional thread: a record exists with a body that references
    // the notes it captured.
    await bindSession(flagOnVault, config, { session: "ses_prov" });
    const provPath = recordPath(flagOnVault, "ses_prov");
    const raw = await fs.readFile(provPath, "utf8");
    await fs.writeFile(
      provPath,
      raw.replace(/\s*$/, "\nCaptured [[the provisional thread note one]] and [[the provisional thread note two]].\n"),
    );
    // Late binding: the real identity arrives, the provisional id in play.
    const b = await bindSession(flagOnVault, config, {
      session: "ses_real",
      ephemeralId: "ses_prov",
    });
    expect(b.adopted).toBe(true);
    expect(b.id).toBe("ses_real");
    // The provisional file is GONE — never forked.
    await expect(fs.access(provPath)).rejects.toThrow();
    // The named record carries the adopted thread: session field rewritten,
    // body preserved (the [[links]] moved with it).
    const named = await readFrontmatterFile(recordPath(flagOnVault, "ses_real"));
    expect(named.data?.session).toBe("ses_real");
    expect(named.body).toContain("[[the provisional thread note one]]");
    expect(named.body).toContain("[[the provisional thread note two]]");
  });

  it("adopt merges when BOTH records exist: earliest created wins, body carries over", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    // Provisional first (earlier created), named second.
    const prov = await bindSession(flagOnVault, config, { session: "ses_merge_prov" });
    const provCreated = (await readFrontmatterFile(prov.record as string)).data?.created;
    await new Promise((r) => setTimeout(r, 1100)); // distinct created dates
    const named = await bindSession(flagOnVault, config, { session: "ses_merge_named" });
    const namedPath = named.record as string;
    // Give the provisional a link the named record lacks.
    const raw = await fs.readFile(prov.record as string, "utf8");
    await fs.writeFile(
      prov.record as string,
      raw.replace(/\s*$/, "\nCaptured [[the merge adoption note]].\n"),
    );
    const b = await bindSession(flagOnVault, config, {
      session: "ses_merge_named",
      ephemeralId: "ses_merge_prov",
    });
    expect(b.adopted).toBe(true);
    const merged = await readFrontmatterFile(namedPath);
    // Earliest created wins — the thread started when the provisional did.
    expect(merged.data?.created).toBe(provCreated);
    // Body carries over; one record, not two.
    expect(merged.body).toContain("[[the merge adoption note]]");
    const files = await fs.readdir(path.join(flagOnVault, "ops", "sessions"));
    expect(files.filter((f) => f.startsWith(slugify("ses_merge")))).toHaveLength(1);
  });

  it("adopt repoints other records' lineage edges — the thread stays connected", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    // A follower already points at the provisional id.
    await bindSession(flagOnVault, config, {
      session: "ses_follower",
      parent: "ses_repoint_prov",
    });
    // The provisional record exists (adoption target).
    await bindSession(flagOnVault, config, { session: "ses_repoint_prov" });
    const b = await bindSession(flagOnVault, config, {
      session: "ses_repointed_real",
      ephemeralId: "ses_repoint_prov",
    });
    expect(b.adopted).toBe(true);
    const follower = await readFrontmatterFile(recordPath(flagOnVault, "ses_follower"));
    expect(follower.data?.continues).toBe("ses_repointed_real");
  });

  it("adopt writes the declared lineage edge onto the adopted record", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    await bindSession(flagOnVault, config, { session: "ses_adopt_edge_prov" });
    const b = await bindSession(flagOnVault, config, {
      session: "ses_adopt_edge_real",
      ephemeralId: "ses_adopt_edge_prov",
      parent: "ses_the_root",
      lineage: "branched_from",
    });
    expect(b.adopted).toBe(true);
    expect(b.lineage).toBe("branched_from");
    const adopted = await readFrontmatterFile(recordPath(flagOnVault, "ses_adopt_edge_real"));
    expect(adopted.data?.branched_from).toBe("ses_the_root");
    expect(adopted.data?.continues).toBeUndefined();
  });

  it("no provisional record → adoption is a silent no-op (normal bind)", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    const b = await bindSession(flagOnVault, config, {
      session: "ses_plain_named",
      ephemeralId: "ses_never_existed",
    });
    expect(b.adopted).toBeUndefined();
    expect(b.record).toBe(recordPath(flagOnVault, "ses_plain_named"));
  });

  it("wake surface: adoption is visible in the session_binding payload", async () => {
    const config = await loadConfig(path.join(flagOnVault, "mnemos.config.yaml"));
    await bindSession(flagOnVault, config, { session: "ses_wake_adopt_prov" });
    const r = await runWake(flagOnVault, 96, undefined, undefined, false, {
      session: "ses_wake_adopt_real",
      ephemeralId: "ses_wake_adopt_prov",
    });
    expect(r.session_binding?.adopted).toBe(true);
    expect(r.session_binding?.id).toBe("ses_wake_adopt_real");
  });
});
