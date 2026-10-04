"""python -m pytest -q packages/experience/scripts/test_audio_post.py"""

import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_post as ap  # noqa: E402

SR = 24000


def tone(seconds: float, amp: float) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return amp * np.sin(2 * np.pi * 220 * t)


def test_peak_is_normalized_and_written_as_pcm16(tmp_path):
    x = np.concatenate([np.zeros(SR), tone(1.0, 1.15), np.zeros(SR)])  # over full scale + silence padding
    info = ap.finish(x, SR, tmp_path / "a.wav")
    assert -1.05 <= info["peak_dbfs"] <= -0.95
    assert 1.0 <= info["duration_s"] <= 1.3  # silence trimmed, small pad kept
    with wave.open(str(tmp_path / "a.wav")) as w:
        assert (w.getsampwidth(), w.getnchannels(), w.getframerate()) == (2, 1, SR)


def test_duration_flags_catch_runaway_and_cut_clips():
    assert ap.duration_flag("saba", 4.5) == "too_long"  # warden's example: a 4-letter word lasting 4.5 s
    assert ap.duration_flag("saba", 0.6) is None
    assert ap.duration_flag("Weka namba yako ya siri ya Sauti ili kuidhinisha", 0.5) == "too_short"
    assert ap.duration_flag("Weka namba yako ya siri ya Sauti ili kuidhinisha", 3.6) is None


def test_seed_is_stable_per_key():
    assert ap.seed_for("word.saba") == ap.seed_for("word.saba")
    assert ap.seed_for("word.saba") != ap.seed_for("word.sita")


def test_silence_only_stays_empty(tmp_path):
    info = ap.finish(np.zeros(SR), SR, tmp_path / "s.wav")
    assert info["duration_s"] == 0.0
