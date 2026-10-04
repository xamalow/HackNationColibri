# Max lane (06): model and device experiments, provenance

Owner: Max. Helper: xam-claude. Paths owned: `contrib/max/`, `data/model-manifest.json` (lane map r1).
Nothing here is product code; Domain's core and Mobile's app consume the conclusions, not these files.

| Artifact | What |
|---|---|
| [model-decision.md](model-decision.md) | What Qwen3 0.6B may and may not do in Sauti, with measured numbers |
| [langid-decision.md](langid-decision.md) | Language ID for sources with no declared language: franc + refusal rules, test vectors |
| [tagger-decision.md](tagger-decision.md) | Deterministic theme tagger (sw/en/de/fr) that replaces model labels: exact quotes, core output shape |
| [onnx/README.md](onnx/README.md) | opus-mt-en-sw exported to int8 ONNX from upstream Helsinki-NLP for onnxruntime-react-native: chrF 62.8 vs 63.2 (CT2), files, hashes, Mobile loop |
| [../../data/model-manifest.json](../../data/model-manifest.json) | Every candidate model/runtime: source, revision, bytes, sha256 (MEASURED or PUBLISHED), license, status |
| [language-review.csv](language-review.csv) | Every Swahili string this lane wrote, for a native reviewer. All UNREVIEWED |
| [data-card.md](data-card.md) | The synthetic dev set: provenance, size, what it does not cover |
| [devset/feedback_dev.jsonl](devset/feedback_dev.jsonl) | 40 synthetic labeled feedback items (sw/en/de/fr) |
| [qwen_extraction.py](qwen_extraction.py) | The experiment harness (Qwen proposes, code validates like the Domain contract) |
| [results/](results/) | Raw outputs and metrics per run, timestamped, labeled DESKTOP |

## Reproduce

```bash
# model (639,446,688 bytes, Apache-2.0), verify the hash from the manifest
curl -L -o models/qwen3/Qwen3-0.6B-Q8_0.gguf https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/23749fefcc72300e3a2ad315e1317431b06b590a/Qwen3-0.6B-Q8_0.gguf
sha256sum models/qwen3/Qwen3-0.6B-Q8_0.gguf   # 9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031
# runtime (Windows, Python 3.13, no compiler needed)
pip install https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.19/llama_cpp_python-0.3.19-cp313-cp313-win_amd64.whl
python contrib/max/qwen_extraction.py          # ~10 min on a laptop CPU, 4 threads
```

Everything runs offline once the model file is present (`HF_HUB_OFFLINE=1` is set by the harness).

## Qwen3 1.7B run (delegated: anyone with ~2 GB disk and Python 3.13)

```bash
curl -L -o models/qwen3/Qwen3-1.7B-Q8_0.gguf https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf
sha256sum models/qwen3/Qwen3-1.7B-Q8_0.gguf   # 061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a
python contrib/max/qwen_extraction.py --model models/qwen3/Qwen3-1.7B-Q8_0.gguf --sha256 061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a
```

Commit the new `contrib/max/results/qwen3-1.7b-q8-0-desktop-*.json` (record your CPU in the PR) and compare it with
the 0.6B table in model-decision.md, especially the Swahili column.

## Still to do in this lane

- Phone run of the same harness through llama.rn on the test phone (Carter names it), so numbers stop being DESKTOP.
- Native review of `language-review.csv`, then re-run on corrected Swahili.
- Swahili comprehension beyond labels (does the model read a Swahili note correctly when asked a yes/no question?).
- Whisper small on Swahili audio (WER), if the voice path comes back after the text gate.
