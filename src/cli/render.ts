/**
 * Shared human-rendering helpers for the CLI's read/diagnostic verbs.
 *
 * Why this exists: the human-path commands dumped raw JSON — and the CLI is
 * the HUMAN surface (agents speak MCP). `status`, `health`, `doctor`,
 * `query`, `validate`, `graph`, `prune`, `index status`, `sessions`, and
 * `explore` all read like a wire dump. Every one now renders for humans by
 * default with `--json` preserved for scripts; these helpers keep that
 * rendering consistent instead of nine ad-hoc formatters drifting apart.
 */

/** Wrap a list of strings as a bulleted block, N items per line, ~100 cols. */
export function bulletList(items: string[], indent = "  "): string[] {
  const lines: string[] = [];
  let current: string[] = [];
  let len = indent.length;
  const flush = () => {
    if (current.length > 0) lines.push(`${indent}- ${current.join(", ")}`);
    current = [];
    len = indent.length + 2;
  };
  for (const item of items) {
    if (len + item.length + 2 > 100 && current.length > 0) flush();
    current.push(item);
    len += item.length + 2;
  }
  flush();
  return lines;
}

/** "3 notes" / "1 note" — count with a pluralized noun. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Fixed-width score, 3 decimals, no sign noise for zero. */
export function score(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : Number(n).toFixed(3);
}

/** First meaningful description line for a result row — a heading only when
 * nothing else exists (and then with its hashes stripped): collapsed single-
 * line previews often begin with "# Title" and carry the body inline, so
 * skipping every # line returned empty exactly there. */
export function firstLine(text: string | null | undefined, max = 100): string {
  if (!text) return "";
  const lines = text
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const body = lines.find((l) => !l.startsWith("#"));
  const chosen = (body ?? lines[0]?.replace(/^#+\s*/, "")) ?? "";
  if (!chosen) return "";
  return chosen.length > max ? `${chosen.slice(0, max)}…` : chosen;
}

export interface RankedRow {
  title: string;
  score: number;
  snippet?: { description?: string | null; preview?: string | null } | null;
  /** `query ranked`'s shape — search.ts puts the preview under metadata. */
  metadata?: { preview?: string | null } | null;
  scopeTrace?: { band?: string; origin?: string | null; waived?: boolean } | null;
}

/**
 * Numbered ranked results — the shared shape of `query ranked|similar` and
 * `explore`. Rank, score, the §6 origin label when the scope weighting ran,
 * and one description line that is never a heading.
 */
export function formatRankedRows(rows: RankedRow[]): string[] {
  const lines: string[] = [];
  for (const [i, r] of rows.entries()) {
    const origin =
      r.scopeTrace?.origin
        ? ` · from ${r.scopeTrace.origin}${r.scopeTrace.waived ? " (waived)" : ""}`
        : "";
    lines.push(`${i + 1}. ${r.title}  (${score(r.score)}${origin})`);
    const desc = firstLine(r.snippet?.description ?? r.snippet?.preview ?? r.metadata?.preview ?? null);
    if (desc) lines.push(`   ${desc}`);
  }
  return lines;
}
