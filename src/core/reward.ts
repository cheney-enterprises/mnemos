/**
 * Session reward accumulator and credit assignment.
 *
 * Tracks retrievals, adds, and updates within a session, then computes
 * per-note rewards at session end. This is the ONLY path that may write
 * Q-values (see qvalue.ts `updateQ`, and the guard in serve.ts).
 *
 * Reward signals (in priority order):
 *   reported use +0.8 (the agent's explicit testimony — debt #5) | forward citation +1.0
 *   | update +0.5 | within-session re-recall (distinct queries) +0.4
 *   reported only, never credited (#37): downstream creation, partial follow-up, dead end, neutral
 *
 * Reported use (search-path outcome closure): the query path historically had
 * NO channel for the strongest evidence — the agent stating which surfaced
 * notes actually answered the question. The dead_end comment below says it:
 * "read and answered from, but not cited" was indistinguishable from "read
 * and useless". The report closes that gap: mnemos_query_outcome validates
 * the claim against this session's retrieval log (a note never surfaced
 * carries no signal — the ranker's own output is the honest boundary) and
 * the credit is assigned here, at session end, with every other signal.
 * NOT a per-query write; the RewardSource guard is untouched.
 *
 * ## Two production defects fixed 2026-08-28
 *
 * **1. Note keys were not canonical.** `buildOutcome` matched `[[link]]` text
 * against retrieved note ids using raw string equality. Wiki-links carry the
 * TITLE; retrieval logged a mix — measured on a live vault, `retrieval_log`
 * held 1,072 distinct ids of which 772 were slugs and 300 raw titles. So a
 * citation of a slug-keyed note never matched. Result: **forward citation, the
 * strongest signal in this file, fired 0 times in 5 months across 401
 * sessions.** Every id is now normalized through `slugify()` (src/core/slug.ts,
 * the same helper add.ts and graph.ts use — see issue #32 for why that helper
 * exists at all).
 *
 * **2. Exposure correction ran unconditionally.** `reward / exposure^0.5` is
 * the CIKM 2024 correction for exposure bias, and it assumes strong signals
 * arriving disproportionately to over-exposed items. While serve.ts was also
 * writing a uniform ~0.02 rank proxy on every query, there was no such signal
 * to correct — the divisor just crushed anything popular. Measured outcome:
 * pearson(exposure, Q) = -0.537, i.e. the more a note was used the lower its
 * learned value, with `index` (104 exposures) at Q=0.0165 while never-retrieved
 * test fixtures sat at the 0.5 initialization ceiling.
 *
 * The proxy is gone. The correction was then damped (EXPOSURE_BETA 0.5 -> 0.25)
 * and floored, and #37 removed it from credit entirely: with an EMA, Q cannot
 * exceed the recent corrected reward, so dividing by lifetime exposure made the
 * ceiling fall with use - a note cited every session peaked at Q 0.48 after 20
 * sessions and sank to 0.20 by 1,000, below a note cited 8 times. A note cited
 * 200 times should rank high; it should not be punished for being the answer.
 * Popularity bias is handled where it belongs, in ranking (explorationBonus
 * damps by exposure, and the cold-start floor surfaces unseen notes).
 */

import type Database from "better-sqlite3";
import { batchUpdateQ, getExposureCount, type RewardSource } from "./qvalue.js";
import { slugify } from "./slug.js";

/**
 * Signals that are written to note_q. Everything else is reported only.
 * downstream_creation is reported only (#37 review): it fired for every
 * retrieved note whenever anything was created, linked or not - "retrieved
 * alongside" at up to 0.6, above an actual update. A created note that links
 * a retrieved one is already a forward_citation.
 */
const CREDITED_SIGNALS = new Set<string>(["forward_citation", "update", "re_recall", "reported_use"]);

/** Credit for a note the agent explicitly reported as used (debt #5). Below
 * forward_citation (a new note linking it is durable evidence of value),
 * above update (an edit can be incidental). */
export const REPORTED_USE_REWARD = 0.8;

export interface RetrievalEvent {
  noteId: string;
  rank: number;
  queryText: string;
  queryType: string;
}

export interface SessionOutcome {
  forwardCitations: string[];
  updatedNotes: string[];
  createdNotes: string[];
  reRecalledNotes: string[];
  /** Notes the agent explicitly reported as used (validated against the
   * retrieval log at report time; only accepted ones land here). */
  reportedUse: string[];
}

/** Diagnostic breakdown of one session's credit assignment. */
export interface RewardBreakdown {
  noteId: string;
  reward: number;
  signal:
    | "forward_citation"
    | "update"
    | "downstream_creation"
    | "re_recall"
    | "reported_use"
    | "partial_follow_up"
    | "dead_end"
    | "neutral";
  bestRank: number;
  exposure: number;
  rawReward: number;
}

