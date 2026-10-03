#!/usr/bin/env bash
# Download every local model into models/ (never committed). Run once with network,
# afterwards Sauti Host runs fully offline.
set -euo pipefail

cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-.venv/bin/python}"
MODELS_DIR="${SAUTI_MODELS_DIR:-models}"

"$PYTHON" - "$MODELS_DIR" <<'EOF'
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download

models = Path(sys.argv[1])

print("Whisper small (CTranslate2, MIT) ...")
snapshot_download("Systran/faster-whisper-small", local_dir=models / "faster-whisper-small")

print("Qwen3 0.6B GGUF Q8_0 (Apache 2.0) ...")
hf_hub_download("Qwen/Qwen3-0.6B-GGUF", "Qwen3-0.6B-Q8_0.gguf", local_dir=models / "qwen3")

print("MMS-TTS Swahili (CC-BY-NC 4.0) ...")
snapshot_download("facebook/mms-tts-swh", local_dir=models / "mms-tts-swh")

print("NLLB-200 distilled 600M, CTranslate2 int8 (CC-BY-NC 4.0) ...")
snapshot_download("JustFrederik/nllb-200-distilled-600M-ct2-int8", local_dir=models / "nllb-600m-ct2-int8")
snapshot_download(
    "facebook/nllb-200-distilled-600M",
    local_dir=models / "nllb-600m-ct2-int8",
    allow_patterns=["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "sentencepiece.bpe.model"],
)

print(f"Done. Models are in {models.resolve()}")
EOF
