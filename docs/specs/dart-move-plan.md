# The Dart Move — map and plan

**Status: DRAFT — a planning document, not a decision.** Eric set the horizon
("we are going to move to Dart at some point in the near future") and parked
the Bun migration because of it. This document maps what the move IS, what it
costs, and the decisions it needs — so that when the horizon arrives, the
move is executed, not improvised.

---

## 0. The strategic asset that makes this move safe

mnemos is **markdown-native**. The notes are plain markdown with a documented
frontmatter schema; the entire derived state (embeddings, link graph, Q
values, communities) lives in `.mnemos/` and is **rebuildable from the
markdown at any time**. The learned layer has an export path
(`mnemos index export-learned` → NDJSON). The spec's zero-migration law
(§8: "the live vault runs unmodified") is therefore also the **port's
contract**: a Dart engine that reads the same vault — same frontmatter, same
session records, same config shape — is mnemos, whatever language it
speaks. The markdown is the truth; the engine is a view.

This is why the move is *possible without risk to the memory itself*. What
is at risk is only **engine behavior parity** — and that is what the
conformance suite (§3 below) exists to prove.

## 1. Decision 1 (Eric's): motivation → scope option

The plan differs materially depending on WHY Dart. Three candidate scopes:

| Option | What it means | Cost | When it's right |
|---|---|---|---|
| **A. Full rewrite** | `mnemos-dart`: the engine, CLI, and MCP server all Dart; Node retired | Highest — see §4 | One language across the whole product stack matters more than schedule |
| **B. Embedded library** | A **Dart package** (pub) exposing the engine for *aifc to embed* — the app carries its own memory; Node mnemos stays the agent-facing bridge during transition | Medium — the engine core without the CLI/bridge surface | If the real motivation is aifc-native memory (the app is Dart already) |
| **C. Strangler-fig** | Dart components grow inside the Node host (weighting/decisions first), Node keeps the MCP plumbing | Lowest up-front, but split-brain risk forever | Only if neither A nor B is justified |

**The likely tell:** if the Dart horizon is driven by aifc, Option B is the
natural shape — and it reuses most of Option A's core work anyway. The core
engine (markdown, frontmatter, index, weighting, stream) is common to all
three options; the CLI/bridge/MCP shell is what differs.

## 2. The dependency map (Node → Dart), risk-rated

