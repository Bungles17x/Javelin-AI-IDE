# Your Own Javelin Model — the local runbook

How to end up with a model that is **yours**, runs **on your machine**, and gets
**better the more you use it** — without pretending any of it is more than it is.

---

## Read this first: three different things are called "your model"

They are not the same, and confusing them is how people end up disappointed.

| What | What it really is | Ready in | Cost |
|---|---|
| **Derived model** | Your identity, running over a stock base model | **minutes** | free |
| **Trained model** | Your behaviour, learned from your own runs | **days–weeks of use** | free (local) or a few $ (rented) |
| **Flagship (80B)** | A large, genuinely powerful model | **needs a datacentre GPU** | hundreds–thousands of $ |

**The honest ceiling:** a model as capable as a frontier assistant cannot run on a
10GB consumer card. That is a hardware fact, not a tuning problem. What you *can* own
and run locally is a solid, tool-driving coder — and you can train it on your own work
so it reflects how *you* code.

---

## Part 1 — A derived model you can run today (minutes)

Build a Javelin-branded model on top of a local coder base:

```bash
npm run model:local
```

This creates `javelin-coder` in your local runtime, with Javelin's identity as the
system prompt. It is a **derived** model — the weights are the base author's; what is
yours is the identity, the runtime, the tools and the memory.

Use it:
- In the app: Provider **Local (keyless)**, Model **Javelin Coder (local, built here)**.
- From a terminal: `ollama run javelin-coder` (or your configured runtime).

**What this is good for:** tool-calling file work, with your identity and standards,
keyless and offline. **What it is not:** a frontier model.

---

## Part 2 — Make it *learn from you* (the part that compounds)

A fine-tune is only as good as its training data, and the only honest source of that
data is **your real runs**. So Javelin can record them automatically.

### Turn on auto-capture

Every run is written as a JDF trajectory — the task, every tool call, its exact
arguments, the outputs, the failures, the repair — when capture is enabled:

```js
await javelin.think({
  task,
  workspace,
  autoCapture: true,        // opt-in. Off by default.
  captureDir: 'traces',     // where trajectories land
})
```

Auto-capture is **off unless you ask for it**, and a failure to write a trace
**never** fails your task. It is an observation, not a requirement.

### Or capture explicitly

```bash
npm run capture --task "Fix the bug in calc.js" --workspace ./my-project
npm run capture --tasks tasks.jsonl          # one {"task": "..."} per line
```

Both write the same format, so they mix freely.

### Turn traces into training data

```bash
npm run train:dataset --traces traces --out datasets/javelin-real
```

This does not naively replay whole runs (that would teach the model to fail). It
**segments** each trajectory into lessons and keeps only good ones:

- **tool-selection** — look before you leap
- **edit-precision** — successful edits, with exact snippets
- **verification** — running tests after editing
- **repair** — a failure, the diagnosis, and the *successful different* action after it
- **honesty** — refusing to repeat a dead action, refusing to claim unverified success

A failed repair is **never** exported as a correct answer.

**Data reality:** each productive run yields roughly 2–5 examples. A fine-tune worth
running wants **hundreds to thousands**. That is ~200–500 real runs — days or weeks of
normal use, not an afternoon. The exporter will warn you when the data is too thin.

---

## Part 3 — Train it (needs a GPU)

```bash
npm run train:prepare --dataset datasets/javelin-real
npm run train:run --run training/runs/javelin-lora
npm run train:status          # confirms it actually trained, with proof
```

- On **CPU**, a small model (≤ ~1.5B) trains but produces a weak coder.
- On a **rented GPU** (a few dollars for a few hours), a 7B fine-tune is realistic and
  the pipeline is hardware-independent — see `docs/TRAINING.md`.

`train:status` will only ever say *trained* if the trainer exited 0 **and** a usable
adapter exists on disk. Launched ≠ trained.

### Merge and serve it with Javelin's own server (no Ollama)

```bash
python training/finetune/merge.py     # adapter → standalone weights
npm run serve:model                   # Javelin's own OpenAI-compatible server
```

Then select provider **Javelin (self-hosted)** in the app.

**Be clear about the boundary:** a language model's matrix math cannot run in
JavaScript — it needs a native backend (CUDA/ROCm/Metal/CPU kernels). `serve:model`
runs that backend *itself* (via `llama-server`) or proxies to one you already run.
It is Javelin's serving layer, not a reimplementation of CUDA. If no backend exists,
it says so and stops — it does not pretend to run a model it cannot.

---

## Part 4 — Power when you need it

Owning the runtime is the point: the **same agent loop** drives a local 7B or a
frontier cloud model. Nothing else changes.

- Provider **Local (keyless)** → fast, private, modest capability.
- Provider **Groq / Custom** → maximum capability, your code leaves the machine.
- Provider **Javelin (self-hosted)** → your own trained weights, served by you.

"Your own AI" is not one checkpoint. It is the identity, the tools, the memory, the
traces and the runtime — all yours — with the engine swappable underneath.

---

## Honest limits (the ones that matter)

- **A trained adapter is not automatically a good model.** Run `reportEngineFitness()`
  before trusting one. An adapter that regressed is worse than none.
- **Derived ≠ trained.** `npm run model:local` sets a system prompt; it does not change
  weights. `npm run models` labels the difference so you never have to guess.
- **80B does not fit here.** `npm run models -- javelin-coder-80b` will tell you what it
  actually requires and why this machine cannot train it.
- **Garbage in, garbage out.** Traces from failed or half-finished work teach failure.
  The exporter filters aggressively, but the quality of your runs sets the ceiling.

---

## The whole path, at a glance

```bash
npm run model:local                                  # 1. run your own model now
npm run capture --task "..." --workspace ./project   # 2. record real runs (or autoCapture)
npm run train:dataset --traces traces --out datasets/javelin-real   # 3. lessons
npm run train:prepare --dataset datasets/javelin-real               # 4. config (needs GPU)
npm run train:run --run training/runs/javelin-lora                  # 5. train
python training/finetune/merge.py                                   # 6. merge
npm run serve:model                                                 # 7. serve it yourself
npm run models                                      # 8. check what is really built
```
