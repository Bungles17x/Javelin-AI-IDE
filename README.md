# Javelin AI

Javelin is a self-hosted coding assistant and IDE. Chat, Agent, and Javelin Core run against a model served by Ollama on your own computer; the application does not send prompts or project files to hosted AI APIs.

## What “from scratch” means here

Javelin's IDE, agent runtime, project tools, and local integration are built in this repository. The included JavaScript model/training code is experimental and is **not** a capable coding model: it has not been trained to production quality. Training a useful base model from random weights requires very large datasets and substantial GPU compute. For useful local coding today, Javelin uses the locally installed `javelin-coder` Ollama model. This is local inference, not a hosted API.

## Three Modes

- **Chat** — ask questions, get streamed answers from your local model.
- **Agent** — give it a task. It inspects, plans, edits behind an approval gate, runs your tests,
  and fixes its own failures.
- **Javelin** — runs on **Javelin Core**, its own reasoning runtime: an explicit
  understand → plan → act → verify → repair lifecycle with persistent memory, a project index,
  hypothesis-driven self-correction, and the local Javelin model underneath.
  See [docs/JAVELIN-CORE.md](docs/JAVELIN-CORE.md).

## Requirements

- Node.js 18+ and npm
- [Ollama](https://ollama.com/) installed and running locally
- The `javelin-coder` model available to Ollama (several GB of disk and enough RAM for the selected model)

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
- **Live workspace updates** — files read by the agent open in the activity view; edits and new files appear in the Explorer/editor while the run is active
- **Live command output** — project commands stream stdout/stderr into the activity timeline; non-allowlisted commands pause for approval
- **Task checklist** — a stated plan becomes a live checklist that ticks off as real work succeeds. A retry of a failed action never reads as progress
- **Stop button** — aborts the run mid-flight and unblocks any pending approval
- **Verified before "done"** — the agent reports what it actually ran; `finish` carries an
  explicit `verified` flag rather than assuming success
- **Command policy** — commands follow the selected autonomy/approval setting; non-allow-listed commands always require approval. Destructive system commands such as `rm -rf /` and `mkfs` are hard-blocked
- **Bounded large-file diffs** — large edits use a linear-time preview path to avoid quadratic slowdowns while retaining changed lines and exact change counts
**Self-hosted AI**

- **Local inference by default** — the default endpoint is Ollama at `127.0.0.1:11434`
- **No hosted AI APIs** — remote endpoints are rejected by the desktop/web provider
- **Model stays local** — prompts, project context, and tool results go only to local Ollama
- **Offline after model installation** — no network access is needed for inference once the model is installed
**Chat mode**

- Streaming responses, GitHub-flavored markdown, per-block Copy button, dark mode, persistence
## Getting Started
### Standalone Desktop IDE (Windows)

Javelin is available as its own desktop IDE; Visual Studio Code is not required:

```powershell
npm install
npm run desktop:dev
```

In desktop development mode, renderer edits hot-reload through Vite. Changes to
Electron's `desktop/main.cjs`, `desktop/preload.cjs`, or
`desktop/textFileTypes.cjs` automatically restart the desktop shell. This
development watcher does not update an installed production copy; rebuild and
install that copy with the desktop build workflow.

To build the per-user Windows setup program:

```powershell
npm run desktop:build
```

The installer is created in `release/` as `Javelin AI IDE Setup <version>.exe`. The IDE includes a project explorer, Monaco code editor, and the Javelin chat/agent workspace. Open a project folder or create a new workspace from the Explorer; creating one asks you to choose its parent directory and a folder name, so you do not need an existing project. Javelin works only inside the selected workspace, and file changes remain approval-gated. Electron is isolated from the renderer, and filesystem access is limited to the folder selected by the user. Local model runtime and model weights remain separate downloads.

### Prerequisites
- Node.js (v18 or higher) and npm
- Ollama installed and running
- Javelin Coder installed in Ollama (`ollama list` should show `javelin-coder:latest`)

### Install and run
```bash
npm install
npm run dev
```

If Ollama does not already contain Javelin Coder, install Ollama and add the model using the model distribution provided with your Javelin build. The application does not silently substitute a cloud provider or train a toy model when the model is missing. The dev server runs on `http://localhost:3000`.

### VS Code Extension (Private Install)

To install the private Javelin AI Assistant extension into your local VS Code:

```bash
npm run install:extension
```

This verifies developer authorization (`lildc`), compiles the extension, packages the private `.vsix` archive, and installs it directly into VS Code.

### Windows IDE Installer

Build a distributable Windows setup executable from this checkout:

```powershell
npm run build:installer
```

The installer is written to `installer-output/Javelin-AI-IDE-Setup.exe`. It installs the Javelin extension into VS Code, installs the current-user VS Code build if one is not already present, and adds a Javelin AI IDE shortcut. The local model runtime and model weights are not bundled; install Ollama and the Javelin model using the instructions supplied with the model distribution. The VS Code extension starts Ollama on demand. This private build is restricted to the authorized `lildc` account.

### Configuration
Open **Settings** (gear icon) to select an installed local Ollama model. The default is
`javelin-coder:latest`. The desktop app discovers installed models at startup; install the
Javelin model separately if it is missing. No model is silently trained or replaced by a cloud service.

### Tests
```bash
npm test
```

The automated suites use scripted inference and run without a GPU. They validate orchestration and
tool behavior, not model quality:

| Suite | Proves |
|---|---|
| `agent-safety` | overwrite protection, edit guards, checkpoint revert, command policy, diffs |
| `agent-loop` | end-to-end loop with a scripted model: approvals, failure memory, abort |
| `javelin-core` | Core's lifecycle, self-correction, verification enforcement, memory |
| `training-pipeline` | traces captured from **real** runs export into valid training data |
| `trained-model` | a trained model drives the **unmodified** runtime as an engine |

### Agent training data
```bash
npm run train:dataset                        # build a dataset (seeds)
npm run train:dataset --traces traces/    # or from captured real runs
npm run train:prepare --dataset datasets/x   # generate fine-tune config + scripts
```

Capturing real runs can export trajectories for research and evaluation:

```js
import { createTraceRecorder } from './training/dataset/recorder.js'
const recorder = createTraceRecorder({ task })
await javelin.think({ task, workspace, onEvent: recorder.observe })
const trajectory = recorder.finish({ status, verified })   // → JDF, train-ready
```

The recorder is an **observer** on the existing event stream — it changes nothing in the runtime.
This pipeline does not train a capable language model. See [docs/TRAINING.md](docs/TRAINING.md).

## Getting Started

### Prerequisites

- Node.js (v18 or higher) — required for built-in `fetch` streaming
- npm
- Ollama running locally with `javelin-coder:latest` installed

### Installation

```bash
npm install
npm run dev
```

The dev server runs on `http://localhost:3000`.

### Configuration

Inference uses local Ollama at `127.0.0.1:11434`; it does not call a hosted AI API or require an API key.

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
├── ERROR-CODES.md               # every run failure code and what to check
├── JAVELIN-CORE.md              # architecture, memory model, honest limits
└── TRAINING.md                  # dataset format, fine-tune, from-scratch roadmap
```

## How the Agent Loop Works
Each step the model may call a tool. The engine lives in `src/engine/`; `src/lib/agent.js`
is the stable entry point the IDE and the tests import:

0. **Checkpoint** — before the first tool call the engine snapshots the workspace. The run
   result exposes that `baseline` id, so Revert works even when a run fails halfway.
1. **Inspect** — `list_files` / `read_file` / `search_code` to understand the code first, plus
   `project_overview` and `find_references` for the indexed architecture, imports and reverse
   dependencies. The prompt starts with a bounded project map; file contents are only read on demand.
2. **Plan** — a short natural-language plan, surfaced in the UI.
3. **Act** — `edit_file` (targeted), `write_file` (new files), or `append_file` (extending a file
   chunk by chunk). Mutations pause for approval, with a preview diff attached to the request.
4. **Verify** — `verify_project` runs the project's own test/typecheck/lint/build scripts, and
   `run_command` covers anything else. Output and exit codes feed back into the loop; in the IDE,
   a change is checked automatically before `finish` is accepted. A failed check goes back to the
   model as evidence to fix, not as a success.
5. **Recover** — a failed call is recorded by signature. If the model tries the *same* call again,
   the loop refuses and injects a reminder instead of executing it; repeated failures require a
   root-cause hypothesis before the next attempt.
6. **Finish** — `finish` ends the run with an honest summary. The result is classified by evidence:
   `verified` (a real check passed after the last change), `likely` (verified writes, no passing
   check), or `unverified` (failed/stopped/no evidence). A model's `verified: true` claim cannot
   override that classification.

Runaway loops are prevented by several independent bounds, not just one: a step cap
(`MAX_STEPS`, 40 — enough to scaffold and verify a multi-file project), repeated-action and
no-action limits, a stalled-step limit, a wall-clock budget, and duplicate-call blocking keyed
to workspace progress.

Large files are built in chunks: `append_file` extends a file instead of replacing it, so a
model with a small output limit can still produce a long file over several small, verifiable
calls. Reads of large files say how many lines the file has and instruct the model to
`read_file` with `start`/`end` for the rest, so big files stay editable rather than half-seen. A call blocked for lack of
progress becomes legal again as soon as a different action really changes the workspace, which
is what makes verify → fix → verify work without allowing infinite retries.

### Engine layout

| Module | Responsibility |
| --- | --- |
| `src/engine/providers.js` | Model transport: SSE streaming, tool-call assembly, local/hosted policy, retries, timeouts, usage |
| `src/engine/memory.js` | Bounded transcript, attempt ledger, per-path read cache, metrics |
| `src/engine/tools.js` | Tool schema binding, execution, approval keys, post-write verification, project tools |
| `src/engine/projectIndex.js` | Project index, imports/reverse dependencies, architecture context, export/import checks, verification-command detection |
| `src/engine/reasoning.js` | System prompt, task framing, plan extraction, completion rules |
| `src/engine/run.js` | The orchestrator: phase machine, guards, budgets, events |
| `src/engine/limits.js` | Every numeric bound in one place |
| `src/engine/index.js` | Public API (`runAgent`, transport, memory helpers) |

### Models: local and hosted

Local models run through Ollama and stay on this machine: the transport refuses any non-loopback
URL for a local provider and never attaches a credential. Hosted providers (OpenAI, Groq, Together,
OpenRouter, or any OpenAI-compatible endpoint) must be selected explicitly, use `https`, and carry
their own API key. Both paths share one streaming transport, so tool calling, verification and
the loop guards are identical either way.

### Error codes

Every run that fails or stops early reports a stable code next to its summary — `ER.0203` when
the model repeats itself, `ER.0103` for a timeout, `ER.0102` for a rejected API key, and so on.
The code appears in the run result panel, the final message, the status line, and on thrown
provider errors. The full list, with what to check for each, is in
[docs/ERROR-CODES.md](docs/ERROR-CODES.md).

## Also Included

`vscode-extension/` holds a companion VS Code extension that shares the same Groq backend but
runs inside the editor, with selection-aware context and insert-into-editor. See its own README.

## License

MIT
