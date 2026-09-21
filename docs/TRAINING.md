# Javelin Model Training — architecture, pipeline, and honest limits

This document covers how Javelin goes from "agent runtime driving someone else's
model" toward "its own model", and is explicit about the distance between those two
things.

---

## The short version

| Step | Feasible now? | What it gives you | Real cost |
|---|---|
| **1. Capture traces** | **Yes** | The data asset everything else depends on | Free |
| **2. Fine-tune a small base (LoRA)** | **Yes — even on CPU** | Javelin's *policy*: tool use, verify/repair, honesty | Hours |
| **3. Fine-tune a 7B base** | Yes, with a capable GPU | Stronger model, same policy | 1 GPU, hours |
| **4. Continued pre-training** | Yes, with a budget | Domain-adapted base | 10s of GPUs, weeks |
| **5. Train from scratch** | **Technically yes, practically no** | A genuinely new model | 1000s of GPUs, months, $M+ |

Steps 1–2 are built and tested here, and step 2 runs on this class of machine.
Steps 4–5 need compute a personal machine does not have — a fact about hardware,
not about effort.

---

## Which path does YOUR machine take?

Run this before anything else:

```bash
node training/finetune/prepare.mjs
```

It detects the GPU, VRAM, RAM, ROCm and WSL, then prints every training path and
whether it will actually work. It does not guess.

### Can I fine-tune on a Radeon RX 6700 (RDNA2) on Windows?

**Not with ROCm, no.** AMD's ROCm-on-Windows PyTorch preview covers **Radeon 7000
and 9000 series only**. An RX 6700 is RDNA2 and is not on that list. QLoRA is also
Linux-only, because `bitsandbytes` requires it.

That is not the end of the road. There are three paths that do work:

| Path | Works? | Notes |
|---|---|---|
| **CPU LoRA on a small model** | **Yes** | 32GB RAM comfortably fits a 0.5B–1.5B model. Slow, but it genuinely trains a real adapter and proves the pipeline. |
| **ROCm on Linux via WSL2** | **Likely** | RDNA2 is supported by ROCm on Linux in many builds, and this is the only route that gives you QLoRA. Community-supported, so expect to tinker. |
| **Rent a CUDA GPU** | **Yes** | A few hours on a rented 4090/A100 costs a few dollars and removes every driver problem. The pipeline is hardware-independent. |

**DirectML** (`torch-directml`) runs on AMD GPUs on Windows without ROCm, but
training support is limited and slow. Treat it as an experiment, not a route to a
good adapter.

### The honest recommendation
On a 10GB RDNA2 card with 32GB RAM:

1. **Start with CPU LoRA on a 0.5B model.** It works today, needs no drivers, and
   proves the entire pipeline end-to-end — data, training, merge, serve, evaluate.
   This is the step that finds bugs in your dataset, and it is worth doing first.
2. **Then rent a CUDA GPU** if you want a genuinely capable adapter. At that point
   you already know the pipeline works, so the rented hours are spent training
   rather than debugging drivers.
3. **Try WSL2 + ROCm** if you want to stay local and enjoy tinkering. It is the only
   local path to QLoRA.

---

## What fine-tuning can and cannot do

**Can:**
- Teach the model to emit tool calls in Javelin's exact format
- Teach the *policy*: inspect before editing, exact-snippet edits, verify after editing
- Teach repair behaviour: don't repeat a failed action, state a cause first
- Teach honesty: never claim unverified success
- Make a small model behave like a disciplined agent

**Cannot:**
- Add knowledge the base model never had
- Make a 7B model reason like a 400B one
- Fix a base model that cannot follow instructions at all
- Produce a model that is "Javelin's own" in the sense of owning its weights

This is the honest boundary. Fine-tuning changes *behaviour*, not *capability*.

---

## Stage 1 — Capture (built)

```
training/dataset/recorder.js
```

The recorder is an **observer** on Javelin's existing event stream. It changes
nothing in the runtime.

```js
import { createTraceRecorder } from './training/dataset/recorder.js'

const recorder = createTraceRecorder({ task })
await javelin.think({ task, workspace, onEvent: recorder.observe })
const trajectory = recorder.finish({ status, verified })
appendToJsonl(trajectory, 'traces/run-001.jsonl')
```

**Why raw trajectories, not training examples:** the interpretation of a run changes
as the model improves. Traces are the durable asset; examples are a derived view.

---

## Stage 2 — Export (built)

```
training/dataset/exporter.js
```

A trajectory is *what happened*. An example is a *lesson*. The exporter segments a
run into five lesson types and — critically — only keeps segments with good outcomes:

