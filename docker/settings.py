# All settings can be overridden with environment variables (which is how
# buildDocker.ps1 configures the container); the values here are the defaults.

import os

# API key guarding all endpoints. Leave empty for no authentication.
# The NllbTranslatorEncConverter sends "SIL-NLLB-Auth-Key <your key>" as the
# Authorization header, so include that prefix in this value, e.g.
#   API_KEY = 'SIL-NLLB-Auth-Key my-secret-key'
# (buildDocker.ps1 -ApiKey adds the prefix for you.)
API_KEY = os.environ.get('API_KEY', '')

PORT = int(os.environ.get('PORT', 8010))

# Hugging Face repo to serve when no local model is mounted at MODEL_DIR.
# Private repos work if HF_TOKEN is set in the environment.
MODEL_NAME = os.environ.get('MODEL_NAME', 'google/translategemma-4b-it')

# In-container path where buildDocker.ps1 mounts a local model. May contain
# either a full model (config.json + *.safetensors) or a LoRA adapter
# (adapter_config.json); for an adapter, the base model is downloaded from
# BASE_MODEL (or the base recorded inside the adapter itself).
MODEL_DIR = os.environ.get('MODEL_DIR', '/app/model')
BASE_MODEL = os.environ.get('BASE_MODEL', '')

# 'auto' = 4-bit NF4 quantization on GPU (fits an 8 GB card), full bf16 on CPU.
# Explicit options: '4bit', '8bit', 'none'.
QUANTIZE = os.environ.get('QUANTIZE', 'auto')

# Double quantization (quantizes the quantization constants themselves) saves
# ~0.4 bits/param of VRAM at the cost of an extra dequant step per layer on
# every forward pass. Off by default: on an 8 GB card there's plenty of
# headroom without it (measured ~58 MB extra use), and skipping it measured
# ~10-25% faster generation. Set DOUBLE_QUANT=true to claim that VRAM back
# if a card is tight on memory.
DOUBLE_QUANT = os.environ.get('DOUBLE_QUANT', 'false').strip().lower() == 'true'

MAX_NEW_TOKENS = int(os.environ.get('MAX_NEW_TOKENS', 1024))

# Comma-separated language codes to advertise in addition to the ones baked
# into the model's chat template (i.e. the codes the model was fine-tuned on).
EXTRA_LANGUAGES = os.environ.get('EXTRA_LANGUAGES', 'xnr')

# For SILConverters: if you serve a local model, you can record its HOST path
# here so the NLLB Translator setup dialog can verify it exists. Purely
# informational; the server itself uses MODEL_DIR above.
LOCAL_MODEL_PATH = ''
