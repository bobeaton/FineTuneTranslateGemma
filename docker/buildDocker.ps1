<#
.SYNOPSIS
  Build and run the TranslateGemma translation webservice Docker container.

.DESCRIPTION
  The -Model parameter accepts either:
    - a local folder (default: the merged fine-tuned model in this workspace's
      models\ folder). The folder may hold a full model or just a LoRA adapter
      (adapter_config.json) -- for an adapter, the base model is pulled from
      Hugging Face on first start and cached in a named docker volume.
    - a Hugging Face repo id (e.g. "google/translategemma-4b-it" or a private
      "you/your-finetune"). Private repos use -HfToken (defaults to $env:HF_TOKEN).

.EXAMPLE
  # Serve the local fine-tuned Hindi<->Kangri model (GPU by default)
  .\buildDocker.ps1

.EXAMPLE
  # Serve the stock 4B model pulled from Hugging Face (gated: needs HF_TOKEN)
  .\buildDocker.ps1 -Model google/translategemma-4b-it

.EXAMPLE
  # Force CPU-only
  .\buildDocker.ps1 -Cpu

.EXAMPLE
  # Rebuild the image only
  .\buildDocker.ps1 -BuildOnly
#>
param(
    # Local model folder OR Hugging Face repo id.
    [string]$Model = "",

    [int]$Port = 8010,

    # Bare API key; the 'SIL-NLLB-Auth-Key ' prefix the NllbTranslatorEncConverter
    # sends is added automatically. Empty = no authentication.
    [string]$ApiKey = "",

    # Hugging Face token for gated/private repos (default: the HF_TOKEN env var).
    [string]$HfToken = $env:HF_TOKEN,

    # 'auto' = 4-bit on GPU / bf16 on CPU. Or '4bit' | '8bit' | 'none'.
    [ValidateSet("auto", "4bit", "8bit", "none")]
    [string]$Quantize = "auto",

    # GPU is used by default; pass -Cpu to force CPU-only.
    [switch]$Cpu,
    [switch]$Detached,
    [switch]$BuildOnly,
    # Fixed container name so it shows up predictably in Docker Desktop and can
    # be stopped/started there instead of re-running this script.
    [string]$ContainerName = "translategemma",
    # Auto-remove the container when it stops (default: it persists for restart).
    [switch]$Ephemeral
)

$ErrorActionPreference = "Stop"
$ImageName = "translategemma-translator"
$RepoRoot = Split-Path -Parent $PSScriptRoot  # docker/ -> project root

if (-not $Model) {
    $Model = Join-Path $RepoRoot "models\translategemma-4b-hi-xnr-merged"
}

Write-Host "Building Docker image '$ImageName' (build context: $RepoRoot)..."
docker build -f (Join-Path $PSScriptRoot "Dockerfile") -t $ImageName $RepoRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

if ($BuildOnly) {
    Write-Host "Build complete (skipped run due to -BuildOnly)."
    exit 0
}

# Replace any leftover container of the same name (running or stopped), so a
# repeat run of this script is a clean "replace" while `docker start` and the
# Docker Desktop buttons keep working on the existing one.
$existing = docker ps -aq --filter "name=^/$ContainerName$"
if ($existing) {
    Write-Host "Removing existing container '$ContainerName' ($existing)..."
    docker rm -f $ContainerName | Out-Null
}

$dockerArgs = @("run")
if ($Ephemeral) { $dockerArgs += "--rm" }
$dockerArgs += @("--name", $ContainerName)
if ($Detached) { $dockerArgs += "-d" } else { $dockerArgs += "-it" }
$dockerArgs += @("-p", "${Port}:8010", "-e", "PORT=8010")
$dockerArgs += @("-e", "QUANTIZE=$Quantize")

# Named volume for the HF cache: base/remote model downloads survive restarts.
$dockerArgs += @("-v", "translategemma-hf-cache:/root/.cache/huggingface")

if (Test-Path $Model) {
    # Local folder (full model or LoRA adapter). Bind-mounting a native Windows
    # path straight through Docker Desktop's WSL2 file-sharing bridge is very
    # slow for a multi-GB safetensors file -- reads that should take seconds
    # can take minutes. Instead, sync it once into a named Docker volume
    # (native Linux-VM storage, fast) and mount that volume read-only; the
    # sync is skipped on later runs unless the source folder's total size or
    # newest file timestamp has changed.
    $resolved = (Resolve-Path $Model).Path
    $files = Get-ChildItem $resolved -File -Recurse
    $totalSize = ($files | Measure-Object Length -Sum).Sum
    $maxWrite = ($files | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum.Ticks
    $syncMarker = "$resolved|$totalSize|$maxWrite"
    $volumeName = "translategemma-model-cache"

    Write-Host "Syncing local model into cache volume '$volumeName' (skipped if already up to date)..."
    docker run --rm `
        -v "${resolved}:/src:ro" `
        -v "${volumeName}:/dst" `
        -e "SYNC_MARKER=$syncMarker" `
        python:3.13-slim `
        sh -c 'if [ -f /dst/.sync-marker ] && [ "$(cat /dst/.sync-marker)" = "$SYNC_MARKER" ]; then echo "Model cache up to date."; else echo "Copying model into cache volume (one-time, or source changed)..."; find /dst -mindepth 1 -delete; cp -r /src/. /dst/; printf "%s" "$SYNC_MARKER" > /dst/.sync-marker; echo "Copy complete."; fi'
    if ($LASTEXITCODE -ne 0) { throw "model cache sync failed" }

    Write-Host "Serving local model: $resolved (via volume $volumeName)"
    $dockerArgs += @("-v", "${volumeName}:/app/model:ro", "-e", "MODEL_DIR=/app/model")
} else {
    if ($Model -notmatch "^[\w.-]+/[\w.-]+$") {
        throw "Model '$Model' is neither an existing folder nor a Hugging Face repo id (owner/name)"
    }
    Write-Host "Serving Hugging Face model: $Model"
    $dockerArgs += @("-e", "MODEL_NAME=$Model")
}

if ($HfToken) { $dockerArgs += @("-e", "HF_TOKEN=$HfToken") }
if ($ApiKey) {
    if ($ApiKey -notlike "SIL-NLLB-Auth-Key*") { $ApiKey = "SIL-NLLB-Auth-Key $ApiKey" }
    $dockerArgs += @("-e", "API_KEY=$ApiKey")
}
if (-not $Cpu) { $dockerArgs += @("--gpus", "device=0") }
$dockerArgs += $ImageName

# Don't echo the args verbatim -- they may contain the HF token / API key.
Write-Host "Starting container '$ContainerName' on port $Port (GPU: $(if (-not $Cpu) {'yes'} else {'no'}))..."
docker @dockerArgs

if ($Detached) {
    if (-not $Ephemeral) {
        Write-Host "`nContainer '$ContainerName' is running detached and will persist when stopped."
        Write-Host "Restart it later from Docker Desktop, or:  docker start $ContainerName"
        Write-Host "Follow the startup log with:              docker logs -f $ContainerName"
    }
    Write-Host "Web UI: http://localhost:$Port/  (the model takes a minute or two to load)"
} else {
    Write-Host "`nRunning in the foreground (Ctrl-C to stop)."
    Write-Host "To view the web UI, in another PowerShell window run:"
    Write-Host "  Start-Process http://localhost:$Port/"
}
