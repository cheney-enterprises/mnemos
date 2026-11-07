import { describe, it, expect } from "vitest";
import { replaceCurrentStateSection } from "../../src/core/mapstate.js";

// The ritual's write path: Current State overwrite must be surgical —
// Key Notes, frontmatter, and everything after survive; never append.

const mapBody = [
  "# Roust Project Map",
  "",
  "## Key Notes",
  "- [[note-one]] — first",
  "- [[note-two]] — second",
  "",
  "## Current State (2026-11-01)",
  "- done: old thing",
  "- next: old action",
  "",
  "## Recent Additions",
  "- [[note-three]]",
].join("\n");

describe("replaceCurrentStateSection", () => {
  it("replaces the section in place, keeping the sections around it", () => {
    const r = replaceCurrentStateSection(mapBody, "- done: new thing\n- next: new action", "2026-11-08");
    expect(r.created).toBe(false);
    expect(r.heading).toBe("## Current State (2026-11-01)");
    const out = r.content;
    expect(out).toContain("## Current State (2026-11-08)");
    expect(out).toContain("- done: new thing");
    expect(out).not.toContain("old thing");
    // Everything before and after survives
    expect(out).toContain("## Key Notes");
    expect(out).toContain("- [[note-one]] — first");
    expect(out).toContain("## Recent Additions");
    expect(out).toContain("- [[note-three]]");
    // Order preserved: Key Notes before Current State before Recent Additions
    expect(out.indexOf("## Key Notes")).toBeLessThan(out.indexOf("## Current State (2026-11-08)"));
    expect(out.indexOf("## Current State (2026-11-08)")).toBeLessThan(out.indexOf("## Recent Additions"));
    // No append: exactly one Current State heading
    expect(out.match(/current state/gi)?.length).toBe(1);
  });

  it("matches the heading case-insensitively and with extra words", () => {
    const body = "## Key Notes\n- [[x]]\n\n## Current State — updated daily\n- stale\n\n## Other\n";
    const r = replaceCurrentStateSection(body, "- fresh", "2026-11-08");
    expect(r.created).toBe(false);
    expect(r.content).toContain("- fresh");
    expect(r.content).not.toContain("stale");
    expect(r.content).toContain("## Other");
  });

  it("section at end of file: replaced, trailing newline kept", () => {
    const body = "# Map\n\n## Current State\n- old\n";
    const r = replaceCurrentStateSection(body, "- new", "2026-11-08");
    expect(r.created).toBe(false);
    expect(r.content).toContain("- new");
    expect(r.content).not.toContain("old");
    expect(r.content.endsWith("\n")).toBe(true);
  });

  it("creates the section when the map has none (first ritual run)", () => {
    const body = "# Map\n\n## Key Notes\n- [[x]] — only key notes";
    const r = replaceCurrentStateSection(body, "- done: first", "2026-11-08");
    expect(r.created).toBe(true);
    expect(r.content).toContain("## Current State (2026-11-08)");
    expect(r.content).toContain("- done: first");
    expect(r.content).toContain("## Key Notes");
  });

  it("never merges into a following section: replaced block is exactly bounded", () => {
    const body = "# M\n\n## Current State\n- old A\n- old B\n\n## Next Section\n- keep me intact";
    const r = replaceCurrentStateSection(body, "- new", "2026-11-08");
    expect(r.content).not.toContain("old A");
    expect(r.content).not.toContain("old B");
    expect(r.content).toContain("## Next Section\n- keep me intact");
    // The new content must not bleed into Next Section
    const csIdx = r.content.indexOf("## Current State (2026-11-08)");
    const nextIdx = r.content.indexOf("## Next Section");
    expect(nextIdx).toBeGreaterThan(csIdx);
  });

  it("multi-line new content lands verbatim under the stamped heading", () => {
    const body = "## Current State\n- old\n\n## Tail\n";
    const content = "- done: a\n- next: b\n- blocked: c";
    const r = replaceCurrentStateSection(body, content, "2026-11-08");
    expect(r.content).toContain("## Current State (2026-11-08)\n- done: a\n- next: b\n- blocked: c");
  });
});

describe("replaceCurrentStateSection — separator hygiene", () => {
  it("keeps a blank line between the replaced section and the next heading", () => {
    const body = "## Current State\n- old\n\n## Next\n- keep";
    const r = replaceCurrentStateSection(body, "- new", "2026-11-08");
    expect(r.content).toContain("- new\n\n## Next");
    expect(r.content).not.toContain("- new\n## Next");
  });

  it("no trailing blank at end of file", () => {
    const body = "## Current State\n- old\n";
    const r = replaceCurrentStateSection(body, "- new", "2026-11-08");
    expect(r.content.endsWith("- new\n")).toBe(true);
    expect(r.content.endsWith("- new\n\n")).toBe(false);
  });
});
