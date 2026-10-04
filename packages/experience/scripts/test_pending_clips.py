"""Unit tests for pending_clips.py (no model, no audio).

    python -m pytest -q packages/experience/scripts/test_pending_clips.py
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pending_clips as pc  # noqa: E402

MANIFEST = json.loads((pc.PKG / "audio" / "manifest.json").read_text(encoding="utf-8"))
PENDING = pc.load()


def _rendered(entry: dict, status: str = "RECORDED") -> dict:
    e = copy.deepcopy(entry)
    e.update({"status": status, "wav_sha256": "0" * 64, "duration_s": 1.2, "seed": 7, "audio": True})
    return e


def test_pending_file_is_valid_and_never_available():
    keys = [e["key"] for e in PENDING["clips"]]
    assert len(keys) == len(set(keys)) == 28
    assert not set(keys) & pc.available_keys(MANIFEST)  # pending keys are not counted as available
    for e in PENDING["clips"]:
        assert e["status"] == "PENDING_RENDER" and e["review_status"] == "UNREVIEWED" and e["needs_native_review"]
        assert e["group"] == pc.group_for(e["key"])
        assert "file" not in e and "wav_sha256" not in e  # nothing rendered, nothing faked
        assert pc.is_fresh(e), e["key"]
    assert {"word.na", "word.mia"}.isdisjoint(keys)  # audio:false words are not re-added here


def test_jobs_skip_stale_and_unknown_status():
    pending = copy.deepcopy(PENDING)
    pending["clips"][0]["text"] = "changed"
    pending["clips"][1]["status"] = "NO_AUDIO"
    got = [e["key"] for e in pc.jobs(pending)]
    assert PENDING["clips"][0]["key"] not in got and PENDING["clips"][1]["key"] not in got
    assert len(got) == 26


def test_word_clip_must_say_its_key():
    e = copy.deepcopy(next(x for x in PENDING["clips"] if x["key"] == "word.jumamosi"))
    assert e["text"] == "jumamosi" and e["display_text"] == "Jumamosi"
    e["text"] = "Jumamosi"
    e["text_sha256"] = pc._sha256("Jumamosi")
    assert not pc.is_fresh(e)


def test_recorded_alert_clip_moves_into_manifest_with_text():
    manifest, pending = copy.deepcopy(MANIFEST), copy.deepcopy(PENDING)
    entry = next(e for e in pending["clips"] if e["key"] == "alert.see_sms")
    entry.update(_rendered(entry))
    assert pc.promote(manifest, pending, entry) == "manifest"
    clip = manifest["alert_clips"][-1]
    assert clip["key"] == "alert.see_sms" and clip["file"] == "audio/sw/alert.see_sms.wav"
    assert clip["text"] == "Maelezo yako kwenye SMS." and "group" not in clip
    assert "alert.see_sms" in pc.available_keys(manifest)
    assert all(e["key"] != "alert.see_sms" for e in pending["clips"])


def test_recorded_word_clip_joins_word_clips_without_text():
    manifest, pending = copy.deepcopy(MANIFEST), copy.deepcopy(PENDING)
    entry = next(e for e in pending["clips"] if e["key"] == "word.wanne")
    entry.update(_rendered(entry))
    pc.promote(manifest, pending, entry)
    clip = manifest["word_clips"][-1]
    assert clip["key"] == "word.wanne" and "text" not in clip and clip["text_sha256"] == pc._sha256("wanne")


def test_suspect_render_stays_pending_and_unavailable():
    manifest, pending = copy.deepcopy(MANIFEST), copy.deepcopy(PENDING)
    entry = next(e for e in pending["clips"] if e["key"] == "platform.booking")
    entry.update(_rendered(entry, "SUSPECT"))
    assert pc.promote(manifest, pending, entry) == "pending"
    assert entry["suspect_file"] == "audio/sw/platform.booking.wav" and "file" not in entry
    assert "platform.booking" not in pc.available_keys(manifest)
    assert entry in pc.jobs(pending)  # re-rendered on the next run


def test_promote_refuses_duplicates_and_unrendered():
    manifest, pending = copy.deepcopy(MANIFEST), copy.deepcopy(PENDING)
    entry = next(e for e in pending["clips"] if e["key"] == "alert.urgent")
    with pytest.raises(ValueError):
        pc.promote(manifest, pending, {**entry, "status": "RECORDED"})  # no wav_sha256
    entry.update(_rendered(entry))
    pc.promote(manifest, pending, copy.deepcopy(entry))
    with pytest.raises(ValueError):
        pc.promote(manifest, pending, entry)
