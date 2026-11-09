import { describe, it, expect } from "vitest";
import {
  stripFrontmatter,
  isFirstRunIdentity,
  groundRules,
  projectProtocol,
  capturePolicy,
  sessionEnd,
  renderOnboarding,
  renderDoctrine,
} from "../../src/core/doctrine.js";
import { resolveAreas } from "../../src/core/promote.js";

// The doctrine is the contract with every future agent. These tests pin the
// load-bearing sentences: remove one and a cold agent loses a behavior.

describe("identity helpers", () => {
  it("stripFrontmatter removes the yaml block and keeps the body", () => {
    const t = "---\ndescription: x\ntype: self\n---\n\n# Identity\n\nBody here.\n";
    expect(stripFrontmatter(t)).toContain("# Identity");
    expect(stripFrontmatter(t)).not.toContain("description: x");
  });

  it("isFirstRun: empty, frontmatter-only, and scaffold-template identities all count", () => {
    expect(isFirstRunIdentity("")).toBe(true);
    expect(isFirstRunIdentity("---\ndescription: x\n---\n")).toBe(true);
    expect(isFirstRunIdentity("<!-- First session: fill this in -->")).toBe(true);
    expect(isFirstRunIdentity("---\n---\n# Identity\n\nOri, an agent.")).toBe(false);
  });
});

describe("ground rules", () => {
  it("bans direct vault access with the reason", () => {
    const g = groundRules("/v");
    expect(g).toContain("Vault access is MCP-ONLY");
    expect(g).toContain("Never read, write, move, rename, list, or search");
    // BOTH failure modes are named — a read misleads, a write corrupts.
    expect(g).toContain("misleads");
    expect(g).toContain("corrupts the vault invisibly");
    // The escape hatch names the ladder, not the filesystem.
    expect(g).toContain("change tools");
    expect(g).toContain("corrupts the vault invisibly");
  });

  it("teaches wake-first, the retrieval ladder, and the write path", () => {
    const g = groundRules("/v");
    expect(g).toContain("call mnemos_wake with project=");
    expect(g).toContain("project_choice_required");
    expect(g).toContain("NEVER work a session unscoped");
    expect(g).toContain("with project=");
    expect(g).toContain("mnemos_query_ranked is the default lookup");
    expect(g).toContain("memory_sql");
    expect(g).toContain("multi-word prose title");
    expect(g).toContain("silently fails");
  });

  it("carries the capability model: no agent delete, propose-only purge", () => {
    const g = groundRules("/v");
    expect(g).toContain("can only PROPOSE a hard delete");
    expect(g).toContain("You can never delete a note yourself");
  });

  it("names the policy surface and the display-the-refusal duty", () => {
    const g = groundRules("/v");
    expect(g).toContain("mnemos.config.yaml gates removal-class operations");
    expect(g).toContain("display it to the user verbatim");
    expect(g).toContain("You cannot change policy");
  });

  it("includes mnemos://policy in the resource list", () => {
    expect(groundRules("/v")).toContain("mnemos://policy");
  });

  it("lists file=map in the STATE tools and the session-end ritual", () => {
    const g = groundRules("/v");
    expect(g).toContain("MAP UPDATE (mnemos_update file=map");
    expect(g).toContain("Replace semantics");
    expect(sessionEnd()).toContain("file=map");
  });
});

describe("project protocol", () => {
  it("says the agent always knows its project via wake + map", () => {
    const p = projectProtocol();
    expect(p).toContain("wake briefing lists active projects");
    expect(p).toContain("your project's map is the entry point");
  });

  it("teaches the map Current State update as a performable tool call", () => {
    const p = projectProtocol();
    // The ritual step must name its tool and parameter — an instruction the
    // agent cannot execute through the surface is a doctrine bug (the
    // pre-phase-3 failure: the step existed, no tool could perform it).
    expect(p).toContain("mnemos_update file=map project=");
  });

  it("requires explicit project tags", () => {
    expect(projectProtocol()).toContain("ALWAYS pass project explicitly");
  });

  it("teaches the self-serve new-project flow with the naming convention", () => {
    const p = projectProtocol();
    expect(p).toContain("type=moc");
    expect(p).toContain("MUST start with the project tag");
    expect(p).toContain("no config needed");
    expect(p).toContain("mnemos_update file=goals");
  });

  it("keeps config routing out of agent hands", () => {
    expect(projectProtocol()).toContain("the user's to change, never yours");
  });
});

describe("capture policy", () => {
  it("gives the capture test and the exclusion list", () => {
    const c = capturePolicy();
    expect(c).toContain("rediscover this expensively");
    expect(c).toContain("DO NOT CAPTURE");
    expect(c).toContain("ephemeral task state");
  });
});

describe("session end", () => {
  it("orders the persist ritual with overwrite semantics", () => {
    const s = sessionEnd();
    expect(s).toContain("mnemos_add");
    expect(s).toContain("Current State");
    expect(s).toContain("never append");
    expect(s).toContain("file=daily");
    expect(s).toContain("op=supersede");
    expect(s).toContain("starts cold except for what you persisted");
  });
});

