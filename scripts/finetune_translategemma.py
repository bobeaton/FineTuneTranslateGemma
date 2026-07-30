"""QLoRA fine-tuning of google/translategemma-4b-it on the Hindi<->Kangri dataset.

Sized for an 8 GB GPU (RTX 4060 Laptop): 4-bit NF4 base model, LoRA adapters on
the language-model projection layers only, batch 1 x grad-accum 16, gradient
checkpointing, paged 8-bit AdamW.

The dataset (data/GemmaDataSet_HIN_XNR_Total.json) is JSONL in TranslateGemma's
own fine-tuning format, so each example is rendered with the model's chat
template (which understands source_lang_code / target_lang_code content parts)
and pre-tokenized before being handed to TRL's SFTTrainer.

Typical usage:
  # quick smoke test (~200 examples, 10 optimizer steps)
  python scripts/finetune_translategemma.py --limit 200 --max-steps 10 --output-dir output/smoke

  # full run, 1 epoch (default)
  python scripts/finetune_translategemma.py

  # resume after an interruption
  python scripts/finetune_translategemma.py --resume
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tg_common import DEFAULT_MODEL, render_training_text, resolve_model_id

WORKSPACE = Path(__file__).resolve().parent.parent
DEFAULT_DATA = WORKSPACE / "data" / "GemmaDataSet_HIN_XNR_Total.json"
DEFAULT_OUTPUT = WORKSPACE / "output" / "translategemma-4b-hi-xnr-lora"


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model-id", default=DEFAULT_MODEL)
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--max-steps", type=int, default=-1,
                    help="stop after N optimizer steps (overrides --epochs)")
    ap.add_argument("--limit", type=int, default=0,
                    help="use only the first N examples (0 = all); for smoke tests")
    ap.add_argument("--max-length", type=int, default=512,
                    help="max tokens per example; longer examples are dropped, not truncated")
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--eval-size", type=int, default=200,
                    help="examples held out for eval (0 disables eval)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resume", action="store_true",
                    help="resume from the last checkpoint in --output-dir")
    return ap.parse_args()


def load_examples(path: Path, limit: int) -> list:
    examples = []
    with path.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line:
                examples.append(json.loads(line))
            if limit and len(examples) >= limit:
                break
    return examples


def main():
    args = parse_args()

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoTokenizer, BitsAndBytesConfig
    from trl import SFTConfig, SFTTrainer

    if not torch.cuda.is_available():
        sys.exit("ERROR: CUDA GPU not available - training on CPU is not practical.")
    print(f"GPU: {torch.cuda.get_device_name(0)} "
          f"({torch.cuda.get_device_properties(0).total_memory / 2**30:.1f} GB)")

    random.seed(args.seed)
    args.model_id = resolve_model_id(args.model_id)

    # ---------------- data ----------------
    data_path = Path(args.data)
    examples = load_examples(data_path, args.limit)
    print(f"Loaded {len(examples):,} examples from {data_path.name}")

    tokenizer = AutoTokenizer.from_pretrained(args.model_id)

    def to_fields(ex):
        """(src_lang, tgt_lang, src_text, tgt_text) from one dataset record."""
        user = next(m for m in ex["messages"] if m["role"] == "user")["content"][0]
        target = next(m for m in ex["messages"] if m["role"] == "assistant")["content"][0]
        return user["source_lang_code"], user["target_lang_code"], user["text"], target["text"]

    # Show one rendered example so the applied template is visible in the log.
    sample_text = render_training_text(tokenizer, *to_fields(examples[0]))
    print("--- rendered sample ---")
    print(sample_text)
    print("-----------------------")
    sample_ids = tokenizer(sample_text, add_special_tokens=False)["input_ids"]
    assert sample_ids[0] == tokenizer.bos_token_id, \
        "rendered text did not tokenize to a leading <bos> token"

    print("Tokenizing with the model chat template ...")
    input_ids_list, dropped = [], 0
    for ex in examples:
        text = render_training_text(tokenizer, *to_fields(ex))
        ids = tokenizer(text, add_special_tokens=False)["input_ids"]
        if len(ids) > args.max_length:
            dropped += 1  # a truncated translation would teach truncated output
            continue
        input_ids_list.append(ids)
    lengths = [len(i) for i in input_ids_list]
    print(f"Kept {len(input_ids_list):,} examples "
          f"(dropped {dropped} longer than {args.max_length} tokens); "
          f"avg {sum(lengths)/len(lengths):.0f} tokens, max {max(lengths)}")

    random.shuffle(input_ids_list)
    eval_size = min(args.eval_size, len(input_ids_list) // 10)
    train_ids = input_ids_list[eval_size:]
    eval_ids = input_ids_list[:eval_size]
    train_ds = Dataset.from_dict({"input_ids": train_ids})
    eval_ds = Dataset.from_dict({"input_ids": eval_ids}) if eval_size else None
    print(f"Train: {len(train_ds):,}  Eval: {eval_size}")

    # ---------------- model ----------------
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    model_kwargs = dict(
        quantization_config=bnb_config,
        dtype=torch.bfloat16,
        attn_implementation="eager",  # recommended for Gemma 3 training
        device_map={"": 0},
    )
    try:
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(args.model_id, **model_kwargs)
    except (ValueError, OSError):
        from transformers import AutoModelForCausalLM
        model = AutoModelForCausalLM.from_pretrained(args.model_id, **model_kwargs)
    model.config.use_cache = False

    # LoRA on the text stack only. TranslateGemma keeps Gemma 3's multimodal
    # architecture, so restrict to language_model when a vision tower exists.
    module_names = [name for name, _ in model.named_modules()]
    has_vision = any("vision_tower" in n for n in module_names)
    proj = "(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"
    if has_vision:
        target_modules = rf".*language_model.*\.{proj}"
    else:
        target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                          "gate_proj", "up_proj", "down_proj"]
    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=target_modules,
    )

    # ---------------- training ----------------
    output_dir = Path(args.output_dir)
    sft_config = SFTConfig(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        optim="paged_adamw_8bit",
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        max_length=None,          # data is pre-tokenized and pre-filtered
        packing=False,
        logging_steps=10,
        eval_strategy="steps" if eval_ds is not None else "no",
        eval_steps=250,
        save_strategy="steps",
        save_steps=250,
        save_total_limit=2,
        report_to="none",
        seed=args.seed,
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        processing_class=tokenizer,
        peft_config=peft_config,
    )

    resume = args.resume and any(output_dir.glob("checkpoint-*"))
    trainer.train(resume_from_checkpoint=resume)

    final_dir = output_dir / "final"
    trainer.save_model(str(final_dir))
    tokenizer.save_pretrained(str(final_dir))
    print(f"Saved LoRA adapter to {final_dir}")


if __name__ == "__main__":
    main()
