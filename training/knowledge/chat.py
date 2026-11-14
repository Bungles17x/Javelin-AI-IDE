"""
Ask the trained model a question from the terminal.

    .venv/Scripts/python.exe training/knowledge/chat.py "how do you approach a strange codebase"
    .venv/Scripts/python.exe training/knowledge/chat.py            # interactive

This loads the *merged* adapter, so what you see here is exactly what `serve.py`
serves to the IDE — no separate code path that could behave differently.
"""

import argparse
import os
import sys

BASE = "HuggingFaceTB/SmolLM2-135M-Instruct"
ADAPTER = os.path.join("training", "knowledge", "out")
SYSTEM = (
    "You are Javelin, a senior software engineer working inside a code editor. "
    "You answer with a concrete method, state uncertainty plainly, and never claim "
    "work you did not do."
)


def load(base, adapter):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    # Same rule as the server: the adapter records the base it belongs to, and using
    # the wrong one produces garbage rather than an error.
    try:
        from serve import base_of

        base = base_of(adapter, base)
    except Exception:
        pass

    tokenizer = AutoTokenizer.from_pretrained(adapter if os.path.isdir(adapter) else base)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=torch.float32)
    if os.path.isdir(adapter):
        model = PeftModel.from_pretrained(model, adapter).merge_and_unload()
    model.eval()
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    return model, tokenizer


def ask(model, tokenizer, question, max_tokens=200, temperature=0.6):
    import torch

    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": question}]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    ids = tokenizer(text, return_tensors="pt", add_special_tokens=False)
    stops = ["<|im_end|>", "<|endoftext|>", "\n\nuser>", "\n\nUser:", "\n\nQ:", "\n\nQuestion:"]
    eos_ids = [tokenizer.eos_token_id]
    im_end = tokenizer.convert_tokens_to_ids("<|im_end|>")
    if isinstance(im_end, int) and im_end >= 0 and im_end != tokenizer.unk_token_id:
        eos_ids.append(im_end)
    with torch.no_grad():
        out = model.generate(
            **ids,
            max_new_tokens=max_tokens,
            do_sample=temperature > 0,
            temperature=max(temperature, 0.01),
            top_p=0.9,
            repetition_penalty=1.12,
            eos_token_id=eos_ids,
            stop_strings=stops,
            tokenizer=tokenizer,
            pad_token_id=tokenizer.pad_token_id,
        )
    reply = tokenizer.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
    for marker in stops:
        cut = reply.find(marker)
        if cut != -1:
            reply = reply[:cut]
    return reply.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="*")
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--adapter", default=ADAPTER, help="default: training/knowledge/out")
    ap.add_argument("--max-tokens", type=int, default=200)
    ap.add_argument("--temperature", type=float, default=0.6)
    args = ap.parse_args()

    if not os.path.isdir(args.adapter):
        print(f"No adapter at {args.adapter}. Run: npm run train:knowledge:run")
        sys.exit(1)

    model, tokenizer = load(args.base, args.adapter)

    if args.question:
        print(ask(model, tokenizer, " ".join(args.question), args.max_tokens, args.temperature))
        return

    print("Javelin (135M, local). Empty line to quit.")
    while True:
        try:
            q = input("\nyou> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not q:
            return
        print("\njavelin>", ask(model, tokenizer, q, args.max_tokens, args.temperature))


if __name__ == "__main__":
    main()
