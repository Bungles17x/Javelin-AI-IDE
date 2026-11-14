# Javelin AI Assistant — VS Code Extension
An autonomous coding agent that lives in your editor's sidebar. It can inspect your real
workspace, plan changes, edit files behind an approval gate, run your tests, and recover from its
own failures.

Runs against your **self-hosted Javelin model by default** using the local Ollama runtime.
The extension only offers local providers and blocks remote provider requests; no cloud AI
API or API key is used.

## Features
**Agent mode (new)**
- **Real workspace** — reads and edits your actual project files, not a snapshot
- **Inspect → plan → edit → verify** — the agent searches and reads before it writes
- **No blind overwrites** — targeted edits by default; whole-file writes require an explicit flag
- **Approval gate with preview diffs** — see exactly what will change before it happens, with
  "always allow" for the rest of the run if you trust it
- **Runs your tests** — executes test/build/lint in a real terminal and reads the exit code
- **Failure memory** — a failed action is never repeated identically; the agent must change tack
- **Checkpoints** — snapshot before risky work, restore from the panel or the Command Palette
- **Stop button** — halts the run and unblocks any pending approval
- **Command policy** — destructive commands (`rm -rf /`, `mkfs`, …) are hard-blocked
**Chat mode**
- **Streaming responses** with a Stop button
- **Code blocks with actions** — every fenced block gets **Copy** and **Insert**
- **Selection-aware** — select code, right-click → *Ask About Selection*
- **Local-only inference** — prompts and project context are sent only to Ollama on this machine
- **Safe rendering** — markdown is escaped, under a strict nonce-based CSP
- **In-editor theming** — picks up your VS Code theme colors

## Installation

### One-Click Private Install (Recommended)

Run from the root directory:

```bash
npm run install:extension
```

This verifies developer authorization (`lildc`), compiles the extension, packages the private `.vsix`, and installs it directly into your local VS Code instance.

### From source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host window, and open the
Javelin AI icon in the activity bar.

## Setup
**Javelin, self-hosted (default).** No API key required. The extension starts Ollama on
this machine when needed and uses the installed Javelin model:

```bash
ollama list
```

Install [Ollama](https://ollama.com/download) and install the Javelin Coder model using the
instructions supplied with your model distribution.
The model runs on your machine; model downloads are only needed once, and inference does not
send prompts or project files to a hosted AI service. You can choose another Ollama model using
**Javelin AI: Select Model Provider** and the `javelin.model` setting.

## Commands

| Command | What it does |
|---|---|
| `Javelin AI: Open Assistant` | Focus the sidebar panel |
| `Javelin AI: Run Agent Task…` | Prompt for a task and run the autonomous agent |
| `Javelin AI: Stop Agent` | Halt the running agent |
| `Javelin AI: Revert All Changes (undo last run)` | Undo every change the last run made, back to how the workspace was before it started |
| `Javelin AI: Accept All Changes (keep last run)` | Keep the last run's changes and retire the revert offer |
| `Javelin AI: Revert to My Last Message (undo chat and files)` | Truncate the conversation back to your last message and restore the files to before it ran |
| `Javelin AI: Restore Checkpoint…` | Pick a checkpoint and revert the workspace to it |
| `Javelin AI: Select Model Provider` | Choose the self-hosted Javelin model or another local Ollama model |
| `Javelin AI: Ask About Selection` | Attach the current selection and ask about it (also on the editor right-click menu) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `javelin.provider` | `javelin` | Self-hosted Javelin or local Ollama; remote providers are disabled |
| `javelin.baseUrl` | `""` | Local Ollama endpoint override; must remain on localhost port 11434 |
| `javelin.model` | `javelin-coder:latest` | Installed local Ollama model tag |
| `javelin.autonomy` | `ask` | How much runs unprompted: `ask` (everything asks), `auto-edit` (edits apply, deleting a file still asks), `full` (edits and deletes run unattended) |
| `javelin.agentAutoApproveSafeCommands` | `true` | Skip the prompt for test/build/lint. Under `ask`, file edits always ask. |
| `javelin.agentMaxSteps` | `24` | Step cap before the agent stops and reports back |

### File permissions
Deleting a file is the one irreversible action, so it is gated more tightly than
editing and can never be blanket-approved:

| Action | `ask` | `auto-edit` | `full` |
|---|---|---|---|
| Read / search | auto | auto | auto |
| Edit or add a file | asks | auto | auto |
| Delete a file | asks | **asks** (per file) | auto |
| Test / build / lint | auto | auto | auto |
| Other commands | asks | asks | auto |
| Catastrophic command | refused | refused | refused |

Choosing **always allow** on a deletion only covers *that* file — it does not become
permission to delete anything else.

### Accept or revert a run

Every run takes a **safety checkpoint automatically**, before the first tool call — you
do not have to trust the agent to remember one. When a run changes files you are
offered two buttons, and the same actions are in the Command Palette:

- **Accept all** — keep the changes.
- **Revert all** — put every changed file back exactly as it was before the run, no
  matter how badly the run went.

This is why a bad run cannot corrupt your project: the escape hatch is created before
the agent starts, not by the agent's own good judgement. If the workspace cannot be
snapshotted, the run **refuses to edit anything** rather than proceeding unprotected.

**Revert to your last message** goes further: it removes that message and everything
after it from the conversation *and* restores the files to before it ran. Your wording
comes back in the input box, so the usual fix for a badly-phrased request — "say it
again, differently" — does not mean retyping it.

### Seeing the project, and what Javelin plans to do

The agent starts by reading the **project tree** (`get_tree`), which shows every folder
and file nested to a depth limit — so it grounds itself in the real layout instead of
guessing at paths one directory at a time. When it states a plan, that plan is turned
into a **task checklist** that ticks off as real work succeeds. Steps are only marked
done on success: a retry of a failed action never reads as progress.

## Honest limits

- **Inference stays local.** The extension restricts model requests to the local Ollama endpoint;
  it does not send prompts or project context to cloud AI providers.
- **This is not a trained frontier model.** The capability comes from the agent scaffolding — tool
  use, the inspect/verify loop, and failure recovery — not from bespoke training.
- **Review agent output.** Every change is gated, diffed and revertible, but you own what ships.

## Development

### Project structure

```
vscode-extension/
├── src/
│   ├── extension.ts     # activation, command registration
│   ├── JavelinPanel.ts  # webview: chat + agent UI, approvals, diffs, checkpoints
│   ├── agent.ts         # the agent loop and command execution
│   ├── workspace.ts     # real-filesystem adapter + LCS diff
│   ├── providers.ts     # provider registry + streaming client
│   ├── aiService.ts     # chat-mode helper (delegates to providers)
│   └── getNonce.ts      # CSP nonce generator
├── package.json         # extension manifest
└── tsconfig.json
```

> The agent loop is shared in shape with the web build in `src/lib/agent.js`; the difference is
> that this one calls real filesystem and terminal primitives.

### Scripts

- `npm run compile` — type-check and emit to `out/`
- `npm run watch` — recompile on change
- `npm run lint` — ESLint

> `fetch` streaming requires a VS Code build running on Node 18+ (VS Code 1.85+ satisfies this).

## Security

- Inference requests are restricted to Ollama on `localhost:11434`; remote AI endpoints are blocked
- The extension does not store or send AI API keys
- The webview runs under `default-src 'none'` with a per-load script nonce
- All model output is HTML-escaped before rendering, so generated code cannot inject markup
- No telemetry is collected; optional update checks contact GitHub when configured

## License

MIT
