# Handoff — TranslateGemma Hindi↔Kangri fine-tune

**Session date:** 2026-07-26 (Claude Code, autonomous session while Bob was away)
**Workspace:** `C:\vscode\FineTuneTranslateGemma`
(Note: the request said `C:\vscode\FineTuneGemmaTranslate`, but the session was
rooted in the existing `FineTuneTranslateGemma` folder, so everything was built
there.)

## What was done

### 1. Dataset merge — DONE ✅

- Wrote [scripts/merge_csv_into_dataset.py](scripts/merge_csv_into_dataset.py)
  (pure stdlib, runs with any Python ≥3.8).
- Merged `Addl Hindi-Kangri Couplets (spellfix).csv` (7,505 pairs, both
  directions → 15,010 examples) into `GemmaDataSet_HIN_XNR_NT.json`
  (45,230 examples).
- De-duplicated with the same key as `TranslationDataset.Deduplicate()` in the
  C# class: `(source_lang, target_lang, source_text, target_text)` —
  2,188 duplicates removed.
- **Result: 58,052 examples**, written to
  `C:\Users\pete_\Dropbox\NTprogress\TranslateGemma\GemmaDataSet_HIN_XNR_Total.json`
  and copied to `data\GemmaDataSet_HIN_XNR_Total.json` in this workspace.
- Output verified byte-compatible with the C# serializer style: compact JSON,
  UTF-8 without BOM, `\n` line endings, un-escaped Devanagari.

### 2. Model choice — `google/translategemma-4b-it`

- GPU is an **RTX 4060 Laptop, 8 GB VRAM** (60 W) — confirms the 4B choice.
  TranslateGemma ships in 4B/12B/27B (released 2026-01-12, Gemma 3 based);
  only 4B is trainable in 8 GB, and only with QLoRA (4-bit base + LoRA).
- The model is **gated** on Hugging Face. A token was already cached on this
  machine (`HF_TOKEN` is set). If downloads fail with 403, accept the license
  at https://huggingface.co/google/translategemma-4b-it and re-run.

### 3. Environment

