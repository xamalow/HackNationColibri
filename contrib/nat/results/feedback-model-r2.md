# Three-condition evaluation r2: local model (Qwen3 0.6B Q8_0), 2026-10-04 01:05 UTC

Runtime: llama.cpp b11381 `llama-completion` (no network port), model sha256 = manifest, Max's best condition
(en prompt + few-shot + JSON grammar, temperature 0) imported from contrib/max/qwen_extraction.py, compact grammar
`eval/feedback/max_findings_compact.gbnf`. **Calibrated** on Max's 40-item dev set before use: 28/40 outputs
identical to Max's published raw outputs, theme F1 0.547 vs his 0.495 (within the 0.1 noise band fixed beforehand).
The first attempt with llama.cpp's own JSON-schema grammar gave F1 0.04 and was discarded.

| Held-out (3 batches, 6 reference findings) | Findings correct | UNSUPPORTED | Missed |
|---|---|---|---|
| Manual reading (Nat, blind) | 6/6 | 1 | 0 |
| Keyword tagger (Max #19 @ cab5b36) | 0/6 | 0 | 6 |
| **Local model, with the language gate** (product path) | **2/6** | **1** | 4 |
| Local model, no language gate | 2/6 | 0 | 4 |

Dev: model 2/6 correct, 2 unsupported (label F1 0.65, sentiment 0.88, quotes 36/36 exact).
Held-out labels: F1 0.70, sentiment 0.95, 32/32 exact quotes; 2 labels on unsupported-language messages without the gate.

**Note:** the "0 unsupported" without the language gate is luck. A sentiment error ("too bitter" read as positive)
plus a label on a Kamba message created a contradiction that hid the overclaim. With the gate, the overclaim shows.

**Verdict:** the model finds a little more than the keyword tagger but overclaims; neither comes close to reading
the messages. AI value for feedback understanding: **not shown**. Desktop CPU, ~8-11 s per message with model reload
(not phone timings).
