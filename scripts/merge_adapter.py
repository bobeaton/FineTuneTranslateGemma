"""Merge the trained LoRA adapter into the TranslateGemma base weights,
producing a standalone model folder that the Docker container (or anything
else) can serve without needing peft or the adapter at runtime.

Runs on CPU in bf16 (the 8 GB GPU can't hold the un-quantized 4B model);
needs roughly 12 GB of free RAM and ~9 GB of disk for the output.

Usage:
  python scripts/merge_adapter.py
  python scripts/merge_adapter.py --adapter output/... --out models/my-merged-model
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
DEFAULT_ADAPTER = WORKSPACE / "output" / "translategemma-4b-hi-xnr-lora" / "final"
DEFAULT_OUT = WORKSPACE / "models" / "translategemma-4b-hi-xnr-merged"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--adapter", default=str(DEFAULT_ADAPTER))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--base", default=None,
                    help="base model id/path (default: the one recorded in adapter_config.json)")
    args = ap.parse_args()

    adapter_dir = Path(args.adapter)
    out_dir = Path(args.out)
    if not (adapter_dir / "adapter_config.json").exists():
        sys.exit(f"ERROR: no adapter_config.json in {adapter_dir}")

    adapter_config = json.loads((adapter_dir / "adapter_config.json").read_text(encoding="utf-8"))
    base_id = args.base or adapter_config["base_model_name_or_path"]
    print(f"Base model: {base_id}")
    print(f"Adapter:    {adapter_dir}")

    import torch
    from peft import PeftModel
    from transformers import AutoTokenizer

    try:
        from transformers import AutoModelForImageTextToText
        model = AutoModelForImageTextToText.from_pretrained(
            base_id, dtype=torch.bfloat16, device_map="cpu")
    except (ValueError, OSError):
        from transformers import AutoModelForCausalLM
        model = AutoModelForCausalLM.from_pretrained(
            base_id, dtype=torch.bfloat16, device_map="cpu")

    print("Merging LoRA weights into the base model ...")
    model = PeftModel.from_pretrained(model, str(adapter_dir))
    model = model.merge_and_unload()

    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Saving merged model to {out_dir} ...")
    model.save_pretrained(str(out_dir), safe_serialization=True)

    tokenizer = AutoTokenizer.from_pretrained(str(adapter_dir))
    tokenizer.save_pretrained(str(out_dir))

    # Carry over the processor configs from the base snapshot so the folder is
    # a complete drop-in replacement for the base repo (harmless for text-only use).
    try:
        from huggingface_hub import snapshot_download
        base_path = Path(snapshot_download(base_id, allow_patterns=["*.json", "*.jinja"]))
        for name in ("preprocessor_config.json", "processor_config.json", "chat_template.jinja"):
            src = base_path / name
            if src.exists() and not (out_dir / name).exists():
                shutil.copy2(src, out_dir / name)
    except Exception as ex:
        print(f"NOTE: could not copy processor configs ({ex}); text-only serving is unaffected.")

    print("Done. Contents:")
    for f in sorted(out_dir.iterdir()):
        print(f"  {f.name}  {f.stat().st_size / 2**20:.1f} MB")


if __name__ == "__main__":
    main()
