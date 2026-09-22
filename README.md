# Javelin AI - Coding Assistant
A web + VS Code AI coding agent built with React, TailwindCSS and Vite. Three modes:

- **Chat** — ask questions, get streamed answers.
- **Agent** — give it a task. It inspects, plans, edits behind an approval gate, runs your tests,
  and fixes its own failures.
- **Javelin** — runs on **Javelin Core**, its own reasoning runtime: an explicit
  understand → plan → act → verify → repair lifecycle with persistent memory, a project index,
  hypothesis-driven self-correction, and a swappable inference engine underneath.
  See [docs/JAVELIN-CORE.md](docs/JAVELIN-CORE.md).

> **What "its own AI" means here, precisely.** Javelin owns its *architecture* — the reasoning
> lifecycle, memory, tools, safety policy and self-repair — which is where most agent capability
> actually comes from. It does not own the model's weights; no session can train a frontier model.
> Javelin treats any model (local Ollama, Groq, or your own endpoint) as a swappable engine.
> This is the same shape as Claude Code, Copilot and Codex.
>
> **Toward its own model.** A training pipeline is included: capture real Javelin runs, export them
> into a versioned dataset format, and fine-tune a base model on Javelin's policy (tool use,
> verify/repair, honesty). The result serves as a Javelin engine with **no runtime changes**.
> See [docs/TRAINING.md](docs/TRAINING.md) for what fine-tuning can and cannot do, and
> [docs/MODEL-IDENTITY.md](docs/MODEL-IDENTITY.md) for how Javelin's identity is kept separate
> from the tools it happens to be given.
>
> **Training honesty.** `npm run train:status` answers "do I have a trained model?" by checking
> files on disk, not by trusting a log. A run counts as trained only if the trainer exited 0 and a
> usable adapter exists. Nothing in this repo has been trained — no Python is installed here, and
> the runner refuses rather than pretending.

## Features
**Agent mode**

- **Inspect → plan → edit → verify loop** — the agent reads and searches code *before* changing it
- **Never overwrites blindly** — targeted `edit_file` by default; a whole-file `write_file` is
  refused if the file already exists unless explicitly forced
- **Approval gate with preview diffs** — every file change and every non-whitelisted command
  shows you the actual diff before it is applied. You can deny, or "always allow" for the run
- **Failure memory** — if an action fails, the agent is told *not* to repeat it and must change
  approach. Identical repeats of a failed call are blocked by the loop, not just discouraged
- **Checkpoints** — a safety checkpoint is taken **automatically before every run**, so a bad run is never final. Revert with one click, or accept and keep going
- **Accept or revert a run** — after any run that changed files you choose: **Accept all** or **Revert all**, restoring every changed file (and un-deleting removed ones) exactly as it was
- **Revert to your last message** — discard your last request *and everything after it*, restoring the files to before it ran. Your wording returns to the input box, so a rephrase is an edit, not a retype
- **Sees the whole project** — starts from `get_tree`, a nested view of every folder and file, instead of guessing paths one directory at a time
- **Task checklist** — a stated plan becomes a live checklist that ticks off as real work succeeds. A retry of a failed action never reads as progress
- **Stop button** — aborts the run mid-flight and unblocks any pending approval
- **Verified before "done"** — the agent reports what it actually ran; `finish` carries an
  explicit `verified` flag rather than assuming success
- **Command policy** — test/build/lint commands run by default; `rm -rf /`, `mkfs` and similar are
  hard-blocked and can never run
**Providers**

