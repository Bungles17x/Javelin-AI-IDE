# Javelin AI Architecture

This document describes the complete architecture of Javelin AI as an independent AI ecosystem.

## Overview

Javelin AI consists of several interconnected components that work together to provide a complete, independent AI system:

```
┌─────────────────────────────────────────────────────────────┐
│                     Javelin AI Ecosystem                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Website    │  │   IDE        │  │   Browser    │      │
│  │   (React)    │  │  (Electron)  │  │  Extension  │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │                 │
│         └─────────────────┼─────────────────┘                 │
│                           │                                   │
│                  ┌────────▼────────┐                          │
│                  │  Javelin Core   │                          │
│                  │  (Runtime)      │                          │
│                  └────────┬────────┘                          │
│                           │                                   │
│                  ┌────────▼────────┐                          │
│                  │  Local Model    │                          │
│                  │  (Inference)    │                          │
│                  └────────┬────────┘                          │
│                           │                                   │
│                  ┌────────▼────────┐                          │
│                  │  Model Files    │                          │
│                  │  (Weights)      │                          │
│                  └─────────────────┘                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Component Details

### 1. User Interfaces

#### Website (React + Vite)
- **Purpose**: Main web interface for chat, agent, and Javelin modes
- **Tech Stack**: React 18, TailwindCSS, Vite
- **Features**:
  - Modern AI conversation interface
  - Streaming responses
  - Conversation history and search
  - Memory dashboard
  - Model management UI
  - Settings and configuration
- **Location**: `src/`, `src/components/`

#### IDE (Electron)
- **Purpose**: Standalone desktop development environment
- **Tech Stack**: Electron, Monaco Editor
- **Features**:
  - Code editor with syntax highlighting
  - File explorer
  - Integrated terminal
  - Project management
  - Git integration
  - Direct Javelin Core integration
- **Location**: `desktop/`

#### Browser Extension
- **Purpose**: Browser-integrated AI assistant
- **Tech Stack**: Chrome Extension API
- **Features**:
  - Popup assistant
  - Side panel (where supported)
  - Page summarization
  - Text explanation
  - Context extraction
  - Local model communication
- **Location**: `vscode-extension/` (VS Code extension - browser extension separate)

### 2. Javelin Core

The central reasoning system that powers all interfaces.

#### Components

**Runtime** (`src/core/runtime.js`)
- Phase machine: Understand → Plan → Act → Verify → Repair
- Tool dispatch and execution
- Approval gating
- Abort handling
- State management

**Memory** (`src/core/memory.js`)
- Project index (files, languages, symbols)
- Episodic memory (actions, outcomes, failures)
- Semantic memory (durable facts with confidence decay)
- Failure tracking (dead actions)

**Tools** (`src/core/tools.js`)
- Tool registry with risk classes
- File operations (read, write, search)
- Command execution with policy
- Permission system
- Safety guards

**Brain** (`src/core/brain.js`)
- Planning heuristics
- Verification policy
- Repair logic
- Hypothesis extraction
- Honesty policy

**Engines** (`src/core/engines.js`)
- Engine registry
- Health checking
- Capability detection
- Swappable inference backends

### 3. Local Model System

The independent model infrastructure.

#### Model Architecture (`local-model/model.js`)
- **Type**: Transformer-based neural network
- **Components**:
  - Multi-head attention
  - Feed-forward networks
  - Layer normalization
  - Position embeddings
  - Output projection
- **Configurations**: Small (256d), Default (512d), Large (768d)

#### Tokenizer (`local-model/tokenizer.js`)
- **Type**: BPE-style subword tokenizer
- **Features**:
  - Trainable from corpus
  - Special tokens (BOS, EOS, PAD, UNK)
  - Efficient encoding/decoding
  - Fallback simple tokenizer

#### Inference Engine (`local-model/inference.js`)
- **Purpose**: Run model inference
- **Features**:
  - Autoregressive generation
  - Sampling strategies (greedy, top-k, top-p)
  - Temperature control
  - Streaming output
  - Tool call detection

#### Training Pipeline (`local-model/training.js`)
- **Purpose**: Train/fine-tune models
- **Features**:
  - Dataset loading
  - Forward/backward pass
  - Loss computation
  - Adam optimizer
  - Checkpointing
  - Validation

#### Adapter (`local-model/adapter.js`)
- **Purpose**: Integrate with Javelin Core
- **Features**:
  - Engine interface compatibility
  - Model loading/saving
  - Health checking
  - Fallback to untrained mode

### 4. Data Flow

#### Chat Flow
```
User Input → Website → Javelin Core → Local Model → Response → Website → User
```

#### Agent Flow
```
Task → Javelin Core → Plan → Tools → Actions → Verify → Repair → Result
                              ↓
                        Local Model
