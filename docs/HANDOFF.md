# Session Handoff — 2026-11-12

Agent: Ori intern (z-ai/glm-5.3-flash), project mnemos. New sessions: read
`docs/project-briefing.md` first; then note that **`docs/specs/session-scope-spec.md`
is the fixed target** Eric blessed tonight — this handoff is the delta since
the 2026-11-11 handoff and covers one very full day.

## Daytime: the queue emptied (six commits, 1207/1207)

1. **Map handoff debt closed first** — the missing 2026-11-11 session-end
   line (bypass defense + briefing) written into the mnemos map via
   `runUpdateFile`, verified.
2. **Forget machinery / schema agreement (`52c31c0`)** — `released` joined
   the status enum in scaffold AND live template (they move together;
   `resolveTemplatePath` validates against the vault-local copy);
   supersede replacements born schema-valid (`created` set, `project`
   inherited, caller `-p` wins). First supersede tests ever.
3. **Honest inboxCount (`892e04b`)** — `.md` only, agreeing with wake; the
   stale-pinning sandbox tests corrected, not weakened.
4. **Intent-first write-path descriptions (`487faee`)** — REMEMBER /
   UPDATE the standing state / FORGET safely / WHICH PROJECT did the user
   mean; closing item 1 of the wake arc. Contract text untouched.
5. **Map-write hardening trio (`998bead`)** — shape check refuses
   whole-note bodies (frontmatter delimiters / H1 / `##`) and empty ones,
   refusals audited as `map_write_refused` and verified live (map
   byte-untouched; first "map changed" report was my own unawaited-Promise
   check bug); oversized bodies write with `argument_shape` in the audit;
   promote refuses map-routed notes unless type=moc. **Root cause en
   route: `moc` was missing from classify's VALID_TYPES** — explicit
   `type: moc` was discarded and reclassified insight. Fixed; map-title
   convention deduped into `mapstate.titleLooksLikeMap`.
6. **All-vault rules audit (Eric's request: fix the other projects too)** —
   now 0 schema violations, 0 dangling links vault-wide: igpu description
   compressed under 200; two old supersede stubs given `created` +
   completed descriptions (one stub's unclosed `[[wiki-link` WAS the lone
   dangling link); 17 notes had `_bypass_warning` in body but not
   frontmatter, exposing the add-path defect — `runAdd` built frontmatter
   fresh and dropped the template's warning. **Fixed (`07041ed`)**: the
   warning travels into every new note from birth (test pins it); live
   vault repaired. Grep lesson: notes ABOUT the defense quote the warning
   in their bodies — the frontmatter check is authoritative.
7. **Briefing + handoff updated and committed (`76063ec` + later).**

## Evening: THE PIVOT (the important part)

Eric asked how the original enforced project boundaries → research showed
it didn't (write-time labels only; reads unscoped until `6f3e605`, and the
relevance engine worked by scoring, not fences). Three dialogue rounds with
Eric converged on the model and he blessed it:

- **`docs/specs/session-scope-spec.md` (committed) is the fixed target.**
  Scope ladder: session → lineage (`continues:`/`branched_from:` edges) →
  project as firm-but-permeable partition → vault universal. Scope-distance
  weighting post-fusion (never a filter); the forget matcher's rare-token
  anchoring becomes the permeability rule ("that elegant method we used
  there" must cross); tiered answers label cross-scope reach; session
  records become retrieval seeds; two-tier capture (invisible auto stream
  vs visible curated adds; forget laws untouched); scope-aware learning;
  coverDaily-style lineage decay; zero migration.
- **Process ruling:** spec-first, flagged behind
  `retrieval.session_scope.enabled`, current contracts IN FORCE until the
  benchmark gate (spec §9: dilution ≤ 5%, miss = 0) passes. Settle design
  arguments by citing spec lines, not chat. Eric named the churn lesson
  himself: ideas outpaced measurement; the spec is the antidote.
- Vault-side: pivot record note added + auto-promoted
  (`the-2026-11-12-evening-pivot-from-project-fences-to-the-scope-ladder-…`);
  map Current State, daily, and goals all rewritten (evening arc + the
  spec-driven plan; the ask-once-becomes-config ladder from the interim
  discussion is superseded by the pivot — do not build it).

## Where things stand
Vault fully rule-compliant. Package 0.9.0+Unreleased, seven change sets
today, waiting on one npm token. MCP servers need a restart to serve any of
today's dist.

## Open items (next session — building begins)
1. **Phase 1 per the spec: session binding + lineage edges** behind
   `retrieval.session_scope.enabled` — harness intake (`session=<id>`,
   `parent=<id>`), constructive binding with no ask, `ops/sessions` stream
   as graph nodes. Read spec §3–§4 first; cite spec lines in the work.
2. **Phase 2: scope-distance weighting + anchor waiver + tiered surfaces**
   (spec §5–§6), then build the benchmark cases from live vault data
   (spec §8–§9; the "ai memory" phantom-blend is the canonical dilution
   case). Numbers decide the flip — not enthusiasm.
3. npm publish when Eric's auth ticket resolves; restart MCP server
   processes for the new dist.
4. If a new defect appears: record it in the briefing's Known Defects
   section with the date and live evidence.
