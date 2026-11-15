/**
 * `mnemos requests` renders for HUMANS. The user-only surface's whole job
 * is legibility — you are about to approve the destruction of notes or a
 * rewrite of the agent's identity, and a raw JSON blob made it easier to
 * approve blind than to read what you were approving. These pin the human
 * form (and `--json` keeps the machine form for scripts).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRequestList,
  formatRequestDecision,
  formatRequestItem,
  runRequestInteractive,
  runRequestDecide,
} from "../../src/cli/forget.js";
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

describe("the decision UX (Eric: the command is the answer)", () => {
  // The [y/N] re-ask on an EXPLICIT verb was the question in the wrong
  // place. The bare `requests <id>` flow is where the question lives.

  it("approve executes with NO prompt in a real terminal (the old code asked [y/N] here)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mnemos-decide-"));
    const notes = join(root, "notes");
    mkdirSync(notes, { recursive: true });
    mkdirSync(join(root, ".mnemos"), { recursive: true });
    mkdirSync(join(root, "ops", "requests"), { recursive: true });
    writeFileSync(
      join(notes, "purge-me.md"),
      "---\ndescription: marked for purge\ntype: insight\n---\n\nBody.\n",
      "utf8",
    );
    writeFileSync(
      join(root, "ops", "requests", "rq-decide-test.json"),
      JSON.stringify({
        id: "rq-decide-test", kind: "purge", slugs: ["purge-me"],
        reason: "the decision-ux test", session_id: "test",
        created: "2026-11-15T00:00:00.000Z", expires: "2026-12-15T00:00:00.000Z",
        status: "pending",
      }),
      "utf8",
    );

    // Simulate the user's terminal: TTY on both streams. With no injected
    // confirm, the OLD code prompted [y/N] here and the test would hang
    // until its 30s timeout; the explicit verb now executes directly.
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      const res = await runRequestDecide(root, "rq-decide-test", "approved");
      expect(res.success).toBe(true);
      expect(res.data?.status).toBe("approved");
      expect(existsSync(join(notes, "purge-me.md"))).toBe(false); // executed, not asked twice
    } finally {
      if (stdinDesc) Object.defineProperty(process.stdin, "isTTY", stdinDesc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the bare-id flow shows the full request, then asks — choose routes the decision", async () => {
    const root = mkdtempSync(join(tmpdir(), "mnemos-bareid-"));
    const notes = join(root, "notes");
    mkdirSync(notes, { recursive: true });
    mkdirSync(join(root, ".mnemos"), { recursive: true });
    mkdirSync(join(root, "ops", "requests"), { recursive: true });
    writeFileSync(
      join(notes, "keep-me.md"),
      "---\ndescription: stays\ntype: insight\n---\n\nBody.\n",
      "utf8",
    );
    writeFileSync(
      join(root, "ops", "requests", "rq-bare-id.json"),
      JSON.stringify({
        id: "rq-bare-id", kind: "purge", slugs: ["keep-me"],
        reason: "the bare-id test", session_id: "test",
        created: "2026-11-15T00:00:00.000Z", expires: "2026-12-15T00:00:00.000Z",
        status: "pending",
      }),
      "utf8",
    );

    // choose = denied → the question's answer executes.
    const res = await runRequestInteractive(root, "rq-bare-id", {
      choose: async () => "denied",
    });
    expect(res.success).toBe(true);
    expect(res.data?.status).toBe("denied");
    expect(existsSync(join(notes, "keep-me.md"))).toBe(true); // deny touched nothing

    // abort → nothing happens, still pending.
    writeFileSync(
      join(root, "ops", "requests", "rq-bare-id2.json"),
      JSON.stringify({
        id: "rq-bare-id2", kind: "purge", slugs: ["keep-me"],
        reason: "abort test", session_id: "test",
        created: "2026-11-15T00:00:00.000Z", expires: "2026-12-15T00:00:00.000Z",
        status: "pending",
      }),
      "utf8",
    );
    const aborted = await runRequestInteractive(root, "rq-bare-id2", {
      choose: async () => "abort",
    });
    expect(aborted.success).toBe(false);
    expect(aborted.warnings.join(" ")).toContain("stays pending");
    const intent = JSON.parse(
      readFileSync(join(root, "ops", "requests", "rq-bare-id2.json"), "utf8"),
    ) as RemovalIntent;
    expect(intent.status).toBe("pending");

    rmSync(root, { recursive: true, force: true });
  });

  it("formatRequestItem renders one request's full block (the bare-id display)", () => {
    const out = formatRequestItem(identityPending, NOW);
    expect(out).toContain("● rq-test-identity   identity_update");
    expect(out).toContain("approve:  mnemos requests approve rq-test-identity");
  });
});