describe("rendering", () => {
  it("onboarding variant mentions onboarding steps and the project protocol", () => {
    const o = renderOnboarding(false);
    expect(o).toContain("AGENT NAME");
    expect(o).toContain("PROJECT PROTOCOL");
  });

  it("full doctrine contains every block and the identity summary", () => {
    const d = renderDoctrine({ vaultRoot: "/v", identitySummary: "Ori, an agent." });
    expect(d).toContain("GROUND RULES");
    expect(d).toContain("PROJECT PROTOCOL");
    expect(d).toContain("CAPTURE POLICY");
    expect(d).toContain("SESSION END");
    expect(d).toContain("Identity:\nOri, an agent.");
    expect(d).toContain("/v");
  });
});

describe("promote fallback warning retarget", () => {
  it("warns with agent-legal fixes, never config-edit instructions", () => {
    const { areas, usedDefault } = resolveAreas(["kite"], {}, ["index"], "index");
    expect(usedDefault).toBe(true);
    expect(areas).toEqual(["index"]);
  });
});

// ---------------------------------------------------------------------------
// The 2026-11-09 revision: four priority tiers + the new contract blocks.
// ---------------------------------------------------------------------------
import { criticalRules, workflowRules, qualityBars, hygieneRules } from "../../src/core/doctrine.js";

describe("revision: the four priority tiers", () => {
  it("critical tier is first, shortest, and carries the never-violate law", () => {
    const c = criticalRules("/v");
    expect(c).toContain("CRITICAL");
    expect(c).toContain("Vault access is MCP-ONLY");
    expect(c).toContain("propose-only");
    // Critical must be shorter than the whole workflow tier — if context
    // dies, these lines must be the ones that survived.
    expect(c.length).toBeLessThan(workflowRules().length);
  });

  it("full doctrine renders tiers in order: critical, workflow, quality, protocol, hygiene", () => {
    const d = renderDoctrine({ vaultRoot: "/v", identitySummary: "TestBot." });
    // Probe HEADER lines, not mentions: PROJECT PROTOCOL's last line says
    // "see SESSION END", which a naive indexOf would match first.
    const order = [
      "CRITICAL, NEVER VIOLATE",
      "WORKFLOW \u2014 the operating loop",
      "QUALITY BARS \u2014 what makes",
      "PROJECT PROTOCOL\n",
      "SESSION END\n",
      "HYGIENE \u2014 recovery",
    ];
    const positions = order.map((h) => d.indexOf(h));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("revision: scope decisions (fix #2 + #6)", () => {
  it("teaches the scope default, the global rarity law, and the session-state ban", () => {
    const w = workflowRules();
    expect(w).toContain("SCOPE DECISIONS");
    expect(w).toContain("Default to the session's project");
    expect(w).toContain("GLOBAL is only for");
    expect(w).toContain("global items are RARE");
    expect(w).toContain("never written down");
  });

  it("teaches the session taxonomy: work vs chat/roleplay with silent naming", () => {
    const w = workflowRules();
    expect(w).toContain("CHAT/ROLEPLAY sessions scope silently");
    expect(w).toContain("the normie never answers a project question");
    expect(w).toContain("ask the user");
  });
});

describe("revision: quality bars (fixes #3 + #4)", () => {
  it("description standard: relevance without opening the note, condition-holds phrasing", () => {
    const q = qualityBars();
    expect(q).toContain("WITHOUT opening the note");
    expect(q).toContain("what was learned, under what condition it holds");
    expect(q).toContain("Max 200 chars");
  });

  it("link discipline: real relationships, broken beats false", () => {
    const q = qualityBars();
    expect(q).toContain("A link asserts a real relationship");
    expect(q).toContain("A broken link is better than a false link");
    expect(q).toContain("link the project map");
  });
});

describe("revision: error-recovery map (fix #5)", () => {
  it("carries failure→remedy pairs for the five real refusals", () => {
    const h = hygieneRules();
    expect(h).toContain("ERROR RECOVERY");
    expect(h).toContain("waits in inbox/");
    expect(h).toContain("No map matched");
    expect(h).toContain("project_suggestions");
    expect(h).toContain("create the scope or pick an existing one");
    expect(h).toContain("never retry around a refusal");
  });

  it("pins the stale-entry law", () => {
    expect(hygieneRules()).toContain("A stale memory surface is a defect, not history");
  });
});

describe("revision: onboarding completeness (fix #7)", () => {
  it("onboarding carries the manual pointer, working-style question, and the boundaries", () => {
    const o = renderOnboarding(false);
    expect(o).toContain("mnemos://manual");
    expect(o).toContain("WORKING STYLE");
    expect(o).toContain("wake.project_default");
    expect(o).toContain("you can never delete their notes");
    expect(o).toContain("never edit vault files directly");
  });

  it("onboarding offers the chat/companionship purpose (the normie path)", () => {
    expect(renderOnboarding(false)).toContain("Mostly chat / companionship");
  });
});
