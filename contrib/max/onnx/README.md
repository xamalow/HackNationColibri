# opus-mt-en-sw as int8 ONNX (translation layer B for iOS)

Owner: Max lane. Consumer: Mobile (onnxruntime-react-native). Status: CANDIDATE, DESKTOP numbers only.

`Helsinki-NLP/opus-mt-en-sw` (Marian, Apache-2.0) exported to ONNX **from the upstream repo itself**, at revision
`28780399d37e1161afc94577a717d7fcfa54fecc`, then dynamically quantized to int8. This replaces the third-party
CTranslate2 conversion (manancode/...) for a runtime that exists on iOS. Model files are never committed
(`/models/` is gitignored); their bytes and sha256 are in [data/model-manifest.json](../../../data/model-manifest.json)
under the ids `opus-mt-en-sw-onnx-*`.

## Result (DESKTOP, FLORES-200 dev, first 100 en sentences, chrF vs swh_Latn)

Same scorer (`chrf()`, `number_guard()` from [../translation_eval.py](../translation_eval.py)), same 100 sentences,
beam 4, max 256 new tokens, 4 threads, as the CTranslate2 run. CPU: AMD64 Family 25 Model 116 (AMD laptop),
onnxruntime 1.30.0 CPUExecutionProvider through optimum's `ORTModelForSeq2SeqLM`.

| Build | chrF mean | chrF median | Latency mean / p95 (s per sentence) | Invented numbers | Blocked by number guard |
|---|---|---|---|---|---|
| CTranslate2 int8 (reference, earlier run) | 63.2 | 64.0 | 0.16 / - | 5 | 10 |
| ONNX fp32, merged decoder | 63.0 | 63.4 | 0.41 / 0.70 | 5 | 11 |
| **ONNX int8, merged decoder** | **62.8** | 62.3 | **0.28 / 0.52** | 5 | 9 |
| ONNX int8, decoder + decoder_with_past | 62.7 | 62.7 | 0.28 / 0.48 | 5 | 9 |
| ONNX int8, merged decoder, greedy (beam 1) | 62.0 | 63.4 | 0.16 / 0.28 | 6 | 10 |

- int8 is 0.4 chrF below the CTranslate2 int8 build and 0.2 below fp32: inside the 2-point budget.
- Greedy decoding costs 0.8 chrF and halves latency. It is much simpler to write in JS than beam search, so it is a
  reasonable first version on the phone; beam 4 can come later.
- The number guard still blocks 9-10 of 100 outputs (44 sentences contain numbers). Its rule is unchanged: a
  blocked translation is never shown, the app shows the original plus code-extracted facts.
- Raw aggregates: [../results/translation-opus-onnx-en-sw-*-desktop.json](../results/). FLORES text is not stored.
- What this does not show: phone latency/memory (to measure on the iPhone), quality on tourist messages
  (FLORES is formal text; see translation-decision.md for the 'booking' -> 'kitabu' class of errors, which int8 keeps).

## Files (models/opus-onnx/en-sw/)

The phone needs only the five **bold** files of `int8/` (138,734,044 bytes, about 139 MB). sha256 measured locally.

| File | Bytes | sha256 |
|---|---|---|
| **int8/encoder_model.onnx** | 49,623,287 | `e3a96a46dc6539b446124f70132bfb317bcceaedcd0019436f36a16e8aefc0d7` |
| **int8/decoder_model_merged.onnx** | 86,784,789 | `2f285f467a0fb3bd351827d59cf56cbcba6dd58919d86dbe3fab4ff7d6823907` |
| int8/decoder_model.onnx (fallback pair) | 86,618,330 | `3afb726d2d11083d427fc3951e24aa015cc79d48ad553b0c2f64a9f3e037f50f` |
| int8/decoder_with_past_model.onnx (fallback pair) | 83,406,387 | `eb4cdf6f1cf59a9264e3b90e19f6c406c0a1e5d0763f9ba426bb7bd5c54a611d` |
| **int8/source.spm** (= upstream) | 820,602 | `49d825aac86bf2083c0952b920479aa0d86376613cb9da552135723f9e6aebda` |
| **int8/vocab.json** (same mapping as upstream) | 1,505,062 | `6b03d6100c9136fb67683d3306ef264a3d8ff90a41a9b4a5b1b3b8e3f4e7a2fd` |
| int8/target.spm (= upstream, only for the Python tokenizer) | 813,467 | `80090fbc9ccdbcd1982ddd13b2bb790bf927491fab206565c715f498a4803b9d` |
| **int8/generation_config.json** (token ids below) | 304 | `89defc130c8af9487e56fda621fc42af2130fb4576d625ec6534680d2014f469` |
| fp32/encoder_model.onnx | 197,509,750 | `3a1cb7f0367e1b26a9018ee88901e4da76f8dcb3ad1ca321b00f8aeec65a1ed5` |
| fp32/decoder_model_merged.onnx | 344,023,273 | `ec6f9145742292785bed4f2fa337d8a87145a613fe69d3db15ae67ba9b53c2aa` |
| fp32/decoder_model.onnx | 343,841,661 | `30a98dda96b3f2f0dfe82d973be5d18f09d6cd3656c202700bfa08a4305fd5e3` |
| fp32/decoder_with_past_model.onnx | 331,212,054 | `dde3b2c6edf9da40dc3ef4b5c119f1d90c73f1848e64508ed0b9a69e8a5b8ded` |

