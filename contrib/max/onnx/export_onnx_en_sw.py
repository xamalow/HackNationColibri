"""Max lane: export Helsinki-NLP/opus-mt-en-sw (Apache-2.0, Marian) to ONNX fp32 + int8, from the upstream repo.

    python contrib/max/onnx/export_onnx_en_sw.py            # needs the throwaway env described in README.md

1. Downloads the upstream repo at a pinned revision (PyTorch weights + tokenizer files only, no tf_model.h5)
   into models/hf/opus-mt-en-sw and checks pytorch_model.bin against the LFS sha256 published by Hugging Face.
2. Exports with optimum (task text2text-generation-with-past) into models/opus-onnx/en-sw/fp32.
3. Dynamic int8 quantization (onnxruntime.quantization.quantize_dynamic, QInt8 weights, per-tensor) of the
   encoder, the decoder and the decoder-with-past into models/opus-onnx/en-sw/int8, then optimum's merge_decoders
   fuses the two int8 decoders into int8/decoder_model_merged.onnx (quantize_dynamic does not reach the weights
   of an already merged decoder: they sit outside its If branches, so the file stayed fp32-sized). Tokenizer and
   config files are copied next to them.
4. Prints bytes + sha256 of every ONNX file and writes them to models/opus-onnx/en-sw/hashes.json.

Nothing written here is committed: /models/ is gitignored. Only the hashes go to data/model-manifest.json.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
REPO = "Helsinki-NLP/opus-mt-en-sw"
REVISION = "28780399d37e1161afc94577a717d7fcfa54fecc"
WEIGHTS_SHA256 = "dd3fc2179f4c5e4ff79241d33f644091bd93036e6b11c17e1feb749e0f0324a5"  # LFS oid of pytorch_model.bin
SNAPSHOT = ROOT / "models" / "hf" / "opus-mt-en-sw"
OUT = ROOT / "models" / "opus-onnx" / "en-sw"
GRAPHS = ("encoder_model.onnx", "decoder_model_merged.onnx", "decoder_model.onnx", "decoder_with_past_model.onnx")
SIDE_FILES = ("config.json", "generation_config.json", "source.spm", "target.spm", "vocab.json",
              "tokenizer_config.json", "special_tokens_map.json")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(REPO, revision=REVISION, local_dir=str(SNAPSHOT),
                      allow_patterns=["*.json", "*.spm", "pytorch_model.bin", "README.md"])
    if sha256(SNAPSHOT / "pytorch_model.bin") != WEIGHTS_SHA256:
        raise SystemExit("pytorch_model.bin does not match the published LFS sha256")


def export_fp32() -> None:
    from optimum.exporters.onnx import main_export

    main_export(str(SNAPSHOT), output=OUT / "fp32", task="text2text-generation-with-past", do_validation=True)


def quantize_int8() -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from optimum.onnx.graph_transformations import merge_decoders

    (OUT / "int8").mkdir(parents=True, exist_ok=True)
    for name in ("encoder_model.onnx", "decoder_model.onnx", "decoder_with_past_model.onnx"):
        quantize_dynamic(OUT / "fp32" / name, OUT / "int8" / name, weight_type=QuantType.QInt8, per_channel=False)
    merge_decoders(OUT / "int8" / "decoder_model.onnx", OUT / "int8" / "decoder_with_past_model.onnx",
                   save_path=OUT / "int8" / "decoder_model_merged.onnx", strict=False)  # as optimum does for seq2seq
    for name in SIDE_FILES:
        shutil.copy2(OUT / "fp32" / name, OUT / "int8" / name)


def record() -> dict:
    hashes = {}
    for variant in ("fp32", "int8"):
        for name in GRAPHS:
            p = OUT / variant / name
            hashes[f"{variant}/{name}"] = {"bytes": p.stat().st_size, "sha256": sha256(p)}
            print(f"{variant}/{name}  {p.stat().st_size:>11,}  {hashes[f'{variant}/{name}']['sha256']}")
    for name in ("source.spm", "target.spm", "vocab.json"):
        p = OUT / "int8" / name
        hashes[f"int8/{name}"] = {"bytes": p.stat().st_size, "sha256": sha256(p)}
    (OUT / "hashes.json").write_text(json.dumps(hashes, indent=2) + "\n", encoding="utf-8")
    return hashes


def main() -> None:
    download()
    if not (OUT / "fp32" / GRAPHS[0]).exists():
        export_fp32()
    quantize_int8()
    record()


if __name__ == "__main__":
    main()