export class SessionRewardAccumulator {
  private retrievals: RetrievalEvent[] = [];
  private reported: string[] = [];
  private addedContent: string[] = [];
  private updatedNoteIds: string[] = [];
  private createdNoteIds: string[] = [];
  private lastBreakdown: RewardBreakdown[] = [];
  private flushed = false;
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  logRetrieval(
    noteId: string,
    rank: number,
    queryText: string,
    queryType: string,
  ): void {
    this.retrievals.push({ noteId: slugify(noteId), rank, queryText, queryType });
  }

  logAdd(noteId: string, content: string): void {
    this.createdNoteIds.push(slugify(noteId));
    this.addedContent.push(content);
  }

  logUpdate(noteId: string): void {
    this.updatedNoteIds.push(slugify(noteId));
  }

  /**
   * Record an agent's reported-use outcome (debt #5, mnemos_query_outcome).
   * Only notes this session actually SURFACED can carry the signal —
   * `validateReportedUse` decides, and callers must pass its accepted set.
   */
  logReportedUse(accepted: string[]): void {
    for (const n of accepted) this.reported.push(slugify(n));
  }

  /**
   * Validate a reported-use claim against this session's retrieval log.
   * Exact or slug-normalized match (navigators may echo display titles).
   * The boundary is honest by construction: a note the ranker never
   * surfaced cannot be reported as used, so a hallucinated title can never
   * steer learning toward something retrieval didn't offer.
   */
  validateReportedUse(notes: string[]): { accepted: string[]; rejected: string[] } {
    const surfaced = new Set(this.retrievals.map((r) => r.noteId));
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const raw of notes) {
      const slug = slugify(raw);
      if (surfaced.has(slug) || surfaced.has(raw)) accepted.push(slug);
      else rejected.push(raw);
    }
    return { accepted, rejected };
  }

  /**
   * Credit every retrieved note for this session.
   *
   * Signals are checked in strength order and the first match wins — a cited
   * note is not additionally penalized for anything else. `bestRank` is the
   * shallowest rank the note ever reached, so a note that appeared at rank 0
   * once and rank 7 twice is credited on the rank the agent most likely read.
   */
  computeRewards(db: Database.Database): Map<string, number> {
    const outcome = this.buildOutcome();
    const credits = new Map<string, number>();
    const breakdown: RewardBreakdown[] = [];
    const seen = new Map<string, number[]>();

    // Re-recall means distinct queries (#37 review): a retry or second page
    // of the same query logged the note twice and paid 0.4 without use.
    const queries = new Map<string, Set<string>>();
    for (const r of this.retrievals) {
      const ranks = seen.get(r.noteId) ?? [];
      ranks.push(r.rank);
      seen.set(r.noteId, ranks);
      const qs = queries.get(r.noteId) ?? new Set<string>();
      qs.add(r.queryText.trim().toLowerCase());
      queries.set(r.noteId, qs);
    }

    for (const [noteId, ranks] of seen) {
      const bestRank = Math.min(...ranks);
      let reward: number;
      let signal: RewardBreakdown["signal"];

      // Reported use FIRST: it is direct testimony, checked before every
      // inferred proxy. A note the agent said answered the question needs no
      // circumstantial corroboration — and if it was ALSO cited or updated,
      // the report is the more honest description of why.
      if (outcome.reportedUse.includes(noteId)) {
        reward = REPORTED_USE_REWARD;
        signal = "reported_use";
      } else if (outcome.forwardCitations.includes(noteId)) {
        reward = 1.0;
        signal = "forward_citation";
      } else if (outcome.updatedNotes.includes(noteId)) {
        reward = 0.5;
        signal = "update";
      } else if (queries.get(noteId)!.size > 1) {
        // Constant: coming back to a note more often in one session is not
        // weaker evidence. 0.4 / count paid a note recalled 5 times 0.08.
        //
        // Checked BEFORE downstream_creation (#37 follow-up, Codex review):
        // since #37 downstream_creation is report-only, so while it came first
        // any session that wrote an unrelated note lost every re-recall credit.
        reward = 0.4;
        signal = "re_recall";
      } else if (outcome.createdNotes.length > 0) {
        reward = 0.6 * (1 / Math.log2(bestRank + 2));
        signal = "downstream_creation";
      } else if (
        outcome.forwardCitations.length > 0 ||
        outcome.updatedNotes.length > 0
      ) {
        reward = 0.1 / Math.log2(bestRank + 2);
        signal = "partial_follow_up";
      } else if (bestRank <= 2) {
        // Dead end: a top-3 note the session never visibly used. Reported, not
        // credited (#37 review). "Read and answered from, but not cited" looks
        // identical to "read and useless", so a penalty here demoted notes for
        // being read - the #37 sign on a smaller scale. It needs a real
        // not-useful signal before it can be a verdict.
        reward = 0;
        signal = "dead_end";
      } else {
        reward = 0;
        signal = "neutral";
      }

      const rawReward = reward;
      // Reported in the breakdown; no longer divides credit (#37, see header).
      const exposure = getExposureCount(db, noteId);

      const finalReward = Math.max(-1, Math.min(1, reward));
      // Only signals that say the note was USED reach note_q (#37):
      //   - neutral: no signal. Written as 0 it pulled Q down (2,604 of 3,320
      //     updates on one vault).
      //   - dead_end: read-but-not-cited is indistinguishable from useless.
      //   - partial_follow_up: "retrieved alongside the note that was cited"
      //     paid <= 0.1, which an EMA reads as a demotion for any note above it.
      // They stay in the breakdown so the signal mix is still reported.
      if (CREDITED_SIGNALS.has(signal)) credits.set(noteId, finalReward);
      breakdown.push({
        noteId,
        reward: finalReward,
        signal,
        bestRank,
        exposure,
        rawReward,
      });
    }

    this.lastBreakdown = breakdown;
    return credits;
  }

  /**
   * Per-signal counts from the last `computeRewards` call.
   *
   * Exists so the zero-forward-citation failure is observable instead of
   * silent: if `forward_citation` is 0 across many sessions with non-empty
   * `mnemos_add` traffic, key normalization has regressed again.
   */
  getSignalCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const b of this.lastBreakdown) {
      counts[b.signal] = (counts[b.signal] ?? 0) + 1;
    }
    return counts;
  }

  getBreakdown(): RewardBreakdown[] {
    return this.lastBreakdown;
  }

  /**
   * Compute this session's credit and write it, once.
   *
   * The sanctioned write path condensed to one call, because fix-list item 5
   * measured what happens when it is spelled out per caller: `note_q` held 717
   * rows with 707 at `update_count = 0`, since only the MCP server assembled
   * accumulator + `computeRewards` + `batchUpdateQ`, and every other entry
   * point retrieved without ever crediting. A caller that retrieves and then
   * concludes now needs one line and cannot get the source wrong.
   *
   * Returns the number of notes credited, so the absence of signal is a value
   * a caller can check rather than something it has to infer from the table.
   *
   * Guarded against a second call: rewards are session-scoped and cumulative
   * here (there is no `clear()`), so flushing twice would inflate
   * `update_count` and `reward_sum` over the whole accumulated set. Subsequent
   * calls return 0 and write nothing.
   */
  concludeSession(
    db: Database.Database,
    source: RewardSource = "session_batch",
  ): number {
    if (this.flushed || !this.hasData()) return 0;
    const rewards = this.computeRewards(db);
    if (rewards.size === 0) return 0;
    batchUpdateQ(db, rewards, this.sessionId, source);
    this.flushed = true;
    return rewards.size;
  }

  /** True once `concludeSession` has written this session's credit. */
  isFlushed(): boolean {
    return this.flushed;
  }

  /**
   * Resolve session outcomes into canonical note ids.
   *
   * Both sides of the citation match are slugified: the link text as written
   * in the note body, and the retrieved ids (already slugified on ingest by
   * `logRetrieval`). This is the fix for the 0-citations-in-5-months defect.
   */
  private buildOutcome(): SessionOutcome {
    const retrievedIds = new Set(this.retrievals.map((r) => r.noteId));
    const forwardCitations: string[] = [];

    for (const content of this.addedContent) {
      const links = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      for (const link of links) {
        // Strip [[ ]], then any |alias and #heading suffix before slugifying —
        // Obsidian-style links are common in this vault and would otherwise
        // never match.
        const inner = link.slice(2, -2);
        const target = inner.split("|")[0]!.split("#")[0]!.trim();
        const slug = slugify(target);
        if (retrievedIds.has(slug)) {
          forwardCitations.push(slug);
        }
      }
    }

    return {
      forwardCitations: [...new Set(forwardCitations)],
      updatedNotes: [...new Set(this.updatedNoteIds)],
      createdNotes: [...new Set(this.createdNoteIds)],
      reRecalledNotes: [],
      reportedUse: [...new Set(this.reported)],
    };
  }

  hasData(): boolean {
    return this.retrievals.length > 0 || this.reported.length > 0;
  }
}