Upstream weights used: `pytorch_model.bin`, 299,670,357 bytes, sha256
`dd3fc2179f4c5e4ff79241d33f644091bd93036e6b11c17e1feb749e0f0324a5` (equal to the Hugging Face LFS oid).
The int8 set is larger than the CTranslate2 `model.bin` (76 MB) because the shared 58,950 x 512 embedding is
stored in both graphs and the decoder also keeps the output projection; fine for side-loading, worth knowing.

## Reproduce

Windows, Python 3.12, about 3 GB of disk for the throwaway env + fp32 export. Keep the env at a short path
(MAX_PATH: a venv under a long temp path failed to unpack transformers).

```bash
python -m uv venv ../oxenv --python 3.12
python -m uv pip install --python ../oxenv torch --index-url https://download.pytorch.org/whl/cpu   # 2.14.1+cpu
python -m uv pip install --python ../oxenv "optimum[onnxruntime]==2.1.0" optimum-onnx==0.1.0 transformers==4.57.6 \
    onnx==1.23.1 onnxruntime==1.30.0 sentencepiece==0.2.2 sacremoses==0.2.0 huggingface-hub==0.36.2
../oxenv/Scripts/python contrib/max/onnx/export_onnx_en_sw.py      # ~1 min: download, export, int8, hashes.json
../oxenv/Scripts/python contrib/max/onnx/verify_onnx_en_sw.py --flores <flores200_dataset/dev> --variant int8
../oxenv/Scripts/python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant fp32
../oxenv/Scripts/python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant int8 --split
../oxenv/Scripts/python contrib/max/onnx/verify_onnx_en_sw.py --flores <dev> --variant int8 --beams 1
../oxenv/Scripts/python contrib/max/onnx/reference_greedy_ort.py --flores <dev>   # plain-ORT loop == optimum
```

FLORES-200 (CC-BY-SA 4.0): https://dl.fbaipublicfiles.com/nllb/flores200_dataset.tar.gz, `dev/` split only.
Equivalent CLI export: `optimum-cli export onnx --model models/hf/opus-mt-en-sw --task text2text-generation-with-past
models/opus-onnx/en-sw/fp32` (the CLI has no `--revision` flag, so the script downloads the pinned revision first).

Notes on the export:
- optimum 2.x moved the ONNX exporter to the `optimum-onnx` package; the `exporters` extra no longer exists.
- `quantize_dynamic` on the already merged decoder leaves it fp32-sized (its weights sit outside the If branches).
  The script therefore quantizes `decoder_model` and `decoder_with_past_model`, then fuses them with optimum's
  `merge_decoders(strict=False)`, as optimum does for seq2seq. The merged int8 file scores within 0.1 chrF of the pair (62.8 vs 62.7).
- The exporter's weight deduplication needs `accelerate` (not installed), so the fp32 decoder files are larger
  than necessary. This does not change outputs.
- Graphs: opset 18, int8 ops `DynamicQuantizeLinear` + `MatMulInteger` (standard ONNX ops).

## For Mobile (onnxruntime-react-native)

Load two sessions: `encoder_model.onnx` and `decoder_model_merged.onnx`. The whole loop below, in ~40 lines of
numpy + onnxruntime + sentencepiece (no transformers), is [reference_greedy_ort.py](reference_greedy_ort.py): port that.
Measured: its token ids equal `MarianTokenizer`'s and its greedy translations equal optimum's on 20/20 FLORES dev
sentences (`python contrib/max/onnx/reference_greedy_ort.py --flores <dev>`).

1. **Tokenize (open integration item).** The app must reproduce SentencePiece encoding with `source.spm`
   (unigram model, built-in `nmt_nfkc` normalization, no byte fallback) exactly, e.g. with a JS/WASM
   SentencePiece port that applies the normalizer stored in the .spm, then map each piece to its id with
   `vocab.json` (unknown piece -> `<unk>` = 1) and append `</s>` = 0. No such port is chosen or tested yet;
   test vectors (input text -> ids from the Python `MarianTokenizer`) should be generated before integrating.
2. **Encoder:** `input_ids` int64 [1, n], `attention_mask` int64 [1, n] of ones -> `last_hidden_state` float [1, n, 512].
3. **Decoder loop** (greedy first): start with `decoder_start_token_id` = 58949 (`<pad>`). Inputs:
   `input_ids` [1, 1], `encoder_hidden_states`, `encoder_attention_mask`, 24 `past_key_values.{0-5}.{decoder,encoder}.{key,value}`
   float [1, 8, len, 64], and `use_cache_branch` bool [1]. Step 1: `use_cache_branch=false` with zero-length
   past tensors; later steps: `true` and the previous step's `present.*` outputs (keep the encoder ones from step 1).
   Take the argmax of `logits[0, -1]` after setting logit 58949 (`<pad>`, in `bad_words_ids`) to -inf; stop at
   `</s>` = 0 or 256 tokens.
4. **Detokenize:** map ids back to pieces with `vocab.json`, drop `</s>`/`<pad>`, join, replace `▁` with a space,
   trim (en and sw share one vocabulary, `separate_vocabs: false`; `target.spm` is only used by the Python tokenizer).
5. Run `number_guard()` semantics before showing anything (Domain owns the rule).

Unverified on the phone: operator support of the int8 ops in the onnxruntime build that onnxruntime-react-native
ships, latency, and peak memory with ~137 MB of graphs. The fallback pair (`decoder_model` +
`decoder_with_past_model`) avoids the If node if a runtime rejects it, at the cost of ~84 MB more.
