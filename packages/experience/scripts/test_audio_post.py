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


def test_candidate_seeds_keep_the_single_seed_render():
    seeds = ap.candidate_seeds("word.saba", 3)
    assert seeds[0] == ap.seed_for("word.saba")  # --seeds 1 reproduces earlier renders
    assert seeds[1:] == [ap.seed_for("word.saba#1"), ap.seed_for("word.saba#2")]
    assert len(set(seeds)) == 3
    assert ap.candidate_seeds("word.saba", 0) == [ap.seed_for("word.saba")]


def test_normalize_for_cer():
    assert ap.normalize_for_cer("  Je, NI   sawa?! ") == "je ni sawa"
    assert ap.normalize_for_cer("ng'ombe") == "ng ombe"


def test_levenshtein():
    assert ap.levenshtein("", "abc") == 3
    assert ap.levenshtein("kitten", "sitting") == 3
    assert ap.levenshtein("saba", "saba") == 0
    assert ap.levenshtein("sawa", "saba") == ap.levenshtein("saba", "sawa") == 1


def test_cer():
    assert ap.cer("Ni sawa.", "ni sawa?") == 0.0
    assert ap.cer("sawa", "ni sawa") == round(3 / 7, 4)
    assert ap.cer("", "saba") == 1.0
    assert ap.cer("saba saba saba", "saba") > 1.0  # runaway repetition can exceed 1
    assert ap.cer("", "?!") == 0.0 and ap.cer("x", "") == 1.0
    assert ap.best_cer("SMS", ["es em es", "sms"]) == 0.0


def cand(seed, duration_s, flag=None, cer=None):
    return {"seed": seed, "duration_s": duration_s, "flag": flag, "cer": cer}


def test_select_by_cer_then_flag_then_duration():
    cands = [cand(1, 0.9, cer=0.5), cand(2, 3.0, flag="too_long", cer=0.1), cand(3, 0.6, cer=0.1)]
    assert ap.select_candidate(cands, 0.6) == (2, "cer")  # equal CER: the unflagged one wins
    cands = [cand(1, 0.9, cer=0.2), cand(2, 0.6, cer=0.2)]
    assert ap.select_candidate(cands, 0.6) == (1, "cer")  # equal CER, no flags: closest duration
    cands = [cand(1, 0.6), cand(2, 0.9, cer=0.4)]
    assert ap.select_candidate(cands, 0.6) == (1, "cer")  # a transcribed candidate beats an untranscribed one


def test_select_by_duration_without_cer():
    cands = [cand(1, 4.5, flag="too_long"), cand(2, 0.9), cand(3, 0.7)]
    assert ap.select_candidate(cands, 0.6) == (2, "duration")
    assert ap.select_candidate([cand(1, 4.5, flag="too_long"), cand(2, 5.0, flag="too_long")], 0.6)[0] == 0
    assert ap.select_candidate([cand(1, 0.7), cand(2, 0.5)], 0.6)[0] == 0  # exact tie keeps seed order


def test_select_needs_candidates():
    import pytest
    with pytest.raises(ValueError):
        ap.select_candidate([], 1.0)


def test_suspect_reasons():
    assert ap.suspect_reasons(cand(1, 0.6, cer=0.1)) == []
    assert ap.suspect_reasons(cand(1, 0.6)) == []  # no Whisper: duration only
    assert ap.suspect_reasons(cand(1, 0.6, cer=0.5)) == ["cer_0.5>0.35"]
    assert ap.suspect_reasons(cand(1, 4.5, flag="too_long", cer=0.36), max_cer=0.4) == ["duration_too_long"]
    assert ap.suspect_reasons(cand(1, 0.6, cer=0.35)) == []  # threshold is inclusive


def test_overrides_and_model_files_without_a_model():
    import json

    import generate_audio as ga

    overrides = json.loads(ga.OVERRIDES.read_text(encoding="utf-8"))["overrides"]
    assert ga.spoken("channel.sms", "SMS", overrides) == ("es em es", ["es em es", "sms", "s m s"], True)
    assert ga.spoken("word.na", "na", overrides)[2] is False
    assert ga.spoken("word.mia", "mia", overrides)[2] is False
    assert ga.spoken("word.saba", "saba", overrides) == ("saba", ["saba"], True)
    for o in overrides.values():
        assert o["review_status"] == "UNREVIEWED"
        assert not any(ch.isdigit() for ch in o.get("tts_text", ""))
    src = '''
        ve.load_state_dict(torch.load(ckpt_dir / "ve.pt", weights_only=True))
        t3_state = load_safetensors(ckpt_dir / "t3_mtl23ls_v2.safetensors")
        if "model" in t3_state.keys(): pass
        s3gen.load_state_dict(torch.load(ckpt_dir / 's3gen.pt'))
        tokenizer = MTLTokenizer(str(ckpt_dir / "grapheme_mtl_merged_expanded_v1.json"))
        if (builtin_voice := ckpt_dir / "conds.pt").exists(): pass
    '''
    assert ga.files_loaded_by(src) == ga.MODEL_FILES
    assert ga.model_files_for(object)[0] == ga.MODEL_FILES  # no from_local: fall back to the constant
