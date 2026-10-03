"""Paths and settings. Override with environment variables, never with secrets in code."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MODELS_DIR = Path(os.environ.get("SAUTI_MODELS_DIR", ROOT / "models"))
DB_PATH = Path(os.environ.get("SAUTI_DB_PATH", ROOT / "data" / "sauti.db"))
LOG_PATH = Path(os.environ.get("SAUTI_LOG_PATH", ROOT / "data" / "sauti.log"))

WHISPER_DIR = MODELS_DIR / "faster-whisper-small"
QWEN_PATH = MODELS_DIR / "qwen3" / "Qwen3-0.6B-Q8_0.gguf"
TTS_DIR = MODELS_DIR / "mms-tts-swh"
NLLB_DIR = MODELS_DIR / "nllb-600m-ct2-int8"


def force_offline() -> None:
    """Forbid any model download or hub call at runtime: the core path is offline."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
