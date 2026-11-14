"""
Train Javelin's knowledge adapter on CPU.
=========================================

A real LoRA fine-tune of a small instruct model, sized so it finishes on an 8-core
desktop with no GPU. It is deliberately boring: no trainer framework, no distributed
anything, one file you can read in five minutes.

    .venv/Scripts/python.exe training/knowledge/train_lora.py \
        --data datasets/knowledge --out training/knowledge/out --epochs 4

Two details that decide whether the result is usable:

1. **Loss is computed on assistant tokens only.** If you train on the whole
   conversation the model learns to generate the *user's question too*, and it will
   happily answer itself. The labels for system/user tokens are set to -100.

2. **The chat template comes from the tokenizer**, so training and inference agree.
   A hand-written template that differs by one newline produces a model that looks
   fine in the loss curve and rambles in the app.

The script reports loss before and after, plus sample generations from held-out
prompts, because a loss number alone is not evidence of anything.
"""

import argparse
import json
import math
import os
import random
import sys
import time

import torch
from torch.utils.data import DataLoader, Dataset


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


class ChatDataset(Dataset):
    """Tokenises chat records, masking everything that is not the assistant's reply."""

    def __init__(self, rows, tokenizer, max_len=512):
        self.items = []
        self.skipped = 0
        for row in rows:
            messages = row["messages"]
            try:
                full = tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=False
                )
                prompt_only = tokenizer.apply_chat_template(
                    messages[:-1], tokenize=False, add_generation_prompt=True
                )
            except Exception:
                self.skipped += 1
                continue

            full_ids = tokenizer(full, add_special_tokens=False)["input_ids"]
            prompt_ids = tokenizer(prompt_only, add_special_tokens=False)["input_ids"]

            if len(full_ids) < 2 or len(full_ids) > max_len:
                self.skipped += 1
                continue

            # Labels: -100 for the prompt, real ids for the reply.
            n_prompt = min(len(prompt_ids), len(full_ids) - 1)
            labels = [-100] * n_prompt + full_ids[n_prompt:]
            if all(l == -100 for l in labels):
                self.skipped += 1
                continue

            self.items.append(
                {
                    "input_ids": torch.tensor(full_ids, dtype=torch.long),
                    "labels": torch.tensor(labels, dtype=torch.long),
                }
            )

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


def collate(batch, pad_id):
    width = max(len(b["input_ids"]) for b in batch)
    input_ids, labels, attention = [], [], []
    for b in batch:
        pad = width - len(b["input_ids"])
        input_ids.append(torch.cat([b["input_ids"], torch.full((pad,), pad_id, dtype=torch.long)]))
        labels.append(torch.cat([b["labels"], torch.full((pad,), -100, dtype=torch.long)]))
        attention.append(torch.cat([torch.ones(len(b["input_ids"]), dtype=torch.long), torch.zeros(pad, dtype=torch.long)]))
    return {
        "input_ids": torch.stack(input_ids),
        "labels": torch.stack(labels),
        "attention_mask": torch.stack(attention),
    }


@torch.no_grad()
def evaluate(model, loader):
    model.eval()
    total, count = 0.0, 0
    for batch in loader:
        batch = {k: v.to(next(model.parameters()).device) for k, v in batch.items()}
        out = model(**batch)
        total += out.loss.item()
        count += 1
    model.train()
    return total / max(count, 1)


