/**
 * §7 two-tier capture — the session stream (the machinery nobody sees):
 * a capture under a bound session appends to the session record, created
 * on first capture, append-only, zero gates. Plus the §8.3 concurrency
 * suite: parallel session-stream writes (the product is many sessions
 * writing one shared vault).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runAdd } from "../../src/cli/add.js";
import { bindSession, appendToSessionRecord } from "../../src/core/sessionscope.js";
import { slugify } from "../../src/core/slug.js";
import { loadConfig } from "../../src/core/config.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

let vault: string;
let config: Awaited<ReturnType<typeof loadConfig>>;

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-stream-"));
  await runInit({ targetDir: vault });
  // The flag is ON by default (activated 2026-11-15); load the live config.
  config = await loadConfig(path.join(vault, "mnemos.config.yaml"));
  await runIndexBuild(vault);
}, 120000);

afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

const recordPath = (id: string) => path.join(vault, "ops", "sessions", `${slugify(id)}.md`);

describe("§7 the session stream — created on first capture", () => {
  it("an ephemeral capture creates its record on first capture — never by wake", async () => {
    // Wake never wrote a record (bindSession ephemeral writes nothing); the
    // FIRST CAPTURE creates it.
    const sessionId = `ses-${randomUUID()}`;
    await runAdd({
      startDir: vault,
      title: "the first streamed capture",
      content: "The stream record is born with this capture.",
      description: "First capture under an ephemeral session.",
      project: ["mnemos"],
      streamSession: sessionId,
    });
    const parsed = await readFrontmatterFile(recordPath(sessionId));
    expect(parsed.data?.session).toBe(sessionId);
    expect(parsed.body).toContain("Captured [[");
    expect(parsed.body).toContain("the-first-streamed-capture");
  });

  it("appends accumulate — a second capture adds a line, never replaces", async () => {
    const sessionId = "ses_stream_accumulate";
    await runAdd({
      startDir: vault, title: "streamed capture one",
      content: "One.", description: "First.", project: ["mnemos"], streamSession: sessionId,
    });
    await runAdd({
      startDir: vault, title: "streamed capture two",
      content: "Two.", description: "Second.", project: ["mnemos"], streamSession: sessionId,
    });
    const parsed = await readFrontmatterFile(recordPath(sessionId));
    expect(parsed.body).toContain("streamed-capture-one");
    expect(parsed.body).toContain("streamed-capture-two");
    const captureLines = parsed.body.split("\n").filter((l) => l.includes("Captured [["));
    expect(captureLines.length).toBe(2);
  });

  it("appendToSessionRecord preserves an existing lineage edge", async () => {
    const sessionId = "ses_stream_lineage";
    await bindSession(vault, config, { session: sessionId, parent: "ses_stream_root" });
    await appendToSessionRecord(vault, config, sessionId, ["Captured [[a lineage note]] — x"]);
    const parsed = await readFrontmatterFile(recordPath(sessionId));
    expect(parsed.data?.continues).toBe("ses_stream_root");
    // The stream records the PROSE link as written ([[a lineage note]]).
    expect(parsed.body).toContain("[[a lineage note]]");
  });

  it("flag off → the stream is a no-op (writes nothing)", async () => {
    const flagOff = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-stream-off-"));
    try {
      await runInit({ targetDir: flagOff });
      const offConfig = await loadConfig(path.join(flagOff, "mnemos.config.yaml"));
      offConfig.retrieval.session_scope.enabled = false;
      const r = await appendToSessionRecord(flagOff, offConfig, "ses_off", ["Captured [[x]] — y"]);
      expect(r).toBeNull();
      const files = await fs.readdir(path.join(flagOff, "ops", "sessions"));
      expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(0);
    } finally {
      await fs.rm(flagOff, { recursive: true, force: true });
    }
  });
});

describe("§8.3 concurrency — parallel session-stream writes", () => {
  it("N concurrent captures under ONE session all land (no lost updates)", async () => {
    const sessionId = "ses_stream_race";
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        runAdd({
          startDir: vault,
          title: `concurrent stream capture ${String(i).padStart(2, "0")}`,
          content: `Concurrent capture number ${i}.`,
          description: `Concurrency probe ${i}.`,
          project: ["mnemos"],
          streamSession: sessionId,
        }),
      ),
    );
    const parsed = await readFrontmatterFile(recordPath(sessionId));
    const captureLines = parsed.body.split("\n").filter((l) => l.includes("Captured [["));
    expect(captureLines.length).toBe(N); // every capture survived the race
  });

  it("concurrent captures across SIBLING sessions don't clobber each other", async () => {
    const sessions = ["ses_stream_sib_a", "ses_stream_sib_b", "ses_stream_sib_c"];
    await Promise.all(
      sessions.flatMap((s, si) =>
        Array.from({ length: 4 }, (_, i) =>
          runAdd({
            startDir: vault,
            title: `sibling ${si} capture ${i}`,
            content: "Sibling capture.",
            description: "Across-session concurrency.",
            project: ["mnemos"],
            streamSession: s,
          }),
        ),
      ),
    );
    for (const s of sessions) {
      const parsed = await readFrontmatterFile(recordPath(s));
      const captureLines = parsed.body.split("\n").filter((l) => l.includes("Captured [["));
      expect(captureLines.length).toBe(4);
    }
  });
});

describe("§8.3 the narrow window — rewrites hold the lock too (the named debt closed)", () => {
  const captureLine = (i: number) => `Captured [[lock window note ${i}]] — stream line ${i}`;

  it("a re-bind rewriting the record cannot eat appends landing mid-rewrite", async () => {
    const sessionId = "ses_lockwindow_bind";
    // The record exists and has history before the race starts.
    await appendToSessionRecord(vault, config, sessionId, [captureLine(99)]);
    const N = 8;
    await Promise.all([
      // 8 appends to the record...
      ...Array.from({ length: N }, (_, i) =>
        appendToSessionRecord(vault, config, sessionId, [captureLine(i)]),
      ),
      // ...interleaved with re-binds (wholesale read-modify-write rewrites).
      ...Array.from({ length: 4 }, () =>
        bindSession(vault, config, { session: sessionId }),
      ),
    ]);
    const parsed = await readFrontmatterFile(recordPath(sessionId));
    for (let i = 0; i < N; i++) {
      expect(parsed.body).toContain(`lock window note ${i}]]`);
    }
    expect(parsed.body).toContain(`lock window note 99]]`); // the history survived too
  });

  it("an adoption absorbing the provisional record keeps appends landing mid-adoption", async () => {
    const provisional = "ses_lockwindow_prov";
    const explicit = "ses_lockwindow_named";
    await appendToSessionRecord(vault, config, provisional, [captureLine(50)]);
    const N = 6;
    const results = await Promise.all([
      // Appends racing the adoption: each lands either in the provisional
      // record (absorbed) or re-creates the provisional after it (kept).
      ...Array.from({ length: N }, (_, i) =>
        appendToSessionRecord(vault, config, provisional, [captureLine(i)]),
      ),
      bindSession(vault, config, {
        session: explicit,
        ephemeralId: provisional,
      }),
    ]);
    expect(results.at(-1)?.adopted).toBe(true);
    const named = await readFrontmatterFile(recordPath(explicit));
    const provPath = recordPath(provisional);
    const provExists = await fs.stat(provPath).then(() => true, () => false);
    const provBody = provExists ? (await readFrontmatterFile(provPath)).body : "";
    for (let i = 0; i < N; i++) {
      const line = `lock window note ${i}]]`;
      expect(named.body.includes(line) || provBody.includes(line)).toBe(true);
    }
    expect(named.body).toContain(`lock window note 50]]`); // the pre-race line was absorbed
    expect(named.data?.session).toBe(explicit);
  });

  it("compression re-reads inside the lock: appends landing mid-compression survive", async () => {
    const sessionId = "ses_lockwindow_compress";
    const today = new Date();
    const oldDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // A 30-day-old record with history — inside the compress band.
    await appendToSessionRecord(vault, config, sessionId, [captureLine(70)]);
    const recordFile = recordPath(sessionId);
    const raw = await fs.readFile(recordFile, "utf8");
    const withOldDate = raw.replace(
      /created: \d{4}-\d{2}-\d{2}/,
      `created: ${oldDate}`,
    );
    await fs.writeFile(recordFile, withOldDate, "utf8");

    const N = 4;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        appendToSessionRecord(vault, config, sessionId, [captureLine(i)]),
      ),
      // Concurrent decay pass — wholesale body rewrites of the same record.
      // runCoverDaily-equivalent: apply=true, raw band boundary crossed.
      (async () => {
        const { compressSessionStreams } = await import("../../src/core/sessionscope.js");
        await compressSessionStreams(vault, config, { apply: true });
      })(),
    ]);
    const parsed = await readFrontmatterFile(recordFile);
    // Every capture link survives — the appended captures either kept their
    // line (append after compression) or their link (append absorbed by the
    // compression's link pass). No lost updates either way.
    for (let i = 0; i < N; i++) {
      expect(parsed.body).toContain(`lock window note ${i}]]`);
    }
    expect(parsed.body).toContain(`lock window note 70]]`);
  });
});
