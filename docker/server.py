"""TranslateGemma translation web service.

Serves the (fine-tuned) TranslateGemma model behind the same HTTP API that the
NLLB Docker containers expose, so it works as a drop-in endpoint for the
NllbTranslatorEncConverter in SILConverters / encoding-converters-core:

  GET  /                              simple browser test page
  GET  /api/v1/translate/languages/   flat JSON array of language codes
  GET  /api/v1/translate/languages/names/   {code: display name} (used by the test page)
  POST /api/v1/translate/             {sourceLanguage, targetLanguage, text[, directionForward]}
                                      -> {originalText, translatedText}
  GET  /healthz                       {"status": "ok"} once the model is loaded

Extensions over the NLLB servers:
  - "directionForward": false in the POST body swaps source/target, matching
    the IEncConverter DirectionForward semantics.
  - Language codes are normalized leniently: NLLB-style codes ("hin_Deva")
    and ISO 639-3 codes ("hin") are mapped to the BCP-47-style codes
    TranslateGemma expects ("hi"); unknown codes (like "xnr") pass through.

Model selection (see settings.py): a volume-mounted local model directory
(MODEL_DIR, full model or LoRA adapter) takes precedence; otherwise MODEL_NAME
is pulled from Hugging Face (HF_TOKEN supports private repos).
"""

import os
import re
import threading
import time

from flask import Flask, jsonify, render_template, request
from gevent.pywsgi import WSGIServer

from settings import (API_KEY, BASE_MODEL, DOUBLE_QUANT, EXTRA_LANGUAGES,
                      MAX_NEW_TOKENS, MODEL_DIR, MODEL_NAME, PORT, QUANTIZE)
from tg_common import render_prompt

app = Flask(__name__)

# ---------------------------------------------------------------- model load

import torch  # noqa: E402
from transformers import AutoTokenizer, BitsAndBytesConfig  # noqa: E402

USE_CUDA = torch.cuda.is_available()


def _load_base(model_id_or_path: str):
    quantize = QUANTIZE
    if quantize == "auto":
        quantize = "4bit" if USE_CUDA else "none"
    kwargs = {
        "dtype": torch.bfloat16,
        "attn_implementation": "sdpa",
        "device_map": {"": 0} if USE_CUDA else "cpu",
    }
    if quantize in ("4bit", "8bit"):
        if not USE_CUDA:
            raise RuntimeError("bitsandbytes quantization requires a GPU (run with --gpus)")
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=quantize == "4bit",
            load_in_8bit=quantize == "8bit",
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=DOUBLE_QUANT,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    print(f"Loading {model_id_or_path} (cuda={USE_CUDA}, quantize={quantize}) ...")
    try:
        from transformers import AutoModelForImageTextToText
        return AutoModelForImageTextToText.from_pretrained(model_id_or_path, **kwargs)
    except (ValueError, OSError):
        from transformers import AutoModelForCausalLM
        return AutoModelForCausalLM.from_pretrained(model_id_or_path, **kwargs)


def load_model_and_tokenizer():
    """Local mounted dir (full model or LoRA adapter) wins; else HF repo."""
    if MODEL_DIR and os.path.isdir(MODEL_DIR) and os.listdir(MODEL_DIR):
        if os.path.exists(os.path.join(MODEL_DIR, "adapter_config.json")):
            import json
            with open(os.path.join(MODEL_DIR, "adapter_config.json"), encoding="utf-8") as f:
                recorded_base = json.load(f).get("base_model_name_or_path")
            base_id = BASE_MODEL or recorded_base
            print(f"MODEL_DIR is a LoRA adapter; loading base {base_id} + adapter")
            model = _load_base(base_id)
            from peft import PeftModel
            model = PeftModel.from_pretrained(model, MODEL_DIR)
            tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
            return model, tokenizer, f"{base_id} + {MODEL_DIR}"
        print(f"Serving local model directory {MODEL_DIR}")
        return (_load_base(MODEL_DIR),
                AutoTokenizer.from_pretrained(MODEL_DIR), MODEL_DIR)
    print(f"Serving Hugging Face model {MODEL_NAME}")
    return (_load_base(MODEL_NAME),
            AutoTokenizer.from_pretrained(MODEL_NAME), MODEL_NAME)


model, tokenizer, MODEL_LABEL = load_model_and_tokenizer()
model.eval()
generate_lock = threading.Lock()
print(f"Model ready: {MODEL_LABEL}")

# ------------------------------------------------------------- language list

# TranslateGemma's chat template embeds a {code: language-name} map; harvest it
# so /languages/ reflects exactly what the loaded model knows, plus any custom
# fine-tuned codes from EXTRA_LANGUAGES (e.g. xnr).
_LANG_ENTRY = re.compile(r'"([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)":\s*"([^"]+)"')


