# CPU override for the loving_swirles (nllb-studies) container, used only so
# both translation containers can be resident at once for the TranslateGemma
# comparison (the two GPU models don't both fit in 8 GB of VRAM together).
API_KEY = ''
PORT = 8000
MODEL_NAME = 'sil-ai/nllb-finetuned-hin-xnr-bible-plus-studies'
DEVICE = -1
