# Javelin Chatting Knowledge — training your own chat model

This directory trains a model you own the adapter for, on how a careful engineer
works, and runs entirely on this machine. No GPU, no cloud account, no Ollama.

```bash
npm run train:knowledge        # build the corpus   -> datasets/knowledge/
npm run train:knowledge:run    # train the adapter  -> training/knowledge/out/
npm run chat:knowledge -- "how do you approach a strange codebase"   # talk to it
npm run serve:knowledge        # serve it on http://127.0.0.1:8787/v1
```

## What is actually being trained

A LoRA adapter on **Qwen2.5-Coder-1.5B-Instruct** (1.55B parameters, 4.36M trainable),
on a 60-example corpus of engineering answers written for this project. The corpus is
grouped by topic — `method`, `code`, `testing`, `git`, `security`, `performance`,
`architecture`, `agent` — and split deterministically so the validation set is a
real held-out set, not a reshuffle.

Two choices worth knowing about:

- **Answers state a method, not a fact.** A sub-1B model cannot hold an encyclopaedia,
  but it can learn a way of working: measure before optimising, reproduce before
  fixing, never claim a check you did not run.
- **Loss is computed on assistant tokens only** (`labels = -100` for the prompt). If
  you skip this, the model learns to generate the question too and answers itself.

## Measured result on this machine

CPU (Ryzen 7 5800XT, 8 threads, 32 GB RAM), 49 train / 11 validation examples:

| Model | Epochs | Rank | LR | Val loss | Wall time |
|---|---|---|---|---|---|
| SmolLM2-135M, untrained | — | — | — | 4.2877 | — |
| SmolLM2-135M adapter | 25 (kept epoch 23) | 16 | 1e-4 | 3.6670 | 659 s |
| Qwen2.5-Coder-0.5B, untrained | — | — | — | 4.2271 | — |
| Qwen2.5-Coder-0.5B adapter — **Javelin Chatting Knowledge** | 10 | 16 | 1e-4 | 3.4747 | 640 s |
| Qwen2.5-Coder-1.5B, untrained | — | — | — | 3.8795 | — |
| Qwen2.5-Coder-1.5B adapter — **Javelin Coder 1.5B** (default) | 6 | 16 | 1e-4 | **3.1423** | 891 s |

## Serving speed: llama.cpp instead of PyTorch

The Python server generates on CPU at about 2.7 tokens/s for the 1.5B model, which is
fine for a reply and painful for an agent loop. The same weights converted to a
Q4_K_M GGUF and served by llama.cpp measured **18.2 tokens/s** (first token in
~0.05 s) on this machine — the app calls it the same way, on the same port.

`npm run serve:knowledge` now starts llama.cpp when `tools/llama/llama-server.exe`
and `training/knowledge/gguf/` exist, and falls back to the Python server otherwise.
`npm run serve:knowledge:python` always uses Python.

Both model ids are served from one router process, so `javelin-coder-1.5b` and
`javelin-knowledge` keep working:

```bash
# once, to produce the two GGUF files (already present in this checkout)
.venv/Scripts/python.exe training/knowledge/merge_adapter.py
.venv/Scripts/python.exe training/knowledge/merge_adapter.py \
  --base Qwen/Qwen2.5-Coder-0.5B-Instruct --adapter training/knowledge/out \
  --out training/knowledge/merged-knowledge-0.5b
.venv/Scripts/python.exe tools/llama-src/convert_hf_to_gguf.py \
  training/knowledge/merged-coder-1.5b --outfile training/knowledge/coder-1.5b-f16.gguf --outtype f16
.venv/Scripts/python.exe tools/llama-src/convert_hf_to_gguf.py \
  training/knowledge/merged-knowledge-0.5b --outfile training/knowledge/knowledge-0.5b-f16.gguf --outtype f16
tools/llama/llama-quantize.exe training/knowledge/coder-1.5b-f16.gguf \
  training/knowledge/gguf/javelin-coder-1.5b.gguf Q4_K_M
tools/llama/llama-quantize.exe training/knowledge/knowledge-0.5b-f16.gguf \
  training/knowledge/gguf/javelin-knowledge.gguf Q4_K_M
```

A 1.5B model is still a 1.5B model: speed is fixed, breadth of capability is not.
For 3D scenes and complete applications, use a hosted model — the local models are
for offline, private, small edits.

Three adapters are kept: `out/` is **Javelin Chatting Knowledge** (0.5B), `out-1.5b/`
is **Javelin Coder 1.5B** and the default in the app, `out-135m/` the earlier 135M run.
Both are served from the same endpoint and chosen by model id:

- `javelin-knowledge` → Chatting Knowledge (0.5B, loads in seconds)
- `javelin-coder-1.5b` → Coder 1.5B (better at code, ~1 GB more RAM)
The server reads the base model from `out/adapter_config.json`, so an adapter can
never be served on the wrong base — that mismatch produces garbage, not an error.

`out/report.json` always holds the numbers, the per-epoch history, and the same five
held-out prompts answered **before** and **after** training. Compare the two answers
yourself — that is the only honest way to judge whether it improved.

### The overfitting result worth keeping

An earlier run at rank 32 / LR 3e-4 for 40 epochs hit **val 3.6573 at epoch 4** and
then went *up* every epoch while training loss fell (3.29 → 2.44): with 49 examples
the model was memorising, not learning. The script now keeps the best-generalising
weights and stops when validation stops improving. That single change is why the
saved adapter is epoch 23 rather than epoch 25 of a run that had stopped improving.

## What this can and cannot do

**Can:** reproduce the voice and the structure of the answers it was trained on, run
offline, answer without a key, and be extended with more data or a bigger base at
any time. In practice: fluent, grammatical answers that follow the *shape* of the
training answers while still getting specifics wrong.

Example, question not in the corpus: "Should I use Redis for caching session data?"

> Redis is not a cache. It's a database. The point is to store data, not retrieve it.

Confident, clean, and wrong. The 135M model answered this same question with a
rambling paragraph that never landed on a claim; the 0.5B model produces a sharp but
incorrect one. Fluency arrived before accuracy, which is the usual order.

More data moves accuracy slowly; a bigger base model moves it quickly.

**Cannot:** reason like a large model, know facts that are not in the corpus, or act
as a coding agent that drives tools. A 0.5B model is a demonstration of the pipeline
and a personal assistant for the things it was taught — not a replacement for the
hosted model the IDE defaults to.

Scaling up is a config change, not a rewrite: `--base Qwen/Qwen2.5-Coder-1.5B-Instruct`
with the same corpus and script is how the 1.5B model was produced (891 s on CPU); a 3B
base fits the same script and needs roughly twice that time, still with no GPU.

## Files

| File | Purpose |
|---|---|
| `build-knowledge-dataset.mjs` | Curated corpus → chat-format JSONL + manifest |
| `train_lora.py` | CPU LoRA training, assistant-only loss, before/after sampling |
| `serve.py` | OpenAI-compatible `/v1/chat/completions` over the merged adapter |
| `out/` | Adapter weights, tokenizer, `report.json` (generated) |
