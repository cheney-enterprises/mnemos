/**
 * `mnemos requests` renders for HUMANS. The user-only surface's whole job
 * is legibility — you are about to approve the destruction of notes or a
 * rewrite of the agent's identity, and a raw JSON blob made it easier to
 * approve blind than to read what you were approving. These pin the human
 * form (and `--json` keeps the machine form for scripts).
 */
import { describe, it, expect } from "vitest";
import { formatRequestList, formatRequestDecision } from "../../src/cli/forget.js";
import type { RemovalIntent } from "../../src/core/policy.js";

const NOW = new Date("2026-11-15T12:00:00Z");

const identityPending: RemovalIntent = {
  id: "rq-test-identity",
  kind: "identity_update",
  slugs: [],
  content: "---\ndescription: Agent identity — who I am, how I work\ntype: self\n---\n\n# Identity\n\nOri, Eric's intern...\n",
  selfFile: "identity",
  reason: "identity rewrite requested via agent session",
  session_id: "agent",
  created: "2026-11-15T03:46:37.689Z",
  expires: "2026-11-22T03:46:37.689Z",
  status: "pending",
};

const purgePending: RemovalIntent = {
  id: "rq-test-purge",
  kind: "purge",
  slugs: ["stale-note-one", "stale-note-two"],
  reason: "purge requested via cli",
  session_id: "cli",
  created: "2026-11-09T02:43:48.040Z",
  expires: "2026-11-16T02:43:48.040Z",
  status: "pending",
};

const approvedPurge: RemovalIntent = { ...purgePending, id: "rq-old", status: "approved" };

describe("formatRequestList", () => {
  it("renders pending requests in full: id, kind, reason, detail, expiry, commands", () => {
    const out = formatRequestList([identityPending, purgePending], NOW);
    expect(out).toContain("Pending requests — 2");
    expect(out).toContain("● rq-test-identity   identity_update");
    expect(out).toContain("reason: identity rewrite requested via agent session");
    // The preview is the frontmatter DESCRIPTION, not the "# Identity" heading.
    expect(out).toContain('"Agent identity — who I am, how I work"');
    expect(out).not.toContain('"# Identity"');
    // Purge names its exact targets — approval without naming is how the
    // wrong notes die.
    expect(out).toContain("forgets:  stale-note-one, stale-note-two");
    expect(out).toContain("expires 2026-11-22 (in 7d)");
    expect(out).toContain("approve:  mnemos requests approve rq-test-identity");
    expect(out).toContain("deny:     mnemos requests deny rq-test-purge");
  });

  it("expires-soon shows as days; already-expired shows EXPIRED", () => {
    const out = formatRequestList([purgePending], NOW);
    expect(out).toContain("(in 1d)");
    const expired: RemovalIntent = { ...purgePending, expires: "2026-11-14T00:00:00.000Z" };
    expect(formatRequestList([expired], NOW)).toContain("EXPIRED");
  });

  it("settled requests collapse to one history line each", () => {
    const out = formatRequestList([approvedPurge], NOW);
    expect(out).toContain("No pending requests (1 decided/expired in history");
    expect(out).toContain("○ rq-old   purge   approved");
  });

  it("an empty queue says so plainly", () => {
    const out = formatRequestList([], NOW);
    expect(out).toContain("No pending requests (0 decided/expired");
  });
});

describe("formatRequestDecision", () => {
  it("an identity approval says what was rewritten and that a backup exists", () => {
    const out = formatRequestDecision("rq-test-identity", "approved", {
      id: "rq-test-identity",
      status: "approved",
      written: "identity.md",
      backed_up: true,
    });
    expect(out).toContain("✓ approved rq-test-identity");
    expect(out).toContain("self/identity.md rewritten");
    expect(out).toContain("backed up in self/.history/");
  });

  it("a purge approval says how many notes and where they went", () => {
    const out = formatRequestDecision("rq-test-purge", "approved", {
      id: "rq-test-purge",
      status: "approved",
      changed: 2,
      trashed_in: "ops/.trash",
    });
    expect(out).toContain("2 note(s) moved to ops/.trash");
  });

  it("a denial says nothing executed", () => {
    const out = formatRequestDecision("rq-test-purge", "denied", { id: "rq-test-purge", status: "denied" });
    expect(out).toContain("✗ denied rq-test-purge");
    expect(out).toContain("nothing executed");
  });
});