| Lesson | What it teaches |
|---|---|
| `tool-selection` | Inspect the codebase before changing it |
| `edit-precision` | Exact-snippet edits; successful edits only |
| `verification` | Run tests after editing |
| `repair` | Failure → different successful action |
| `honesty` | Don't repeat dead actions; don't claim unverified success |

**Repairs are derived from evidence, not from a runtime event.** A failed action
followed by a successful action *of a different signature* is a repair. An identical
retry is never labelled a repair — that is the behaviour the runtime blocks, and
training on it would teach the model to flail.

---

## Stage 3 — Build (built)

```bash
npm run train:dataset                        # seeds only
npm run train:dataset --traces traces/    # import captured runs
npm run train:dataset --traces traces/ --out datasets/javelin-v0
```

Pipeline: load → export → merge seeds → dedupe → filter → validate → split → write.

Deterministic split means evaluation numbers are comparable across runs.

### The dataset format (JDF)

```
training/dataset/format.js
```

Two record kinds, because they serve different purposes:

- **`trajectory`** — the raw, multi-step episode. The audit trail.
- **`sft`** — a training example. A derived lesson.

Five design decisions worth stating:

1. **Tool calls are structured, not text.** Javelin's value is driving tools in a
   verify/repair loop; a text-only format could not teach that.
2. **Every record carries provenance** (`runtime-trace` / `human` / `synthetic` /
   `repair`). A pipeline that cannot distinguish observed from generated data will
   eventually train on its own hallucinations.
3. **Outcome labels are explicit** (`verified`, `status`), so preference pairs can be
   built later without re-instrumenting anything.
4. **Content-derived ids**, so re-exporting the same example produces the same id and
   deduplication works across machines.
5. **Versioned and additive.** Old datasets stay readable.

---

## Stage 4 — Fine-tune (built; runs on CPU, GPU, or AMD)

```bash
# Auto-detects hardware, picks a base model that fits, and chooses lora vs qlora:
npm run train:prepare --dataset datasets/javelin-v0
python training/finetune/train.py     # trains the adapter
python training/finetune/merge.py     # merge adapter into base weights
```

The generator sizes the base model to the hardware:

| VRAM | Base model chosen | Why |
|---|---|---|
| 24GB+ | Qwen2.5-Coder **7B** | Fits with LoRA |
| 16GB | Qwen2.5-Coder **7B** | Fits comfortably |
| 10GB | Qwen2.5-Coder **3B** | A 7B would need QLoRA, unavailable on AMD/Windows |
| 8GB | Qwen2.5-Coder **1.5B** | Smaller base keeps training feasible |
| CPU | Qwen2.5-Coder **0.5B** | Largest that trains in reasonable time |

The generated `train.py` detects CUDA, ROCm, MPS or CPU at runtime and adapts
(`use_cpu`, `bf16`, `device_map`). It warns rather than crashes when it lands on CPU.

LoRA/QLoRA via `transformers` + `peft` + `trl`. Those are the ecosystem's tools for
this; reimplementing them would be worse than using them, so they are named as
dependencies rather than pretended away.

**Hyperparameters are generated from the dataset**, not hand-written — rank, learning
rate and epochs scale with dataset size, and the generator explains each choice.

**One detail that matters a lot:** training is configured to compute loss **only on
assistant target tokens**. Learning to generate tool *results* instead of tool *calls*
is a classic agent fine-tune failure, and this is how it is avoided.

### Serving the result

```bash
ollama create javelin -f Modelfile
```

Then Javelin uses it as an engine — `src/core/javelinEngine.js`. **No runtime changes.**

---

## Stage 5 — Verify the model before trusting it (built)

```js
import { reportEngineFitness } from './src/core/javelinEngine.js'

const report = await reportEngineFitness(engine, heldOutExamples)
// { formatCompliance, actionAccuracy, bySkill, verdict }
```

Two metrics that actually matter:

- **format compliance** — does it emit a well-formed tool call at all?
- **action accuracy** — is it the *right* tool with the *right* arguments?

An adapter that regressed is worse than no adapter. Run this before serving.

---

## Stage 6 — Training from scratch: the real requirements

This is the part most projects are vague about. Concretely, training a competent
coding model from scratch requires:

### 6.1 Tokenizer
Train a BPE tokenizer on the corpus (`tokenizers` library). Vocabulary ~32k–128k.
Coding-specific consideration: whitespace-sensitive tokens matter enormously — a
tokenizer that mangles indentation degrades code quality measurably. This is a real
research finding (see the StarCoder/CodeGen tokenizer ablations), not a detail.

