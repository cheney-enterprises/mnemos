/**
 * Query-addressed forgetting: supersede, release, purge.
 *
 * Mnemos had none of these. Measured on ForgetEval (deeplethe/lethe, MIT, the
 * only benchmark that scores forgetting) Mnemos returned 0/1000 — every case
 * N/A, every family, because the adapter could not implement the three
 * optional operations. MemPalace scores the same 0. Meanwhile BM25 from 1994
 * scores 25.5 on MemoryAgentBench's selective-forgetting competency and beats
 * Cognee, MemGPT, Mem0 and Zep.
 *
 * The hard part is not deleting. It is deciding WHAT the query addresses.
 *
 *   release("Grace paella preferences")  must evict "Grace likes paella."
 *                                        and KEEP "Hannah likes anchovy pizza."
 *   supersede("Uma job employer", ...)   must match "Uma works at OpenAI."
 *                                        where the only shared token is "Uma".
 *
 * Over-match and you destroy facts the caller still needs; under-match and
 * the thing you were asked to forget is still there. Pure lexical overlap
 * fails the second case (one token). Pure embedding similarity fails the
 * first (both sentences are "person likes food" and sit close together).
 *
 * So matching is anchored, not thresholded: a note is a candidate only if it
 * shares a RARE token with the query — a proper noun, an identifier, a
 * number — and candidates are then ordered by embedding similarity. Rarity
 * is measured against the vault itself, so "Grace" anchors and "likes" does
 * not, without a stopword list to maintain.
 *
 * Status lives in frontmatter because the markdown is the truth. A released
 * note keeps its file and stops being recalled; a purged note is unlinked.
 * Both survive `rm -rf .mnemos/` for exactly that reason.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { tokenize } from "./bm25.js";
import { readFrontmatterFile, writeFrontmatterFile } from "./frontmatter.js";
import { embedText } from "./engine.js";
import type { EngineConfig } from "./config.js";
import { isForgotten } from "./status.js";
import { richTokens, longSubstrings, type AnchorIndex } from "./anchortokens.js";

export { FORGOTTEN_STATUSES, isForgotten } from "./status.js";

export interface ForgetMatch {
  slug: string;
  file: string;
  text: string;
  anchor: number;
  similarity: number;
  /** The query tokens that actually matched this note (the anchor's mass
   * came from these). Empty for a pure identifier hit. */
  terms: string[];
  /**
   * How many live notes contain ALL of `terms` together — the pair-
   * exclusivity signal ("Grace paella": two words that are each common-ish
   * but rare as a PAIR are an exact address). Infinity when there are no
   * matched terms (pure identifier), so only the identifier bar can waive.
   * Computed identically on both corpus sources; pinned by test.
   */
  jointDf: number;
}

export interface ForgetResult {
  matched: ForgetMatch[];
  count: number;
}

