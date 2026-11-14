"""Merge a LoRA adapter into its base model and write a plain HF checkpoint.

llama.cpp cannot read PEFT adapters, so the adapter has to become ordinary
weights first. Output is fp16, which the converter then turns into GGUF.
"""

import argparse
import os

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    parser.add_argument("--adapter", default=os.path.join("training", "knowledge", "out-1.5b"))
    parser.add_argument("--out", default=os.path.join("training", "knowledge", "merged-coder-1.5b"))
    args = parser.parse_args()

    print(f"loading base {args.base}", flush=True)
    model = AutoModelForCausalLM.from_pretrained(args.base, dtype=torch.float16, device_map="cpu")
    tokenizer = AutoTokenizer.from_pretrained(args.base)

    print(f"attaching adapter {args.adapter}", flush=True)
    peft_model = PeftModel.from_pretrained(model, args.adapter)
    merged = peft_model.merge_and_unload()

    os.makedirs(args.out, exist_ok=True)
    merged.save_pretrained(args.out, safe_serialization=True)
    tokenizer.save_pretrained(args.out)
    print(f"merged weights written to {args.out}", flush=True)


if __name__ == "__main__":
    main()
