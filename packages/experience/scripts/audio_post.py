"""Post-processing and sanity checks for generated Swahili clips (no model needed, unit-tested).

Used by generate_audio.py after each Chatterbox render:
- trim leading/trailing silence, peak-normalize to -1 dBFS, write 16-bit PCM mono WAV (stdlib `wave`);
- flag a clip whose duration is implausible for its text (runaway or repeated tokens), so it is retried with
  another seed and, if still wrong, marked SUSPECT instead of shipped.
"""

from __future__ import annotations

import hashlib
import wave
from pathlib import Path

import numpy as np

TARGET_PEAK_DBFS = -1.0
SILENCE_DBFS = -45.0
# Swahili speech at a calm pace: roughly 12-15 characters per second; a short word still needs ~0.4 s.
CHARS_PER_SECOND = 13.0
MIN_EXPECTED_S = 0.4
MAX_FACTOR = 2.5  # longer than 2.5x the expected duration (+0.6 s) = runaway
MIN_FACTOR = 0.35  # shorter than 0.35x = probably cut off


def seed_for(key: str) -> int:
    """A stable seed per clip key, so a re-render with the same model gives the same audio."""
    return int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:8], 16)


def expected_seconds(text: str) -> float:
    return max(MIN_EXPECTED_S, len(text.strip()) / CHARS_PER_SECOND)


def duration_flag(text: str, seconds: float) -> str | None:
    """None if plausible, else 'too_long' or 'too_short'."""
    exp = expected_seconds(text)
    if seconds > MAX_FACTOR * exp + 0.6:
        return "too_long"
    if seconds < MIN_FACTOR * exp:
        return "too_short"
    return None


def trim_silence(x: np.ndarray, sr: int, threshold_dbfs: float = SILENCE_DBFS, pad_s: float = 0.08) -> np.ndarray:
    if x.size == 0:
        return x
    thr = 10 ** (threshold_dbfs / 20)
    idx = np.flatnonzero(np.abs(x) > thr)
    if idx.size == 0:
        return x[:0]
    pad = int(pad_s * sr)
    return x[max(0, idx[0] - pad): min(x.size, idx[-1] + 1 + pad)]


def normalize_peak(x: np.ndarray, target_dbfs: float = TARGET_PEAK_DBFS) -> np.ndarray:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak == 0.0:
        return x
    return x * (10 ** (target_dbfs / 20) / peak)


def write_pcm16(path: Path, x: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def peak_dbfs(x: np.ndarray) -> float:
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    return float("-inf") if peak == 0 else round(20 * np.log10(peak), 2)


def finish(x: np.ndarray, sr: int, path: Path) -> dict:
    """Trim, normalize, write; return the measurements recorded in the manifest."""
    y = normalize_peak(trim_silence(np.asarray(x, dtype=np.float64).reshape(-1), sr))
    write_pcm16(path, y, sr)
    return {"duration_s": round(y.size / sr, 3), "peak_dbfs": peak_dbfs(y), "sample_rate": sr, "format": "pcm_s16le"}
