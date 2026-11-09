/**
 * Scope suggester — when the user references a conversation vaguely ("our
 * crazy chat from the other night with the pirates"), rank the projects
 * they most likely mean.
 *
 * This is the cross-scope reference companion: the doctrine teaches the
 * agent to cross scopes; this module tells it WHICH scope. Pure functions
 * + one best-effort signal gatherer, same degrade-to-empty contract as the
 * roster.
 *
 * Signals (all mechanical, no LLM):
 *   - text:    fuzzy token overlap between the user's words and the
 *              project's own footprint (tag tokens, map title, its daily
 *              lines, its note titles). "pirates" hits a project whose
 *              daily lines talk about pirates.
 *   - recency: "the other night" — recent activity ranks up. Exponential
 *              decay over days-since-last-activity, half-life 7d.
 *   - size:    a bigger project is a more likely referent than a 1-note
 *              stub — mild log-square-root weight, never decisive.
 *   - current: the scope the session is already in is mildly likelier to
 *              be the referent — tiny bias, never decisive.
 */

export interface ScopeCandidate {
  project: string;
  /**
   * The project's text footprint: slugs + map title + recent daily lines +
   * note DESCRIPTIONS (descriptions are where human-language tokens live —
   * 'performance track' appears in a description, never in a slug).
   */
  footprint: string;
  /** ISO of last activity, when known. */
  lastActive: string | null;
  notes: number;
}

export interface ScopeSuggestion {
  project: string;
  /** 0..1 — relative confidence, not a probability. */
  score: number;
  /** Which signals fired, for the agent to explain its suggestion. */
  reasons: string[];
}

/** Weight knobs — tuned so text dominates, recency breaks ties, the rest nudge. */
const WEIGHTS = { text: 1.0, recency: 0.45, size: 0.15, current: 0.12 } as const;
const RECENCY_HALF_LIFE_DAYS = 7;
const NOW_MS = Date.now();

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
      // Stopwords: high-frequency English glue that otherwise dominates the
      // overlap (observed live: "the" scored above the real content token).
      .filter((t) => !STOPWORDS.has(t)),
  );
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "was", "were",
  "have", "has", "had", "you", "your", "our", "their", "his", "her",
  "about", "into", "over", "when", "what", "which", "who", "how", "why",
  "stuff", "thing", "things", "chat", "night", "other", "some", "just",
]);

function recencyScore(lastActive: string | null): { score: number; days: number | null } {
  if (!lastActive) return { score: 0, days: null };
  const t = Date.parse(lastActive);
  if (Number.isNaN(t)) return { score: 0, days: null };
  const days = Math.max(0, (NOW_MS - t) / 86_400_000);
  return { score: Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS), days };
}

function sizeScore(notes: number): number {
  return notes <= 0 ? 0 : Math.sqrt(notes) / 10; // 1 note → 0.1, 25 → 0.5, 100 → 1.0
}

/**
 * IDF across the candidate set: a token in EVERY footprint (cross-mentions —
 * the roust handoff line mentions the flutter session) is weak evidence; a
 * token unique to one footprint ('snooze' lives only in roust) is strong.
 * idf(t) = ln(1 + N/df), N = candidates, df = footprints containing t.
 */
function tokenIdf(
  refTokens: string[],
  footprints: Array<Set<string>>,
): Map<string, number> {
  const N = Math.max(1, footprints.length);
  const weights = new Map<string, number>();
  for (const t of refTokens) {
    let df = 0;
    for (const fp of footprints) if (fp.has(t)) df += 1;
    weights.set(t, Math.log(1 + N / Math.max(1, df)));
  }
  return weights;
}

/**
 * Rank the user's fuzzy reference against known projects.
 * `currentScope` biases (never decides) toward the session's active scope.
 * Returns candidates sorted by score; empty when no candidates carry any
 * signal (all zero scores are dropped — a no-signal answer is honest).
 */
export function suggestScopes(
  reference: string,
  candidates: ScopeCandidate[],
  currentScope?: string,
): ScopeSuggestion[] {
  const ref = tokens(reference);
  const footprints = candidates.map((c) => tokens(c.project + " " + c.footprint));
  const idf = tokenIdf([...ref], footprints);
  const out: ScopeSuggestion[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];
    let score = 0;

    // Text: IDF-weighted containment — what fraction of the reference's
    // DISTINCTIVE tokens the footprint explains. Containment alone measured
    // two failures: sqrt/Jaccard buried real signals in big footprints
    // ('snooze' → 0.08 for roust), and flat containment let one glancing
    // cross-mention ('flutter' in a roust handoff line) match a flutter
    // query at full strength. IDF fixes both: rare-token hits dominate,
    // everywhere-token hits weigh near nothing.
    const foot = footprints[candidates.indexOf(c)];
    const hits = [...ref].filter((t) => foot.has(t));
    const idfSum = [...ref].reduce((s2, t) => s2 + (idf.get(t) ?? 0), 0);
    const textScore =
      ref.size === 0 || idfSum === 0 ? 0 : hits.reduce((s2, t) => s2 + (idf.get(t) ?? 0), 0) / idfSum;
    if (hits.length > 0) {
      score += textScore * WEIGHTS.text;
      const distinctive = hits
        .slice()
        .sort((a, b) => (idf.get(b) ?? 0) - (idf.get(a) ?? 0));
      reasons.push(`mentions ${distinctive.slice(0, 3).join(", ")}`);
    }

    // Recency: "the other night" — decay from last activity.
    const rec = recencyScore(c.lastActive);
    if (rec.score > 0) {
      score += rec.score * WEIGHTS.recency;
      reasons.push(
        rec.days === null
          ? "recently active"
          : rec.days < 2
            ? "active today/yesterday"
            : `active ${Math.round(rec.days)}d ago`,
      );
    }

    // Size: mild prior toward bigger projects.
    const sz = sizeScore(c.notes);
    score += sz * WEIGHTS.size;

    // Current scope: tiny bias.
    if (currentScope && c.project === currentScope) {
      score += WEIGHTS.current;
      reasons.push("current scope");
    }

    // A candidate with no text hit and no recency signal is noise —
    // size+current alone must not put a random project on the list.
    if (hits.length === 0 && rec.score === 0) continue;

    out.push({ project: c.project, score, reasons });
  }

  const max = out.reduce((m, s) => Math.max(m, s.score), 0);
  if (max <= 0) return [];
  return out
    .map((s) => ({ ...s, score: s.score / max }))
    .sort((a, b) => b.score - a.score);
}