interface LiveNote {
  slug: string;
  file: string;
  text: string;
  tokens: Set<string>;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Tokens that survive tokenisation, plus raw alphanumeric runs of length >= 6.
 *
 * The function itself lives in anchortokens.ts now (a leaf module, so
 * indexstore.ts can persist the per-note identifier runs without inheriting
 * the embedder's import graph); it is re-exported here because the §5 anchor
 * waiver (scopeweight) imports it from this module — spec session-scope §5:
 * "reuse the forget matcher's richTokens/anchoring machinery". Same
 * identifier-shaped-token insight, second consumer.
 */
export { richTokens } from "./anchortokens.js";

async function loadLiveNotes(notesDir: string): Promise<LiveNote[]> {
  const out: LiveNote[] = [];
  let names: string[];
  try {
    names = await fs.readdir(notesDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(notesDir, name);
    let parsed;
    try {
      parsed = await readFrontmatterFile(file);
    } catch {
      continue;
    }
    const status = String(parsed.data?.status ?? "").toLowerCase();
    if (isForgotten(status)) continue; // already forgotten
    const text = String(parsed.body ?? "").trim();
    out.push({
      slug: name.slice(0, -3),
      file,
      text,
      tokens: new Set(tokenize(text)),
    });
  }
  return out;
}

/**
 * Notes the query addresses.
 *
 * Document frequency is computed over the live notes, so a token shared by
 * most of them cannot anchor. With the small fact sets ForgetEval builds this
 * is exactly the proper-noun/identifier signal; on a real vault it degrades
 * gracefully into ordinary IDF.
 *
 * The anchor phase runs against one of two interchangeable sources:
 *
 *   - the files themselves (`loadLiveNotes`) — the original path, always
 *     current, O(vault) file I/O per call;
 *   - an `AnchorIndex` over the derived store (indexstore.ts) — the same
 *     statistics answered by indexed lookup, O(query) instead of O(vault).
 *     Produced by `storeAnchorInverted(db)`; `openSyncedIndex` syncs the
 *     store on every open, so an index-backed corpus reflects the files.
 *
 * `onlySlugs` restricts the EMBEDDING stage to a candidate set without
 * touching the anchor phase: per-note similarity is independent, so the
 * result is exactly the unrestricted match set intersected with onlySlugs.
 * The §5 waiver uses it — it only ever consumes matches ∩ its candidates,
 * and this keeps a hub-heavy query from embedding half the vault.
 *
 * Both extensions leave the default call — and every forget operation —
 * byte-for-byte on the original behavior; the equivalence is what
 * tests/core/anchor-index.test.ts pins.
 */
export async function matchForForget(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: {
    minRatio?: number;
    minSimilarity?: number;
    limit?: number;
    /** Restrict the similarity stage to these slugs (see above). */
    onlySlugs?: Set<string>;
    /** Serve the anchor phase from the derived index instead of the files. */
    anchorIndex?: AnchorIndex;
  } = {},
): Promise<ForgetMatch[]> {
  const minSimilarity = opts.minSimilarity ?? 0.25;
  const q = richTokens(query);

  // ── Phase A: anchor mass ────────────────────────────────────────────
  const raw = new Map<string, number>(); // shared-token IDF mass (+ identifier hits)
  const idHits = new Map<string, number>();
  // slug → the query tokens this note actually carries (the anchor's mass).
  const matchedTerms = new Map<string, string[]>();
  // Set by the branch below: joint document frequency of a term set — how
  // many live notes contain ALL of them (the pair-exclusivity signal).
  let jointDfOf: (terms: string[]) => number = () => Infinity;
  // slug → where phase B reads the body from. `text` is prefetched on the
  // file path; the index path reads lazily (only survivors need it).
  const bodies = new Map<string, { file: string; text?: string }>();

  if (opts.anchorIndex) {
    const inv = opts.anchorIndex;
    const N = inv.noteCount();
    const df = inv.dfOf(q.tokens);
    const idf = (t: string) => Math.max(Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5)), 0.01);

    for (const t of q.tokens) {
      const mass = idf(t);
      for (const slug of inv.notesWithTerm(t)) {
        raw.set(slug, (raw.get(slug) ?? 0) + mass);
      }
    }
    for (const l of q.longs) {
      // Direct containment — an identifier appearing in the body is an exact
      // address. LIKE over note_long is a scan of a sparse table; identifiers
      // are rare by construction.
      const direct = inv.notesContainingLong(l);
      const credited = new Set<string>();
      for (const slug of direct) {
        idHits.set(slug, (idHits.get(slug) ?? 0) + 2);
        credited.add(slug);
      }
      // Reverse containment — the note carries a body token inside the
      // query's identifier (`sk-zzpqk51fpk` in `sk-zzpqk51fpk-secret`). The
      // file path's per-(note, long) `else if` means a direct hit excludes
      // the reverse credit for the same long.
      if (l.length >= 8) {
        const seen = new Set<string>();
        for (const s of longSubstrings(l, 6)) {
          for (const slug of inv.notesWithTerm(s)) {
            if (credited.has(slug) || seen.has(slug)) continue;
            seen.add(slug);
            idHits.set(slug, (idHits.get(slug) ?? 0) + 1);
          }
        }
      }
    }
    for (const [slug, mass] of raw) {
      const ids = idHits.get(slug) ?? 0;
      if (mass + ids > 0) raw.set(slug, mass + ids);
    }
    for (const slug of idHits.keys()) {
      if (!raw.has(slug)) raw.set(slug, idHits.get(slug)!);
    }
    for (const slug of raw.keys()) {
      bodies.set(slug, { file: path.join(notesDir, `${slug}.md`) });
    }
    // Matched terms per note, from the same inverted lookups (cached — a
    // query has a handful of tokens).
    const postingCache = new Map<string, Set<string>>();
    const postingOf = (t: string): Set<string> => {
      let s = postingCache.get(t);
      if (!s) {
        s = new Set(inv.notesWithTerm(t));
        postingCache.set(t, s);
      }
      return s;
    };
    for (const t of q.tokens) {
      for (const slug of postingOf(t)) {
        const arr = matchedTerms.get(slug);
        if (arr) arr.push(t);
        else matchedTerms.set(slug, [t]);
      }
    }
    jointDfOf = (terms: string[]): number => {
      if (terms.length === 0) return Infinity;
      // Intersection over the cached posting sets, smallest first.
      const postings = terms.map(postingOf).sort((a, b) => a.size - b.size);
      let count = 0;
      for (const slug of postings[0]) {
        if (postings.every((p) => p.has(slug))) count += 1;
      }
      return count;
    };
  } else {
    const notes = await loadLiveNotes(notesDir);
    if (notes.length === 0) return [];

    const df = new Map<string, number>();
    for (const n of notes) for (const t of n.tokens) df.set(t, (df.get(t) ?? 0) + 1);

    // Smoothed IDF, log((N+1)/(df+0.5)).
    //
    // The first version cut any token whose document frequency exceeded half
    // the corpus. On a real vault that is fine. On a ForgetEval case holding
    // three facts every token appears in 33-100% of notes, so with a single
    // note in scope NOTHING could anchor and matching returned 0 with no
    // error. It passed the two-note smoke test only because df/N landed
    // exactly on the boundary. Smoothing keeps the weight positive at any
    // corpus size and lets frequency be a small weight instead of a cliff.
    const N = notes.length;
    const idf = (t: string) => Math.max(Math.log((N + 1) / ((df.get(t) ?? 0) + 0.5)), 0.01);

    // Raw IDF mass each note shares with the query, plus identifier hits,
    // tracked separately because an identifier is an address and a word is not.
    for (const n of notes) {
      let anchor = 0;
      const shared: string[] = [];
      for (const t of q.tokens) {
        if (n.tokens.has(t)) {
          anchor += idf(t);
          shared.push(t);
        }
      }
      if (shared.length > 0) matchedTerms.set(n.slug, shared);
      // Identifier containment, in both directions: the note may carry a
      // suffixed form of the query's identifier or vice versa.
      const lower = n.text.toLowerCase();
      let ids = 0;
      for (const l of q.longs) {
        if (lower.includes(l)) ids += 2;
        else if (l.length >= 8 && [...n.tokens].some((t) => t.length >= 6 && l.includes(t))) ids += 1;
      }
      if (ids > 0) idHits.set(n.slug, ids);
      anchor += ids;
      if (anchor > 0) raw.set(n.slug, anchor);
      bodies.set(n.slug, { file: n.file, text: n.text });
    }
    jointDfOf = (terms: string[]): number => {
      if (terms.length === 0) return Infinity;
      let count = 0;
      for (const n of notes) {
        if (terms.every((t) => n.tokens.has(t))) count += 1;
      }
      return count;
    };
  }
  if (raw.size === 0) return [];

  // When the query names an identifier that some note actually contains, the
  // address is exact and nothing else is a candidate.
  //
  // Without this, purge("alice@post.dev customer history") deleted bob's
  // record too: both notes carry "customer", bob cleared the relative bar on
  // that word alone, and 50 of 200 purge cases failed by destroying a record
  // the caller never named. Over-matching a delete is the worst failure this
  // module can have -- it is silent, and the data is gone.
  if (idHits.size > 0) {
    for (const slug of [...raw.keys()]) if (!idHits.has(slug)) raw.delete(slug);
  }

  // Keep notes carrying a substantial share of the BEST note's mass, not of
  // the query's own mass.
  //
  // Normalising by the query was the second thing that silently returned
  // nothing here. `supersede("Uma job employer", ...)` must match "Uma works
  // at OpenAI."; "job" and "employer" appear in no note, so they contribute
  // nothing to the numerator while inflating the denominator, and the one
  // genuine hit scored 0.162 against a 0.2 floor. Forget queries are
  // descriptive by nature — they name the subject, not its wording — so the
  // question is which note this query addresses relative to the others, and
  // that is a comparison between notes.
  const best = Math.max(...raw.values());
  const ratio = opts.minRatio ?? 0.5;
  // Deterministic candidate order (sorted by slug): both anchor sources must
  // reach the similarity stage in the same order, so a tie in the final sort
  // breaks identically whether the corpus came from the files or the index.
  const candidates: Array<{ slug: string; file: string; text?: string }> = [];
  const anchors = new Map<string, number>();
  for (const slug of [...raw.keys()].sort()) {
    const a = raw.get(slug) ?? 0;
    if (a >= best * ratio) {
      anchors.set(slug, a);
      const body = bodies.get(slug);
      if (body) candidates.push({ slug, file: body.file, text: body.text });
    }
  }
  if (candidates.length === 0) return [];

  const qv = await embedText(query, config);
  const scored: ForgetMatch[] = [];
  for (const c of candidates) {
    // onlySlugs narrows the embedding stage (see the doc comment): notes
    // outside the caller's candidate set are dropped before the embed,
    // which is the waiver's whole cost save on a hub-heavy query.
    if (opts.onlySlugs && !opts.onlySlugs.has(c.slug)) continue;
    let text = c.text;
    if (text === undefined) {
      // Index-sourced corpus: read the body now — only similarity
      // survivors need it, so this is a handful of files, not the vault.
      try {
        const parsed = await readFrontmatterFile(c.file);
        text = String(parsed.body ?? "").trim();
      } catch {
        continue; // the file vanished between index sync and this read
      }
    }
    const nv = await embedText(text, config);
    const sim = cosine(qv, nv);
    const anchor = anchors.get(c.slug) ?? 0;
    // A strong identifier hit stands on its own: "sk-zzpqk51fpk" appearing
    // verbatim is not a semantic judgement and must not be gated on one.
    if (anchor >= 2 || sim >= minSimilarity) {
      const terms = matchedTerms.get(c.slug) ?? [];
      scored.push({
        slug: c.slug,
        file: c.file,
        text,
        anchor,
        similarity: sim,
        terms,
        jointDf: jointDfOf(terms),
      });
    }
  }
  scored.sort((a, b) => b.anchor + b.similarity - (a.anchor + a.similarity));
  return opts.limit ? scored.slice(0, opts.limit) : scored;
}

async function setStatus(file: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const parsed = await readFrontmatterFile(file);
  await writeFrontmatterFile(file, { ...(parsed.data ?? {}), ...extra, status }, parsed.body);
}

/**
 * Options guarding the blast radius of a forget call.
 *
 * Measured on a real 1,550-note vault: `release("Mnemos positioning strategy")`
 * addresses **159 notes**; "CourtShare engagement mechanics" 53; "Kashi token
 * incentives" 41. ForgetEval scores this same matcher at 97.8%, because its
 * cases hold eight facts and four distractors. Raise that to 200 distractors
 * — a flag the harness already has and nobody sets — and the amnesia family
 * falls from 100% to 65%. Selectivity degrades with corpus size, and the
 * benchmark's default configuration cannot see it.
 *
 * So destructive calls are capped and previewable. Supermemory has shipped
 * `dryRun`, `threshold` and `maxForget` on `POST /v4/memories/forget-matching`
 * for a while; this is the same idea, arrived at from the other direction.
 */
export interface ForgetOptions {
  /**
   * Actually change something. DEFAULT FALSE — every forget call is a dry run
   * until the caller opts in, matching `mnemos prune`, which has always required
   * `--apply` and previews otherwise.
   *
   * Defaulting the other way is indefensible for an operation whose failure
   * mode is silent data loss: the matcher scored 97.8% on ForgetEval while
   * being willing to delete 159 notes from a real vault, and a caller who
   * mistypes a query should get a report, not a hole.
   */
  apply?: boolean;
  /**
   * Refuse the call if it would touch more than this many notes. Default 10.
   * `Infinity` disables the guard, and the caller has to type that.
   */
  maxForget?: number;
}

export class ForgetBlastRadiusError extends Error {
  constructor(readonly query: string, readonly matched: ForgetMatch[], readonly cap: number) {
    super(
      `"${query}" addresses ${matched.length} notes, over the maxForget cap of ${cap}. ` +
        `Re-run with dryRun to inspect, narrow the query, or pass an explicit cap. ` +
        `First matches: ${matched.slice(0, 3).map((m) => m.slug).join(", ")}`,
    );
    this.name = "ForgetBlastRadiusError";
  }
}

function guardBlastRadius(query: string, matched: ForgetMatch[], opts: ForgetOptions): void {
  const cap = opts.maxForget ?? 10;
  if (matched.length > cap) throw new ForgetBlastRadiusError(query, matched, cap);
}

/** Soft-evict every note the query addresses. The files remain on disk. */
export async function release(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, query, config);
  guardBlastRadius(query, matched, opts);
  if (!opts.apply) return { matched, count: 0 }; // dry run is the default
  for (const m of matched) {
    await setStatus(m.file, "released", { released_by: query, released: new Date().toISOString().slice(0, 10) });
  }
  return { matched, count: matched.length };
}

