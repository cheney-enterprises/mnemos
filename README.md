# Mnemos

**Open-source persistent memory infrastructure for AI agents.**

Mnemos implements human cognition as mathematical models on a knowledge graph. Activation decay from ACT-R. Spreading activation along wiki-link edges. Hebbian co-occurrence from retrieval patterns. Reinforcement learning on retrieval itself. Recursive graph traversal with sub-question decomposition. The system learns what matters, forgets what doesn't, and optimizes its own retrieval pipeline.

Persistent memory across sessions, clients, and machines. Zero-infrastructure retrieval that [matches and in several cases strongly outperforms incumbents on benchmarks](#benchmarks) — and you own every byte of your data. Markdown on disk. Wiki-links as graph edges. Git as version control. No database lock-in, no cloud dependency, no vendor capture.

**v0.8.1** · [npm](https://www.npmjs.com/package/@cheney-enterprises/mnemos) · Apache-2.0 ·
Fork of [aayoawoyemi/Ori-Mnemos](https://github.com/aayoawoyemi/Ori-Mnemos) by Aayo Awoyemi —
rebranded and extended; the original design and benchmark results are his.

---

## Use

Mnemos is three surfaces over one index. The markdown is the truth; the index is
derived. The learned half — Q-values, LinUCB arms, retrieval history — is not,
so export it before deleting anything (see [When to rebuild](#when-to-rebuild)).

**CLI**

```bash
npx mnemos init          # scaffold a vault
npx mnemos index build   # derive the index
npx mnemos explore "…"   # navigated retrieval
npx mnemos sql "…"       # read-only SQL over the index
```

**MCP server** — `mnemos serve`, registered in a client config. This is how an
agent uses it.

**Library** — `recall` is the same wired entry the CLI and the MCP
`mnemos_recall` tool both go through, so the programmatic path and the agent
path cannot drift.

```ts
import { recall } from "mnemos";

const res = await recall("./vault", "what did we decide about caching?", { limit: 5 });
for (const hit of res.data.results) console.log(hit.title, hit.score);
```

`searchComposite` is also exported for callers that have already assembled
vectors, graph metrics and a config; `recall` does that assembly for you.

The export surface is deliberately small and is a semver contract; the rest of
`src/core` is internal. Versions before 0.8.0 shipped no `main` and no
`exports`, so a bare import threw and the library path did not exist — but the
CLI and MCP paths always worked, and existing users were unaffected.

`mnemos/cli` resolves to the CLI entry, for callers that need to locate
the binary and spawn it rather than link against it. `require.resolve` on it
is the intended use; importing it runs the CLI.

## Benchmarks

### ForgetEval — Can It Forget On Command?

[deeplethe/lethe](https://github.com/deeplethe/lethe), `bench/forgeteval/`,
MIT. **No API key, no network, no LLM judge.** The scorer is a ~20-line
deterministic substring check in `GeneratedCase.run()`: it calls
`recall_texts(query, k=10)` itself, joins the top 10, and tests
`must_contain` / `must_not_contain`. Generation is `random.Random(42)` over
templates. The optional LLM hook is `llm=None` by default and was not used.

| family | Mnemos | what it requires |
|---|:---:|---|
| supersession | **200 / 200** | replace a fact, old value must not surface |
| decay | **200 / 200** | `release(query)` — soft-evict on demand |
| amnesia | **198 / 200** | evict one subject, keep the bystanders |
| purge | **182 / 200** | hard-delete, verbatim secret must be gone |
| drift | **198 / 200** | two supersessions in sequence, only the last survives |
| **overall** | **978 / 1000 (97.8%)** | 1,000 generated cases, seed 42 |

Not fitted to the suite: unseen seeds give **97.2%** (seed 7) and **98.0%**
(seed 123). The fixes were structural bugs in the matcher, not case-specific
patches.

**Quote these against a 35% floor, not against zero.** The oracle is
`must_contain` AND `must_not_contain` over the top 10, and when
`must_contain` is empty — every `decay` case and 150 of 200 `purge` cases,
350 of 1,000 — a system that returns *nothing* passes vacuously. A null
adapter that accepts writes and never returns anything scores **350/1000 =
35%, including 100% on the whole decay family**. On the 650 cases that
actually discriminate, Mnemos is **628/650 = 96.6%** and its purge drops from
91% to **64%**, which is its real weak spot. The published LangMem 99.5 /
Lethe 99.3 / Mem0 88.8 are full-suite and carry the same floor.
See [`docs/falsification/forgeteval-validity.md`](./docs/falsification/forgeteval-validity.md).

| System | template | adversarial |
|---|:---:|:---:|
| LangMem | 99.5 | — |
| Lethe v1 | 99.3 | 63.4 |
| **Mnemos** | **97.8** | **65.7** |
| Mem0 | 88.8 | 68.3 |
| MemPalace | 0 | — |

**Mnemos scored 0/1000 on this benchmark earlier the same day.** Not a low
score — a structural zero. ForgetEval's adapter protocol has three optional
operations, `supersede`, `release` and `purge`, and Mnemos had none of them:
zero source hits across `src/`. Every case was N/A. The ACT-R decay and
Ebbinghaus curves Mnemos already had are ranking-time priors, and no benchmark
measures those; ForgetEval's "decay" family means an explicit `release(query)`
call. `src/core/forget.ts` is 305 lines and closed the whole gap in a day,
which is the most informative number on this page.

**That table is not a ranking, and "third" would be a bad way to read it.**

ForgetEval's code lives inside `deeplethe/lethe` — the benchmark and its
top-scoring system are the same org, in a repo with 14 stars. The template
column has four entries, one of which (MemPalace) scores 0 by construction
because it exposes no deletion primitive at all. Two of the rest saturate.
On the adversarial layer Mnemos is 5th of 14 configurations and lands inside
the 63–68% band the paper's own McNemar test calls noise (χ²=0.125,
p=0.724); the paper's words are "the bench reads the trade-off, not a
winner." The one comparison that is statistically real is Mnemos vs Lethe on
template, z=2.81, p=0.005 — Lethe is genuinely ahead.

**Who is missing matters more than who placed.** Supermemory (30.6k stars,
$2.6M seed) ships `POST /v4/memories/forget-matching` — natural-language
forgetting with `dryRun`, `threshold`, `maxForget` and an audit handle —
plus versioned `PATCH` supersession. That is a better-specified control
plane than anything scored here, and it maps onto the adapter protocol
almost verbatim. It has never been benchmarked. Neither have Hindsight
(24.0k), Cognee (30.8k, excluded for API incompatibility), MemOS (11.5k) or
Honcho (7.3k).

So the honest claim is not that Mnemos forgets better than the field. It is
that **Mnemos forgets offline, with no API key**, and that the field has no
idea how well it forgets:

> Fifteen agent-memory systems were checked. **Zero publish a forgetting
> benchmark for their own system.** Five such benchmarks exist — ForgetEval,
> Memora/FAMA, MemoryAgentBench-SF, StateMemBench, MemLeak — and vendors
> cite none of them. Every forgetting number in existence was produced by a
> rival or an outsider.

**Read the adversarial column with one more caveat.** 253 of its 385 cases
were admitted only if the vendor's own system passed them, annotated in
`adversarial.py` as "Oracle-validated (Lethe / Lethe+LLM passes the case)".
The authors' own blind 77-case external subset drops the whole field from
the 63–68% band to 28–33%, which says the in-house suite is materially
easier. A benchmark whose admission filter is "the measurer's system solves
it" cannot rank the measurer.

Reproduce:

```bash
git clone https://github.com/deeplethe/lethe && cd lethe
cp <mnemos>/bench/forgeteval_mnemos_adapter.py bench/forgeteval/mnemos_adapter.py
export MNEMOS_BRIDGE=<mnemos>/bench/forgeteval-bridge.mjs
python -m bench.forgeteval.run --adapter mnemos --suite template --scale 200 --seed 42
```

Four minutes, 1,000 cases, $0.00. The adapter talks NDJSON to a resident Node
process because the harness makes ~10 calls per case and a CLI subprocess per
call would spend hours on interpreter startup.


### HotpotQA — Multi-Hop Retrieval

Head-to-head against [Mem0](https://github.com/mem0ai/mem0). Both systems indexed the
same documents and answered the same questions in the same run.

| Metric | Mnemos | Mem0 1.0.6 | Δ |
|--------|:----------:|:----------:|:-:|
| Recall@5 | **0.87** | 0.29 | **3.0×** |
| MRR | **0.91** | 0.42 | **2.2×** |
| Retrieval F1 | **0.51** | 0.26 | **2.0×** |
| Answer proxy | **0.73** | 0.34 | **2.1×** |
| Infrastructure | Markdown + SQLite | Redis + Qdrant + cloud | — |

`n = 50`, single run, no seed averaging, `topK = 5`. Mem0 at **1.0.6** (March 2026);
**2.x is not yet re-run**, so read this as a point-in-time comparison, not a current
one. Raw output: [`bench/results/`](./bench/results/), reproduce with
[`bench/hotpotqa-eval.ts`](./bench/hotpotqa-eval.ts) and
[`bench/mem0-hotpotqa.py`](./bench/mem0-hotpotqa.py).

**These are not HotpotQA's official metrics and must not be compared to the
HotpotQA leaderboard.** The official scorer, `hotpot_evaluate_v1.py`, reports
answer EM/F1 under its own `normalize_answer`, plus supporting-fact F1 over
`(title, sentence_id)` pairs, plus joint EM/F1. The table above is a
title-level retrieval metric defined in `bench/hotpotqa-eval.ts`, and
"answer proxy" is not a HotpotQA metric at all — it is token recall of the
gold answer against retrieved text. The comparison is valid in one direction
only: Mnemos and Mem0 went through the *same* harness on the *same* questions,
so the ratio between the two columns means something. The absolute numbers
do not transfer anywhere.

At `n = 50` the Wilson 95% intervals are Mnemos `[0.75, 0.94]` and Mem0
`[0.18, 0.43]` on Recall@5. They do not overlap, so the gap is real, but the
two-decimal precision in the table is not: read 0.87 as "high 0.80s".

Latency is not reported here. The evaluation harness does not record it, so any
number would be recalled rather than measured. What is measured is that Mnemos answers
from markdown plus a local SQLite index with **no API key and no network**.

### LoCoMo — Long-Term Conversational Memory

**1,536 questions over 10 conversations.** Retrieval is BM25 + embedding +
PageRank fusion at top-5. No API key and no network: the answer column is an
extractive proxy, token recall of the ground-truth answer against retrieved
text, not a generated answer.

| Category | Recall | Answer F1 | MRR | n |
|---|:---:|:---:|:---:|:---:|
| open-domain | 0.943 | 0.929 | — | 841 |
| single-hop | 0.863 | 0.758 | — | 321 |
| multi-hop | 0.528 | 0.670 | — | 282 |
| temporal | 0.565 | 0.478 | — | 92 |
| **overall** | **0.827** | **0.819** | **0.729** | **1,536** |

Raw output: `bench/results/locomo-eval-2026-09-19T22-37-31-698Z.json`.
Reproduce with `npx tsx bench/locomo-eval.ts --json`; the run takes 48 s.

Multi-hop and temporal are the weak categories and are reported as such.

Two corrections to earlier versions of this file, both found on 2026-09-19:

- It previously reported **695** questions and an overall recall of 0.687. That
  subset silently excluded the open-domain category, which is 841 of the 1,536
  questions — more than half the benchmark. The per-category figures were close
  to correct; the "overall" was an average over a hand-picked three categories.
  `bench/README.md` carried a third set of numbers again (44.7% recall) that
  reproduces nothing in the current harness. One number now, with the run file
  beside it.
- The 2026-09-19 run reproduces the 2026-07-22 run to three decimals, so these
  figures are stable across the retrieval-metric repair in `09ac45d` and the
  lambda change in `72fdd13`.

**No comparison table against published LoCoMo leaderboards is given, on purpose.**
Those are LLM-judge scores; the above is token F1. They are different quantities
and putting them in one column would invent a ranking rather than report one. A
previous version of this README did exactly that.

LoCoMo itself has known defects. An independent audit found 6.4% of questions
carry wrong answer keys, putting the theoretical ceiling at 93.57%, and the
standard gpt-4o-mini judge accepts 62.81% of deliberately wrong answers. At
least one published score exceeds the mathematical ceiling. A close result on
this benchmark is weak evidence in either direction, which is why it is reported
here and not led with.

### LongMemEval-S — Retrieval, 500 Questions

Session granularity, 470 scored (the official scorer excludes the 30
abstention questions). **No API key, no network, no LLM judge** — the
benchmark's own scorer imports `sys`, `json` and `numpy` and nothing else.

| | recall_any@k | recall_all@k | ndcg_any@k |
|---|:---:|:---:|:---:|
| @1 | 0.866 | 0.300 | 0.866 |
| @5 | **0.966** | **0.830** | **0.884** |
| @10 | 0.981 | 0.904 | 0.898 |

`recall_all@k` requires *every* gold session in the top k; `recall_any@k`
requires one. The official summary reports `recall_all@5` and `ndcg_any@5`.

Against published figures on the same benchmark using the same embedder, all
three zero-API-call:

| System | Embedder | R@1 | R@5 | R@10 |
|---|---|:---:|:---:|:---:|
| MemPalace (raw) | all-MiniLM-L6-v2 | 80.6% | 96.6% | 98.2% |
| Lethe v1 | all-MiniLM-L6-v2 | 85.4% | **97.4%** | **99.0%** |
| **Mnemos** | Xenova/all-MiniLM-L6-v2 | **86.6%** | 96.6% | 98.1% |

Mnemos leads at @1 and is at parity by @10. **That is a smaller claim than it
looks.** An independent analysis of MemPalace
([arXiv:2604.21284](https://arxiv.org/abs/2604.21284)) concluded its 96.6% R@5
"is the performance of ChromaDB's default embedding model (all-MiniLM-L6-v2)
applied to verbatim text chunks" and is reproducible with a minimal ChromaDB
setup. At k=5 this metric is saturated and mostly measures the embedder, which
is the same one in all three rows. The honest reading is that Mnemos's retrieval
is not the bottleneck and this axis no longer separates systems.

Mnemos's `recall_any@5` of 0.9660 and MemPalace's published 96.6% agree to three
significant figures. That is a coincidence, not a copied number; the full
per-question output is committed.

Weak categories, consistent with LoCoMo: multi-session 0.653 and
temporal-reasoning 0.772 `recall_all@5`, against 1.000 for both single-session
types. Multi-hop and temporal are where Mnemos loses on both benchmarks, which is
two independent measurements agreeing rather than noise.

Reproduce:

```bash
npx tsx bench/longmemeval-eval.ts --data <longmemeval_s_cleaned.json>
python bench/longmemeval-score.py <rankings.json> <path/to/LongMemEval>
python <LongMemEval>/src/evaluation/print_retrieval_metrics.py <rankings.jsonl>
```

11 minutes, 500 questions, $0.00. `bench/longmemeval-score.py` imports the
benchmark's own `evaluate_retrieval` rather than reimplementing `recall_all@k`,
so these are the authors' metric definitions.

---

## Quick Start

```bash
npm install -g @cheney-enterprises/mnemos
mnemos init my-agent
cd my-agent
```

Connect to your agent:

```bash
# Full adapters — auto-orient at session start, capture at session end
mnemos bridge claude-code --vault ~/brain                 # hooks + MCP + CLAUDE.md
mnemos bridge hermes --vault ~/brain                      # native plugin + MCP + HERMES.md
mnemos bridge opencode --vault ~/brain                    # plugin + MCP + AGENTS.md
mnemos bridge ori --vault ~/brain                         # ~/.ori/mcp.json (global only)

# MCP-only adapters — tools available, no lifecycle automation
mnemos bridge cursor --vault ~/brain                      # .cursor/mcp.json
mnemos bridge codex --vault ~/brain                       # ~/.codex/config.toml
mnemos bridge ori --vault ~/brain                         # ~/.ori/mcp.json

# Any MCP client
mnemos bridge generic --vault ~/brain                     # prints config for manual setup
```

Claude Code, Hermes Agent, and OpenCode get full lifecycle integration — the agent orients at session start, captures insights at session end, and validates notes on write. Cursor, Codex, and other MCP clients get access to all 18 tools but manage their own session lifecycle.

Manual MCP config (works with any client that speaks MCP):

```json
{
  "mcpServers": {
    "mnemos": {
      "command": "mnemos",
      "args": ["serve", "--mcp", "--vault", "/path/to/brain"],
      "env": { "MNEMOS_VAULT": "/path/to/brain" }
    }
  }
}
```

Start a session. The agent receives its identity automatically and begins onboarding on first run.

---

## What's New

**v0.6.0 — Navigated Recursion.** `mnemos explore` no longer returns a flat synthesis. The agent sees the decomposition tree — which branches produced results, which hit dead ends — and steers the traversal itself. New session commands: `explore-start`, `explore-expand`, `explore-conclude`. Budget is a nudge, not a wall: soft exhaustion with explicit extension. A cross-encoder reranking stage now sits on top of four-signal fusion. RMH Constraint 2 goes from partial to real.

```
$ mnemos explore-start "why did we choose SQLite over postgres"

exploration e7f2 — 3 branches
├─ [1] storage engine tradeoffs        4 notes, strong signal
├─ [2] deployment constraints          2 notes
└─ [3] prior migration decisions       dead end — no notes

next: mnemos explore-expand e7f2 1   |   mnemos explore-conclude e7f2 --answered
```

**v0.5.6 — OpenCode bridge.** Full lifecycle integration: first-run onboarding, auto session capture, note validation, multi-vault support. `mnemos bridge opencode` — one command.

**v0.5.5 — Ebbinghaus warmth.** Notes accessed once fade fast (half-life ~7 days). Notes accessed across many sessions embed deeply (up to ~28 days). Short-term and long-term memory, structurally distinct.

Full history in the [CHANGELOG](./CHANGELOG.md).

---

## Recursive Memory Harness

Mnemos is the first implementation of the **Recursive Memory Harness** (RMH) framework — a set of constraints on how persistent memory should behave for AI agents.

The core insight comes from Recursive Language Models ([Zhang, Krassa & Khattab, 2026](https://arxiv.org/abs/2512.24601)). RLM treats context not as input to be stuffed into a window, but as an environment to be navigated. The model doesn't get a bigger desk — it gets legs and walks into the library. RMH applies the same principle to persistent memory.

Three constraints define the framework:

1. **Retrieval must follow the graph.** Memory is not a flat vector store. Notes are nodes, wiki-links are edges. Retrieval walks the structure — Personalized PageRank at α=0.45, spreading activation along edges, community-aware traversal. The topology of the graph shapes what gets found.

2. **Unresolved queries must recurse.** When a single retrieval pass is insufficient, the system decomposes the question into sub-questions, retrieves against each, and synthesizes. Convergence detection stops recursion when new passes stop surfacing new information. This is what `mnemos explore` does.

3. **Every retrieval must reshape the graph.** Retrieval is not read-only. Co-occurrence edges grow between notes retrieved together (Hebbian learning). Q-values update based on whether retrieved notes were actually useful. The graph learns from how it is used — every query makes the next query better.

Most memory systems treat retrieval as search. RMH treats retrieval as navigation, recursion, and learning — on a graph that evolves with every session.

Read the full paper: [Introducing Recursive Memory Harness](https://mnemos.com/rmh)

---

## What It Does

- **Persistent identity.** Agent state — name, personality, goals, methodology — is stored in plain markdown and auto-injected at session start via MCP instructions. Identity survives client switches, machine migrations, and model changes without reconfiguration.

- **Knowledge graph.** Every `[[wiki-link]]` is a directed edge. PageRank authority, Louvain community detection, betweenness centrality, bridge detection, orphan and dangling link analysis. Structure is queryable through MCP tools and CLI.

- **Three memory spaces.** Identity (`self/`) decays at 0.1x — barely fades. Knowledge (`notes/`) decays at 1.0x — lives and dies by relevance. Operations (`ops/`) decays at 3.0x — burns hot and clears itself. The separation is architectural, not cosmetic.

- **Cognitive forgetting.** Notes decay using ACT-R base-level learning equations, not arbitrary TTLs. Used notes stay alive. Their neighbors stay warm through spreading activation along wiki-link edges. Structurally critical nodes are protected by Tarjan's algorithm. `mnemos prune` analyzes the full activation topology before archiving anything.

- **Four-signal fusion.** Semantic embeddings, BM25 keyword matching, personalized PageRank, and associative warmth fused through score-weighted Reciprocal Rank Fusion. Intent classification (episodic, procedural, semantic, decision) shifts signal weights automatically.

- **Dampening pipeline.** Three post-fusion stages validated by ablation testing: gravity dampening halves cosine-similarity ghosts with zero query-term overlap, hub dampening applies a P90 degree penalty to prevent map notes from dominating results, and resolution boost surfaces actionable knowledge (decisions, learnings) over passive observation.

- **Learning retrieval (v0.4.0).** Three intelligence layers improve retrieval quality from session to session, synthesized from 63 research sources. See [Retrieval Intelligence](#retrieval-intelligence-v040) below.

- **Capture-promote pipeline.** `mnemos add` captures to inbox. `mnemos promote` classifies (idea, decision, learning, insight, blocker, opportunity), detects links, suggests areas. 50+ heuristic patterns. Optional LLM enhancement.

- **Zero cloud dependencies.** Local embeddings via all-MiniLM-L6-v2 running in-process. SQLite for vectors and intelligence state. Everything on your filesystem. Zero API keys required for core functionality.

---

## Retrieval Intelligence (v0.4.0)

Three learning layers that improve retrieval quality over time without manual tuning. Synthesized from 63 research sources across reinforcement learning, information retrieval, cognitive science, and bandit theory.

### Layer 1 — Q-Value Reranking

Notes earn Q-values from session outcomes via exponential moving average updates. Over time, genuinely useful notes rise and noise sinks.

| Signal | Reward | What triggers it |
|--------|--------|-----------------|
| Forward citation | +1.0 | You `[[link]]` a retrieved note in new content |
| Update after retrieval | +0.5 | You edit a note you just retrieved |
| Within-session re-recall | +0.4 | Same note surfaces across different queries |

After RRF fusion, Phase B reranks the candidate set with a lambda blend of similarity score and learned Q-value, plus an exploration bonus that ensures under-retrieved notes still get discovered. The bonus shrinks as a note is shown without ever being used; once a note has been credited it keeps the full bonus, so being used never ranks a note below an equally relevant note nobody has seen. A cumulative bias cap (MAX=3.0, compression=0.3) prevents runaway score inflation.

### Layer 2 — Co-Occurrence Edges

Notes that are retrieved together grow edges between them — Hebbian learning on the knowledge graph. Edge weights are computed using NPMI normalization (genuine association beyond base rate), GloVe power-law frequency scaling, and Ebbinghaus decay with strength accumulation (frequently co-retrieved pairs decay slower).

Per-node Turrigiano homeostasis prevents hub notes from absorbing all edge weight. Bibliographic coupling bootstraps day-0 edges from existing wiki-link structure before any queries have been run.

The combined wiki-link + co-occurrence graph feeds a Personalized PageRank walk (HippoRAG, α=0.5) that surfaces notes semantic search alone would never find.

### Layer 3 — Stage Meta-Learning

Each optional pipeline stage (PageRank, warmth, hub dampening, co-occurrence PPR) is wrapped in a LinUCB contextual bandit with an 8-dimensional query feature vector. The system learns which stages help for which query types and auto-skips stages that consistently hurt.

Three-way decisions per stage: **run** / **skip** / **abstain** (stop the pipeline early). Cost-sensitive thresholds ensure expensive stages face a higher bar. Essential stages (semantic search, BM25, RRF fusion, Q-reranking) never skip. Q-reranking is essential because the bandit's reward measures result shape and term recall, which cannot see whether a note was used. An ACQO two-phase curriculum runs all stages during exploration (first 50 samples), then optimizes.

### Session Learning Loop

```
Query → Retrieve → Use (cite, update, create) → Reward signals
  ↓                                                    ↓
  Co-occurrence edges grow                Q-values update (session-end batch)
  ↓                                                    ↓
  Stage meta-learner updates              Better retrieval next session
```

All updates happen in a single SQLite transaction at session end, in order: co-occurrence → Q-values → stage learning.

---

## The Stack

```
Layer 6: MCP Server                    18 tools, 7 resources — any agent talks to this
Layer 5: Recursive Exploration         PPR graph traversal, sub-question decomposition, convergence detection
Layer 4: Retrieval Intelligence        Q-value reranking, co-occurrence learning, stage meta-optimization
Layer 3: Dampening Pipeline            gravity, hub, resolution — ablation-validated
Layer 2: Four-Signal Fusion            semantic + BM25 + PageRank + warmth → score-weighted RRF
Layer 1: Knowledge Graph + Vitality    wiki-links, ACT-R decay, spreading activation, zone classification
Layer 0: Markdown files on disk        git-friendly, human-readable, portable
```

18 MCP tools · 7 resources · 22 CLI commands · 1137 tests

---

## Token Economics

Without retrieval, every question requires dumping the entire vault into context. With Mnemos, the cost stays flat.

| Vault Size | Without Mnemos | With Mnemos | Savings |
|:----------:|:-----------:|:--------:|:-------:|
| 50 notes | 10,100 tokens | 850 tokens | **91%** |
| 200 notes | 40,400 tokens | 850 tokens | **98%** |
| 1,000 notes | 202,000 tokens | 850 tokens | **99.6%** |
| 5,000 notes | 1,010,000 tokens | 850 tokens | **99.9%** |

A typical session costs **~$0.10** with Mnemos. Without it: **~$6.00+**.

---

## Architecture

```
                          Any MCP Client
                    (Claude, Cursor, Windsurf,
                     Cline, Hermes, custom agents, VPS)
                              │
                        MCP Protocol
                        (stdio / JSON-RPC)
                              │
                    ┌───────────────────┐
                    │    Mnemos MCP Server  │
                    │                   │
                    │  instructions     │   identity auto-injected
                    │  resources  (7)   │   mnemos:// endpoints
                    │  tools    (16)    │   full memory operations
                    └─────────┬─────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
      ┌───────────┐    ┌───────────┐    ┌───────────┐
      │ Knowledge │    │ Identity  │    │Operations │
      │   Graph   │    │  Layer    │    │  Layer    │
      │           │    │           │    │           │
      │  notes/   │    │  self/    │    │  ops/     │
      │  inbox/   │    │  identity │    │  daily    │
      │  templates│    │  goals    │    │  reminders│
      └─────┬─────┘    │  method.  │    │  sessions │
            │          └───────────┘    └───────────┘
      ┌─────┴──────┐
      │            │
   Wiki-link   Embedding        ┌──────────────────────┐
    Graph       Index            │ Retrieval Intelligence│
   (in-mem)    (SQLite)          │                      │
      │            │             │  Q-values  (note_q)  │
   PageRank    Semantic          │  Co-occur  (edges)   │
   Spreading   BM25              │  Stage Q   (LinUCB)  │
   Activation  4-Signal          │  Dampening (3 stages)│
   Communities Fusion            │  Explore   (PPR+RMH) │
                                 └──────────────────────┘
```

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `mnemos_wake` | Session boot: `project=<tag>` → global context + that project's scoped context in ONE payload — map Current State, the project's OWN goals/daily/reminders (`ops/<tag>/` when present, tag-filtered shared files otherwise), warm notes scoped to its membership, recent notes. Without a project → global-only + a `project_choice_required` prompt the agent relays to the user (config `wake.project_default` can name a default; empty default = forced choice). Onboarding on a fresh vault. |
| `mnemos_update` | Write to identity, goals, methodology, daily, or reminders — `file=map project=<tag>` overwrites a project map's Current State (the SESSION END ritual); `file=daily|goals|reminders project=<tag>` lands in the project's OWN `ops/<tag>/` state files (the scoped wake reads these first); bare writes stay global. **Policy gates apply:** identity/methodology rewrites propose when `identity_update: approval` (the user executes via `mnemos requests approve`); the previous version is always backed up to `.history/`. |
| `mnemos_update_decision` | Record the user's answer to an update notice |
| `mnemos_whats_new` | Release notes for the installed version, or any version |
| `memory_sql` | Read-only SQL over the index — anything the ranking tools cannot express |
| `mnemos_health` | Full diagnostics |
| `mnemos_add` | Capture to inbox. The ask-first gate: with no project tag and none detectable, it refuses to auto-file and returns the live project roster — ask the user which project (or a new one + its name), then re-call. The note waits in `inbox/`. |
| `mnemos_promote` | Promote with classification, linking, and area assignment |
| `mnemos_validate` | Schema validation |
| `mnemos_query_ranked` | Full retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning. `project=<tag>` hard-scopes to one project (results name the other projects); omit to search the whole vault — cross-project learning is the unscoped default. |
| `mnemos_query_similar` | Semantic search (vector only, faster). Same project-scoping contract as ranked. |
| `mnemos_warmth` | Inspect the associative warmth field. `project=<tag>` scopes the field to one project. |
| `mnemos_explore` | Recursive graph traversal — PPR, sub-question decomposition, convergence detection. `project=<tag>` scopes the ANSWER set (traversal stays global). |
| `mnemos_prune` | Activation topology analysis and archive candidates |
| `mnemos_suggest_scope` | Rank which projects the user most likely means by a vague reference ("our crazy chat from the other night with the pirates"). Text (IDF-weighted), recency, size, and current-scope signals; reasons included. Use before creating a conversational scope, or to find the scope to search. |
| `mnemos_forget` | Removal under the capability model: `release`/`supersede` are soft (files kept, dry-run default); `purge` proposes only — records a pending intent with exact slugs and returns the user's `mnemos requests approve <id>` command. Hard deletion is never agent-executable — approvals are refused from any non-interactive process AND from any process running under an agent runtime (a forged PTY does not pass; the process tree is checked and the refusal audited with the ancestry chain). |
| `mnemos_index_build` | Build/update embedding index and bootstrap co-occurrence edges |

Six resources carry the always-readable layer:

| Resource | What it serves |
|----------|----------------|
| `mnemos://manual` | The operating manual, section-addressed: §1 intended use (what belongs in the vault), §2-4 scope/tagging/naming rules, §5 vault layout. Deep reference — read the one section you need, never the whole file; the command workflows are doctrine, carried in every session. `ops/manual.md` — ships with every vault scaffold. |
| `mnemos://identity`, `mnemos://goals`, `mnemos://methodology` | The self layer, as written by `mnemos_update` |
| `mnemos://daily`, `mnemos://reminders` | The ops layer, as written by `mnemos_update` |
| `mnemos://policy` | The effective policy sheet: all six gates with their configured levels, the removal law (propose/approve split, trash, audit), and the config source. Rendered from the same `loadPolicy` the enforcement sites consume, so it cannot drift from what is actually enforced. |

`mnemos_wake` carries the compact form of the last two in every briefing: the
project roster (same `note_project` rows the ask-first gate's refusal shows)
and a one-line policy gate summary.

Five tools were removed in favour of `memory_sql`, which answers their
questions in one statement and is 20–46× faster because it reads the index
instead of re-walking the vault from disk:

| was | now |
|---|---|
| `mnemos_status` | `SELECT COUNT(*) FROM v_note` |
| `mnemos_query orphans` | `SELECT title FROM v_note WHERE inbound = 0` |
| `mnemos_query dangling` | `SELECT * FROM v_dangling` |
| `mnemos_query backlinks` | `SELECT src_title FROM v_link WHERE dst = '…'` |
| `mnemos_query cross-project` | `SELECT n.title FROM v_note n JOIN note_project p ON p.note_id = n.id GROUP BY n.id HAVING COUNT(DISTINCT p.project) > 1` |
| `mnemos_query_important` | `SELECT title, pagerank FROM v_note ORDER BY pagerank DESC` |
| `mnemos_query_fading` | `mnemos_prune`, which its own description already deferred to |

The three navigated-exploration tools (`explore_start` / `_expand` /
`_conclude`) were removed from MCP after six months with zero recorded
sessions. They remain available as `mnemos explore-start`, `mnemos explore-expand`
and `mnemos explore-conclude`.

---

## CLI — every command, what it does, and what it guards

The CLI is the same engine as the MCP tools, for humans and scripts. Run it
from inside a vault (or set `MNEMOS_VAULT` — see `mnemos --help`). JSON
output; `--json` on some commands for the full machine payload.

### Vault & infrastructure

| Command | What it does / what it guards |
|---|---|
| `mnemos init [dir] --json` | Scaffolds a vault: `notes/`, `self/`, `ops/`, `templates/`, `mnemos.config.yaml`, the `.mnemos/` marker. Idempotent — a second run skips existing files. |
| `mnemos status` | Vault overview: note counts, index state. Read-only. |
| `mnemos health` | Full diagnostics: orphans, dangling links, schema violations, index health. Read-only. Run after bulk writes. |
| `mnemos serve --mcp [--vault <path>]` | Runs the MCP server (stdio JSON-RPC). This is what agents connect through; the registration in `~/.ori/mcp.json` (or other clients) carries the `--vault` flag. |
| `mnemos index build [--force]` | Rebuilds the derived index and embeddings. Automatic on every query (stat-filtered); `--force` re-embeds everything — use after writes from outside `mnemos add`. `index status` reports coverage; `index export-learned` / `import-learned` move the accumulated learning tables (see *When to rebuild* below — a rebuild destroys them). |
| `mnemos graph metrics` / `graph communities` | PageRank/centrality and Louvain clustering over the knowledge graph. Read-only. |
| `mnemos whats-new [version]` | Release notes. |

### Capture & promote

| Command | What it does / what it guards |
|---|---|
| `mnemos add "<prose title>" -t <type> -d "<desc>" -p <tag> -c "<body>"` | Captures to `inbox/`. **Title must be multi-word prose** — a slug title silently fails (`success:false`). **The ask-first gate:** with no `-p` and no detectable project, the note is staged in inbox, NOT filed, and the response returns the project roster + the question for the user. `-c`/`-f`/`--content-stdin` supply the body. Auto-promotes to `notes/` when `promote.auto: true` and the project gate passes. |
| `mnemos promote [note] [--all] [-t <type>] [-d <desc>] [-l <links...>] [-p <tag>] [--dry-run] [--no-auto]` | Moves an inbox note into the knowledge graph: type classification, wiki-link application, project routing (into the project's map). You are the intelligence layer — your overrides win; heuristics fill gaps. `--dry-run` previews. |
| `mnemos validate <path>` | Schema validation of one note (frontmatter, types, description limits). Read-only. |

### Removal — the capability model in the CLI

| Command | What it does / what it guards |
|---|---|
| `mnemos forget release <query> [--apply] [--max-forget <n>]` | Soft-evict matched notes: `status: released`, files KEPT, never recalled — reversible. **Dry-run by default**; `--apply` mutates. Blast cap: refuses when the query addresses more than `--max-forget` notes (default 10). |
| `mnemos forget supersede <query> --new-text <text> [-p <tag>] [--apply]` | Retires the best match and writes its replacement. Same dry-run default and blast cap. |
| `mnemos forget purge --slugs <s1,s2> [--reason <text>]` | **Proposes a hard delete — never executes.** Records a pending intent (exact slugs only; query-addressed purge was removed after it unlinked 6 unintended notes) and returns the approval command. The agent surface can stop here; execution is the next line, and it is not the agent's. |
| `mnemos requests [list] \| approve <id> \| deny <id>` | **The user-only surface.** Executes or rejects a pending intent. Guards, in order: refuses non-pending intents; **refuses any process without an interactive terminal** (agent shells cannot approve their own proposals); **refuses any process whose ancestry contains an agent runtime** (`ori`, `claude`, … — a `script`-wrapped PTY does not pass; the forged chain is audited). Real terminals get the `[y/N]` prompt. Every decision — and every refusal — is written to `ops/forget-audit.jsonl` with process provenance. Executed purges trash before unlink (`ops/.trash/`). |

### Retrieval

| Command | What it does / what it guards |
|---|---|
| `mnemos query ranked <query> [--limit <n>] [--project <tag>]` | Full retrieval: 4 signals fused via RRF + Q-value reranking + spreading activation. `--project <tag>` **hard-filters the answer set** to that project's notes (the exploration pool too) and names the other projects in the response; **omit it to search the whole vault** — cross-project learning is the unscoped default. Unknown tag degrades to unscoped WITH a warning. |
| `mnemos query similar <query>` | Semantic-only search (faster, single signal). Same `--project` contract. |
| `mnemos explore <query> [--depth <n>] [--limit <n>] [--project <tag>]` | Multi-hop PPR graph traversal with sub-question decomposition. `--project` scopes the ANSWER set (traversal stays global — the graph is honest). |
| `mnemos query orphans / dangling / backlinks <note> / cross-project / important / fading` | Structure and vitality queries: unlinked notes, broken wiki-links, what links to a note, notes in multiple projects, PageRank ranking, decay detection. Read-only. |

### Topology & bridges

| Command | What it does / what it guards |
|---|---|
| `mnemos prune [--apply] [--verbose]` | Activation topology analysis; lists archive candidates. **Dry-run by default** — `--apply` archives. |
| `mnemos archive` | Status-flip archiving (files kept). |
| `mnemos bridge <target>` | Registers the mnemos MCP server for a client. Full lifecycle: `claude-code`, `hermes`, `opencode` (hooks/plugin + MCP + instructions). MCP-only: `cursor`, `codex`, **`ori`** (`~/.ori/mcp.json` — global only, the harness carries its own lifecycle). `generic` prints config for any client. `--scope project\|global`, `--activation auto\|manual`, `--uninstall`, `status` inspects all installs. Preserves unrelated servers; re-bridge updates in place. |
| `mnemos wake [--budget <n>] [--project <tag>] [--json]` | The briefing, human-readable. `--project <tag>` scopes (global + that project's context in one output); bare wake prints the global briefing **plus the PROJECT CHOICE REQUIRED block** for the user to answer. `--json` emits the full machine payload (`projectWake`, `project_choice_required`). |

The removal law, in one line: **the agent can propose; only the user executes —
and only from a terminal the agent does not control.**

Path-taking commands treat relative file paths as vault-relative. Absolute
paths continue to work unchanged.

### When to rebuild

`.mnemos/` holds two different things, and only one of them is disposable.

**Derived** — rebuilt from the markdown on demand:

| store | maintained by | needs `mnemos index build` when |
|---|---|---|
| derived index (`note`, `edge`, `note_term`, graph-metrics cache) | every query, automatically — one `stat` per file, reparse only what changed | never for an edit; `--force` if a query warns it "covers N of M notes" |
| embeddings (semantic vectors) | `mnemos add` on write; queries only if the table is missing or empty | a note was written by something other than `mnemos add` (an editor, a sync client, a script) — it is findable by keyword and links immediately, but not by meaning until it is embedded |
| co-occurrence bootstrap | `mnemos index build` only | link structure changed a lot and you want day-0 edges to reflect it |

**Accumulated** — nowhere else, and a rebuild destroys it:

`retrieval_log`, `note_q`, `q_history`, `q_history_genuine`, `stage_q`,
`stage_log`, `boosts`, `note_access`, `memory_events`, and the `retrieval`
rows of `co_occurrence`.

Measured on a 1,548-note vault: `rm -rf .mnemos/ && mnemos index build` empties
**eight** of those tables — six months of retrieval history across 564
sessions, 1,427 learned Q-values, and the eight live LinUCB arms that decide
which ranking stages run. Two of them, `q_history_genuine` and
`memory_events`, are created by no production code at all and cannot be
reconstructed by anything.

So export before you delete:

```bash
mnemos index export-learned          # -> ops/mnemos-learned.ndjson
rm -rf .mnemos/
mnemos index build
mnemos index import-learned
```

That round-trip is verified lossless on a real vault by
`bench/learned-roundtrip.mjs`, which compares row counts *and* a digest over
the Q-values themselves, because counts matching while values drift is a pass
that means nothing. The export is NDJSON, deterministically ordered, ~23 MB
for 56,850 rows against a 243 MB binary — small enough and diffable enough to
commit, which the binary is not.

The practical rule: **edit and query freely; run `mnemos index build` after
bulk-adding notes from outside Mnemos, and `mnemos index build --force` if a query
reports it cannot cover the vault.** `--force` is a full reparse that keeps
accumulated state; only deleting the file loses it.

Earlier versions of this README said everything under `.mnemos/` was derived and
disposable. That was wrong, and following it cost six months of learning.

---

## Vault Structure

```
vault/
├── .mnemos/                      # Vault marker + derived state (embeddings.db, caches)
├── mnemos.config.yaml            # Configuration (the USER owns this file — the agent never edits it)
├── notes/                        # The knowledge graph — durable, cross-session knowledge
│   ├── index.md                  # Hub entry point
│   ├── <project-tag>-project-map.md   # One map per project: Key Notes + Current State (the living handoff)
│   └── <note>.md                 # Typed notes with project frontmatter + wiki-links
├── inbox/                        # Capture buffer — notes land here first, ALWAYS
├── templates/                    # Note and map schemas (the shape every note must satisfy)
├── self/                         # The agent's identity — WHO it is (one agent, never per-project)
│   ├── identity.md               # Name, personality, values (identity_update gate)
│   ├── goals.md                  # GLOBAL goals — umbrella threads spanning projects
│   ├── methodology.md            # Processing principles (identity_update gate)
│   └── memory/                   # Agent's accumulated self-insights
└── ops/                          # Operational state — what the agent is DOING (wake reads this)
    ├── daily.md                  # GLOBAL session log — cross-project record of what happened
    ├── reminders.md              # GLOBAL time-bound commitments (due/upcoming only surface in wake)
    ├── <tag>/                    # Per-project state: goals.md, daily.md, reminders.md
    │   ├── goals.md              #   THIS project's goals (scoped wake reads these first)
    │   ├── daily.md              #   THIS project's session log
    │   └── reminders.md          #   THIS project's time-bound items
    ├── sessions/                 # Explore-session records
    ├── requests/                 # Pending removal/identity intents (the approval queue)
    ├── .trash/                   # Executed purges — trash copy before unlink, always
    ├── forget-audit.jsonl        # Append-only audit: every intent, approval, refusal, execution
    └── promote.log               # Promotion history
```

Every file is plain markdown. Open it in any text editor, Obsidian, or your file browser. `git log` is your audit trail.

### What each area is FOR (and who touches it)

**`notes/` — the knowledge. Durable facts, decisions, doctrines, platform truths.**
What a fresh session must *retrieve*. Written via `mnemos_add` → `mnemos_promote`; each note
carries `project: [tag]` frontmatter, which is the single source of truth for project separation
(the derived index mirrors it into `note_project`, and every scoped read filters on it). The map's
`## Current State` section is the overwritten, always-current "where we are" — the handoff of record.

**`inbox/` — the airlock. Nothing skips it.**
`mnemos_add` writes here first. The note is staged, not filed: the ask-first gate refuses to
auto-promote anything without a project, so a project-less capture waits in inbox until the user
answers ("existing project, or a new one + its name?"). Promote moves it into `notes/` with
classification, links, and routing.

**`self/` — the agent's identity. WHO it is — global by nature.**
- `identity.md` / `methodology.md`: the self-model. Rewriting these is `identity_update`-gated:
  the agent proposes, the user approves from a real terminal.
- `goals.md`: the GLOBAL goal set — umbrella threads spanning projects ("ship the Flutter
  sidecar", "keep the vault honest"). Per-project goals live in `ops/<tag>/goals.md`, and the
  scoped wake reads those first. Bare `mnemos_update file=goals` means global.

**`ops/` — the operational state. WHAT the agent is doing — wake reads this.**
- `daily.md` (global) + `ops/<tag>/daily.md` (per project): session logs. The scoped wake reads
  the project's own file first, falling back to tag-filtered lines of the shared file.
- `reminders.md` (global) + `ops/<tag>/reminders.md` (per project): time-bound commitments.
  The temporal filter surfaces only due/upcoming items; expired ones never appear. Genuinely
  global items ("follow up with Eric on X") belong in the shared file; project-bound ones in
  the project's file.
- `requests/`: the capability model's approval queue — pending purge/identity intents await a
  user's `mnemos requests approve|deny <id>` from a real terminal.
- `forget-audit.jsonl`: append-only record of every removal decision, with process provenance.

**The division in one line:** `notes/` is what the agent knows, `self/` is who the agent is,
`ops/` is what the agent is doing, `inbox/` is what it is not yet sure about. And every state
file in `ops/` has a global form and a per-project form (`ops/<tag>/`), with the project form
winning whenever a project is named.

---

## Deployment

**Local.** Install globally, `mnemos init`, connect your MCP client. Done.

**VPS / headless.** Install on the server. `mnemos serve --mcp --vault /path/to/vault`. Memory persists on the filesystem. Back up with `git push`.

**Remote terminals.** Hermes Agent supports Docker, SSH, Modal, and Daytona backends. If your agent runs in a remote terminal, `mnemos` must be installed and on PATH inside that environment, and the vault must be on persistent storage (not ephemeral). For serverless backends like Modal where environments hibernate, mount the vault on a persistent volume.

**Multi-vault.** Separate Mnemos instances for separate agents. Each vault is self-contained: its own identity, knowledge graph, and operational state.

**Scriptable.** CLI returns structured JSON. Use in cron jobs, webhook handlers, or orchestration loops.

## Install Model

Mnemos separates three install concepts:

- `scope`: `global` follows one vault across the machine, `project` stays inside one repo/workspace
- `activation`: `auto` runs `mnemos_wake` at session start where the adapter supports it, `manual` leaves tools available but does not auto-orient
- `vault`: explicit `--vault` wins; otherwise Mnemos resolves by install scope

Precedence rules:

- project install overrides global install
- explicit `--vault` overrides inferred vault
- project activation overrides global activation

Bridge lifecycle:

- rerun the same `mnemos bridge ...` command to update vault path or activation in place
- use `--uninstall` to remove Mnemos-owned config from supported adapters
- generic installs emit manual uninstall instructions because Mnemos does not own that client config surface

Claude Code, Hermes Agent, and OpenCode are fully automated adapters with lifecycle hooks. Claude Code uses hook scripts; Hermes uses a native Python plugin installed at `~/.hermes/plugins/mnemos/`; OpenCode uses a JavaScript plugin at `.opencode/plugins/lifecycle.js`. All three auto-orient at session start (via first-run detection) and capture insights at session idle. Cursor and Codex have native MCP config install support. Codex writes to `~/.codex/config.toml` and uses a single global config surface; "project" scope there means project-like runtime vault discovery, not a separate project config file. Other MCP-capable clients can use `mnemos bridge generic` now and wire the emitted config into their own client surface.

---

## Configuration

`mnemos.config.yaml` controls all tunable parameters. Generated with sensible defaults on `mnemos init`.

| Section | Controls |
|---------|----------|
| `vitality` | Decay parameters, metabolic rates, zone thresholds, bridge bonus |
| `activation` | Spreading activation: damping, max hops, min boost |
| `retrieval` | Signal weights, exploration budget, RRF k |
| `engine` | Embedding model, database path |
| `warmth` | Surprise threshold, PPR parameters, graph weight |
| `promote` | Auto-promotion, project routing |
| `llm` | Optional: Anthropic, OpenAI-compatible, or local models |

LLM integration is optional. Every operation works deterministically with heuristics alone. When configured, LLM improves classification and link suggestions.

---

## Why Sovereignty Matters

Most memory systems store your agent's knowledge in infrastructure you do not control. A proprietary database. A cloud service. A vendor's format.

Mnemos stores memory as files you own. The vault is portable. Move it to a new machine, push it to a git remote, open it in a text editor. Switch MCP clients by changing one config line. The memory survives any platform change because it was never locked to a platform.

This is not ideological. It is architectural. Portable memory is composable memory.

---

## Development

```bash
git clone https://github.com/cheney-enterprises/mnemos.git
cd Mnemos
npm install
npm run build
npm link
mnemos --version
```

```bash
npm test              # 860+ tests
npm run lint          # Type check
npm run dev           # Watch mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

Thanks to [@maichler](https://github.com/maichler) and the rest of the Mnemos community for their PRs and additions.

---

## License

Apache-2.0

---

Memory is sovereignty. Mnemos gives your agent a mind.
