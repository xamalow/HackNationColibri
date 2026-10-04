"""Generate the Swahili voice clips listed in audio/manifest.json with Chatterbox (MIT), at build time on a laptop.

    pip install chatterbox-tts==<pin> torchaudio      # GPU optional; CPU works, slower
    pip install faster-whisper                        # optional, only for --select-cer
    python packages/experience/scripts/generate_audio.py --device cuda --revision <sha>   # all 133 clips
    python packages/experience/scripts/generate_audio.py --device cpu --revision <sha> --only 3
    python packages/experience/scripts/generate_audio.py --device cuda --revision <sha> --seeds 3 --select-cer

What it does, per clip:
- reads the current Swahili text (copy clips: copy/sw.json by key; word clips: the word after "word."),
- refuses a clip whose text hash no longer matches the manifest (a stale clip must never play),
- applies audio/tts_overrides.json: `tts_text` = what the clip says when it must differ from the displayed copy
  (same meaning, UNREVIEWED); `audio: false` = the clip is dropped (status NO_AUDIO, never rendered or played;
  the line is shown as text, in the call flow sent as SMS text),
- pins the model: downloads exactly --revision (huggingface_hub.snapshot_download), limited to the files
  ChatterboxMultilingualTTS.from_local reads (MODEL_FILES, see below), and loads from that folder,
- renders --seeds N candidates with seeds derived from the key (audio_post.candidate_seeds; candidate 0 is
  seed_for(key), so --seeds 1 reproduces earlier renders), trims silence, peak-normalizes to -1 dBFS and writes
  16-bit PCM mono (audio_post.py, unit-tested),
- with --select-cer and faster_whisper installed: transcribes every candidate (language sw, digit tokens
  suppressed because the spoken text never has digits) and keeps the lowest character error rate against the
  spoken text; ties and the no-Whisper case go to a candidate without a duration flag, then the one closest to
  the expected duration (audio_post.select_candidate),
- if no candidate is acceptable (duration flag, or CER > --max-cer), renders up to --retries more with
  seed_for(key) + 1, + 2, ... (the pre---seeds retry sequence); a clip whose chosen candidate is still not
  acceptable is written but marked status SUSPECT with suspect_reasons, never RECORDED,
- records status, wav_sha256, duration_s, peak_dbfs, seed, cer, transcript, duration_flag, every candidate tried,
  the selection method and generator (package version, model repo + revision + files, language, device, Whisper
  model). review_status stays UNREVIEWED until a native Swahili listener reviews it.

Written by the Max lane; NOT run on the Max laptop (model ~3.2 GB, delegated). The Chatterbox multilingual API
used (ChatterboxMultilingualTTS.from_local / generate(text, language_id="sw")) follows the package source;
if the installed version differs, adapt the two calls marked API and keep everything else.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import re
import shutil
import sys
import tempfile
from importlib import metadata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

PKG = Path(__file__).resolve().parent.parent
MANIFEST = PKG / "audio" / "manifest.json"
OVERRIDES = PKG / "audio" / "tts_overrides.json"
SW = PKG / "copy" / "sw.json"
MODEL_REPO = "ResembleAI/chatterbox"

# allow_patterns for snapshot_download: only the files ChatterboxMultilingualTTS.from_local(ckpt_dir) reads
# (chatterbox-tts mtl_tts.py: ve.pt -> VoiceEncoder, t3_mtl23ls_v2.safetensors -> T3 multilingual,
# s3gen.pt -> S3Gen vocoder, grapheme_mtl_merged_expanded_v1.json -> MTLTokenizer, conds.pt -> built-in voice;
# the same list the library's own from_pretrained passes, minus Cangjie5_TC.json, see CANGJIE_NOTE).
# Derived without downloading weights: HF API file list of ResembleAI/chatterbox at main 5bb1f6e (18 files,
# 13.87 GB) + the library's from_local. These five are 3.21 GB, which matches warden's measurement (13.9 GB
# pulled by an unfiltered snapshot, 10.7 GB never loaded). Skipped: the English model (t3_cfg.*,
# s3gen.safetensors, ve.safetensors, tokenizer.json) and other multilingual versions (t3_23lang.safetensors,
# mtl_tokenizer.json, t3_mtl23ls_v3.safetensors, s3gen_v3.*). chatterbox-tts was not installed where this was
# written, so at run time the list is re-derived from the installed from_local (model_files_for) and this
# constant is only the fallback.
MODEL_FILES = ["conds.pt", "grapheme_mtl_merged_expanded_v1.json", "s3gen.pt", "t3_mtl23ls_v2.safetensors", "ve.pt"]
CANGJIE_NOTE = (
    "chatterbox-tts's MTLTokenizer fetches Cangjie5_TC.json itself with hf_hub_download from the main branch of "
    "ResembleAI/chatterbox, NOT pinned to model_revision. It is Chinese-only data (Cangjie codes for Chinese "
    "characters) and is not used for Swahili text, so it cannot change these clips."
)
MEASURED = ("duration_s", "peak_dbfs", "sample_rate", "format", "wav_sha256", "seed", "attempts", "cer",
            "transcript", "duration_flag", "suspect_reasons", "selection", "candidates", "generator")


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
    """The displayed Swahili text of a clip (the hashed source of truth)."""
    if key.startswith("word."):
        return key[len("word."):]
    entry = sw.get(key)
    return entry["text"] if entry else None


def spoken(key: str, text: str, overrides: dict[str, dict]) -> tuple[str, list[str], bool]:
    """(text the clip says, accepted CER references, audio on?) after audio/tts_overrides.json."""
    o = overrides.get(key, {})
    say = o.get("tts_text", text)
    return say, o.get("cer_refs", [say]), o.get("audio", True)


def files_loaded_by(source: str) -> list[str]:
    """Checkpoint file names quoted in a from_local implementation (ckpt_dir / "ve.pt", ...)."""
    return sorted(set(re.findall(r"""["']([\w.\-]+\.(?:pt|safetensors|json))["']""", source)))


def model_files_for(cls: type) -> tuple[list[str], str]:
    """allow_patterns for the installed chatterbox version, falling back to MODEL_FILES."""
    try:
        found = files_loaded_by(inspect.getsource(cls.from_local))
    except (OSError, TypeError, AttributeError):
        found = []
    if len(found) >= 3:
        return found, "parsed from the installed ChatterboxMultilingualTTS.from_local"
    return MODEL_FILES, "MODEL_FILES constant in generate_audio.py"


def load_whisper(name: str):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    return WhisperModel(name, device="auto", compute_type="default")


def digit_token_ids(model) -> list[int]:
    """Whisper tokens containing a digit: suppressed, so 'saba' is not transcribed as '7' (spoken text has no digits)."""
    try:
        return sorted(i for t, i in model.hf_tokenizer.get_vocab().items() if any(ch.isdigit() for ch in t))
    except Exception:  # noqa: BLE001 - tokenizer layout differs between versions; suppression is best-effort
        return []


def transcribe(model, path: Path, suppress: list[int]) -> str:
    segments, _ = model.transcribe(str(path), language="sw", beam_size=5, condition_on_previous_text=False,
                                   suppress_tokens=[-1, *suppress])
    return " ".join(s.text.strip() for s in segments).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu", help="cpu, cuda or mps")
    ap.add_argument("--only", type=int, help="generate only the first N clips (smoke test)")
    ap.add_argument("--revision", required=True, help="Hugging Face commit sha of ResembleAI/chatterbox (pinned)")
    ap.add_argument("--retries", type=int, default=3,
                    help="extra renders (seed_for(key)+1, +2, ...) when no candidate is acceptable")
    ap.add_argument("--seeds", type=int, default=1, help="candidates rendered per clip (best is kept); default 1")
    ap.add_argument("--select-cer", action="store_true",
                    help="pick the candidate by Whisper CER (needs faster_whisper; otherwise duration only)")
    ap.add_argument("--whisper-model", default="large-v3", help="faster_whisper model name for --select-cer")
    ap.add_argument("--max-cer", type=float, default=None,
                    help="best candidate above this CER is SUSPECT (default audio_post.MAX_CER = 0.35)")
    args = ap.parse_args()
    if args.seeds < 1:
        ap.error("--seeds must be >= 1")

    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # API
    from huggingface_hub import snapshot_download

    from audio_post import (MAX_CER, best_cer, candidate_seeds, duration_flag, expected_seconds, finish,
                            select_candidate, suspect_reasons)

    max_cer = MAX_CER if args.max_cer is None else args.max_cer
    model_files, files_source = model_files_for(ChatterboxMultilingualTTS)
    if model_files != MODEL_FILES:
        print(f"note: installed chatterbox loads {model_files}, not MODEL_FILES {MODEL_FILES}; using the former")
    # The pin is the download, not just a label; allow_patterns skips the ~10.7 GB the multilingual model never reads.
    local = snapshot_download(MODEL_REPO, revision=args.revision, allow_patterns=model_files)
    model = ChatterboxMultilingualTTS.from_local(local, device=args.device)  # API

    whisper = suppress = None
    if args.select_cer:
        whisper = load_whisper(args.whisper_model)
        if whisper is None:
            print("WARNING: --select-cer but faster_whisper is not importable; selecting by duration only")
        else:
            suppress = digit_token_ids(whisper)
    generator = {
        "package": "chatterbox-tts", "package_version": metadata.version("chatterbox-tts"),
        "model_repo": MODEL_REPO, "model_revision": args.revision, "model_files": model_files,
        "model_files_source": files_source, "language_id": "sw", "device": args.device, "license": "MIT",
        "unpinned_fetch": CANGJIE_NOTE,
        "whisper": None if whisper is None else {
            "package": "faster-whisper", "package_version": metadata.version("faster-whisper"),
            "model": args.whisper_model, "language": "sw", "digit_tokens_suppressed": len(suppress or []),
        },
    }

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8"))["overrides"]
    sw = _strings(json.loads(SW.read_text(encoding="utf-8")))
    clips = manifest["copy_clips"] + manifest["word_clips"]
    done = stale = dropped = suspect = 0
    for clip in clips[: args.only] if args.only else clips:
        key = clip["key"]
        text = clip_text(key, sw)
        if text is None or _sha256(text.encode("utf-8")) != clip["text_sha256"]:
            print(f"STALE, skipped: {key}")
            stale += 1
            continue
        say, refs, audio_on = spoken(key, text, overrides)
        for field in (*MEASURED, "tts_text", "tts_text_sha256", "no_audio_reason"):
            clip.pop(field, None)
        if say != text:
            clip.update({"tts_text": say, "tts_text_sha256": _sha256(say.encode("utf-8"))})
        if not audio_on:
            clip.update({"audio": False, "status": "NO_AUDIO", "no_audio_reason": overrides[key].get("reason")})
            dropped += 1
            print(f"NO_AUDIO {key}: dropped by tts_overrides.json, shown/sent as text")
            continue

        out = PKG / clip["file"]
        with tempfile.TemporaryDirectory() as tmp:

            def render(seed: int, tmp: str = tmp, say: str = say, refs: list[str] = refs) -> dict:
                torch.manual_seed(seed)
                wav = model.generate(say, language_id="sw")  # API
                path = Path(tmp) / f"{seed}.wav"
                info = finish(wav.squeeze().detach().cpu().numpy(), model.sr, path)
                heard = transcribe(whisper, path, suppress or []) if whisper is not None else None
                return {"seed": seed, "path": path, "info": info, "duration_s": info["duration_s"],
                        "flag": duration_flag(say, info["duration_s"]), "transcript": heard,
                        "cer": None if heard is None else best_cer(heard, refs)}

            seeds = candidate_seeds(key, args.seeds)
            cands = [render(s) for s in seeds]
            while len(cands) - len(seeds) < args.retries and all(suspect_reasons(c, max_cer) for c in cands):
                cands.append(render(seeds[0] + len(cands) - len(seeds) + 1))
            best, method = select_candidate(cands, expected_seconds(say))
            chosen = cands[best]
            shutil.copyfile(chosen["path"], out)
        reasons = suspect_reasons(chosen, max_cer)
        status = "SUSPECT" if reasons else "RECORDED"
        clip.update({
            "audio": True, "status": status, "suspect_reasons": reasons, "seed": chosen["seed"],
            "cer": chosen["cer"], "transcript": chosen["transcript"], "duration_flag": chosen["flag"],
            "attempts": len(cands),
            "selection": {"method": method, "seeds_requested": args.seeds, "retries_used": len(cands) - len(seeds),
                          "max_cer": max_cer if whisper is not None else None},
            "candidates": [{k: c[k] for k in ("seed", "duration_s", "flag", "cer", "transcript")} for c in cands],
            "wav_sha256": _sha256(out.read_bytes()), "generator": generator, **chosen["info"],
        })
        done += 1
        suspect += bool(reasons)
        print(f"{status} {key} seed {chosen['seed']} ({chosen['duration_s']} s, cer {chosen['cer']}, "
              f"{len(cands)} tried, by {method}): {say}")
    manifest["tts_overrides"] = "audio/tts_overrides.json"
    manifest["provenance_notes"] = [CANGJIE_NOTE]
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"rendered {done} ({suspect} SUSPECT), dropped {dropped} (NO_AUDIO), stale {stale}; "
          "review_status stays UNREVIEWED until the native Swahili review")


if __name__ == "__main__":
    main()
