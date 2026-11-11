# STOP — this is an AI memory vault. Do not browse it.

If you can read this file, you are inside an agent's persistent memory vault
(Mnemos). Everything here is managed by software — schema validation, a link
graph, an embedding index, an audit trail — and the files on disk are NOT the
memory. Browsing them gives you a wrong view and touching them corrupts it:

- **A direct READ misleads.** Retrieval here is ranked, scoped, and learned;
  raw files are not that view. Note titles and folder listings will point you
  at the wrong things and you will trust a corrupted picture.
- **A direct WRITE corrupts.** Editing, moving, or renaming any file here
  skips schema, links, index, and audit. The damage is invisible until it
  isn't.

## The only correct door

Connect the Mnemos MCP server (or use the `mnemos` CLI), then start every
session with wake:

- **MCP:** call `mnemos_wake` (bare) → it returns your briefing and, if the
  project is not yet known, a question to relay to the user → then call
  `mnemos_wake` with `project=<tag>`.
- **CLI:** `mnemos wake` (from inside the vault, or with `MNEMOS_VAULT=<path>`).

Wake returns the identity, the project roster, the access rules, and — once
the project is known — that project's full briefing. Retrieval tools refuse
until a wake has happened; that is the design, not a malfunction.

- Operating manual (read by section): `ops/manual.md`
- Policy and capability model: `mnemos.config.yaml` — the USER's file; never
  edit it.
- The user approves removals and identity rewrites from their own terminal.
  You can never delete a note yourself.

This vault belongs to its human owner. Direct file access is authorized only
for the owner — and even then, writes go through the tools, because backups,
audit, and index sync are free there.