- **Local, keyless by default** — runs against [Ollama](https://ollama.com) on your machine. No
  API key, and your code never leaves the computer
- **Groq / OpenAI-compatible cloud** — opt-in, pluggable, for when you want a larger model
- **Custom endpoint** — point at LM Studio, vLLM, OpenRouter, or your own server
**Chat mode**

- Streaming responses, GitHub-flavored markdown, per-block Copy button, dark mode, persistence
## Getting Started
### Prerequisites
- Node.js (v18 or higher)
- npm
- **For the default keyless local model:** [Ollama](https://ollama.com/download), then:

  ```bash
  ollama pull qwen2.5-coder:7b
  ```

### Installation
```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:3000`.

### Configuration
Open **Settings** (gear icon). Provider defaults to **Local (keyless)** — click *Check local
runtime* to confirm Ollama is reachable. To use a cloud model instead, pick Groq and paste a free
key from <https://console.groq.com/keys>, or choose *Custom* and give it a base URL.

### Tests
```bash
npm test
```

Five suites, all deterministic and GPU-free:

| Suite | Proves |
|---|---|
| `agent-safety` | overwrite protection, edit guards, checkpoint revert, command policy, diffs |
| `agent-loop` | end-to-end loop with a scripted model: approvals, failure memory, abort |
| `javelin-core` | Core's lifecycle, self-correction, verification enforcement, memory |
| `training-pipeline` | traces captured from **real** runs export into valid training data |
| `trained-model` | a trained model drives the **unmodified** runtime as an engine |

### Training a model
```bash
npm run train:dataset                        # build a dataset (seeds)
npm run train:dataset --traces traces/    # or from captured real runs
npm run train:prepare --dataset datasets/x   # generate fine-tune config + scripts
```

Capturing real runs feeds the pipeline:

```js
import { createTraceRecorder } from './training/dataset/recorder.js'
const recorder = createTraceRecorder({ task })
await javelin.think({ task, workspace, onEvent: recorder.observe })
const trajectory = recorder.finish({ status, verified })   // → JDF, train-ready
```

The recorder is an **observer** on the existing event stream — it changes nothing in the runtime.
See [docs/TRAINING.md](docs/TRAINING.md).

## Getting Started

### Prerequisites

- Node.js (v18 or higher) — required for built-in `fetch` streaming
- npm

### Installation

```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:3000`.

### Configuration

Open **Settings** (gear icon, top right) and paste a free Groq API key from
<https://console.groq.com/keys>. You can also provide it at build time:

```bash
# .env.local
VITE_GROQ_API_KEY=gsk_...
```

> **Note:** the key is sent from the browser directly to Groq and stored in this browser's
> `localStorage`. That is fine for local/personal use, but for anything public you should proxy
> the request through your own backend so the key is never exposed to clients.

### Building for Production

```bash
npm run build     # outputs to dist/
npm run preview
```

## Usage
### Chat
1. Type a question, or pick an example prompt.
2. Press **Enter** to send (Shift+Enter for a newline).
3. Copy any code block with the **Copy** button in its header.

### Agent
1. Switch to the **Agent** tab.
2. In the web app, click **Import files** to give the agent a workspace. (A web page cannot read
   your disk, so the workspace is an explicit in-memory snapshot you control. The VS Code
   extension edits your real project directly — no import needed.)
3. Describe the task, e.g. *"Find the bug in the parser and fix it, then run the tests."*
4. Approve or deny each proposed change. Watch the step timeline for pass/fail per action.
5. If something goes wrong, click a checkpoint to revert, or **Stop** to halt the run.
6. **Export changes** downloads the resulting files.

### Javelin
1. Switch to the **Javelin** tab.
2. Import files (as in Agent mode) so Javelin has a workspace.
3. Describe the task. Javelin will run its own loop: understand → plan → act → verify → repair.
4. Watch the **phase rail** and the **plan card** to see what it decided and why.
5. When verification fails, a **diagnosis** appears — Javelin stated a cause before retrying.
6. Expand **Javelin system** to see engine health, memory counts and what it has learned about
   your project. Dead actions are listed there and will not be retried.

Javelin's learnings persist across sessions.

## Honest Limits
These are worth stating plainly rather than overselling:

- **"No API key" means a local model.** A 70B cloud model cannot run inside a browser tab or a
  VS Code webview — no amount of code changes that. Keyless mode therefore runs a local model via
  Ollama. Quality and speed scale with your hardware and the model you pull.
- **This is not a trained frontier model.** No coding session can train one; that takes large-scale
  GPU clusters and months. What makes Javelin feel capable is the *scaffolding*: tool use, the
  inspect/plan/verify loop, project context, and failure recovery. That is where most of the
  practical quality comes from, and it is real — but it is not the same thing as a 400B model.
- **The web app edits an imported snapshot, not your disk.** Browsers have no filesystem access.
  Use the VS Code extension for real files.
- **Agent output still needs review.** Every path is gated and revertible, but you are responsible
  for what ships.

## Tech Stack
| Layer | Choice |
|---|---|
| UI | React 18 |
| Build | Vite 5 |
| Styling | TailwindCSS (CSS-variable theming) |
| Icons | lucide-react |
| Markdown | react-markdown + remark-gfm |
| Inference | OpenAI-compatible HTTP (local via Ollama, or Groq/custom) |
| Diffs | built-in LCS diff (no dependency) |

## Project Structure
```
src/
├── App.jsx                      # chat + agent + Javelin screens, run state, persistence
├── core/                        # ← Javelin Core: the agent runtime itself
│   ├── index.js                 # public facade: createJavelin()
│   ├── runtime.js               # phase machine, tool dispatch, approval gating
│   ├── identity.js              # ← single source of Javelin's identity (identity vs tools)
│   ├── brain.js                 # planning, verification + repair policy
│   ├── memory.js                # project index, episodic + semantic memory
│   ├── engines.js               # swappable inference engines + registry
│   └── tools.js                 # tool registry with risk classes
├── hooks/
│   └── useJavelin.js            # binds Core to React (the only React-aware part)
├── components/
│   ├── AgentTimeline.jsx        # phase strip, step timeline, checkpoint bar
│   ├── JavelinPanel.jsx         # Core's phase rail, plan, steps, diagnostics
│   ├── ApprovalDialog.jsx       # approve/deny with a preview diff
│   ├── Button.jsx
│   ├── Card.jsx
│   ├── DiffView.jsx             # collapsible line-level diff renderer
│   ├── Markdown.jsx
│   ├── SettingsDialog.jsx       # provider, endpoint, key, model
│   └── Textarea.jsx
└── lib/
    ├── agent.js                 # the agent loop: plan/act/verify/recover
    ├── agentTools.js            # tool schemas, diff, command policy
    ├── providers.js             # provider registry + streaming client
    ├── virtualWorkspace.js      # in-memory workspace for the web build
    ├── ai.js                    # chat-mode helper (delegates to providers)
    └── utils.js

training/                        # ← the path toward Javelin's own model
├── build-dataset.mjs            # dataset builder CLI (npm run train:dataset)
├── train.mjs                    # training runner — records what actually happened
├── status.mjs                   # "do I have a trained model?" — checked against disk
├── provenance.mjs               # run ledger; refuses to claim an unfinished run
├── hardware.mjs                 # GPU/VRAM/ROCm detection + honest path advice
├── dataset/
│   ├── format.js                # JDF schema + validator (the contract)
│   ├── recorder.js              # observes Core runs → raw trajectories
│   ├── exporter.js              # trajectories → training examples (5 lesson types)
│   └── seeds.js                 # synthetic bootstrap corpus, labelled as such
└── finetune/
    ├── config.mjs               # LoRA/QLoRA config generator + train/merge scripts
    └── prepare.mjs              # prepare a run + honest environment/data checks

tests/
├── agent-safety.test.mjs        # overwrite/edit/checkpoint/command-policy/diff
├── agent-loop.test.mjs          # end-to-end loop with a scripted model
├── javelin-core.test.mjs        # Javelin Core lifecycle, memory, self-correction
├── training-pipeline.test.mjs   # capture → export → validate, against real runs
├── trained-model.test.mjs       # a trained model drives the unmodified runtime
└── run.mjs                      # bundling test runner (npm test)

docs/
├── JAVELIN-CORE.md              # architecture, memory model, honest limits
└── TRAINING.md                  # dataset format, fine-tune, from-scratch roadmap
```

## How the Agent Loop Works
Each step the model may call a tool. The loop is in `src/lib/agent.js`:

1. **Inspect** — `list_files` / `read_file` / `search_code` to understand the code first.
2. **Plan** — a short natural-language plan, surfaced in the UI.
3. **Act** — `edit_file` (targeted) or `write_file` (new files). Mutations pause for approval,
   with a preview diff attached to the request.
4. **Verify** — `run_command` for tests/build. Output and exit code feed back into the loop.
5. **Recover** — a failed call is recorded by signature. If the model tries the *same* call again,
   the loop refuses and injects a reminder instead of executing it.
6. **Finish** — `finish` ends the run with an honest summary and a `verified` flag.

A hard step cap (`MAX_STEPS`) prevents runaway loops.

## Also Included

`vscode-extension/` holds a companion VS Code extension that shares the same Groq backend but
runs inside the editor, with selection-aware context and insert-into-editor. See its own README.

## License

MIT
