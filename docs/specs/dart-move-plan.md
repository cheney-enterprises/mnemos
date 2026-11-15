# The Dart Move — map and plan

**Status: DECIDED (2026-11-15) — all five rulings recorded (§8). The port
trigger is MET by Eric's ruling: "we are at the shape I like. I wanted to
improve and finish the original. It appears we have done that — there is no
more work to do." Phase 1 (the embedder matrix spike + conformance
harness) is the next build.**

---

## 0. The sharpened goal (Eric, 2026-11-15)

> "The entire reason would be to provide a memory backend to the Flutter
> app. But with that comes considerations for all of the different
> platforms, **including the embedding agent — what works on what
> platform**. The goal is to make it a seamless integration into the app,
> with embedding agents (and whatever else we find) changing depending upon
> the platform build. **macOS and iOS have their own built-in embedder**
> that needs to be tested to ensure that it meets standards — if it does
> not, we need to determine what does and what will work on those
> platforms. **Android has its built-in embedder. Desktop can use what we
> use now. Web we will have to determine.**"

This is **Option B with a platform matrix**: an embedded memory backend for
aifc, where the ENGINE is pure Dart (portable) and the EMBEDDING AGENT is a
platform interface with per-platform implementations. That is the Flutter
way (platform channels / FFI plugins), and it maps one-to-one onto mnemos's
existing architecture — the embedder is ALREADY a config-selected component
(`embedding_model`), the vectors are derived state, and the markdown is the
truth.

**The load-bearing architectural fact:** because the index is rebuildable,
**per-platform embeddings don't need to be cross-platform compatible.** The
markdown syncs; each device rebuilds its own index with ITS embedder. (If
aifc's memory syncs across devices, this is the whole design — see the
decisions.)

## 0.1 The platform-embedder matrix

| Platform | Embedding agent | Status |
|---|---|---|
| **macOS / iOS** | Apple's built-in embedder (`NLContextualEmbedding`, iOS 17+/macOS 14+) — on-device, private, no model download | **UNTESTED — the first spike.** Question: does it meet retrieval standards? (Contextual word embeddings, not sentence embeddings — pooling strategy matters. Language coverage varies.) If it fails: determine what does (TFLite MiniLM on-device, or the desktop path) |
| **Android** | Android's built-in embedder (MediaPipe TextEmbedder / TFLite route) | **UNTESTED — spike after Apple.** Same bar |
| **Desktop** (macOS/Windows/Linux Flutter) | **What we use now** — all-MiniLM-L6-v2 via onnxruntime | Known quantity (the whole bench history) |
| **Web** | To be determined | Candidates: transformers.js (WASM/WebGPU), server-side embedding API, or no-local-memory on web |

**The standards bar is already instrumented.** "Meets standards" = the
existing quality instruments, run per embedder against the same fixture:
the **probe** (hard cases pass, dilution in family) and the **bench**
(retrieval quality on real content). An embedder is platform-eligible only
when the probe passes with it. This is the same falsification discipline as
the §9 gate — applied to the embedding layer.

## 0.2 What this changes in the architecture

- The engine core (markdown, frontmatter, index, §5 ladder, stream,
  adoption, decay, stamping) is **pure Dart** — no platform channels, fully
  portable, testable on the host.
- The embedder becomes an **interface** (`EmbeddingAgent`) with per-platform
  implementations: NLContextualEmbedding (Darwin), MediaPipe/TFLite
  (Android), onnxruntime (desktop), TBD (web).
- The MCP server story changes shape: inside the app, memory is a **library
  call**, not a server. The MCP surface remains for AGENT access to the
  same vault (the agent bridge), but the app itself reads its memory
  in-process.
- Vector storage gains a **model tag** (embedder id + dims per index) so a
  rebuilt index can never silently mix vectors from different agents.

## 0.3 The strategic asset that makes this move safe

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

## 1. The scope option, resolved by the sharpened goal

The sharpened goal **is Option B**: an embedded Dart package for aifc. What
remains open is the fate of the Node engine and the agent bridge (Decision
3 below) — the agent-facing surface (CLI, MCP, bridges) could stay Node
indefinitely, retire at the flip, or be ported last.

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

**And the new axis: embedder conformance (§0.1).** Each platform's
embedding agent runs the probe against the fixture corpus; it is
platform-eligible only when the hard cases pass and the dilution/miss
numbers hold in family with the desktop baseline. The embedder is a
variable under test — the corpus, the cases, and the bar are constant.

The conformance rule: **both engines — and every embedder — run against the
same vault and must agree on the probe, the bench, and the golden queries
before eligibility.**

## 4. Phased sequencing

- **Phase 0 — the decisions (§8 of this document).** Sync model, standards
  definition, timing, the Node engine's fate.
- **Phase 1 — the embedder matrix spike + conformance harness.** FIRST (the
  Bun lesson: measure the platform deps before anything commits):
  NLContextualEmbedding on macOS/iOS, MediaPipe/TFLite on Android, onnx
  baseline on desktop — each against the probe fixture. Plus the Dart
  skeleton: the fixture corpus loads; frontmatter + config parse
  identically.
- **Phase 2 — the core engine (pure Dart).** Index build, recall (BM25 +
  vectors + PPR), the §5 ladder, stream, adoption, decay — each behind its
  test.
