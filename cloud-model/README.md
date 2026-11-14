# Javelin Cloud — your model, your endpoint

A GPU host serving **your** merged weights behind an OpenAI-compatible HTTPS API.
The IDE points at it and nothing else is in the request path: no Gemini, no Groq, no
proxy deciding what model answers.

```bash
# 1. train larger, on a GPU (hours instead of days)
python training/knowledge/train_lora.py --device cuda \
    --base Qwen/Qwen2.5-Coder-7B-Instruct \
    --data datasets/knowledge --out training/knowledge/out-7b --epochs 3 --rank 32

# 2. fold the adapter into full weights
npm run model:merge -- --adapter training/knowledge/out-7b --out models/javelin-cloud

# 3. serve it (any GPU box, or a managed host — see below)
docker build -t javelin-cloud .
docker run --gpus all -p 8000:8000 \
  -e MODEL_ID=/models/javelin-cloud -e JAVELIN_API_KEY=change-me \
  -v "$PWD/models/javelin-cloud:/models/javelin-cloud:ro" javelin-cloud
```

Then in the IDE: **Settings → Provider → Javelin Hosted (your own GPU model)**

| Field | Value |
|---|---|
| Base URL | `https://your-host.example.com/v1` |
| Model | `Javelin 7B` / `Javelin 14B` (`javelin-7b` / `javelin-14b`) |
| API key | the `JAVELIN_API_KEY` you set |

`Custom OpenAI-compatible endpoint` also works and is the right choice for any other
server (LM Studio, llama.cpp, vLLM). `Javelin Hosted` exists so the model picker
lists the 7B/14B names you actually deployed.

That's the whole integration. `src/lib/providers.js` already requires `https:` for a
remote endpoint, sends `Authorization: Bearer`, and streams SSE — vLLM speaks that.

## Be clear about "no other AI"

Two different claims, and only one is achievable on a personal budget:

| Claim | Reality |
|---|---|
| **No other AI serves your requests** | **True here.** The container loads your merged weights; no vendor model is called. |
| **The weights are 100% yours** | **Not literally.** A fine-tune inherits its base model's knowledge. Qwen's weights are Apache-2.0, so you may host, rename and sell the result, but the base was trained by someone else. |

Training a competent base from scratch needs thousands of GPU-months (see
`docs/TRAINING.md` §6). What you get by hosting a merged fine-tune is a model you
control, with no third party in the loop — which is what actually matters for
privacy, cost and being able to say "this is mine".

## What size to run

| Base | Weights (bf16) | Fits on | Speed | Notes |
|---|---|---|---|---|
| 0.5B (current) | ~1 GB | anything | very fast | a CPU serves this; a GPU is overkill |
| 3B | ~6 GB | 8–12 GB | fast | first size that follows instructions reliably |
| **7B** | ~15 GB | **24 GB** (A10G, L4, 4090) | ~1 s/turn | the sweet spot: agent-grade on one card |
| **14B** | ~28 GB | **40 GB** (A100) or 2×24 GB | ~2 s/turn | better reasoning, double the cost |

Weights alone are not the whole budget: vLLM reserves KV cache on top, which is why
14B wants a 40 GB card rather than a 32 GB one at useful context lengths. On two
24 GB cards, set `TP_SIZE=2` for tensor parallelism.

`--max-model-len 8192` in `start.sh` is what lets the agent send real file context.
Two concurrent requests on a 24 GB card is realistic; vLLM batches them.

## 7B and 14B, end to end

```bash
# 7B — the one to actually ship
npm run model:train:7b      # LoRA on a 24 GB card, ~1-3 hours for 3 epochs
npm run model:merge:7b      # -> models/javelin-7b (bf16, ~15 GB)

# 14B — needs 40 GB, or 2x24 GB with TP_SIZE=2
npm run model:train:14b
npm run model:merge:14b     # -> models/javelin-14b (~28 GB)
```

Both presets use `--rank 32 --batch-size 1 --grad-accum 8`, which fits a single
24 GB card and keeps the effective batch at 8. If you rent a bigger card, raise
`--batch-size` before raising the learning rate.

Serve whichever you merged:

```bash
docker build -t javelin-cloud ./cloud-model
docker run --gpus all -p 8000:8000 \
  -e MODEL_ID=/models/javelin-7b -e SERVED_NAME=javelin-7b \
  -e JAVELIN_API_KEY=change-me \
  -v "$PWD/models/javelin-7b:/models/javelin-7b:ro" javelin-cloud
```

Then **Settings → Javelin Hosted (your own GPU model)**, paste the https URL and the
key, and pick **Javelin 7B** or **Javelin 14B** from the model list. The served name
must match the model id in that list, or the server will answer 404 for it.

## Where to run it

Any of these run this image unchanged:

- **Baseten** — managed, GPU-backed, OpenAI-compatible endpoint, scale-to-zero option. `baseten/config.yaml` is ready to deploy with Truss.
- **RunPod / Vast.ai** — rent a GPU by the hour, run the container, expose the port.
- **Modal** — serverless, pay per second of GPU time.
- **A GPU VM you already pay for** — `docker run` and put TLS in front (Caddy or Cloudflare Tunnel).

Costs are order $0.4–$1.5 per GPU-hour for a 16–24 GB card. A 7B model answers a
chat turn in about a second on those, versus ~20 seconds on this CPU.

## The honest tradeoff

Every option above needs an account and a payment method. There is no free tier that
serves a 7B model continuously — the arithmetic doesn't allow it. If free is a hard
requirement, the realistic version is: keep the 0.5B local (free, slow, small), and
spend a few dollars a week on a GPU endpoint for the hours you actually work.
