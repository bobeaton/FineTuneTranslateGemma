"""Shared helpers for the TranslateGemma fine-tuning workspace."""

DEFAULT_MODEL = "google/translategemma-4b-it"
# Ungated re-upload of the same weights (transformers layout + vLLM-style chat
# template). Used automatically until the Gemma license has been accepted for
# the gated google/ repo on this machine's HF account.
FALLBACK_MODEL = "Infomaniak-AI/vllm-translategemma-4b-it"

END_OF_TURN = "<end_of_turn>\n"

# Language names used in the rendered prompt. Codes missing from a template's
# built-in map (like xnr/Kangri) are passed through as the raw code — this
# matches the mirror template's behavior and is what training data looks like.
LANG_NAMES = {"hi": "Hindi"}

# Exact prompt format produced by the TranslateGemma chat template, verified
# byte-identical between google/translategemma-4b-it (structured content) and
# the Infomaniak vLLM re-upload (marker strings) for supported language pairs.
# Needed as a fallback because Google's template hard-fails on language codes
# outside its map (xnr is not in it); the training data was rendered with the
# mirror's template, which this reproduces exactly.
PROMPT_FORMAT = (
    "<bos><start_of_turn>user\n"
    "You are a professional {src_name} ({src}) to {tgt_name} ({tgt}) translator. "
    "Your goal is to accurately convey the meaning and nuances of the original "
    "{src_name} text while adhering to {tgt_name} grammar, vocabulary, and "
    "cultural sensitivities.\n"
    "Produce only the {tgt_name} translation, without any additional "
    "explanations or commentary. Please translate the following {src_name} "
    "text into {tgt_name}:\n\n\n"
    "{text}<end_of_turn>\n"
    "<start_of_turn>model\n"
)


def resolve_model_id(model_id: str) -> str:
    """Fall back to the ungated mirror if the gated google/ repo is inaccessible."""
    if model_id != DEFAULT_MODEL:
        return model_id
    from huggingface_hub import auth_check
    from huggingface_hub.errors import GatedRepoError
    try:
        auth_check(model_id)
        return model_id
    except GatedRepoError:
        print(f"NOTE: no access to gated {model_id} (license not accepted yet).")
        print(f"      Falling back to the ungated mirror: {FALLBACK_MODEL}")
        return FALLBACK_MODEL
    except Exception:
        return model_id  # offline / transient error: let from_pretrained decide


def render_prompt(tokenizer, src_lang: str, tgt_lang: str, text: str) -> str:
    """Render the user prompt (ending with '<start_of_turn>model\\n') for one
    translation request, working with either style of TranslateGemma chat
    template.

    Google's original template takes structured content parts carrying
    source_lang_code/target_lang_code; the vLLM re-upload's template instead
    wants a single string with <<<source>>>/<<<target>>>/<<<text>>> markers.
    Both render the same final prompt text.
    """
    structured = [{
        "role": "user",
        "content": [{
            "type": "text",
            "source_lang_code": src_lang,
            "target_lang_code": tgt_lang,
            "text": text,
        }],
    }]
    marker = [{
        "role": "user",
        "content": f"<<<source>>>{src_lang}<<<target>>>{tgt_lang}<<<text>>>{text}",
    }]
    for messages in (structured, marker):
        try:
            return tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            continue
    # Both template styles failed (e.g. Google's official template with a
    # language code outside its map): build the identical prompt directly.
    return PROMPT_FORMAT.format(
        src=src_lang, tgt=tgt_lang,
        src_name=LANG_NAMES.get(src_lang, src_lang),
        tgt_name=LANG_NAMES.get(tgt_lang, tgt_lang),
        text=text.strip(),
    )


def render_training_text(tokenizer, src_lang: str, tgt_lang: str,
                         src_text: str, tgt_text: str) -> str:
    """Full training sequence: rendered prompt + target + end-of-turn.

    Built from the *generation* prompt so that what the model sees in training
    is byte-identical to what it sees at inference time.
    """
    return render_prompt(tokenizer, src_lang, tgt_lang, src_text) + tgt_text + END_OF_TURN