- **Phase 3 — the embedding agent interface.** The `EmbeddingAgent`
  abstraction with per-platform implementations, the model tag in vector
  storage, and the per-embedder conformance runs.
- **Phase 4 — in-app integration.** aifc embeds the package; memory is a
  library call in-process.
- **Phase 5 — the agent bridge.** The MCP surface over the Dart engine (the
  agents reach the same vault), or the Node bridge continues during
  transition (Decision 3).
- **Phase 6 — learned-state + the flip.** Export/import rehearsed on a
  copy; the Node engine's role resolved per Decision 3.

## 5. The risk register

- **NLContextualEmbedding quality (the first unknown):** Apple's contextual
  embeddings are word-level, need pooling for sentence similarity, and
  their language coverage varies. The spike measures retrieval quality, not
  just "does it run." If it fails the bar: fall back to TFLite MiniLM
  on-device (the desktop agent, on Apple silicon).
- **Cross-platform vector mismatch (architectural, resolved by design):**
  different embedders produce incompatible vectors — harmless because the
  index is per-device and rebuildable, PROVIDED the sync model syncs
  markdown only (Decision: confirm).
- **The learned-state migration (medium):** Q/warmth are accumulated state,
  NOT derived — the export/import path exists but has never carried a full
  vault across an engine. Rehearse on a copy. (In-app, per-device Q is a
  NEW question: whose learning is it when the app is multi-device?)
- **Louvain (medium):** the depth signal's community detection — port,
  simplify, or freeze the depth at its default.
- **On-device latency/size (medium, mobile):** MiniLM on a phone — model
  size (~25MB quantized) and embed latency must fit aifc's UX budget.
  Measure in the Phase 1 spike.
- **The long tail of CLI UX (low):** prompts, colors, the teaching `--help`
  — easy but voluminous (and possibly not needed in-app).

## 6. Effort, honestly

- Core engine (Phase 2): **1–2 weeks of focused agent-work** with the
  conformance suite as the verifier — the spec, the tests, and the fixture
  make this a port, not a redesign.
- Embedder matrix (Phase 1+3): **the schedule risk lives here** — Apple's
  and Android's agents are unknowns; the spike bounds them.
- In-app integration + agent bridge (Phase 4–5): **~1 week**.
- Learned-state migration rehearsed (Phase 6): **days**.
- The unknowns are where estimates die — Phase 1 is the spike phase by
  design (the Bun spike's lesson, applied where it matters most).

## 7. What does NOT move

- The vault — markdown is the truth; it runs unmodified (§8), per device.
- The activated config — same schema, same meaning (the embedder id joins
  it as a per-platform value).
- The probe/bench — they run THROUGH whichever engine and embedder is under
  test, by design; they are the move's measuring instruments, not its
  victims.
- The agent-facing MCP contract — whatever serves it, the tools and
  payloads stay.

## 8. The decisions — ALL RULED (Eric, 2026-11-15/16)

1. **The sync model — RULED (two-tier).** Synced tier: the markdown notes
   sync via aifc's planned **e2e cloud sync**; each device rebuilds its own
   index with its own embedder. Free tier: **device-only by default** (a
   user's memory is never silently uploaded). Design rules that follow:
   **notes are the sync unit; derived state (embeddings, Q, stream) never
   syncs — it is per-device**; first-sync merge is slug-level (captures are
   add-oriented; edit conflicts belong to aifc's e2e layer); the engine must
   tolerate the note set changing underneath it mid-session (the index sync
   already does).
2. **The standards bar — RULED (parity-or-better, proven).** "All of the
   embedders need to perform as well (or better) on all of our current
   tests." The Apple embedder starts at *unknown, presumed ineligible* —
   there are no benchmarks; we are the benchmark. The Apple trade-off is
   explicit and Eric's to judge at spike time: the built-in (zero bundle
   cost, unproven quality) vs bundling our own model (proven quality, ~25MB
   bundle cost) — **bundling is the acknowledged last resort**, accepted
   only if the built-in cannot meet the bar and nothing else on-device
   works. The spike prices both sides.
3. **The Node engine's fate — RULED (two independent packages).** The Dart
   and Node packages are **completely different packages**; Dart either
   works (proven by conformance) or it doesn't; and if it works, which
   package someone chooses is simply *their choice*. No coordination
   between engines, no shared-vault rules, and **parity is not guaranteed
   after the port** — each package evolves on its own merits. The Node
   package is not auto-retired; it remains the agent-side choice.
4. **The learned state — RULED (build + rehearse the migration; use only
   on an actual switch).** The export/import roundtrip is part of the port's
   conformance proof. aifc users start **fresh** with **per-device**
   learning (derived state never syncs; a fresh install personalizes cold
   and warms over its first sessions).
5. **The port trigger — RULED (MET).** Eric's mental model: "get the Node
   one into a shape we liked, then port to Dart, and maintain that." The
   shape milestone is **declared met** — the original was the goal
   (improve and finish it), and it is finished. The named debts (the
   O(vault) waiver scan, the lock window, pair-exclusivity, §8.1 per-band
   Q, edge decay) are **accepted as part of the shape** and carry into the
   Dart package as its opening backlog — they do not block the port.
