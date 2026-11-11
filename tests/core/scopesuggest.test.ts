/**
 * Scope suggester unit tests — the ranking behind wake's resolve-first gate
 * and the inline project_suggestions field. The IDF contract caught here was
 * found LIVE: cwd "ai memory" produced a phantom three-way 1.00 tie because
 * (a) a token present in EVERY footprint still scored ln(2) ≈ 0.69 under the
 * old ln(1 + N/df) formula, and (b) zero-evidence hits still claimed
 * "mentions memory" — dressing recency noise up as a text match while the
 * true memory project (fewest notes) ranked third on size alone.
 */
import { describe, it, expect } from "vitest";
import { suggestScopes, type ScopeCandidate } from "../../src/core/scopesuggest.js";

const base = (project: string, footprint: string, notes: number, daysAgo = 2): ScopeCandidate => ({
  project,
  footprint,
  lastActive: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  notes,
});

// "memory" appears in EVERY footprint; the distinctive tokens do not.
const candidates = [
  base("flutter", "chatbox flutter openrouter impeller widget memory", 28),
  base("roust", "alarm countdown snooze haptics budget memory", 25),
  base("mnemos", "mnemos vault doctrine wake retrieval memory", 4),
];

describe("IDF: universal tokens are zero evidence", () => {
  it("a token in every footprint contributes no text score and no 'mentions' reason", () => {
    const out = suggestScopes("memory", candidates);
    // No text-backed claim anywhere: 'memory' cannot discriminate.
    for (const s of out) {
      expect(s.reasons.some((r) => r.startsWith("mentions "))).toBe(false);
    }
  });

  it("a reference of ONLY universal tokens still returns candidates (recency ranks them), honestly labeled", () => {
    const out = suggestScopes("memory", candidates);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].score).toBeGreaterThan(0); // recency/size carry it
  });

  it("a distinctive token resolves its project with a full text score", () => {
    const out = suggestScopes("snooze", candidates);
    expect(out[0].project).toBe("roust");
    expect(out[0].reasons.some((r) => r.includes("snooze"))).toBe(true);
    // The gap is decisive: distinctive evidence dominates recency/size noise.
    expect(out[0].score - (out[1]?.score ?? 0)).toBeGreaterThan(0.5);
  });

  it("mixed reference: the distinctive token decides, the universal token adds nothing", () => {
    const out = suggestScopes("memory snooze", candidates);
    expect(out[0].project).toBe("roust");
    expect(out[0].reasons.some((r) => r.includes("snooze"))).toBe(true);
  });

  it("the project with genuinely matching distinctive tokens wins even when it is the smallest", () => {
    // The live failure: mnemos (4 notes) ranked third on size when every
    // candidate carried the same zero-evidence 'memory' hit. With a real
    // distinctive reference, mnemos must WIN.
    const out = suggestScopes("wake retrieval", candidates);
    expect(out[0].project).toBe("mnemos");
  });

  it("two distinctive tokens across two projects produce a genuine race, not a phantom", () => {
    const out = suggestScopes("snooze widget", candidates);
    const roust = out.find((s) => s.project === "roust");
    const flutter = out.find((s) => s.project === "flutter");
    expect(roust?.reasons.some((r) => r.includes("snooze"))).toBe(true);
    expect(flutter?.reasons.some((r) => r.includes("widget"))).toBe(true);
  });

  it("no-signal reference returns candidates ranked by recency only, with no text claims", () => {
    const out = suggestScopes("quantum xylophone", candidates);
    for (const s of out) {
      expect(s.reasons.some((r) => r.startsWith("mentions "))).toBe(false);
    }
  });
});
