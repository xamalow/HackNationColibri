# W2 plan: Answer a tourist

Implementation plan for workflow W2 (see `CLAUDE.md` §5). W2 also builds the minimal shared
core (storage, states, policy, transport base) that the other workflows reuse.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| Phone calls | Voicemail via telephony provider (e.g. Africa's Talking) + missed-call SMS callback proposal | Stock Android cannot answer a call and capture/inject call audio (blocked since Android 10). Basic phone runs no code. Telephony is transport only, Whisper runs locally |
| Airbnb / GetYourGuide | Parse host notification emails (IMAP) + GetYourGuide supplier API as optional connector | Messages are behind login. Scraping breaks Airbnb ToS, risks Noor's account, requires storing her password, needs a headless browser |
| Airbnb replies | Approved reply is pasted manually (assisted send) | Airbnb has no public API. Said openly as a limitation |
| Language detection | fastText `lid.176.ftz` (<1 MB, CC-BY-SA 3.0) for text, Whisper LID for audio | NLLB needs a source language, it does not detect one |
| Date and party size | Deterministic parsers (`dateparser` + regex) or structured fields from platform emails | Price and availability need them. Never extracted by the LLM |
| Default transport | `simulated.py`, synthetic inbox (text, `.eml`, `.wav`) | Full demo in airplane mode |

## Inbound channels

All implement `sauti/transport/base.py` and produce one normalized `InboundMessage`:

```
InboundMessage(channel, external_id, sender_ref, received_at, text | audio_path,
               lang?, structured: {booking_ref?, date?, party_size?}, synthetic: bool)
```

| Channel | Source | Notes |
|---|---|---|
| `sms`, `whatsapp` | gateway / official WhatsApp Business API | No unofficial WhatsApp libraries |
| `voicemail` | telephony provider recording (`.wav`) | Whisper transcribes + detects language |
| `missed_call` | Android call log | No text. Produces a callback-SMS proposal |
| `email_airbnb`, `email_gyg` | IMAP, per-platform parser (code) | Structured fields trusted more than free text |
| `gyg_api` | GetYourGuide supplier API | Requires supplier approval. Optional |

Dedupe key: `(channel, external_id)`, plus booking reference across email and API.

## Pipeline

```
fetch (transport) -> ingest.py      validate, sanitize, dedupe, ASR for voicemail     RECEIVED
                  -> translate.py   LID -> NLLB -> Swahili (original kept)
                  -> classify.py    intent {price,date,directions,booking,other} + confidence
                                    date / party size via code parsers
                  -> facts (code)   price = rate x people, capacity minus bookings on ALL channels
                  -> propose.py     fixed template -> Qwen adapts tone -> fact check
                                    (every number/date must match code facts, else raw template)
                                    -> NLLB back -> proposal A/B/C + content hash      PROPOSED
                  -> approve.py     policy.py: explicit ID + hash                      APPROVED
                                    booking: slot held on every channel
                  -> outbox.py      idempotency key, restart-safe          QUEUED -> SENT -> DELIVERED
```

Fail-safe: low confidence, question outside the farm sheet, or missing date/party size means no
draft. Noor gets a "needs you" item with the translated message.

Prompt injection: tourist text enters prompts as delimited data only. Qwen only rewrites a
template and its output must pass the fact check.

## Build order

1. **Scaffold**: `pyproject.toml` (uv, pinned), `.gitignore`, `.env.example`, package skeleton.
2. **Core without models**: SQLite schema, states, `policy.py`, simulated transport, keyword
   classifier stub, pass-through translator stub, `noor_cli.py`. Tests: policy, states, restart,
   booking. Goal: English message end to end.
3. **Real models**: LID, NLLB, Whisper (voicemail), Qwen tone adaptation + fact check.
4. **Channels**: Airbnb/GYG email parsers on synthetic `.eml`, simulated voicemails, missed calls.
5. **Eval**: intent accuracy vs keyword baseline, correct "not sure" rate on out-of-scope messages.

## Known limitations

- Voicemail and GYG API need a provider account / supplier approval, so they are simulated in the demo
- Airbnb replies are sent manually after approval
- Weekday latency: the smartphone is only available on weekends
- Synthetic voicemails are recorded by the team and labeled synthetic
