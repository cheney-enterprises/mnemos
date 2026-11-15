/**
 * The anchor machinery — identifier-shaped tokens and the inverted index
 * that serves them.
 *
 * `richTokens` lived in forget.ts (it was born for query-addressed
 * forgetting) and the §5 anchor waiver reuses it verbatim (spec
 * session-scope §5: "reuse the forget matcher's richTokens/anchoring
 * machinery"). Two consumers now, plus a third in indexstore.ts, which
 * persists the per-note longs at sync time — and indexstore must not
 * import forget.ts, because forget.ts imports the embedder (engine.ts)
 * and every indexstore consumer would inherit that module graph. So the
 * function lives here: a leaf that imports only the tokenizer.
 *
 * The second part of richTokens matters for identifiers. `purge("API key
 * sk-zzpqk51fpk")` must reach "API key issued to ops: sk-zzpqk51fpk-secret."
 * — the note's identifier is the query's identifier with a suffix, so exact
 * token equality never fires and only a substring test connects them.
 */

import { tokenize } from "./bm25.js";

export function richTokens(text: string): { tokens: Set<string>; longs: string[] } {
  const tokens = new Set(tokenize(text));
  const longs: string[] = [];
  // An identifier, not merely a long word. The distinction is load-bearing:
  // `longs` drives an exclusivity rule, so admitting "customer" or "history"
  // would make every note carrying a common word an exact address.
  //
  // The first version matched /[a-z0-9][a-z0-9-]{5,}/ and therefore could not
  // see an email at all -- "@" and "." were outside the class, so
  // "alice@post.dev" yielded only ["customer","history"]. That is why 50 of
  // 200 purge cases deleted a second customer's record: the one token that
  // uniquely named the target was invisible, and a shared common word decided
  // the match instead.
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._@+-]{5,}/g)) {
    const tok = m[0].replace(/[.]+$/, "");
    if (/[0-9@._+-]/.test(tok.slice(1))) longs.push(tok);
  }
  return { tokens, longs };
}

/**
 * The inverted anchor index — corpus statistics answered by lookup instead
 * of by scanning the vault.
 *
 * The §5 anchor waiver ran `matchForForget` per weighted query, and the
 * matcher's anchor phase read and re-tokenized EVERY note file. Measured on
 * the real vault pattern (1,500+ notes): whole-vault file I/O per query for
 * a question the derived index already answers — note_term holds the body
 * postings, and note_long (added with this index) holds the identifier runs.
 *
 * Semantics are the matcher's own, unchanged: same token vocabulary
 * (bm25.ts's tokenize, body field only — tf_body > 0), same live-note
 * filter (FORGOTTEN_STATUSES), same identifier containment in both
 * directions. `matchForForget` produces identical results with and without
 * one — that equivalence is what the tests pin.
 */
export interface AnchorIndex {
  /** Live (non-forgotten) note count — the N in the IDF formula. */
  noteCount(): number;
  /** Document frequency of each term among live notes' bodies. */
  dfOf(terms: Iterable<string>): Map<string, number>;
  /** Live notes whose body carries the term (body tf > 0). */
  notesWithTerm(term: string): string[];
  /** Live notes whose body contains the identifier as a substring. */
  notesContainingLong(longToken: string): string[];
}

/**
 * Alphanumeric sub-runs of a long identifier, length >= min — the candidate
 * note-token set for the reverse containment check (`note token inside the
 * query's identifier`). A body token t with l.includes(t) can only be one of
 * these: tokens are maximal alphanumeric runs (tokenize splits on the same
 * class richTokens scans), so t spans no separator and sits inside exactly
 * one run of l.
 */
export function longSubstrings(longToken: string, min = 6): Set<string> {
  const out = new Set<string>();
  for (const run of longToken.split(/[^a-z0-9]+/)) {
    if (run.length < min) continue;
    for (let start = 0; start + min <= run.length; start++) {
      for (let end = start + min; end <= run.length; end++) {
        out.add(run.slice(start, end));
      }
    }
  }
  return out;
}