@torch.no_grad()
def sample(model, tokenizer, prompts, max_new_tokens=120):
    model.eval()
    results = []
    for prompt in prompts:
        messages = [
            {"role": "system", "content": "You are Javelin, a senior software engineer working inside a code editor. You answer with a concrete method, state uncertainty plainly, and never claim work you did not do."},
            {"role": "user", "content": prompt},
        ]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        ids = tokenizer(text, return_tensors="pt", add_special_tokens=False)
        ids = {k: v.to(next(model.parameters()).device) for k, v in ids.items()}
        out = model.generate(
            **ids,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=0.7,
            top_p=0.9,
            repetition_penalty=1.15,
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )
        generated = out[0][ids["input_ids"].shape[1]:]
        results.append({"prompt": prompt, "answer": tokenizer.decode(generated, skip_special_tokens=True).strip()})
    model.train()
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="HuggingFaceTB/SmolLM2-135M-Instruct")
    ap.add_argument("--data", default="datasets/knowledge")
    ap.add_argument("--out", default="training/knowledge/out")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--patience", type=int, default=3,
                    help="stop when validation loss has not improved for this many epochs")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"],
                    help="auto uses a CUDA GPU when one is present, otherwise CPU")
    ap.add_argument("--seed", type=int, default=1337)
    ap.add_argument("--no-train", action="store_true", help="load and sample only")
    ap.add_argument("--report-only", action="store_true",
                    help="measure an already-saved adapter and rewrite its report.json")
    ap.add_argument("--report-seconds", type=float, default=0.0,
                    help="wall time of the original run, for the report")
    args = ap.parse_args()

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    from transformers import AutoModelForCausalLM, AutoTokenizer

    # GPU when there is one. This matters more than any hyperparameter: the same
    # 7B adapter that takes days on this CPU trains in under an hour on one rented
    # card, and bf16 is what makes it fit.
    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        print("No CUDA device available; falling back to CPU.")
        device = "cpu"
    dtype = torch.float32
    if device == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16

    print(f"\n=== Javelin Chatting Knowledge adapter ===")
    print(f"base      {args.base}")
    if device == "cuda":
        print(f"device    {torch.cuda.get_device_name(0)} ({str(dtype).replace('torch.', '')})")
    else:
        print(f"device    cpu (threads={torch.get_num_threads()})")
    print(f"data      {args.data}")

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(args.base, dtype=dtype).to(device)

    train_rows = read_jsonl(os.path.join(args.data, "train.jsonl"))
    val_rows = read_jsonl(os.path.join(args.data, "validation.jsonl"))

    train_ds = ChatDataset(train_rows, tokenizer, args.max_len)
    val_ds = ChatDataset(val_rows, tokenizer, args.max_len)
    print(f"examples  {len(train_ds)} train / {len(val_ds)} validation ({train_ds.skipped} too long or malformed)")

    if len(train_ds) == 0:
        print("No usable training examples. Aborting rather than reporting a fake run.")
        sys.exit(1)

    train_loader = DataLoader(
        train_ds, batch_size=args.batch_size, shuffle=True,
        collate_fn=lambda b: collate(b, tokenizer.pad_token_id),
    )
    val_loader = DataLoader(
        val_ds, batch_size=args.batch_size, shuffle=False,
        collate_fn=lambda b: collate(b, tokenizer.pad_token_id),
    )

    held_out = [r["messages"][1]["content"] for r in val_rows[:5]]
    before_samples = sample(model, tokenizer, held_out) if held_out else []
    before_loss = evaluate(model, val_loader) if len(val_ds) else float("nan")
    print(f"val loss before  {before_loss:.4f}  (perplexity {math.exp(min(before_loss, 20)):.1f})")

    if args.report_only:
        from peft import PeftModel

        print(f"report-only: measuring the saved adapter in {args.out}", flush=True)
        model = PeftModel.from_pretrained(model, args.out)
        model = model.merge_and_unload()
        model.eval()
        after_loss = evaluate(model, val_loader) if len(val_ds) else float("nan")
        after_samples = sample(model, tokenizer, held_out) if held_out else []
        write_report(args, before_loss, after_loss, before_samples, after_samples,
                     args.report_seconds, len(train_ds), len(val_ds), device=device)
        print(f"val loss {before_loss:.4f} -> {after_loss:.4f}", flush=True)
        return

    if args.no_train:
        write_report(args, before_loss, before_loss, before_samples, before_samples, 0.0, len(train_ds), len(val_ds), device=device)
        return

    from peft import LoraConfig, get_peft_model

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    optim = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)
    total_steps = max(1, math.ceil(len(train_loader) / args.grad_accum) * args.epochs)
    warmup = max(1, int(total_steps * 0.06))
    sched = torch.optim.lr_scheduler.LambdaLR(
        optim,
        lambda s: min((s + 1) / warmup, max(0.0, (total_steps - s) / max(1, total_steps - warmup))),
    )

    model.train()
    started = time.time()
    step = 0
    history = []
    best_val = float("inf")
    best_epoch = 0
    best_state = None
    stale = 0
    for epoch in range(args.epochs):
        running, seen = 0.0, 0
        for i, batch in enumerate(train_loader):
            batch = {k: v.to(device) for k, v in batch.items()}
            out = model(**batch)
            loss = out.loss / args.grad_accum
            loss.backward()
            running += out.loss.item()
            seen += 1
            if (i + 1) % args.grad_accum == 0 or i + 1 == len(train_loader):
                torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
                optim.step()
                sched.step()
                optim.zero_grad(set_to_none=True)
                step += 1
                if step % 5 == 0 or step == 1:
                    elapsed = time.time() - started
                    print(f"  epoch {epoch + 1}/{args.epochs}  step {step}/{total_steps}  loss {running / max(seen, 1):.4f}  {elapsed:.0f}s", flush=True)
        epoch_loss = running / max(seen, 1)
        history.append({"epoch": epoch + 1, "trainLoss": round(epoch_loss, 4)})
        val = evaluate(model, val_loader) if len(val_ds) else float("nan")
        print(f"epoch {epoch + 1} done  train {epoch_loss:.4f}  val {val:.4f}", flush=True)

        # Small corpora overfit quickly: training loss keeps falling while held-out
        # loss turns upward. Keep the best-generalising weights, not the last ones.
        if not math.isnan(val) and val < best_val - 1e-3:
            best_val = val
            best_epoch = epoch + 1
            stale = 0
            best_state = {
                k: v.detach().clone() for k, v in model.state_dict().items() if "lora_" in k
            }
        else:
            stale += 1
            if stale >= args.patience:
                print(f"early stop at epoch {epoch + 1} (best epoch {best_epoch}: val {best_val:.4f})", flush=True)
                break

    if best_state:
        missing, unexpected = model.load_state_dict(best_state, strict=False)
        print(f"restored epoch {best_epoch} weights (val {best_val:.4f})", flush=True)

    after_loss = evaluate(model, val_loader) if len(val_ds) else float("nan")
    after_samples = sample(model, tokenizer, held_out) if held_out else []
    elapsed = time.time() - started

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    tokenizer.save_pretrained(args.out)
    write_report(args, before_loss, after_loss, before_samples, after_samples, elapsed, len(train_ds), len(val_ds), history, best_epoch, device=device)
    print(f"\nadapter saved to {args.out}")
    print(f"val loss {before_loss:.4f} -> {after_loss:.4f} (best epoch {best_epoch}) in {elapsed:.0f}s\n")


def write_report(args, before_loss, after_loss, before_samples, after_samples, elapsed, n_train, n_val, history=None, best_epoch=None, device="cpu"):
    os.makedirs(args.out, exist_ok=True)
    report = {
        "base": args.base,
        "device": device,
        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "epochs": args.epochs,
        "lr": args.lr,
        "rank": args.rank,
        "trainExamples": n_train,
        "validationExamples": n_val,
        "seconds": round(elapsed, 1),
        "valLossBefore": None if math.isnan(before_loss) else round(before_loss, 4),
        "valLossAfter": None if math.isnan(after_loss) else round(after_loss, 4),
        "history": history or [],
        "bestEpoch": best_epoch,
        "samples": [{"prompt": b["prompt"], "before": b["answer"], "after": a["answer"]} for b, a in zip(before_samples, after_samples)],
    }
    with open(os.path.join(args.out, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"report    {os.path.join(args.out, 'report.json')}")


if __name__ == "__main__":
    main()
