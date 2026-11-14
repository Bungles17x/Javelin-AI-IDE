"""
Merge the LoRA adapter into the base model and save full weights.

    .venv/Scripts/python.exe training/knowledge/merge_and_export.py \
        --adapter training/knowledge/out --out models/javelin-cloud

An adapter is a delta, not a model: a serving stack (vLLM, TGI, llama.cpp, Ollama)
wants one directory of weights it can load without PEFT. Merging bakes the delta in.

Two things worth knowing:

1. **The base model is read from the adapter**, not from a flag, so the merge cannot
   be applied to the wrong base — that produces silence-deep garbage, not an error.

2. **`safe_merge=True`** keeps the merged weights finite even if the adapter carries
   an outlier; without it a bad merge can emit NaN and the model answers emptiness.
"""

import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="training/knowledge/out")
    ap.add_argument("--base", default=None, help="defaults to the adapter's recorded base")
    ap.add_argument("--out", default="models/javelin-cloud")
    ap.add_argument("--dtype", default="float16", choices=["float16", "bfloat16", "float32"])
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    if not os.path.isdir(args.adapter):
        print(f"No adapter at {args.adapter}. Train one first: npm run train:knowledge:run")
        sys.exit(1)

    base = args.base
    if not base:
        with open(os.path.join(args.adapter, "adapter_config.json"), "r", encoding="utf-8") as f:
            base = json.load(f).get("base_model_name_or_path")
    if not base:
        print("Adapter does not record its base model; pass --base explicitly.")
        sys.exit(1)

    dtype = {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": torch.float32}[args.dtype]

    print(f"base      {base}")
    print(f"adapter   {args.adapter}")
    print(f"dtype     {args.dtype}")

    tokenizer = AutoTokenizer.from_pretrained(args.adapter)
    model = AutoModelForCausalLM.from_pretrained(base, dtype=dtype)
    model = PeftModel.from_pretrained(model, args.adapter)
    model = model.merge_and_unload(safe_merge=True)
    model.eval()

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out, safe_serialization=True)
    tokenizer.save_pretrained(args.out)

    total = sum(p.numel() for p in model.parameters())
    with open(os.path.join(args.out, "MERGE.json"), "w", encoding="utf-8") as f:
        json.dump({
            "base": base,
            "adapter": args.adapter,
            "dtype": args.dtype,
            "parameters": total,
            "note": "Full merged weights. Serve with vLLM/TGI; convert to GGUF for llama.cpp or Ollama.",
        }, f, indent=2)

    print(f"\nmerged {total/1e6:.0f}M parameters into {args.out}")
    print("next: cloud-model/README.md — serve it, then point the IDE's Custom provider at it\n")


if __name__ == "__main__":
    main()
