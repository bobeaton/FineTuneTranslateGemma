# TranslateGemma translation webservice (Docker)

Hosts the fine-tuned TranslateGemma model behind a localhost HTTP endpoint
that is **drop-in compatible with the NLLB Translator EncConverter**
(`NllbTranslatorEncConverter` in encoding-converters-core / SILConverters),
while supporting **all languages and both directions** the loaded model knows.

## Quick start

```powershell
# serve the local fine-tuned Hindi<->Kangri model on the GPU, in the background
.\buildDocker.ps1 -Gpu -Detached

# then browse to the test page (the model takes ~1-2 minutes to load)
Start-Process http://localhost:8010/
```

The container is created with a fixed name (`translategemma`), so after the
first run you can stop/start it from Docker Desktop or with
`docker stop translategemma` / `docker start translategemma`.
Re-running `buildDocker.ps1` rebuilds and replaces it.

## Choosing the model (`-Model`)

| What you pass | What happens |
|---|---|
| *(nothing)* | serves `..\models\translategemma-4b-hi-xnr-merged` (the fine-tuned model, merged; created by `scripts\merge_adapter.py`) |
| a folder with a full model | mounted read-only and served |
| a folder with a LoRA adapter (`adapter_config.json`) | the base model is pulled from HF (cached in a docker volume) and the adapter is applied on top |
| a Hugging Face repo id (e.g. `google/translategemma-4b-it`) | pulled from HF; private/gated repos work via `-HfToken` (default `$env:HF_TOKEN`) |

Downloads are cached in the named volume `translategemma-hf-cache`, so a
container rebuild does not re-download the model.

## GPU / CPU and quantization

- `-Gpu` passes the GPU through (`--gpus "device=0"`). With `-Quantize auto`
  (default), the model is loaded 4-bit quantized on GPU — this fits the 4B
  model in 8 GB of VRAM and translates a verse in a few seconds.
- Without `-Gpu` the model runs on CPU in bf16 (needs ~10 GB of container RAM
  and is much slower — a minute or more per verse; fine for occasional use).

## API

All endpoints accept an optional `Authorization` header. If the container is
started with `-ApiKey <key>`, every request must send
`Authorization: SIL-NLLB-Auth-Key <key>` (which is what the
NllbTranslatorEncConverter does when you enter the key in its Setup tab).

### `GET /api/v1/translate/languages/`

Flat JSON array of the language codes the loaded model supports (harvested
from the model's own chat template + the fine-tuned extras such as `xnr`):
`["aa", "af", ..., "hi", ..., "xnr", ...]`

### `GET /api/v1/translate/languages/names/`

Same list as `{code: display-name}` — used by the test page dropdowns.

### `POST /api/v1/translate/`

```json
{
  "sourceLanguage": "hi",
  "targetLanguage": "xnr",
  "text": "…",
  "directionForward": true
}
```

Returns `{"originalText": "…", "translatedText": "…"}`.

- `directionForward` is optional (default `true`). Sending `false` swaps
  source and target, mirroring the `IEncConverter.DirectionForward` semantics —
  one converter definition (e.g. Hindi↔Kangri) can serve both directions.
- Language codes are normalized leniently: NLLB-style codes (`hin_Deva`) and
  ISO 639-3 codes (`hin`) are mapped to the codes TranslateGemma uses (`hi`);
  unknown codes (like `xnr`) pass through to the model as-is.

### `GET /healthz`

`{"status": "ok", "model": "…", "device": "cuda"|"cpu"}` once the model is
loaded — poll this to know when the container is ready.

## Using from SILConverters

In the NLLB Translator converter setup, point the endpoint at
`http://localhost:8010` and use language codes as configured here (e.g. `hi`
and `xnr`; `hin_Deva`-style codes are also accepted). If you set an API key on
the container, enter the same key (without the `SIL-NLLB-Auth-Key` prefix) in
the converter's Setup tab.

## Files

- `server.py` — Flask app (model loading, prompt rendering, endpoints)
- `settings.py` — defaults; every value can be overridden by environment
  variables, which is how `buildDocker.ps1` configures the container
- `Dockerfile` — `python:3.11-slim` base; the model itself is *not* baked in
- `buildDocker.ps1` — build + run helper (see `Get-Help .\buildDocker.ps1 -Examples`)