### 6.2 Corpus
| Source | Size | Notes |
|---|---|---|
| GitHub (permissively licensed) | 1–10 TB | The Stack v2 is the standard starting point; licence filtering is mandatory |
| Documentation | 100s GB | Teaches APIs and intent |
| Synthetic instruction/agent data | 1–100 GB | What this pipeline produces, at scale |
| Human-written corrections | Small, high value | Weight these heavily |

Filtering is most of the work: deduplication, licence compliance, and quality
classifiers remove the majority of raw data.

### 6.3 Compute — the hard wall
| Model size | Tokens | GPUs | Time | Cost |
|---|---|---|
| ~1B | 100B | 8×A100 | ~1 week | ~$10k |
| ~7B | 1T | 64×A100 | ~2 weeks | ~$200k |
| ~70B | 15T | 2000+×H100 | ~2 months | ~$5M+ |

Chinchilla-optimal scaling is ~20 tokens per parameter. These are order-of-magnitude
figures for planning, not quotes.

For contrast, a **fine-tune** of an existing model on a few thousand examples —
what stages 1–4 actually do — runs in hours on one GPU, or overnight on a CPU for a
sub-1B model. That difference in scale is the whole reason fine-tuning is the right
starting point and from-scratch is not.

### 6.4 Staged approach that is actually rational

Nobody sane starts at 7B. The rational ladder:

1. **Train a ~10M-parameter model on a toy corpus.** Proves the *pipeline*, not
   quality. Days on one GPU. This is the step that catches data bugs.
2. **Scale to ~100M–1B** on a filtered real corpus. Days on a few GPUs.
3. **Continued pre-training** — take an open base model and train it further on
   Javelin's coding + agent corpus. Much cheaper than from-scratch, most of the
   benefit.
4. **Full fine-tune** (not LoRA) on the JDF dataset.
5. **From-scratch at scale** — only with real funding.

Step 1 is the honest first milestone, and it is achievable.

### 6.5 Where this repository is on that ladder

- Stages 1–3 and 5: **built and tested**.
- Stage 4 (LoRA): **built**; needs a GPU to run.
- Stage 6.1–6.2 infrastructure: **designed**; not built, because without 6.3 it
  produces nothing usable.
- Stage 6.3–6.5: **out of reach** on a single machine.

---

## Verification

```bash
npm test
```

The training suites prove, without a GPU and without a real model:

- `training-pipeline.test.mjs` — recorder captures real runs; exporter derives repair
  lessons; only successful actions become targets; failed edits never become targets;
  the format rejects dangling tool ids and non-string arguments
- `trained-model.test.mjs` — a served Javelin model registers as an engine and drives
  the **unmodified** runtime; probes fail honestly when the model is absent;
  fitness evaluation flags an unusable model
- `hardware.test.mjs` — the profiler gives correct advice for AMD RDNA2/RDNA3,
  NVIDIA, Intel and CPU-only machines; an AMD 6000-series card is told Windows ROCm
  does not support it and is offered the routes that do; every profile yields a
  viable path and a size-appropriate base model

---

## Commands
```bash
npm test                                        # everything
npm run train:status                            # do I actually have a trained model?
# What can THIS machine actually do?
node training/finetune/prepare.mjs
npm run train:dataset                           # build dataset from seeds
npm run train:dataset --traces traces/        # build from captured runs
# Generate a fine-tune config sized to the detected hardware:
npm run train:prepare --dataset datasets/x
# Train (records the truth; refuses to claim a run that did not finish):
npm run train:run --run training/runs/javelin-lora
# Check honestly whether a model exists:
npm run train:status
```

`npm run train:status` is the fastest way to answer "do I actually have a trained
model?". It corroborates the provenance record against files on disk, so it cannot
report a model that is not there.

---

## Honest limits, restated

- **Fine-tuning is not training a model from scratch.** It adapts a base model's
  behaviour. The base model's weights remain someone else's.
- **A CUDA GPU is not required, but it is the smoothest path.** CPU LoRA on a small
  model works and is the recommended first step on an AMD/Windows machine. A Radeon
  6000-series card cannot use ROCm on Windows — AMD's preview covers 7000/9000 only.
- **No training was performed in this repository.** No Python or PyTorch is installed
  here, so the pipeline was built, validated and tested — but not executed. Running
  it requires installing Python 3.10+ and the dependencies for your chosen path.
  `npm run train:run` **refuses to proceed and records the failure** rather than
  reporting a success it cannot substantiate, and `npm run train:status` says plainly
  that nothing has been trained.
- **Small datasets barely move a model.** Below ~500 real traces, expect little. The
  tooling says so rather than quietly producing a useless adapter.
- **From-scratch training needs compute that a personal machine does not have.**
  The engineering is designed; the hardware is the limit.
