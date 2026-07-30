# Build context must be the FineTuneTranslateGemma project root (not this
# docker/ folder), since scripts/tg_common.py is shared with the training code
# -- buildDocker.ps1 handles this.
FROM python:3.13-slim

# build-essential (gcc) is required at *runtime*, not just build time: torch /
# bitsandbytes dispatch the 4-bit kernels through Triton, which JIT-compiles
# itself with a C compiler on first use ("Failed to find C compiler" otherwise).
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
ENV CC=gcc

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY docker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY docker/server.py docker/settings.py ./
COPY scripts/tg_common.py .
COPY docker/templates ./templates

# The model is NOT baked into the image. Either:
#  - mount a local model (full or LoRA adapter) at /app/model, or
#  - set MODEL_NAME (+ HF_TOKEN for private repos) and mount a named volume at
#    /root/.cache/huggingface so the download persists across restarts.
# buildDocker.ps1 sets all of this up.

EXPOSE 8010
CMD ["python", "server.py"]