| Node dependency | Role | Dart equivalent | Risk |
|---|---|---|---|
| better-sqlite3 | The derived index, Q store, retrieval log (synchronous, battle-tested) | `sqlite3` (pub, FFI, synchronous) | **Low** — mature package, similar synchronous idiom |
| @huggingface/transformers + onnxruntime-node | The embedder (all-MiniLM-L6-v2, 384 dims) | `onnxruntime` Dart FFI package, or a **local embedding sidecar** during transition | **High** — the riskiest dependency. Mitigation: the index is rebuildable, and embedding-parity is NOT required (rebuild changes vectors, not correctness); ranking-parity is what the conformance suite proves |
| graphology + pagerank + louvain | PPR traversal, centrality, communities (depth signal) | Port PPR by hand (it's already custom math in `explore.ts`); Louvain communities are used only by the depth auto-adjust — defer or simplify | **Medium** — PPR port is bounded; Louvain is the long pole |
| @modelcontextprotocol/sdk | The MCP server (stdio JSON-RPC, 18 tools, 7 resources) | Official MCP Dart SDK (exists, 0.x), or hand-roll — the stdio protocol is simple and stable | **Low-Medium** |
| yaml | Config + frontmatter | `yaml` (pub) | **Low** |
| commander, chalk, @clack/prompts, figlet | CLI UX | `args` + `ansi_terms`/hand-rolled | **Low** |
| vitest | 1,275 tests / 91 files / ~20k lines | `package:test` | **Medium** — the migration is mechanical per test but the volume is the cost |

Code inventory to port: **60 core modules + CLI, ~25k LOC** — plus the test
suite (~20k LOC), which is not overhead: **the tests are the spec's
executable form**. Porting them IS porting the contract.

## 3. The conformance contract — how we know the port works

"Test exactly as we expect" is already instrumented:

1. **The probe fixture is the conformance corpus.** The generated hostile
   vault (vocabulary collisions, stale trap, lineage graph) is
   language-neutral markdown — the Dart engine must produce the same probe
   verdicts on it (hard cases pass, dilution/miss in family).
2. **The bench is the behavioral gate.** Same focus/reach cases, same
   §9 definitions, run against the live vault through the Dart engine. The
   activated world's numbers (10% dilution, miss 0) are the bar.
3. **The golden-query set.** The 1,275 tests encode intended behavior; the
   port carries them translated (mechanical per test, large in volume).
4. **The learned-state roundtrip.** `export-learned` from the Node engine →
   import in Dart → identical Q-values on the same vault.

The conformance rule: **both engines run against the same vault and must
agree on the probe, the bench, and the golden queries before the flip.**

## 4. Phased sequencing

- **Phase 0 — the decision (this document's open questions).** Motivation,
  option A/B/C, timing.
- **Phase 1 — conformance harness.** Dart project skeleton; the fixture
  corpus loads; frontmatter + config parse identically (byte-level on
  schema fields).
- **Phase 2 — the core engine.** Index build, recall (BM25 + vectors +
  PPR), the §5 ladder, stream, adoption, decay — each behind its test.
- **Phase 3 — the MCP server.** Same 18 tools, 7 resources, same payloads —
  the clients cannot tell the difference.
- **Phase 4 — capture + stamping + the gates.** The ask-gate replacement's
  full retirement (§3) can land here, in the Dart world, once stamping has
  run in practice on the Node side.
- **Phase 5 — learned-state migration.** Export from Node, import to Dart,
  roundtrip-verified.
- **Phase 6 — the flip.** Dart mnemos IS mnemos; Node retired; the bridges
  rewritten to launch the Dart binary.

## 5. The risk register

- **Embedder parity (high):** different runtime → different float paths →
  slightly different vectors. Harmless to correctness (rebuild), but the
  bench numbers must be re-baselined after the flip.
- **The learned-state migration (medium):** Q/warmth are accumulated state,
  NOT derived — the export/import path exists but has never carried a full
  vault across an engine. Rehearse on a copy.
- **Louvain (medium):** the depth signal's community detection — port,
  simplify, or freeze the depth at its default.
- **The long tail of CLI UX (low):** prompts, colors, the teaching `--help`
  — easy but voluminous.
- **Split-brain (the killer, Option C only):** two engines writing one
  vault. If Option C, the Dart side must be read-only until the flip.

## 6. Effort, honestly

- Core engine (Phase 1–2): **1–2 weeks of focused agent-work** with the
  conformance suite as the verifier — the spec, the tests, and the fixture
  make this a port, not a redesign.
- MCP + capture + stamping (Phase 3–4): **~1 week**.
- Learned-state migration rehearsed (Phase 5): **days**.
- The unknowns (embedder FFI friction, Louvain) are where estimates die —
  Phase 1 must include a **spike of the embedder in Dart before anything
  else commits** (the Bun spike's lesson: measure the native deps first).

## 7. What does NOT move

- The vault — markdown is the truth; it runs unmodified (§8).
- The activated config — same schema, same meaning.
- The clients' written configs — the MCP contract is language-agnostic;
  only the launch command changes (Phase 6).
- The probe/bench — they run THROUGH whichever engine is under test, by
  design; they are the move's measuring instruments, not its victims.

## 8. The open decisions (Eric's, before Phase 1)

1. **Motivation:** why Dart — one language with aifc? embedded memory in
   the app? team/tooling consolidation? (This picks Option A/B/C.)
2. **Timing:** "near future" — after which aifc milestone?
3. **The Node engine's fate:** retired at the flip, or kept as the
   agent-bridge long-term (Option B's shape)?
4. **The learned state:** migrate (export/import) or start the Dart
   engine's learning from zero on a rebuild?
