"""Translate Hindi<->Kangri with (fine-tuned) TranslateGemma.

Loads the 4-bit base model, plus the LoRA adapter from training unless
--base-only is given (useful for before/after comparison).

Usage:
  python scripts/translate.py --direction hi2xnr --text "यीशु ने कहा, मैं ही मार्ग हूँ।"
  python scripts/translate.py --direction xnr2hi --text "..." --base-only
  python scripts/translate.py --direction hi2xnr            # interactive: type lines, Ctrl+Z/Ctrl+C to quit
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tg_common import DEFAULT_MODEL, render_prompt, resolve_model_id

WORKSPACE = Path(__file__).resolve().parent.parent
DEFAULT_ADAPTER = WORKSPACE / "output" / "translategemma-4b-hi-xnr-lora" / "final"

LANGS = {"hi2xnr": ("hi", "xnr"), "xnr2hi": ("xnr", "hi")}


def load_model(model_id: str, adapter: str | None):
    import torch
    from transformers import AutoTokenizer, BitsAndBytesConfig

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    model_kwargs = dict(
        quantization_config=bnb_config,
        dtype=torch.bfloat16,
        attn_implementation="eager",
        device_map={"": 0} if torch.cuda.is_available() else None,
    )
    try:
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(model_id, **model_kwargs)
    except (ValueError, OSError):
        from transformers import AutoModelForCausalLM
        model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)

    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
        print(f"Loaded LoRA adapter: {adapter}")
    model.eval()
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    return model, tokenizer


def translate(model, tokenizer, text: str, src: str, tgt: str) -> str:
    import torch

    prompt = render_prompt(tokenizer, src, tgt, text)
    inputs = tokenizer(
        prompt, add_special_tokens=False, return_tensors="pt",
    )["input_ids"].to(model.device)
    with torch.inference_mode():
        output = model.generate(
            inputs,
            max_new_tokens=512,
            do_sample=False,
            num_beams=1,
        )
    return tokenizer.decode(output[0][inputs.shape[1]:], skip_special_tokens=True).strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--direction", choices=list(LANGS), required=True)
    ap.add_argument("--text", help="text to translate; omit for interactive mode")
    ap.add_argument("--model-id", default=DEFAULT_MODEL)
    ap.add_argument("--adapter", default=str(DEFAULT_ADAPTER))
    ap.add_argument("--base-only", action="store_true",
                    help="skip the LoRA adapter (compare against the stock model)")
    args = ap.parse_args()

    adapter = None if args.base_only else args.adapter
    if adapter and not Path(adapter).exists():
        print(f"NOTE: adapter not found at {adapter}; using base model only.")
        adapter = None

    src, tgt = LANGS[args.direction]
    model, tokenizer = load_model(resolve_model_id(args.model_id), adapter)

    if args.text:
        print(translate(model, tokenizer, args.text, src, tgt))
        return

    print(f"Interactive {src} -> {tgt}. Enter a line to translate, Ctrl+C to quit.")
    try:
        for line in sys.stdin:
            line = line.strip()
            if line:
                print(translate(model, tokenizer, line, src, tgt))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