```

#### Training Flow
```
Dataset → Training Pipeline → Model Weights → Model File → Inference
```

### 5. Offline Operation

Once a model is trained, Javelin operates completely offline:

1. **Model Weights**: Stored locally in `models/` directory
2. **Inference**: All computation happens locally
3. **No Network**: No external API calls or data transmission
4. **Data Privacy**: All data remains on your machine

### 6. Security

- **Local-First**: No cloud dependencies by default
- **No API Keys**: No credentials required
- **Permission Checks**: Tool execution gated by user approval
- **Command Policy**: Destructive commands hard-blocked
- **Input Validation**: All inputs validated before processing
- **Safe File Operations**: File operations constrained to allowed paths

### 7. Extensibility

#### Adding New Tools
1. Define tool schema in `src/core/tools.js`
2. Implement tool logic
3. Register with appropriate risk class
4. Update approval policy if needed

#### Adding New Model Architectures
1. Implement model class in `local-model/model.js`
2. Add configuration in `local-model/config.js`
3. Update training pipeline if needed
4. Register in adapter

#### Adding New Interfaces
1. Import Javelin Core
2. Create UI components
3. Connect to Core via `createJavelin()`
4. Handle events and state

### 8. Agent Engine (`src/engine`)

The Agent mode in the IDE is driven by Javelin's own engine. It is independent of any vendor SDK:
the only thing it needs from a model is an OpenAI-compatible streaming endpoint, which Ollama
provides locally and hosted providers provide over HTTPS.

```
task ─▶ reasoning.js ─▶ run.js ──▶ providers.js ──▶ model
                          │  ▲
                  tools.js│  │memory.js
                          ▼  │
                     workspace / approvals / events
```

**Transport (`providers.js`)**
- One streaming code path for every model: SSE parsing, incremental tool-call assembly,
  salvage of tool calls a small model narrated instead of structuring, and single-JSON
  responses from servers that ignore `stream: true`.
- Policy is enforced before the request: a local provider may only reach a loopback address and
  is never sent a credential; a hosted provider needs an explicit id, `https`, and a key.
- Bounded retries with jittered backoff for 408/409/425/429/5xx and network errors, an idle
  timeout that aborts a stalled stream, and a total-request timeout. Every read is raced
  against the abort signal so a body that ignores the controller cannot hang a run.
- Usage (`prompt_tokens` / `completion_tokens`) is captured when the server reports it.

**Memory (`memory.js`)**
- The transcript is bounded by a character budget. Oversized tool output is compacted first,
  then older turns are replaced by markers; if that is still not enough, the largest remaining
  content is shrunk to a readable head. Messages are never removed, so every assistant
  `tool_calls` keeps its adjacent `tool` results — the protocol stays valid.
- An attempt ledger records each tool signature with the workspace progress version. Repeating
  a call with an unchanged workspace is blocked; the same call after real progress is allowed.
- A per-path read cache (60 s, revision-checked) removes redundant file I/O without ever serving
  content invalidated by a write. Editing one file does not discard another file's cached read.

**Tools (`tools.js`)** — schema binding, argument canonicalisation, command policy, approval
keys, output truncation, and verification of mutations by re-reading the workspace afterwards.

**Project intelligence (`projectIndex.js`)** — a dependency-free structural index built from the
live workspace before the first turn: languages, top-level layout, stack and scripts, entry points,
per-file symbols, local imports resolved to real paths, and the reverse dependency graph. A bounded
`PROJECT CONTEXT` block selects only the files relevant to the task (names, symbols and imports),
so a large repository does not fill the model window. The same index powers `project_overview`,
`find_references`, unresolved-import checks after every change, and the project's real verification
commands (`test`, `typecheck`, `lint`, `build`) used by `verify_project`.

**Evidence and confidence** — every run records what was actually read, searched and executed, and
takes a safety checkpoint before the first tool call. A result is labelled `verified` only when a real
check passed after the last change; otherwise it is `likely` (writes verified on disk, no passing
check) or `unverified` (failed/aborted/no evidence). A model claiming `verified: true` without such a
check is downgraded, with a `verification_required` event and an explicit note. Unresolved local
imports are reported as warnings rather than silently accepted.

**Reasoning (`reasoning.js`)** — the system prompt, task framing, plan extraction, the finish
gate (`finish` is refused while a change task has no successful mutation), and the failure
reminders that replace silently repeated calls. The prompt requires file:line evidence, root-cause
analysis, and one of three confidence labels instead of unqualified claims.

**Orchestrator (`run.js`)** — a phase machine (inspect → plan → act → verify) with hard budgets:
step count, repeated actions, no-action turns, identical responses, stalled steps, and wall-clock
time. Independent read-only calls in one turn run concurrently and their results are reported in
call order; mutations stay strictly sequential. Runs return a summary, steps, checkpoints,
touched files and additive metrics (model calls, retries, cached reads, duplicates blocked,
pruned messages, tokens, model latency, duration). Every ending that is not a clean finish reports a
stable code (`ER.NNNN`) on the result and on its `error` event; the catalog is `src/engine/errors.js`
and is documented in `docs/ERROR-CODES.md`.

## Honest Limitations

### Model Training
- **Not Pre-Trained**: Model starts untrained; requires substantial training
- **Training Time**: Useful models need days/weeks of training
- **Hardware**: GPU strongly recommended for practical training
- **Data Quality**: Model quality depends on training data quality

### Inference Speed
- **CPU Inference**: Slow for large models
- **GPU Required**: For production-speed inference
- **Browser**: Limited by WebAssembly/WebGPU support

### Scalability
- **Single Machine**: Not designed for distributed training
- **Memory**: Model size limited by available RAM/VRAM
- **Dataset Size**: Training on massive datasets requires GPU cluster

## Future Enhancements

Potential improvements:
- WebGPU acceleration for browser inference
- Quantization for faster/smaller models
- LoRA adapters for efficient fine-tuning
- Distributed training support
- Model compression
- Knowledge distillation
- Multi-modal support (images, audio)

## License

MIT License - See LICENSE file
