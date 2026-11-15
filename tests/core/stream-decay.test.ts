/**
 * §8.2 lineage-stream decay — coverDaily's compression applied to session
 * records: recent raw, old compressed to their capture links, ancient
 * archived. Lineage edges are preserved in every band (the §5 gradient's
 * backbone). Dry-run default, matching the house style (prune).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { compressSessionStreams } from "../../src/core/sessionscope.js";
import { loadConfig } from "../../src/core/config.js";
import { slugify } from "../../src/core/slug.js";

let vault: string;
let config: Awaited<ReturnType<typeof loadConfig>>;
const NOW = Date.parse("2026-11-15T12:00:00Z");

function daysAgo(n: number): string {
  return new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-decay-"));
  await runInit({ targetDir: vault });
  config = await loadConfig(path.join(vault, "mnemos.config.yaml"));
  config.retrieval.session_scope.enabled = true;
  const dir = path.join(vault, "ops", "sessions");
  await fs.mkdir(dir, { recursive: true });

  const mk = async (id: string, created: string, captures: number) => {
    const lines = Array.from({ length: captures }, (_, i) => `- 2026-XX-XX Captured [[note ${i} of ${id}]] — body prose ${i}`).join("\n");
    const data = `---\nsession: ${id}\ncreated: ${created}\n${id.includes("child") ? `continues: ses_root_parent\n` : ""}---\n\n# Session ${id}\n\n${lines}\n`;
    await fs.writeFile(path.join(dir, `${slugify(id)}.md`), data);
  };

  await mk("ses_fresh", daysAgo(3), 4);        // raw band
  await mk("ses_mid", daysAgo(40), 6);         // compress band
  await mk("ses_mid_child", daysAgo(45), 3);   // compress band, carries an edge
  await mk("ses_ancient", daysAgo(200), 8);    // archive band
}, 120000);

afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

describe("§8.2 stream compression (dry-run default)", () => {
  it("dry-run reports the bands without touching anything", async () => {
    const r = await compressSessionStreams(vault, config, { now: NOW });
    expect(r.dryRun).toBe(true);
    expect(r.raw).toBe(1);
    expect(r.compressed).toHaveLength(2);
    expect(r.archived).toHaveLength(1);
    // Nothing mutated.
    const fresh = await fs.readFile(
      path.join(vault, "ops", "sessions", `${slugify("ses_fresh")}.md`), "utf8",
    );
    expect(fresh).toContain("note 3 of ses_fresh");
  });

  it("apply: recent stays raw; mid compresses to its links; edges survive", async () => {
    const r = await compressSessionStreams(vault, config, { now: NOW, apply: true });
    expect(r.compressed).toHaveLength(2);
    expect(r.archived).toHaveLength(1);

    // Fresh: untouched, all four capture lines raw.
    const fresh = await fs.readFile(
      path.join(vault, "ops", "sessions", `${slugify("ses_fresh")}.md`), "utf8",
    );
    expect((fresh.match(/Captured \[\[/g) ?? []).length).toBe(4);

    // Mid: compressed to ONE capture summary line + the links preserved,
    // prose gone. The lineage edge SURVIVES compression.
    const mid = await fs.readFile(
      path.join(vault, "ops", "sessions", `${slugify("ses_mid_child")}.md`), "utf8",
    );
    expect(mid).toContain("continues: ses_root_parent");
    expect(mid).toContain("[[note 0 of ses_mid_child]]");
    expect(mid).toContain("prose compressed");
    expect(mid).not.toContain("body prose 0");

    // Ancient: moved to archive/, out of the stream directory.
    const streamFiles = await fs.readdir(path.join(vault, "ops", "sessions"));
    expect(streamFiles).not.toContain(`${slugify("ses_ancient")}.md`);
    const archived = await fs.readFile(
      path.join(vault, "ops", "sessions", "archive", `${slugify("ses_ancient")}.md`), "utf8",
    );
    expect(archived).toContain("[[note 7 of ses_ancient]]");
  });

  it("compression is idempotent — a second run finds nothing to do", async () => {
    const r = await compressSessionStreams(vault, config, { now: NOW, apply: true });
    expect(r.compressed).toHaveLength(0);
    expect(r.archived).toHaveLength(0);
    expect(r.raw).toBe(3); // fresh + the two compressed records (now recent-by-content)
  });
});