/** Hard-delete every note the query addresses. */
export async function purge(
  notesDir: string,
  query: string,
  config: EngineConfig,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, query, config);
  guardBlastRadius(query, matched, opts);
  if (!opts.apply) return { matched, count: 0 }; // dry run is the default
  for (const m of matched) {
    await fs.rm(m.file, { force: true });
  }
  return { matched, count: matched.length };
}

/**
 * Replace what the query addresses with new text.
 *
 * Forward-declared, the way the vault's own supersession works: the new note
 * names what it replaces and the old note's status is derived, so the link
 * survives even if the index is rebuilt from markdown alone.
 *
 * Only the single best match is superseded. ForgetEval's drift family applies
 * two supersessions in sequence over the same subject, and superseding every
 * candidate on the first call would take the replacement written by the first
 * one with it.
 */
export async function supersede(
  notesDir: string,
  oldQuery: string,
  newText: string,
  config: EngineConfig,
  writeNote: (slug: string, text: string, frontmatter: Record<string, unknown>) => Promise<void>,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const matched = await matchForForget(notesDir, oldQuery, config, { limit: 1 });
  if (!opts.apply) return { matched, count: 0 }; // dry run is the default
  const replaced = matched.map((m) => m.slug);
  // The replacement inherits the replaced note's project: project is a
  // schema-required field, and the caller (cli) only supplies it when the
  // operator passed -p. A replacement born without one is schema-invalid.
  let inheritedProject: unknown;
  for (const m of matched) {
    const parsed = await readFrontmatterFile(m.file);
    const project = (parsed.data as Record<string, unknown> | undefined)?.project;
    const present =
      typeof project === "string" ? project.trim() !== "" : Array.isArray(project) && project.length > 0;
    if (present) inheritedProject = project;
    await setStatus(m.file, "superseded", { superseded_by_query: oldQuery });
  }
  const slug =
    (newText.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "note") +
    `-${Date.now().toString(36)}`;
  await writeNote(slug, newText, {
    description: newText.slice(0, 160),
    type: "decision",
    status: "active",
    // Schema-required; supersedes previously wrote replacements without it,
    // so every replacement flagged as a schema violation from birth.
    created: new Date().toISOString().slice(0, 10),
    ...(inheritedProject !== undefined ? { project: inheritedProject } : {}),
    ...(replaced.length ? { supersedes: replaced } : {}),
  });
  return { matched, count: matched.length };
}
