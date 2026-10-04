"""Clips that are needed but not rendered yet (audio/pending_clips.json), and their promotion into the manifest.

Why a separate file: apps/hub (notify.MANIFEST_KEYS) and apps/hub-voice (hub_voice/outbound.py ClipLibrary) treat
every key in audio/manifest.json groups copy_clips / word_clips / alert_clips / clips as an available clip. A clip
that has no audio yet must not be counted as available (the hub would list a call the worker cannot play), so it
lives here until a render is RECORDED, and only then moves into manifest[group] with its file and hashes.

Used by scripts/generate_audio.py (the Chatterbox generator):
    pending = pending_clips.load()
    for entry in pending_clips.jobs(pending): render it like any clip (text = entry["text"],
        out = PKG / pending_clips.target_file(key)), update the entry in place (status, wav_sha256, ...),
        then pending_clips.promote(manifest, pending, entry)
    pending_clips.save(pending)   # after writing the manifest

Pure stdlib, unit-tested (test_pending_clips.py). Never fakes audio: an entry gets a file only from a real render.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PENDING = PKG / "audio" / "pending_clips.json"

# The manifest groups apps/hub and apps/hub-voice read as "available". A key is never in one of these and pending.
AVAILABLE_GROUPS = ("copy_clips", "word_clips", "alert_clips", "clips")
# Where a rendered pending clip goes: word.* keys join the word clips, everything else the alert clips.
TARGET_GROUPS = ("alert_clips", "word_clips")
PENDING_STATUSES = ("PENDING_RENDER", "SUSPECT")
# Fields that only describe the pending state; dropped when the clip moves into the manifest.
PENDING_ONLY = ("group", "display_text", "suspect_file")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load(path: Path = PENDING) -> dict:
    if not path.exists():
        return {"clips": []}
    return json.loads(path.read_text(encoding="utf-8"))


def save(pending: dict, path: Path = PENDING) -> None:
    path.write_text(json.dumps(pending, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def target_file(key: str) -> str:
    """Manifest-relative wav path of a clip (same layout as the existing clips)."""
    return f"audio/sw/{key}.wav"


def group_for(key: str) -> str:
    return "word_clips" if key.startswith("word.") else "alert_clips"


def available_keys(manifest: dict) -> set[str]:
    """What the hub and hub-voice count as available: every key in the four manifest groups."""
    return {c["key"] for g in AVAILABLE_GROUPS for c in manifest.get(g, []) or [] if isinstance(c, dict) and "key" in c}


def is_fresh(entry: dict) -> bool:
    """Text and hash agree (and a word clip says exactly the word after 'word.'); a stale entry is never rendered."""
    key, text = entry.get("key", ""), entry.get("text")
    if not isinstance(text, str) or not text.strip() or _sha256(text) != entry.get("text_sha256"):
        return False
    return not key.startswith("word.") or text == key[len("word."):]


def jobs(pending: dict) -> list[dict]:
    """Entries to render on this run (the dicts themselves, so the generator can update them in place)."""
    return [e for e in pending.get("clips", []) if e.get("status") in PENDING_STATUSES and is_fresh(e)]


def promote(manifest: dict, pending: dict, entry: dict) -> str:
    """After a render updated `entry` in place: RECORDED -> moved into manifest[group] (returns "manifest");
    anything else (SUSPECT) -> stays pending with its measurements and suspect_file for a listener ("pending")."""
    key = entry["key"]
    if entry.get("status") != "RECORDED":
        if "wav_sha256" in entry:
            entry["suspect_file"] = target_file(key)
        return "pending"
    if key in available_keys(manifest):
        raise ValueError(f"{key} is already in the manifest; refusing to add it twice")
    group = entry.get("group") or group_for(key)
    if group not in TARGET_GROUPS or group != group_for(key):
        raise ValueError(f"{key}: unexpected group {group!r}")
    if not entry.get("wav_sha256"):
        raise ValueError(f"{key}: RECORDED without wav_sha256")
    clip = {k: v for k, v in entry.items() if k not in PENDING_ONLY}
    if group == "word_clips":
        clip.pop("text", None)  # word clips carry no text: it is the word after "word." (manifest convention)
    clip["file"] = target_file(key)
    manifest.setdefault(group, []).append(clip)
    pending["clips"] = [e for e in pending.get("clips", []) if e.get("key") != key]
    return "manifest"