- Python **3.12** venv at `.venv\` (3.14 is the default `py` but too new for
  the ML stack; 3.7 is the default `python` — don't use it).
- PyTorch cu128 wheel + transformers/trl/peft/datasets/accelerate/bitsandbytes
  (see [requirements.txt](requirements.txt)).
- Verify with `.venv\Scripts\python.exe scripts\check_env.py`.

### 4. Fine-tuning code

- [scripts/finetune_translategemma.py](scripts/finetune_translategemma.py) —
  QLoRA via TRL `SFTTrainer`. Details in [README.md](README.md).
- [scripts/translate.py](scripts/translate.py) — inference CLI
  (`--direction hi2xnr|xnr2hi`, `--base-only` for before/after comparison).

## Current status — ALL DONE ✅

- [x] Dataset merged and verified (58,052 examples)
- [x] Packages installed: torch 2.11.0+cu128, transformers 5.14.1, trl 1.9.0,
      peft 0.19.1, bitsandbytes 0.50.0 — CUDA + bf16 confirmed working
- [x] Training smoke test passed (5 steps end-to-end)
- [x] **Full training run COMPLETE** (2026-07-26, 08:50 → 22:48, 14.1 h):
      1 epoch = 3,616 optimizer steps over 57,848 examples.
      Final train loss **0.53**, eval loss **0.520**, eval token accuracy
      **88.6%** (eval never exceeded train loss — no overfitting).
      Full loss history: `output\translategemma-4b-hi-xnr-lora\checkpoint-3616\trainer_state.json`.
- [x] **Adapter saved:** `output\translategemma-4b-hi-xnr-lora\final`
      (57 MB `adapter_model.safetensors`)
- [x] Post-training translation test passed — see below.

### Before/after test results (also in `output\adapter_test_results.json`)

The stock model **cannot translate Kangri at all** — asked for hi→xnr it
answers in English; asked for xnr→hi it produces wrong Hindi. The fine-tuned
adapter:

| Test | Result |
|---|---|
| Genesis 1:1 hi→xnr (in dataset) | near-exact reference Kangri (one synonym: ध़रत्तिआ for पृथबिआ) |
| Novel non-biblical sentence hi→xnr | fluent, plausible Kangri |
| Genesis 1:1 xnr→hi | **exact** reference Hindi |
| CSV couplet xnr→hi | **exact** reference Hindi |

Reproduce with:
`.venv\Scripts\python.exe scripts\translate.py --direction hi2xnr --text "<Hindi>"`
(add `--base-only` to see the stock model for comparison).

## Session 2 (2026-07-27): Docker translation webservice ✅

Built [docker/](docker/) — hosts the fine-tuned model behind the same HTTP API
as the NLLB Docker containers, so it plugs straight into the
`NllbTranslatorEncConverter` (encoding-converters-core / SILConverters).

- **Model prep:** `scripts\merge_adapter.py` folded the LoRA adapter into the
  base weights → `models\translategemma-4b-hi-xnr-merged` (8.2 GB, standalone).
- **API** (see [docker/README.md](docker/README.md)): canonical
  `POST /api/v1/translate/` (`{sourceLanguage, targetLanguage, text}` →
  `{originalText, translatedText}`), `GET /api/v1/translate/languages/` (flat
  code array, as the C# client deserializes), `SIL-NLLB-Auth-Key` auth.
  Extensions: `directionForward: false` swaps direction (IEncConverter
  semantics); lenient code normalization (`hin_Deva`/`hin` → `hi`; unknown
  codes like `xnr` pass through); `/languages/names/` (code→name) for the UI;
  `/healthz`.
- **Languages:** harvested from the model's own chat template — 582 codes —
  plus `EXTRA_LANGUAGES` (default `xnr`). Verified the merged model still
  translates base languages (hi→en works) after fine-tuning.
- **buildDocker.ps1**: `-Model` accepts a local folder (full model *or* LoRA
  adapter) or any HF repo id (private via `-HfToken`/`$env:HF_TOKEN`); HF
  downloads cached in the `translategemma-hf-cache` volume. `-Gpu` = 4-bit on
  GPU (fits 8 GB); CPU fallback = bf16. Persistent container named
  `translategemma`, same conventions as the kangri-tts script.
- **Tested locally** (host venv, GPU): hi→xnr and xnr→hi correct,
  `directionForward=false` verified, `hin_Deva`-style codes verified.
- **Container verified end-to-end** (image `translategemma-translator`,
  python:3.13-slim base, 8.4 GB unpacked; container `translategemma`, GPU,
  4-bit): languages list (582 codes, flat array), hi→xnr, xnr→hi,
  `directionForward=false` swap, `hin_Deva→xnr_Deva` code normalization, and
  hi→en (base language retained) all correct. ~1 s/sentence on GPU after the
  first call (the first request also JIT-compiles Triton kernels, ~7 s).
- **Gotcha fixed along the way:** bitsandbytes' 4-bit kernels JIT-compile via
  Triton *at runtime* inside Linux, so the image needs `build-essential` +
  `ENV CC=gcc` (same fix as the kangri-tts Dockerfile). Without it every
  translate call 500s with "Failed to find C compiler".

### Ideas for a next session

- More epochs (`--epochs 2 --resume` won't work across epoch boundaries —
  start a fresh run with `--epochs 2`; ~14 h per epoch) or a second pass at
  lower LR if novel-sentence quality needs improvement.
- A proper held-out test set with BLEU/chrF scoring (e.g. `sacrebleu`) on
  verses excluded from training.
- Export the merged model (`models\translategemma-4b-hi-xnr-merged`) to GGUF
  for llama.cpp / Ollama if a lighter-weight CPU serving path is wanted.
- Upload the merged model to a private HF repo (`hf upload`), after which the
  container can run anywhere with
  `.\buildDocker.ps1 -Gpu -Model you/your-repo -HfToken ...`.

## Gated model & chat templates — resolved ✅

- During the session Bob's HF token initially had no access to the gated
  `google/translategemma-4b-it`; the training run therefore uses
  `Infomaniak-AI/vllm-translategemma-4b-it`, an ungated full-precision
  re-upload of the same weights. **Bob accepted the license mid-session
  (2026-07-26), so the google/ repo is accessible now** and
  `resolve_model_id()` will prefer it automatically from here on.
- Template findings (verified by rendering both):
  - The mirror's chat template takes user content as a marker string
    (`<<<source>>>hi<<<target>>>xnr<<<text>>>…`); Google's official template
    takes the structured content-parts our dataset uses. For supported
    language pairs both render **byte-identical** prompts.
  - **Google's official template hard-fails on `xnr`** (Kangri is not in its
    language-name map; the template does a strict map lookup). The mirror's
    template passes unknown codes through, so prompts say "xnr" where they
    would say "Kangri" — that is what the adapter is trained on.
  - `scripts/tg_common.py::render_prompt()` therefore tries structured, then
    marker, then a verified manual fallback that reproduces the exact same
    prompt text. Result: training and inference are byte-identical regardless
    of which of the two base repos is loaded.
- The LoRA adapter works with either base repo (identical weights and module
  names).

## How to pick this up

1. `cd C:\vscode\FineTuneTranslateGemma`
2. `.venv\Scripts\python.exe scripts\check_env.py` — everything should say OK.
3. If a full training run is in progress or was interrupted:
   `.venv\Scripts\python.exe scripts\finetune_translategemma.py --resume`
   (checkpoints land in `output\translategemma-4b-hi-xnr-lora\`, every 250
   steps, last 2 kept).
4. When training finishes, the adapter is at
   `output\translategemma-4b-hi-xnr-lora\final`. Test with:
   `.venv\Scripts\python.exe scripts\translate.py --direction hi2xnr --text "<Hindi sentence>"`

## Decisions & rationale

- **QLoRA over full fine-tune / LoRA-fp16:** a 4B model in bf16 is ~8 GB of
  weights alone — no room for optimizer state on this GPU. 4-bit NF4 base +
  r=16 LoRA fits with headroom for 512-token sequences.
- **Drop (not truncate) over-length examples:** truncating a translation pair
  mid-target teaches the model to emit truncated translations.
- **Pre-tokenization with the model's chat template:** the dataset is already
  in TranslateGemma's native format; rendering with the model's own template
  guarantees training matches inference exactly, and pre-tokenizing avoids
  any TRL version differences in template handling.
- **Vision tower untouched:** TranslateGemma keeps Gemma 3's multimodal
  architecture; LoRA targets only `language_model` projection layers.
- **Both directions in one adapter:** the dataset interleaves hi→xnr and
  xnr→hi (as the C# generator did), so a single fine-tune serves both.