def harvest_languages() -> dict:
    languages = {}
    template = tokenizer.chat_template or ""
    map_block = template.split("%}", 1)[0] if "set languages" in template else template
    for code, name in _LANG_ENTRY.findall(map_block):
        languages[code] = name
    for code in filter(None, (c.strip() for c in EXTRA_LANGUAGES.split(","))):
        languages.setdefault(code, code)
    if not languages:  # template without a map: fall back to the fine-tuned pair
        languages = {"hi": "Hindi", "xnr": "xnr"}
    return languages


LANGUAGES = harvest_languages()
print(f"Serving {len(LANGUAGES)} language codes")

# Lenient input-code normalization: NLLB-style ("hin_Deva") and ISO 639-3
# codes are mapped onto codes the model's template knows. Unknown codes pass
# through unchanged (the prompt renderer handles them, as with xnr).
ISO3_TO_BCP47 = {
    "hin": "hi", "eng": "en", "ben": "bn", "tam": "ta", "tel": "te",
    "urd": "ur", "pan": "pa", "guj": "gu", "mar": "mr", "mal": "ml",
    "kan": "kn", "ory": "or", "asm": "as", "npi": "ne", "nep": "ne",
    "san": "sa", "kas": "ks", "snd": "sd", "kor": "ko", "zho": "zh",
    "fra": "fr", "deu": "de", "spa": "es", "por": "pt", "rus": "ru",
}


def normalize_lang(code: str) -> str:
    code = (code or "").strip()
    if not code or code in LANGUAGES:
        return code
    bare = code.split("_")[0]  # hin_Deva -> hin
    if bare in LANGUAGES:
        return bare
    mapped = ISO3_TO_BCP47.get(bare.lower(), "")
    if mapped in LANGUAGES:
        return mapped
    return code


# ----------------------------------------------------------------- endpoints

def IsNullOrEmpty(s):
    return s is None or s == ""


def unauthorized():
    return (not IsNullOrEmpty(API_KEY)
            and request.headers.get("Authorization") != API_KEY)


@app.route("/")
def index():
    if unauthorized():
        return jsonify({"error": "Unauthorized"}), 401
    return render_template("index.html", MODEL_NAME=MODEL_LABEL)


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok", "model": MODEL_LABEL,
                    "device": "cuda" if USE_CUDA else "cpu"})


@app.route("/api/v1/translate/languages/", methods=["GET"])
def translate_languages():
    if unauthorized():
        return jsonify({"error": "Unauthorized"}), 401
    # Flat array of code strings: the shape NllbTranslatorEncConverter expects.
    return jsonify(sorted(LANGUAGES))


@app.route("/api/v1/translate/languages/names/", methods=["GET"])
def translate_language_names():
    if unauthorized():
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify(LANGUAGES)


@app.route("/api/v1/translate/", methods=["POST"])
def translate_text():
    if unauthorized():
        return jsonify({"error": "Unauthorized"}), 401
    try:
        data = request.get_json()
        source_language = normalize_lang(data.get("sourceLanguage", "hi"))
        target_language = normalize_lang(data.get("targetLanguage", "xnr"))
        text = data["text"]

        # IEncConverter-style DirectionForward: false swaps the direction, so
        # one converter definition can serve both directions.
        direction_forward = data.get("directionForward", True)
        if isinstance(direction_forward, str):
            direction_forward = direction_forward.strip().lower() not in ("false", "0", "no")
        if not direction_forward:
            source_language, target_language = target_language, source_language

        translated = do_translate(text, source_language, target_language)
        return jsonify({"originalText": text, "translatedText": translated})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def do_translate(text: str, src: str, tgt: str) -> str:
    if not text.strip():
        return text
    prompt = render_prompt(tokenizer, src, tgt, text)
    inputs = tokenizer(prompt, add_special_tokens=False,
                       return_tensors="pt")["input_ids"].to(model.device)
    start = time.monotonic()
    with generate_lock, torch.inference_mode():
        output = model.generate(
            inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            do_sample=False,
            num_beams=1,
        )
    elapsed = time.monotonic() - start
    generated = output.shape[1] - inputs.shape[1]
    hit_cap = generated >= MAX_NEW_TOKENS
    print(f"[translate] {src}->{tgt} {inputs.shape[1]} in-tok, "
          f"{generated} out-tok in {elapsed:.2f}s "
          f"({generated / elapsed:.1f} tok/s)"
          + (" *** HIT MAX_NEW_TOKENS - EOS not reached ***" if hit_cap else ""))
    return tokenizer.decode(output[0][inputs.shape[1]:],
                            skip_special_tokens=True).strip()


if __name__ == "__main__":
    print(f"Listening on port {PORT}")
    WSGIServer(("", PORT), app).serve_forever()
