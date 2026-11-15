/**
 * The anchor index must be an interchangeable source, not an approximation.
 *
 * matchForForget's anchor phase used to read and re-tokenize every note file
 * per call — and the §5 waiver ran it on every weighted query, so retrieval
 * paid whole-vault file I/O for statistics the derived index already holds
 * (note_term's body postings) or can hold cheaply (note_long, the identifier
 * runs). The replacement is only worth anything if it changes nothing, so
 * that is what these tests assert:
 *
 * 1. Equivalence — the matcher produces identical results (slug, anchor,
 *    similarity) with and without a store-backed AnchorIndex, for every case
 *    that actually failed during the ForgetEval run (the same fixtures as
 *    forget.test.ts, now run through both sources).
 * 2. Persistence — syncIndex populates note_long from the body, incrementally.
 * 3. Waiver parity — computeScopeWeights emits identical traces with and
 *    without the index, on the probe fixture (the waiver's real consumers).
 * 4. onlySlugs — restricting the embedding stage is pure intersection: the
 *    matches inside the set are the unrestricted matches inside the set.
 *
 * Freshness is structural, not tested here: callers reach the store through
 * openSyncedIndex, which syncs (stat-filtered) on every open.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { matchForForget } from "../../src/core/forget.js";
import { richTokens, longSubstrings } from "../../src/core/anchortokens.js";
import { initIndexStore, syncIndex, storeAnchorInverted } from "../../src/core/indexstore.js";
import { buildProbeVault } from "../../src/probe/fixture.js";
import { computeScopeWeights, type ScopeTrace } from "../../src/core/scopeweight.js";
import { loadConfig } from "../../src/core/config.js";
import type { EngineConfig } from "../../src/core/config.js";

const config = { embedding_model: "Xenova/all-MiniLM-L6-v2" } as unknown as EngineConfig;

let dir: string;
let notes: string;
let db: InstanceType<typeof Database>;

function note(slug: string, text: string, status?: string) {
  const st = status ? `status: ${status}\n` : "";
  return fs.writeFile(
    path.join(notes, `${slug}.md`),
    `---\ndescription: ${text}\ntype: insight\n${st}---\n\n${text}\n`,
    "utf8",
  );
}

// The canonical cases, verbatim from forget.test.ts — each one failed a real
// ForgetEval run, and each must survive the source swap unchanged.
const CASES: Array<[string, string]> = [
  ["Uma job employer", "uma"],
  ["Uma job employer", "single-note"], // single-note anchoring case below
  ["Grace paella preferences", "grace"],
  ["alice@post.dev customer history", "alice"],
  ["API key sk-zzpqk51fpk", "key"],
];

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-anchor-"));
  notes = path.join(dir, "notes");
  await fs.mkdir(notes, { recursive: true });
  await fs.mkdir(path.join(dir, ".mnemos"), { recursive: true });
  await note("uma", "Uma works at OpenAI.");
  await note("single-note", "Uma works at OpenAI too.");
  await note("toner", "Photocopier toner was reordered.");
  await note("grace", "Grace likes paella.");
  await note("hannah", "Hannah likes anchovy pizza.");
  await note("alice", "Customer alice@post.dev bought 3 items last week.");
  await note("bob", "Customer bob@post.dev placed an order yesterday.");
  await note("key", "API key issued to ops: sk-zzpqk51fpk-secret.");
  await note("bike", "The bicycle rack near the lobby was repainted.");
  await note("forgotten", "Grace likes paella.", "released");

  db = new Database(path.join(dir, ".mnemos", "embeddings.db"));
  initIndexStore(db);
  await syncIndex(db, notes);
}, 120000);

afterAll(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("longSubstrings", () => {
  it("enumerates the alphanumeric sub-runs a body token could be", () => {
    const subs = [...longSubstrings("session-scope2024", 6)];
    expect(subs).toContain("cope2024"); // inside the second run
    expect(subs).toContain("session"); // the whole first run
    expect(subs.every((s) => /^[a-z0-9]+$/.test(s))).toBe(true);
    expect(subs.every((s) => s.length >= 6)).toBe(true);
  });

  it("skips runs too short to matter", () => {
    expect([...longSubstrings("ab-cd", 6)]).toEqual([]);
  });
});

describe("note_long persistence", () => {
  it("syncIndex stores the identifier runs from the body", () => {
    const longs = db
      .prepare(
        `SELECT n.slug AS slug, l.long AS long FROM note_long l
         JOIN note n ON n.id = l.note_id ORDER BY n.slug`,
      )
      .all() as Array<{ slug: string; long: string }>;
    const byslug = new Map<string, string[]>();
    for (const r of longs) {
      if (!byslug.has(r.slug)) byslug.set(r.slug, []);
      byslug.get(r.slug)!.push(r.long);
    }
    expect(byslug.get("alice")).toContain("alice@post.dev");
    expect(byslug.get("key")).toContain("sk-zzpqk51fpk-secret");
    // A note with no identifier-shaped run has no row.
    expect(byslug.get("grace")).toBeUndefined();
  });

  it("the store-backed index answers df, postings and containment like the files", () => {
    const inv = storeAnchorInverted(db);
    expect(inv.noteCount()).toBe(9); // ten notes, one released
    const df = inv.dfOf(["grace", "customer", "paella"]);
    expect(df.get("grace")).toBe(1); // the released copy is filtered
    expect(df.get("customer")).toBe(2);
    expect(inv.notesWithTerm("paella")).toEqual(["grace"]);
    expect(inv.notesContainingLong("alice@post.dev")).toEqual(["alice"]);
    // Suffix containment, both directions — the note carries the long with
    // an extra segment.
    expect(inv.notesContainingLong("sk-zzpqk51fpk")).toEqual(["key"]);
  });

  it("re-syncing a changed note refreshes its longs, and only its longs", async () => {
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM note_long")
      .get() as { c: number };
    await note("bike", "The bicycle rack was repainted. Contact ops@post.dev for access.");
    await syncIndex(db, notes);
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM note_long")
      .get() as { c: number };
    expect(after.c).toBe(before.c + 1); // exactly the new identifier row
    const inv = storeAnchorInverted(db);
    expect(inv.notesContainingLong("ops@post.dev")).toEqual(["bike"]);
  });
});

describe("matchForForget: identical results from both corpus sources", () => {
  const QUERIES = [
    "Uma job employer",
    "Uma job employer", // single-note anchoring
    "Grace paella preferences",
    "alice@post.dev customer history",
    "API key sk-zzpqk51fpk",
    "Session OTP 211755 keyholder",
  ];

  for (const query of QUERIES) {
    it(`"${query}"`, async () => {
      const fromFiles = await matchForForget(notes, query, config);
      const fromStore = await matchForForget(notes, query, config, {
        anchorIndex: storeAnchorInverted(db),
      });
      expect(fromStore.map((m) => m.slug)).toEqual(fromFiles.map((m) => m.slug));
      for (let i = 0; i < fromFiles.length; i++) {
        expect(fromStore[i].anchor).toBeCloseTo(fromFiles[i].anchor, 10);
        expect(fromStore[i].similarity).toBeCloseTo(fromFiles[i].similarity, 10);
        expect(fromStore[i].file).toBe(fromFiles[i].file);
        // The pair-exclusivity signal must be source-independent too.
        expect(fromStore[i].terms).toEqual(fromFiles[i].terms);
        expect(fromStore[i].jointDf).toBe(fromFiles[i].jointDf);
      }
    });
  }

  it("anchors when the corpus is a single live note (the smoothed-IDF case)", async () => {
    // forget.test.ts pins this on the file path with a one-note vault; the
    // index path must behave identically when N == 1.
    const single = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-anchor1-"));
    const sNotes = path.join(single, "notes");
    await fs.mkdir(sNotes, { recursive: true });
    await fs.mkdir(path.join(single, ".mnemos"), { recursive: true });
    await fs.writeFile(
      path.join(sNotes, "uma.md"),
      `---\ndescription: Uma works at OpenAI.\ntype: insight\n---\n\nUma works at OpenAI.\n`,
      "utf8",
    );
    const sdb = new Database(path.join(single, ".mnemos", "embeddings.db"));
    initIndexStore(sdb);
    await syncIndex(sdb, sNotes);
    try {
      const m = await matchForForget(sNotes, "Uma job employer", config, {
        anchorIndex: storeAnchorInverted(sdb),
      });
      expect(m).toHaveLength(1);
      expect(m[0].slug).toBe("uma");
    } finally {
      sdb.close();
      await fs.rm(single, { recursive: true, force: true });
    }
  });

  it("skips forgotten notes in the store exactly like the files do", async () => {
    const fromFiles = await matchForForget(notes, "Grace paella preferences", config);
    expect(fromFiles.map((m) => m.slug)).toEqual(["grace"]);
    const fromStore = await matchForForget(notes, "Grace paella preferences", config, {
      anchorIndex: storeAnchorInverted(db),
    });
    expect(fromStore.map((m) => m.slug)).toEqual(["grace"]);
  });

  it("reverse identifier containment fires through the index", async () => {
    // A note token inside the query's long but not equal to any query token:
    // the note carries "cope2024", the query long is "session-scope2024".
    // Reverse containment is worth +1, below the standalone-identifier bar,
    // so the similarity floor is dropped (-1) to isolate the branch — what
    // is under test is that both corpus sources see the same +1, not the
    // final similarity judgement.
    await note("cope", "Envelope art used cope2024 codes.");
    await syncIndex(db, notes);
    const q = "project session-scope2024 rollout";
    expect(richTokens(q).longs).toContain("session-scope2024");
    const fromFiles = await matchForForget(notes, q, config, { minSimilarity: -1 });
    const fromStore = await matchForForget(notes, q, config, {
      minSimilarity: -1,
      anchorIndex: storeAnchorInverted(db),
    });
    expect(fromFiles.map((m) => m.slug)).toContain("cope");
    expect(fromFiles.map((m) => m.anchor)).toContain(1); // the reverse credit, exactly
    expect(fromStore.map((m) => m.slug)).toEqual(fromFiles.map((m) => m.slug));
  });
});

describe("the note_long migration for pre-existing indexes", () => {
  it("backfills longs for stat-unchanged notes on the first post-upgrade sync", async () => {
    // Simulate the live-vault state this bug was found in: an index built
    // before note_long existed. Every note is stat-identical, so the
    // incremental sync would re-parse nothing and the anchor index would
    // answer from an empty corpus.
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM note_long")
      .get() as { c: number };
    db.exec("DELETE FROM note_long");
    db.prepare("DELETE FROM index_meta WHERE key = 'anchor_longs_built'").run();
    await syncIndex(db, notes); // nothing changed on disk — parsed is empty
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM note_long")
      .get() as { c: number };
    expect(after.c).toBeGreaterThanOrEqual(before.c);
    const inv = storeAnchorInverted(db);
    expect(inv.notesContainingLong("alice@post.dev")).toEqual(["alice"]);
    // And the marker means the next sync does NOT re-read the vault.
    const [marker] = db
      .prepare("SELECT value FROM index_meta WHERE key = 'anchor_longs_built'")
      .all() as Array<{ value: string }>;
    expect(marker?.value).toBeTruthy();
  });
});

describe("pair exclusivity — the joint-df signal on the matches", () => {
  it("a two-word pair shared by several notes reports its joint df", async () => {
    // grace and hannah both "like" food: "likes" has df 2 (plus the
    // released copy is filtered), but "grace paella" together is df 1.
    const fromFiles = await matchForForget(notes, "Grace paella preferences", config);
    const grace = fromFiles.find((m) => m.slug === "grace");
    expect(grace?.terms).toContain("grace");
    expect(grace?.terms).toContain("paella");
    expect(grace?.jointDf).toBe(1); // exactly one live note holds the PAIR
    const fromStore = await matchForForget(notes, "Grace paella preferences", config, {
      anchorIndex: storeAnchorInverted(db),
    });
    expect(fromStore.find((m) => m.slug === "grace")?.jointDf).toBe(1);
  });

  it("a direct identifier hit carries its sub-tokens as terms (tokenize splits the identifier)", async () => {
    // "zzz" appears in no note, so alice's ANCHOR is identifier-driven — but
    // tokenize splits alice@post.dev at separators, so the query always
    // shares its sub-tokens with the note. A direct hit can never be
    // token-empty; its exclusivity is the identifier's anchor weight (>= 2),
    // not a frequency. The joint df of [alice, post, dev] is 1: only alice's
    // note holds all three.
    const fromFiles = await matchForForget(notes, "zzz alice@post.dev", config);
    const alice = fromFiles.find((m) => m.slug === "alice");
    expect(alice).toBeDefined();
    expect(alice!.terms).toEqual(["alice", "post", "dev"]);
    expect(alice!.jointDf).toBe(1);
    expect(alice!.anchor).toBeGreaterThanOrEqual(2);
    const fromStore = await matchForForget(notes, "zzz alice@post.dev", config, {
      anchorIndex: storeAnchorInverted(db),
    });
    expect(fromStore.find((m) => m.slug === "alice")?.terms).toEqual(["alice", "post", "dev"]);
    expect(fromStore.find((m) => m.slug === "alice")?.jointDf).toBe(1);
  });

  it("a reverse containment match reports no terms and an infinite joint df", async () => {
    // The genuine terms-empty shape: the note token (cope2024) sits INSIDE
    // the query's long (session-scope2024) and shares no tokens with it.
    // Reverse containment is worth +1, below the standalone bar, so the
    // similarity floor drops to isolate the branch. With no matched terms
    // the joint df is Infinity — the waiver's identifier-exemption bar
    // (anchor >= 2) is what decides, never a frequency.
    await note("cope2", "Only the envelope registry keeps cope2024 marks.");
    await syncIndex(db, notes);
    const q = "project session-scope2024 rollout";
    const fromFiles = await matchForForget(notes, q, config, { minSimilarity: -1 });
    const cope = fromFiles.find((m) => m.slug === "cope2");
    expect(cope).toBeDefined();
    expect(cope!.terms).toEqual([]);
    expect(cope!.jointDf).toBe(Infinity);
    expect(cope!.anchor).toBe(1);
  });
});

describe("onlySlugs is pure intersection", () => {
  it("matches restricted to the set equal the unrestricted matches inside the set", async () => {
    const inv = storeAnchorInverted(db);
    for (const query of ["Grace paella preferences", "alice@post.dev customer history"]) {
      const full = await matchForForget(notes, query, config, { anchorIndex: inv });
      const restricted = await matchForForget(notes, query, config, {
        anchorIndex: inv,
        onlySlugs: new Set(["grace", "alice", "bob", "unrelated-note"]),
      });
      const expected = full.filter((m) => ["grace", "alice", "bob", "unrelated-note"].includes(m.slug));
      expect(restricted.map((m) => m.slug)).toEqual(expected.map((m) => m.slug));
      // And the file path restricts identically — the bound holds on both.
      const fullFiles = await matchForForget(notes, query, config);
      const restrictedFiles = await matchForForget(notes, query, config, {
        onlySlugs: new Set(["grace", "alice", "bob", "unrelated-note"]),
      });
      expect(restrictedFiles.map((m) => m.slug)).toEqual(
        fullFiles.filter((m) => ["grace", "alice", "bob", "unrelated-note"].includes(m.slug)).map((m) => m.slug),
      );
    }
  });
});

describe("§5 waiver parity — traces identical with and without the index", () => {
  let vault: string;
  let scopeConfig: Awaited<ReturnType<typeof loadConfig>>;
  let scopeDb: InstanceType<typeof Database>;

  beforeAll(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-anchor-waiver-"));
    await buildProbeVault(vault);
    scopeConfig = await loadConfig(path.join(vault, "mnemos.config.yaml"));
    scopeConfig.retrieval.session_scope.enabled = true;
    scopeDb = new Database(path.join(vault, ".mnemos", "embeddings.db"));
    initIndexStore(scopeDb);
    await syncIndex(scopeDb, path.join(vault, "notes"));
  }, 180000);

  afterAll(async () => {
    scopeDb.close();
    await fs.rm(vault, { recursive: true, force: true });
  });

  async function traces(
    query: string,
    candidates: Array<{ title: string; score: number }>,
    withIndex: boolean,
  ): Promise<Map<string, ScopeTrace>> {
    return computeScopeWeights({
      notesDir: path.join(vault, "notes"),
      sessionsDir: path.join(vault, "ops", "sessions"),
      query,
      scope: { session: "ses_probe_child", project: "helios" },
      engineConfig: scopeConfig.engine,
      candidates,
      anchorIndex: withIndex ? storeAnchorInverted(scopeDb) : undefined,
      constants: {
        decay: scopeConfig.retrieval.session_scope.lineage_decay ?? 0.92,
        floor: scopeConfig.retrieval.session_scope.unlinked_floor ?? 0.8,
        other: scopeConfig.retrieval.session_scope.other_scope_multiplier ?? 0.75,
        waiveFloor: scopeConfig.retrieval.session_scope.waive_floor ?? 0.95,
      },
    });
  }

  it("the kappa7 waiver case fires identically on both sources", async () => {
    const candidates = [
      { title: "helios-kappa7-panel-protocol-quirks", score: 1.0 },
      { title: "lineage-root-session-note-the-lantern-backlight-flicker", score: 0.9 },
      { title: "lineage-unrelated-session-note-the-terra-misting-schedule", score: 0.8 },
    ];
    const fromFiles = await traces("helios-kappa7 telemetry frames dropped", candidates, false);
    const fromStore = await traces("helios-kappa7 telemetry frames dropped", candidates, true);
    expect([...fromStore.keys()].sort()).toEqual([...fromFiles.keys()].sort());
    for (const [slug, t] of fromFiles) {
      const other = fromStore.get(slug);
      expect(other?.band).toBe(t.band);
      expect(other?.waived).toBe(t.waived);
      expect(other?.multiplier).toBeCloseTo(t.multiplier, 10);
      expect(other?.hops).toBe(t.hops);
      expect(other?.origin).toBe(t.origin);
    }
    // Sanity: the waiver actually fired in this fixture (both sources are
    // being compared on a case that exercises the machinery).
    expect(fromStore.get("helios-kappa7-panel-protocol-quirks")?.waived).toBe(true);
  });
});
