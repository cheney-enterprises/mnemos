/**
 * Wake resolution tests — the resolve-first gate (Eric's feedback 2026-11-09,
 * items 2-4): a session should scope silently whenever something names the
 * project (explicit tag, config default, repo path, confident hint), and the
 * project question should be the LAST resort — carrying suggestions inside
 * itself when a hint was ambiguous, so the user's next utterance is the only
 * round trip.
 *
 * The pure resolver (resolveProjectByPath) is tested directly; the flows run
 * through runWake against a real three-project vault. startDir is always the
 * vault itself (the production MCP shape); external repos enter via the
 * explicit path= argument.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runPromote } from "../../src/cli/promote.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { runWake, resolveProjectByPath, expandTilde } from "../../src/cli/wake.js";
import { loadConfig } from "../../src/core/config.js";
import { homedir } from "node:os";

let vaultDir: string;
let otherDir: string;

beforeAll(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-wake-resolve-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-wake-other-"));
  await runInit({ targetDir: vaultDir });
  // Three projects with distinctive footprints. The suggester reads slugs +
  // descriptions (+ daily lines) from the index, so the distinguishing words
  // must live where sync will see them.
  const projects: Array<[string, string]> = [
    ["alpha", "alpha calendar scheduling app for dates and events"],
    ["beta", "beta countdown timers and reminders widget"],
    ["gamma", "gamma garden planner and soil tracking"],
  ];
  for (const [tag, desc] of projects) {
    await runAdd({
      startDir: vaultDir,
      // Multi-word prose title — a hyphenated slug is ONE word and add
      // silently fails (the doctrine's documented gotcha; caught live here).
      title: `${tag} project map`,
      type: "moc",
      description: `${tag} project map: ${desc}`,
      content: `Map for the ${desc} project.`,
      project: [tag],
    });
    // The roster (and the suggester's footprints) read the promoted index —
    // inbox notes are invisible to both until promote moves them to notes/.
    await runPromote({ startDir: vaultDir, all: true });
  }
  await runIndexBuild(vaultDir);
}, 120000);

afterAll(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
});

describe("resolveProjectByPath (pure)", () => {
  it("matches an exact registered path", () => {
    expect(resolveProjectByPath("/repo/mnemos", false, { "/repo/mnemos": "mnemos" })).toBe("mnemos");
  });

  it("matches a nested directory under a registered path", () => {
    expect(resolveProjectByPath("/repo/mnemos/src/cli", true, { "/repo/mnemos": "mnemos" })).toBe("mnemos");
  });

  it("does not treat a sibling prefix as nested", () => {
    expect(resolveProjectByPath("/repo/mnemos-other", true, { "/repo/mnemos": "mnemos" })).toBeNull();
  });

  it("longest registered path wins on overlap", () => {
    expect(
      resolveProjectByPath("/repo/mnemos/sub", true, { "/repo": "wrong", "/repo/mnemos": "mnemos" }),
    ).toBe("mnemos");
  });

  it("returns null for unregistered directories", () => {
    expect(resolveProjectByPath("/somewhere/else", true, { "/repo/mnemos": "mnemos" })).toBeNull();
  });

  it("expands ~ to the home directory", () => {
    expect(expandTilde("~/dev/mnemos")).toBe(path.join(homedir(), "dev/mnemos"));
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("/plain/path")).toBe("/plain/path");
  });
});

describe("explicit project beats everything", () => {
  it("project=<tag> scopes with no resolution block", async () => {
    const r = await runWake(vaultDir, 96, "alpha");
    expect(r.projectWake?.project).toBe("alpha");
    expect(r.project_choice_required).toBeUndefined();
  });

  it("unknown explicit project keeps the repair warning (unchanged contract)", async () => {
    const r = await runWake(vaultDir, 96, "no-such-project");
    expect(r.projectWake?.warning).toContain("no project");
    expect(r.project_choice_required).toBeUndefined();
    // The create path is machine-actionable: the agent may create the scope.
    expect(r.projectWake?.new_project_ready).toBe(true);
  });
});

describe("new-project flow", () => {
  it("a named-but-absent project invites creation via a machine-readable flag", async () => {
    const r = await runWake(vaultDir, 96, "fresh-scope");
    expect(r.projectWake?.project).toBe("fresh-scope");
    expect(r.projectWake?.new_project_ready).toBe(true);
    expect(r.projectWake?.warning).toContain("fresh-scope");
  });
});

describe("bare wake without any resolution signal asks", () => {
  it("no default, no path match, no hint -> project_choice_required with the roster", async () => {
    const r = await runWake(vaultDir, 96);
    expect(r.project_choice_required).toBeDefined();
    expect(r.project_choice_required?.projects.length).toBe(3);
    expect(r.projectWake).toBeUndefined();
    expect(r.resolution).toBeUndefined();
  });
});

describe("config default resolves silently", () => {
  it("project_default scopes the bare wake and records the resolution", async () => {
    const configPath = path.join(vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    try {
      await fs.writeFile(configPath, original + "\nwake:\n  project_default: alpha\n");
      const r = await runWake(vaultDir, 96);
      expect(r.projectWake?.project).toBe("alpha");
      expect(r.resolution?.method).toBe("default");
      expect(r.project_choice_required).toBeUndefined();
    } finally {
      await fs.writeFile(configPath, original);
    }
  });
});

describe("the repo->project bridge (wake.project_paths)", () => {
  it("the vault-bound session directory scopes silently when registered", async () => {
    const configPath = path.join(vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    try {
      await fs.writeFile(configPath, original + `\nwake:\n  project_paths:\n    "${vaultDir}": alpha\n`);
      const r = await runWake(vaultDir, 96);
      expect(r.projectWake?.project).toBe("alpha");
      expect(r.resolution?.method).toBe("path");
      expect(r.resolution?.note).toContain(vaultDir);
    } finally {
      await fs.writeFile(configPath, original);
    }
  });

  it("an explicit path= argument resolves even from an unrelated cwd", async () => {
    const configPath = path.join(vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    try {
      await fs.writeFile(configPath, original + `\nwake:\n  project_paths:\n    "${otherDir}": beta\n`);
      // pathArg points at otherDir (registered to beta) while startDir is
      // the vault itself (unregistered) — the explicit argument wins.
      const r = await runWake(vaultDir, 96, undefined, otherDir);
      expect(r.projectWake?.project).toBe("beta");
      expect(r.resolution?.method).toBe("path");
    } finally {
      await fs.writeFile(configPath, original);
    }
  });

  it("a path that registers to nothing falls through to the question", async () => {
    const r = await runWake(vaultDir, 96, undefined, otherDir);
    expect(r.project_choice_required).toBeDefined();
  });
});

describe("hints ask instead of resolving (Eric's call: the question beats fuzzy logic)", () => {
  it("the question carries every roster project with its note count — the user sees the options", async () => {
    // The suggestion engine manufactured phantom ties in the live vault
    // ("ai memory" ranked all three projects 1.00 on a token every footprint
    // contained); the hint parameter is retired. The question is the one
    // path for unknown scopes, and it must name the options inline — the
    // user never faces a bare "which project?".
    const r = await runWake(vaultDir, 96);
    const q = r.project_choice_required;
    expect(q).toBeDefined();
    for (const p of ["alpha", "beta", "gamma"]) {
      expect(q?.question).toContain(p);
    }
    expect(q?.question).toContain("notes");
    expect(q?.question).toContain("NEW project");
  });
});

describe("config parsing keeps the boundary honest", () => {
  it("project_paths entries that are not string->string are dropped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemos-wake-cfg-"));
    try {
      await runInit({ targetDir: dir });
      const configPath = path.join(dir, "mnemos.config.yaml");
      const original = await fs.readFile(configPath, "utf8");
      await fs.writeFile(
        configPath,
        original + '\nwake:\n  project_paths:\n    "/repo": 42\n    "/ok": alpha\n',
      );
      const config = await loadConfig(configPath);
      expect(config.wake.project_paths).toEqual({ "/ok": "alpha" });
      await fs.writeFile(configPath, original);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ask=true forces the question", () => {
  it("skips every silent-resolution path, including an explicit default", async () => {
    const configPath = path.join(vaultDir, "mnemos.config.yaml");
    const original = await fs.readFile(configPath, "utf8");
    try {
      await fs.writeFile(configPath, original + "\nwake:\n  project_default: alpha\n");
      const r = await runWake(vaultDir, 96, undefined, undefined, true);
      expect(r.project_choice_required).toBeDefined();
      expect(r.project_choice_required?.reason).toBe("wake.project_required");
      expect(r.projectWake).toBeUndefined();
      expect(r.resolution).toBeUndefined();
    } finally {
      await fs.writeFile(configPath, original);
    }
  });

  it("explicit project still wins over ask (the user named it)", async () => {
    const r = await runWake(vaultDir, 96, "beta", undefined, true);
    expect(r.projectWake?.project).toBe("beta");
    expect(r.project_choice_required).toBeUndefined();
  });
});

describe("directory-name suggestions (the Alarm App case)", () => {
  it("an unregistered dir asks plainly — no suggestion machinery in the question", async () => {
    // Dir-name folding was retired with the hint path: the question is the
    // user's decision point, and the roster inside it is the only guidance.
    // (Vague references are mnemos_suggest_scope's job, on the user's words.)
    const someDir = path.join(os.tmpdir(), "garden-planner-workspace");
    await fs.mkdir(someDir, { recursive: true });
    try {
      process.env.MNEMOS_VAULT = vaultDir;
      const r = await runWake(someDir, 96);
      expect(r.project_choice_required).toBeDefined();
      expect(r.project_choice_required?.suggestions).toBeUndefined();
      expect(r.project_choice_required?.race_note).toBeUndefined();
      expect(r.projectWake).toBeUndefined();
    } finally {
      delete process.env.MNEMOS_VAULT;
      await fs.rm(someDir, { recursive: true, force: true });
    }
  });
});
