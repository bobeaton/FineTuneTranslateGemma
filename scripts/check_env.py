"""Sanity-check the environment: package versions, GPU, and gated-model access."""

import importlib.metadata as md


def version(pkg: str) -> str:
    try:
        return md.version(pkg)
    except md.PackageNotFoundError:
        return "NOT INSTALLED"


for pkg in ("torch", "transformers", "trl", "peft", "datasets",
            "accelerate", "bitsandbytes", "huggingface_hub"):
    print(f"{pkg:20s} {version(pkg)}")

import torch

print(f"\nCUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    props = torch.cuda.get_device_properties(0)
    print(f"GPU: {props.name}, {props.total_memory / 2**30:.1f} GB VRAM")
    print(f"bf16 supported: {torch.cuda.is_bf16_supported()}")

print("\nChecking access to google/translategemma-4b-it ...")
from huggingface_hub import auth_check
try:
    auth_check("google/translategemma-4b-it")
    print("OK - token has access to the gated model.")
except Exception as ex:
    print(f"PROBLEM: {type(ex).__name__}: {ex}")
    print("Fix: accept the license at https://huggingface.co/google/translategemma-4b-it")
    print("and/or run: huggingface-cli login")
