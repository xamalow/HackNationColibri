"""Post-processing and sanity checks for generated Swahili clips (no model needed, unit-tested).

Used by generate_audio.py after each Chatterbox render:
- trim leading/trailing silence, peak-normalize to -1 dBFS, write 16-bit PCM mono WAV (stdlib `wave`);
- flag a clip whose duration is implausible for its text (runaway or repeated tokens), so it is retried with
  another seed and, if still wrong, marked SUSPECT instead of shipped;
- character error rate (CER) of a Whisper transcript against the spoken text, and the pure best-of-N candidate
  selection used by `generate_audio.py --seeds N [--select-cer]`.
"""

from __future__ import annotations

import hashlib
import unicodedata
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
MAX_CER = 0.35  # best candidate above this CER (Whisper round trip) = SUSPECT


def seed_for(key: str) -> int:
    """A stable seed per clip key, so a re-render with the same model gives the same audio."""
    return int(hashlib.sha256(key.encode("utf-8")).hexdigest()[:8], 16)


def candidate_seeds(key: str, n: int) -> list[int]:
    """Seeds for N candidates of one clip. Candidate 0 keeps seed_for(key), so single-seed renders stay reproducible."""
    return [seed_for(key) if i == 0 else seed_for(f"{key}#{i}") for i in range(max(1, n))]


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


# --- Whisper round trip: CER and best-of-N selection (pure, no model) ---------------------------------------


def normalize_for_cer(text: str) -> str:
    """Lowercase, punctuation and symbols removed, whitespace collapsed (NFKC first)."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = "".join(" " if unicodedata.category(ch)[0] in "PS" else ch for ch in text)
    return " ".join(text.split())


def levenshtein(a: str, b: str) -> int:
    """Edit distance (insert, delete, substitute = 1), two-row dynamic programming."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(hypothesis: str, reference: str) -> float:
    """Character error rate of a transcript against the spoken text, after normalize_for_cer. Can exceed 1."""
    hyp, ref = normalize_for_cer(hypothesis), normalize_for_cer(reference)
    if not ref:
        return 0.0 if not hyp else 1.0
    return round(levenshtein(hyp, ref) / len(ref), 4)


def best_cer(hypothesis: str, references: list[str]) -> float:
    """Lowest CER over accepted spellings of the spoken text (e.g. 'es em es' and 'sms')."""
    return min(cer(hypothesis, r) for r in references)


def _rank(cand: dict, expected_s: float, use_cer: bool) -> tuple:
    c = cand.get("cer")
    cer_key = (c is None, c if c is not None else 0.0) if use_cer else (False, 0.0)
    return (*cer_key, cand.get("flag") is not None, abs(cand["duration_s"] - expected_s))


def select_candidate(cands: list[dict], expected_s: float) -> tuple[int, str]:
    """Index of the best candidate and the method used.

    Each candidate has duration_s, flag (duration_flag result) and optionally cer (None if not transcribed).
    'cer': lowest CER first, then no duration flag, then closest to the expected duration.
    'duration' (no candidate has a CER): no duration flag first, then closest to the expected duration.
    Ties keep the earlier candidate (seed order), so the choice is deterministic.
    """
    if not cands:
        raise ValueError("no candidates")
    use_cer = any(c.get("cer") is not None for c in cands)
    best = min(range(len(cands)), key=lambda i: (_rank(cands[i], expected_s, use_cer), i))
    return best, "cer" if use_cer else "duration"


def suspect_reasons(cand: dict, max_cer: float = MAX_CER) -> list[str]:
    """Why a (selected) candidate must not be shipped as RECORDED; empty list = acceptable."""
    reasons = []
    if cand.get("flag"):
        reasons.append(f"duration_{cand['flag']}")
    if cand.get("cer") is not None and cand["cer"] > max_cer:
        reasons.append(f"cer_{cand['cer']}>{max_cer}")
    return reasons
