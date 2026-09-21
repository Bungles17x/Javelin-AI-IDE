# Javelin Model Identity

What "Javelin's own model" means concretely, why the identity is split in two, and
what the training pipeline guarantees about honesty.

---

## The problem this solves

Javelin's identity was written out in **four places**, and they had drifted. The
training seed prompt was a *shortened copy* of the runtime prompt.

That is a real bug, not untidiness. A model fine-tuned against one identity would be
**served** with a different one, so the fine-tune would spend its capacity fighting
its own system prompt. The model would behave worse than the base it was built from,
with nothing to indicate why.

There is now **one source of truth**: `src/core/identity.js`. Everything else imports
from it, and a test enforces that they cannot diverge again.

---

## Identity vs. capability: the central distinction

A recurring failure in agent models is **baking tool names into the model's
personality**. The model then "knows" it has a `read_file` tool, becomes confused when
a different harness supplies different tools, and cannot be reused outside the exact
runtime it was trained against.

So the identity is composed from two independent layers:

| Layer | What it is | Changes? | Trained in? |
|---|---|
| **`MODEL_IDENTITY`** | Who Javelin *is* — the disposition, the standards, the honesty | Almost never | **Yes** |
| **`AGENT_CONTRACT`** | What Javelin can *do right now* — this session's actual tools | Every session | **No** |

```
composeIdentity({ toolNames, canExecuteCommands, canWriteFiles })
        │
        ├── MODEL_IDENTITY          ← durable character, no tool names
        │     + MODEL_PRINCIPLES
        │
        └── AGENT_CONTRACT          ← injected per run from the real tool registry
              "Available tools: read_file, edit_file, ..."
```

### Why this matters for an independent model

Because the fine-tune learns **behaviour, not bindings**, the resulting model:

- Keeps its character when the toolset changes
- Works in a different harness without retraining
- Cannot hallucinate tools it has not been given (the contract states the real list)
- States plainly when it has *no* tools, rather than pretending it can act

`IDENTITY_TRAINING_PROMPT` deliberately excludes the contract, so the training target
contains no tool names at all. A test asserts this.

---

## Training must not claim what it didn't do

> **A run counts as trained only if the trainer exited 0 *and* a usable adapter
> exists on disk.**

Launched ≠ trained. A half-written adapter is worse than none: it loads, it behaves
badly, and nothing indicates why. So every run writes a provenance record in an
explicit state machine:

```
planned → started → completed | failed | interrupted
```

| State | Means |
|---|---|
| `started` | A crash left evidence that something was attempted but not finished |
| `completed` | Trainer exited 0 **and** a real adapter was verified on disk |
| `failed` | Non-zero exit, missing artifacts, or a preflight rejection |
| `interrupted` | Killed by a signal — distinct from failure |

`verifyProvenance()` **corroborates the record against the filesystem**. A provenance
file is a claim; this checks it. `looksLikeUsableAdapter()` requires both
`adapter_config.json` and a weight file, so a stray log file is not mistaken for a
model.

### Identity drift

The record stores the identity fingerprint at training time. If the identity changes
afterwards, the model is flagged as **drifted** — trained against a character it is no
longer being served with. That is worth knowing rather than silently tolerating.

---

## Commands

```bash
npm run train:status     # do I actually have a trained model? yes/no, with proof
```

Sample output when nothing has been trained:

```
Trained model
  [not     ] javelin-lora
             training did not complete (state: failed) — spawn python ENOENT

Verdict
  NO trained Javelin model.
  No run has completed successfully. Do not serve anything as "Javelin".
```

```bash
# The full path
npm run train:dataset                                   # 1. build a dataset
npm run train:prepare --dataset datasets/<name>         # 2. generate config
npm run train:run --run training/runs/javelin-lora      # 3. train (records truth)
npm run train:status                                    # 4. verify honestly
```

The runner writes provenance **before** preflight, so even an early failure is
recorded. An absent record is then unambiguously "never attempted".

---

## Verification

`tests/identity-provenance.test.mjs` locks in both guarantees:

- inference and training use the **same** identity (the drift bug cannot return)
- the identity contains **no tool names**; the contract contains them
- a contract adapts to the session (read-only, no-tools, no-shell each differ)
- a started / failed / interrupted run is **never** reported as trained
- exit code 0 with a missing adapter is **refused** as a completion
- a non-zero exit cannot be recorded as success even with a valid adapter present
- a real completion **is** recognised, with files listed and identity recorded
- a missing provenance record reports "nothing was trained here"

---

## Honest limits

- **No model has been trained in this repository.** No Python or PyTorch is installed
  here. The pipeline is built and tested; the training run is not executed. `train:run`
  refuses rather than pretending.
- **A trained adapter is not automatically a good model.** Run
  `reportEngineFitness()` before trusting one. An adapter that regressed is worse
  than no adapter.
- **Identity sharing does not make the model "Javelin's own" in the weights sense.**
  It adapts a base model's behaviour. The base weights remain someone else's. What
  Javelin owns is the identity, the runtime, the memory and the tools.
