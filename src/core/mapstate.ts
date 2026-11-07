/**
 * Map Current State section replacement — the ritual's write path.
 *
 * The doctrine tells every agent to end a session by overwriting its project
 * map's Current State ("what is done, the next action, what is blocked").
 * Before this module the instruction was unperformable through the tool
 * surface: mnemos_update only wrote self/ and ops/ files, so the agent either
 * skipped the step or violated the direct-access ban to do it.
 *
 * Replace-one-section semantics, not whole-file rewrite: a map's Key Notes
 * index and frontmatter must survive the ritual untouched, and append is
 * exactly the failure mode ("maps get append-disease") the doctrine bans.
 * Pure functions — the caller owns I/O.
 */

export interface CurrentStateResult {
  /** The full new file content, ready to write. */
  content: string;
  /** Set when the map had no Current State section and one was appended. */
  created: boolean;
  /** The heading the section was found under (matched case-insensitively). */
  heading: string;
}

/**
 * Replace (or create) the `## Current State` section in a map body.
 *
 * Section = the matched `## ... current state ...` heading line through the
 * next `## ` heading or end of body. Frontmatter is never touched — callers
 * split it off before this runs.
 */
export function replaceCurrentStateSection(
  body: string,
  newSection: string,
  today: string,
): CurrentStateResult {
  const lines = body.split("\n");
  const headingRe = /^##\s+.*current state.*$/i;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }

  const stamped = `## Current State (${today})\n${newSection.trimEnd()}\n`;

  if (start === -1) {
    // No section yet: append at the end, after a blank line separator.
    const content = body.trimEnd() + "\n\n" + stamped;
    return {
      content,
      created: true,
      heading: "## Current State",
    };
  }

  // Find the section end: the next "## " heading, or end of file.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const newLines = stamped.trimEnd().split("\n");
  // Keep one blank line between this section and whatever follows — the old
  // section's trailing blank belonged to the replaced slice, so it must be
  // re-added or the next heading glues onto the last content line.
  const needsBlankAfter = end < lines.length && newLines[newLines.length - 1].trim() !== "";
  const out = [
    ...lines.slice(0, start),
    ...newLines,
    ...(needsBlankAfter ? [""] : []),
    ...lines.slice(end),
  ];
  const joined = out.join("\n");
  return {
    content: joined.endsWith("\n") ? joined : joined + "\n",
    created: false,
    heading: lines[start].trim(),
  };
}
