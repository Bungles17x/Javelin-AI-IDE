# Javelin AI Assistant — VS Code Extension
An autonomous coding agent that lives in your editor's sidebar. It can inspect your real
workspace, plan changes, edit files behind an approval gate, run your tests, and recover from its
own failures.

Runs **keyless by default** against a local model (Ollama). Cloud inference (Groq or any
OpenAI-compatible endpoint) is opt-in.

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
- **Encrypted key storage** — API keys go into VS Code's `SecretStorage`, not plain-text settings
- **Safe rendering** — markdown is escaped, under a strict nonce-based CSP
- **In-editor theming** — picks up your VS Code theme colors

## Installation

### From source

```bash
cd vscode-extension
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host window, and open the
Javelin AI icon in the activity bar.

## Setup
**Local, keyless (default).** No API key required:

```bash
ollama pull qwen2.5-coder:7b
```

Install [Ollama](https://ollama.com/download), pull a model, and you're done. Model quality and
speed depend on your hardware — a smaller model is a reasonable trade for staying offline.

**Cloud (optional).** Run **Javelin AI: Select Model Provider** → *Groq*, then
**Javelin AI: Set API Key** and paste a free key from <https://console.groq.com/keys>. The key is
stored encrypted in `SecretStorage`, never in your settings file.

**Custom.** Point `javelin.baseUrl` at any OpenAI-compatible `/v1` endpoint (LM Studio, vLLM,
OpenRouter, your own server) and select the *Custom* provider.

> **Note:** cloud free tiers are rate-limited. On a `429`, wait or switch to a smaller/local model.

## Commands

| Command | What it does |
|---|---|
| `Javelin AI: Open Assistant` | Focus the sidebar panel |
| `Javelin AI: Run Agent Task…` | Prompt for a task and run the autonomous agent |
| `Javelin AI: Stop Agent` | Halt the running agent |
| `Javelin AI: Restore Checkpoint…` | Pick a checkpoint and revert the workspace to it |
| `Javelin AI: Select Model Provider` | Choose local / Groq / custom |
| `Javelin AI: Set API Key` | Store or clear the cloud API key |
| `Javelin AI: Ask About Selection` | Attach the current selection and ask about it (also on the editor right-click menu) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `javelin.provider` | `local` | Where the model runs: `local`, `groq`, or `custom` |
| `javelin.baseUrl` | `""` | Endpoint override; blank uses the provider default |
| `javelin.model` | `qwen2.5-coder:7b` | Model id (an Ollama tag for local models) |
| `javelin.groqApiKey` | `""` | Fallback key, used only if no key is in SecretStorage |
| `javelin.agentAutoApproveSafeCommands` | `true` | Skip the prompt for test/build/lint. File edits always ask. |
| `javelin.agentMaxSteps` | `24` | Step cap before the agent stops and reports back |

## Honest limits

- **Keyless means local.** A large cloud model cannot run inside a webview; keyless mode runs a
  local model via Ollama instead.
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

- API keys are stored in VS Code's encrypted `SecretStorage`
- The webview runs under `default-src 'none'` with a per-load script nonce
- All model output is HTML-escaped before rendering, so generated code cannot inject markup
- The only network call is to `api.groq.com`; no telemetry

## License

MIT
