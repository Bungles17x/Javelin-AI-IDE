# Javelin Core — the agent runtime

Javelin is an AI **system**, not a wrapper around a model. This document describes
its architecture: what Javelin owns, how a task flows through it, and where the
honest boundaries are.

---

## The architectural claim, stated precisely

Javelin owns its **reasoning lifecycle**. It does **not** own the model's weights.

| Layer | Owned by Javelin? | What it is |
|---|---|---|
| Reasoning lifecycle (phases, planning, verification, repair) | **Yes** | The control loop in `core/runtime.js` |
| Memory (project index, episodes, learnings, failure record) | **Yes** | `core/memory.js` |
| Tool registry and safety policy | **Yes** | `core/tools.js` |
| Planning heuristics and honesty policy | **Yes** | `core/brain.js` |
| Raw language generation | Engine (swappable) | `core/engines.js` — Ollama, Groq, or any OpenAI-compatible endpoint |

Swapping the engine changes how fluently Javelin can express itself. It does **not**
change how Javelin thinks, plans, verifies, or recovers — those are code, and they
are Javelin's.

This is the same shape as Claude Code, Copilot, or Codex: a system that harnesses a
model rather than a model that happens to chat.

---

## A task's life

```
        ┌──────────────────────────┐
        │                    JAVELIN RUNTIME                        │
        │                                                           │
 task ─▶│  UNDERSTAND ─▶ PLAN ─▶ ACT ─▶ VERIFY ─▶ CONCLUDE          │
        │      ▲                    │        │                      │
        │      │                    │        ▼                      │
        │      │                    │     REPAIR ─┐                 │
        │      │                    │        │    │ retry with a    │
        │      │                    │        └────┘ new hypothesis  │
        │      │                    ▼                              │
        │      └──────────── failure recorded ◀───┐                 │
        │                                          │                │
        │   MEMORY: index · episodes · learnings · dead-actions     │
        └──────────────────────────┘
                       ▲                            │
                       │                            ▼
              ┌────────────────┐          ┌──────────────────┐
              │  ENGINE        │          │  WORKSPACE       │
              │  (swappable)   │          │  virtual | real  │
              └────────────────┘          └──────────────────┘
```

### 1. UNDERSTAND
Before planning, Javelin grounds itself in reality. It must call `list_files`,
`read_file` or `search_code` and report what it found. The project index from
memory is injected into context so it already knows the shape of the codebase.

### 2. PLAN
Javelin states a numbered plan naming specific files. The plan is captured by
`extractPlan()` and surfaced in the UI — you can see what it intends before it acts.

### 3. ACT
One tool at a time, smallest change that achieves the goal. Every write passes the
approval gate with a **preview diff** computed *before* applying anything.

### 4. VERIFY
Javelin runs the project's tests/build. The result is classified by
`classifyCommandResult()` — did a *verification* command run, and did it pass?

`verificationPolicy()` refuses an unverified `finish` if files changed and a
verification command was available. Javelin cannot claim success it did not confirm.

### 5. REPAIR
When verification fails, Javelin enters REPAIR and must state a hypothesis:
> "The failure is caused by X."

`extractHypothesis()` captures it, and it becomes the standing instruction. This is
the difference between self-correction and flailing.

---

## The two mechanisms that make it self-correcting

### Failure memory — a dead action is never repeated

Every tool call has a stable `actionSignature()`. When a call fails, the signature
goes into a dead-action set. On any subsequent turn:

```js
if (failures.includes(signature)) {
  // blocked — the model is told why and must change approach
}
```

This is enforced by the **runtime**, not requested of the model. A model cannot
talk its way into repeating a dead action.

### Hypothesis-driven repair

Blind retrying produces noise. Javelin must articulate a cause before acting again,
which focuses the next attempt on a specific theory.

---

## Memory: three stores, three jobs

| Store | Contents | Persists | Purpose |
|---|---|
| **Project index** | files, languages, extracted symbols | rebuilt per run | ground every decision in the real codebase |
| **Episodic** | every attempt — tool, args, outcome, detail | yes | detect dead actions; audit what happened |
| **Semantic** | distilled durable facts | yes | carry learnings across sessions |

**Confidence decay.** A contradicted fact loses confidence and is removed once it
reaches zero, so stale beliefs fade instead of persisting forever. An explicit
`remember` starts at 0.7 (trusted); an inferred fact starts at 0.5 and must earn
trust through repetition.

---

## Tool safety: a policy, not a checklist

Every tool declares a **risk class**: `read`, `write`, `execute`, `destructive`.

- `read` — runs freely
- `write` — always requires approval, with a preview diff
- `execute` — allow-listed commands (test/build/lint) run; anything else asks
- `destructive` — **refused outright**, even with approval

`rm -rf /`, `mkfs`, fork bombs, disk formatting and shutdown are hard-blocked in
`BLOCKED_COMMAND_PATTERNS`. This is not a prompt instruction the model can ignore —
it is enforced in code before execution.

---

## Verifying the system works

```bash
npm test
```

`tests/javelin-core.test.mjs` drives the runtime with a **scripted engine**, so the
tests are deterministic and need no model installed. They prove:

1. Project indexing extracts real structure
2. Full lifecycle: understand → plan → act → verify → finish
3. **A repeated failed action is blocked** and the reason is explained
4. **An unverified finish is refused** until verification runs
5. `rm -rf /` is refused outright even when approved
6. A denied edit is not applied and its retry is blocked
7. Memory survives serialisation and grounds later runs
8. Abort works
9. A dead engine degrades gracefully to a healthy one

---

## Engine configuration

| Engine | Key needed | Where it runs |
|---|---|---|
| Local (Ollama) | no | your machine — code never leaves it |
| Groq | yes | cloud |
| Custom | optional | any OpenAI-compatible `/v1` |

Javelin probes engines at runtime. If the configured one is unreachable, it falls
back to a healthy engine and reports the fault rather than failing silently — the
**Javelin system** panel in the UI shows engine health, memory counts and learnings.

---

## Honest limits

- **Javelin does not have its own trained weights.** No session can train a frontier
  model; that needs large-scale GPU clusters and months. Anyone claiming otherwise is
  selling something. What Javelin has is its own *architecture* — and that is where
  most practical coding-agent quality comes from.
- **Keyless means local.** A large cloud model cannot run in a browser tab or a
  webview. Keyless mode runs a local model via Ollama; quality scales with your
  hardware and the model you pull.
- **The web app edits an imported snapshot**, because browsers have no filesystem
  access. The VS Code extension edits your real project.
- **Review agent output.** Every path is gated, diffed and revertible, but you own
  what ships.
