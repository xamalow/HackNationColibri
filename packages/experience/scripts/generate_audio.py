"""Generate the Swahili voice clips listed in audio/manifest.json with Chatterbox (MIT), at build time on a laptop.

    pip install chatterbox-tts==<pin> torchaudio      # GPU optional; CPU works, slower
    python packages/experience/scripts/generate_audio.py --device cuda --revision <sha>   # all 133 clips
    python packages/experience/scripts/generate_audio.py --device cpu --revision <sha> --only 3

What it does, per clip:
- reads the current Swahili text (copy clips: copy/sw.json by key; word clips: the word after "word."),
- refuses a clip whose text hash no longer matches the manifest (a stale clip must never play),
- pins the model: downloads exactly --revision (huggingface_hub.snapshot_download) and loads from that folder,
- renders with a fixed seed per clip key (reproducible), trims silence, peak-normalizes to -1 dBFS and writes
  16-bit PCM mono (audio_post.py, unit-tested),
- checks the duration against the text (audio_post.duration_flag): a runaway or cut clip is re-rendered with
  the next seed, up to --retries; if still implausible it is written but marked status SUSPECT, never RECORDED,
- records status, wav_sha256, duration_s, peak_dbfs, seed, attempts and generator (package version, model repo +
  revision, language, device). review_status stays UNREVIEWED until a native Swahili listener reviews it.

Written by the Max lane; NOT run on the Max laptop (model ~3.3 GB, delegated). The Chatterbox multilingual API
used (ChatterboxMultilingualTTS.from_pretrained / generate(text, language_id="sw")) follows the package README;
if the installed version differs, adapt the two calls marked API and keep everything else.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

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
    ap.add_argument("--revision", required=True, help="Hugging Face commit sha of ResembleAI/chatterbox (pinned)")
    ap.add_argument("--retries", type=int, default=3, help="extra renders with the next seed when the duration is off")
    args = ap.parse_args()

    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # API
    from huggingface_hub import snapshot_download

    from audio_post import duration_flag, finish, seed_for

    local = snapshot_download(MODEL_REPO, revision=args.revision)  # the pin is the download, not just a label
    model = ChatterboxMultilingualTTS.from_local(local, device=args.device)  # API
    generator = {
        "package": "chatterbox-tts", "package_version": metadata.version("chatterbox-tts"),
        "model_repo": MODEL_REPO, "model_revision": args.revision, "language_id": "sw",
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
        out = PKG / clip["file"]
        base_seed = seed_for(clip["key"])
        for attempt in range(args.retries + 1):
            seed = base_seed + attempt
            torch.manual_seed(seed)
            wav = model.generate(text, language_id="sw")  # API
            info = finish(wav.squeeze().detach().cpu().numpy(), model.sr, out)
            flag = duration_flag(text, info["duration_s"])
            if flag is None:
                break
        clip.update({"status": "SUSPECT" if flag else "RECORDED", "duration_flag": flag, "seed": seed,
                     "attempts": attempt + 1, "wav_sha256": _sha256(out.read_bytes()), "generator": generator, **info})
        done += 1
        print(f"{'SUSPECT' if flag else 'ok'} {clip['key']} ({info['duration_s']} s, try {attempt + 1}): {text}")
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"recorded {done}, stale {stale}; review_status stays UNREVIEWED until the native Swahili review")


if __name__ == "__main__":
    main()
