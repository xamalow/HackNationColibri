"""Generate the Swahili voice clips listed in audio/manifest.json with Chatterbox (MIT), at build time on a laptop.

    pip install chatterbox-tts==<pin> torchaudio      # GPU optional; CPU works, slower
    python packages/experience/scripts/generate_audio.py --device cuda            # all 133 clips
    python packages/experience/scripts/generate_audio.py --device cpu --only 3    # smoke test

What it does, per clip:
- reads the current Swahili text (copy clips: copy/sw.json by key; word clips: the word after "word."),
- refuses a clip whose text hash no longer matches the manifest (a stale clip must never play),
- writes audio/sw/<key>.wav and records in the manifest: status RECORDED, wav_sha256, generator (package
  version, model repo + revision, language, device). review_status stays UNREVIEWED: the Swahili text has no
  native review yet, so clips may need re-recording after it.

Written by the Max lane; NOT run on the Max laptop (model ~3.3 GB, delegated). The Chatterbox multilingual API
used (ChatterboxMultilingualTTS.from_pretrained / generate(text, language_id="sw")) follows the package README;
if the installed version differs, adapt the two calls marked API and keep everything else.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from importlib import metadata
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
MANIFEST = PKG / "audio" / "manifest.json"
SW = PKG / "copy" / "sw.json"
MODEL_REPO = "ResembleAI/chatterbox"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _strings(node: object) -> dict[str, dict]:
    """The dict of copy keys inside sw.json, wherever it is nested."""
    if isinstance(node, dict):
        if "screen.today.title" in node:
            return node  # type: ignore[return-value]
        for value in node.values():
            found = _strings(value)
            if found:
                return found
    return {}


def clip_text(key: str, sw: dict[str, dict]) -> str | None:
    if key.startswith("word."):
        return key[len("word."):]
    entry = sw.get(key)
    return entry["text"] if entry else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu", help="cpu, cuda or mps")
    ap.add_argument("--only", type=int, help="generate only the first N clips (smoke test)")
    ap.add_argument("--revision", help="Hugging Face revision of ResembleAI/chatterbox to record (commit sha)")
    args = ap.parse_args()

    import torchaudio
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # API

    model = ChatterboxMultilingualTTS.from_pretrained(device=args.device)  # API
    generator = {
        "package": "chatterbox-tts", "package_version": metadata.version("chatterbox-tts"),
        "model_repo": MODEL_REPO, "model_revision": args.revision or "UNRECORDED", "language_id": "sw",
        "device": args.device, "license": "MIT",
    }

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    sw = _strings(json.loads(SW.read_text(encoding="utf-8")))
    clips = manifest["copy_clips"] + manifest["word_clips"]
    done = stale = 0
    for clip in clips[: args.only] if args.only else clips:
        text = clip_text(clip["key"], sw)
        if text is None or _sha256(text.encode("utf-8")) != clip["text_sha256"]:
            print(f"STALE, skipped: {clip['key']}")
            stale += 1
            continue
        wav = model.generate(text, language_id="sw")  # API
        out = PKG / clip["file"]
        out.parent.mkdir(parents=True, exist_ok=True)
        torchaudio.save(str(out), wav, model.sr)
        clip.update({"status": "RECORDED", "wav_sha256": _sha256(out.read_bytes()), "generator": generator})
        done += 1
        print(f"ok {clip['key']}: {text}")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"recorded {done}, stale {stale}; review_status stays UNREVIEWED until the native Swahili review")


if __name__ == "__main__":
    main()
