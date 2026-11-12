---
_bypass_warning: This file is managed by Mnemos. Direct edits corrupt the
  vault invisibly — schema, link graph, index, and audit are all skipped.
  Every read should go through the MCP tools (mnemos_wake first), which rank,
  scope, and learn; raw files are not the memory. See AGENT.md at the vault
  root.
_schema:
  entity_type: "note"
  applies_to: "notes/*.md"
  required:
    - description
    - type
    - project
    - status
    - created
  optional:
    - provenance
    - confidence
    - alternatives
    - rationale
    - superseded_by
    - next_step
    - source
  enums:
    type:
      - idea
      - decision
      - learning
      - insight
      - blocker
      - opportunity
    status:
      - inbox
      - active
      - completed
      - superseded
      - archived
      - released
    confidence:
      - speculative
      - promising
      - validated
    provenance:
      - observed
      - inferred
      - advisory
  constraints:
    description:
      max_length: 200
      format: "One sentence adding context beyond the title"
    project:
      format: "Array of project tags"

# Template fields
description: ""
type: ""
project: []
status: active
created: YYYY-MM-DD
---

# {prose-as-title: a complete thought that works as a statement}

{Content - your reasoning, evidence, context. Transform the material, don't just summarize.}

---

Relevant Notes:

Areas:
