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
