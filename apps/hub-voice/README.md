# @sauti/hub-voice: the hub's voice agent (Lane 10, Domain)

The tourist calls the farm's number. One computer speaker at the tourism office answers in Swahili or English, checks availability, takes a visit **request**, and files it for Noor, who confirms it herself. While the caller is still on the line, a live browser view prepares the change on the listing with the banner **WAITING FOR NOOR'S APPROVAL · A**. Nothing is saved until her approval arrives.

Max's plan (room #47625) in order: phone and text booking first, GetYourGuide later. Carter's rules (room #47595, #47624): all AI local on the hub PC; Twilio and LiveKit only carry audio and SMS; a spoken or texted "yes" is never approval; no keys in git, the room or logs; the repo is public.

```
 caller ──SIP──▶ LiveKit (self-hosted) ──▶ livekit-agents worker "sauti-hub"  (ONE speaker)
                                               │  STT faster-whisper · LLM Gemma 4 E4B (llama.cpp/Ollama) · TTS Chatterbox as "tts-1"
                                               │  all via OpenAI-compatible base_url on 127.0.0.1
                        every caller turn ─────┼──▶ sidecars (parallel, time budget, fail-open, READ-ONLY)
                                               │     language · safety/tone · booking facts (+ hub availability)
                                               │     translation aid · escalator · preparer (live view)
                                               │          └──▶ append-only, redacted BLACKBOARD ◀── speaker reads via ONE tool call
                        speaker tools ─────────┼──▶ farm_facts · check_availability (read)
                                               └──▶ file_booking_request  (the ONE write: a REQUEST for Noor)
                                                         │
                                               apps/hub (@sauti/core): proposal + read-back SMS to Noor's enrolled phone
                                               Noor: "NDIYO A 482193" (one-time code) or Sauti PIN in the app
                                                         │
                                               preparer process: PreparerGate ok? ──▶ click Save. Otherwise never.
```

## What is enforced, and where

| Rule | Where |
|---|---|
| The agent never confirms; it files a request Noor approves | `policy.py` (speaker rules), `hubclient.HubActions.file_booking_request` returns `pending_owner` only; the hub creates the proposal through `@sauti/core` |
| Sidecars cannot speak, send, call, commit or file | `sidecars/base.SidecarContext` has only `settings`, `hub` (read-only client with exactly `availability` and `farm_facts`), `board`, `now_ms`, `call_id`; `tests/test_sidecars.py` |
| Sidecars are bounded and fail-open | `run_sidecars`: one budget, timeouts and errors recorded, the call carries on |
| The blackboard is append-only and holds no phone number or code | `blackboard.py` + `redact.py`; defence in depth raises `RedactionError` rather than record; `tests/test_blackboard.py` |
| Numbers the speaker says come from approved facts | `farm_facts` tool reads the hub's current farm sheet; the booking sidecar's facts carry exact quotes; the translation aid has a number guard and is "never counted" |
| The live view prepares during the call but never saves without a matching approval | `sidecars/preparer.py`: `PreparerDisplay` has only `prepare`; `PreparerGate.may_commit` requires a contract-valid approval record, `approved`, same digest as the envelope (recomputed) and the prepared change, same action, before `valid_until`, never twice; `tests/test_preparer_gate.py`, `tests/test_live_view.py` |
| Caller ID is not identity | not recorded, not used; `policy.py` rule 3 |
| Who speaks, from which language | `sidecars/language.py`: deterministic stopwords, Bantu look-alikes are `und`, unsupported language or persistent `und` = a person calls back |

## Run

**Talk to it without a phone line:** [RUNBOOK.md](RUNBOOK.md) brings up a self-hosted LiveKit server on loopback, the `sauti-hub` worker and a browser page (`python -m hub_voice.demo serve`, http://127.0.0.1:8790) with a tourist call, a demo owner call and a live panel of the sidecars' advice. `python -m hub_voice.preflight` checks every local piece first.

Offline, nothing installed but Python (this is what the tests and the demo screen use):

```
cd apps/hub-voice
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt      # or .venv/bin/pip
python -m pytest tests -q
python -m hub_voice.simulate fixtures/calls/booking_sw.jsonl               # transcript in, blackboard out (runtime/, gitignored)
python -m hub_voice.demo_check                                            # every rule the demo relies on, asserted; exit 0 = the voice lane is good
```

Live, on the hub PC:

```
pip install "livekit-agents[openai,silero,turn-detector]==1.8.4" "livekit-api>=1.2.1" python-dotenv
cp .env.example .env    # LiveKit self-hosted URL + key/secret, local model server URLs, hub URL + token
python -m hub_voice.agent download-files   # silero + turn detector ONNX, once
python -m hub_voice.agent console          # local microphone test, no LiveKit server
python -m hub_voice.agent dev              # connect to LiveKit; SIP dispatch rule names agent "sauti-hub"
```

Loopback only, enforced: `Settings` and both hub clients refuse any model or hub URL whose host is not 127.0.0.1, localhost or ::1 (`ConfigError` at start-up), and every HTTP client, including the OpenAI-compatible SDK clients handed to the livekit plugins, is built with no proxy from the environment and no redirects (a misconfigured URL is refused without echoing it); only LiveKit and Twilio carry network traffic. Model servers (all local): faster-whisper with an OpenAI-compatible `/v1/audio/transcriptions`; llama.cpp or Ollama serving Gemma 4 E4B at `/v1/chat/completions`, started with `--reasoning off` (or `--reasoning-budget 0`): by default llama.cpp lets Gemma 4 think, spends every token on it and answers with nothing (warden's measurement, room #47669), and the agent and the translation sidecar also ask per request and refuse an empty or thinking-only answer; a Chatterbox wrapper at `/v1/audio/speech` that accepts model `tts-1` and returns wav or pcm at 24 kHz (the plugin sends `tts-1`; the voice name is yours). With no model URLs configured the worker refuses to speak and says so; use `simulate`.

Telephony, after Carter's Twilio and LiveKit setup: inbound via SIP trunk + dispatch rule → `sauti-hub`; outbound calls to Noor (alert clips, read-back) via the LiveKit outbound trunk from the hub; SMS through the hub's Twilio adapter. The hub's F1/F2 (no reply to unknown senders, daily caps) land before the real number is wired.

## Owner mode: Noor calls the farm number herself

Max's plan: the office agent always answers Noor, in her language, for any request. When the caller id's sha256 matches the enrolled owner phone (the hub's `GET /v1/owner/match`; a fixture offline), the same speaker switches to owner mode: it reads her the requests waiting for her (reference, date, party size, source; never visitor names or numbers), summarises visitor feedback from the hub's feedback loop (themes with counts), answers farm questions from the approved facts, and takes her changes ("nitachelewa kidogo", "funga Jumamosi", a message to a visitor) with `propose_change`. Each change is a **proposal** the hub reads back to her enrolled phone with a one-time code, exactly like a tourist's request.

Threat model: a matching caller id selects what the agent talks about, not who it trusts. There is no approve tool in either mode (tested), a spoken "ndiyo, thibitisha" changes nothing (tested), and the number itself is only hashed in memory and never recorded. Someone who fakes Noor's number hears summaries without contact details and can cause, at most, a read-back SMS to her real phone.

Offline: `python -m hub_voice.simulate fixtures/calls/owner_sw.jsonl --owner`.

## Outbound alert calls to Noor (worker "sauti-alert")

Split agreed in the room: the **hub** decides when to call and which clips (its `notify.mjs`), and lists pending owner-alert calls at `GET /v1/owner-alerts/pending`; **hub-voice** places the call and reports `POST /v1/owner-alerts/{alert_id}/result`. No LiveKit code in the hub; the Twilio adapter stays SMS-only.

`python -m hub_voice.outbound poll` polls the hub, plans each call and, live, dispatches the `sauti-alert` LiveKit worker (`python -m hub_voice.outbound dev|start`) into a per-alert room; the worker dials the owner through the LiveKit outbound SIP trunk, plays exactly the listed pre-rendered clips in order, waits a second, reports, and deletes the room. The voice never approves anything; approvals stay SMS code or Sauti PIN.

Safety, each tested in `tests/test_outbound_alerts.py`: the only dial target is `SAUTI_OWNER_E164` from this process's own environment (nothing in an alert or dispatch metadata can select a phone; `device_id` must equal `SAUTI_OWNER_DEVICE_ID`); clip keys are validated against the local manifest, unknown keys refuse the call, and a call with nothing rendered is not placed (never silence); one call per alert, restart-safe, via an append-only ledger written **before** any dispatch, which also counts the daily cap per farm day (Nairobi); a failed dispatch keeps the reservation (no retry storm); dispatch acceptance and answered/played are reported as separate facts (poller facts `refused`, `simulated`, `dispatched`, `dispatch_unknown`; worker facts `answered`, `no_answer`, `failed`; `dispatch_unknown` means the dispatch request raised or its answer was lost, the job may still run, so it is non-final and a later worker result supersedes it, like the core's `send_unknown`); no number, token or key ever appears in errors, reports or the ledger (sha256 only). Without a trunk or `LIVEKIT_URL` the poller runs simulated: plans, ledgers and reports every call, writes `runtime/outbound-calls.jsonl`, places nothing. Live dialing waits for Carter's trunk.

## Interfaces this app uses on apps/hub (merged #45)

`GET /v1/availability?date=YYYY-MM-DD` → `{date, capacity, confirmed, remaining, open}` (the core's `checkCapacity`); `GET /v1/farm` → the approved farm sheet; owner mode: `GET /v1/owner/match?sha256=` → `{match}`, `GET /v1/proposals?status=pending_owner` → `{pending:[{ref,date,party_size,source,filed_at}]}`, `GET /v1/feedback/summary`, `POST /v1/owner-proposals` → `{ref, action_id, status:"pending_owner"}` (the hub sends the read-back SMS + code); `POST /v1/proposals` with `{tenant_id, source:{channel:"voice", call_id}, booking:{date, party_size, visitor_name, language}, note}` → `{ref, action_id, status:"pending_owner"}`. Bearer token from `HUB_TOKEN` (the same paired-device token as `/v1/events`). The hub's refusals are not errors to the speaker: `POST /v1/proposals` 409 `{status:"unavailable", reason, facts}` (full, closed_day, too_late, hours...), 422 `{status:"invalid"}` and 429/503 `{status:"needs_owner"}` come back as `FilingRefused` and the speaker says the matching Swahili/English line (`REFUSAL_LINES`), the live view is left untouched, nothing is pending. `POST /v1/owner-proposals` carries `change.date` and `change.capacity` when Noor said them, so the hub does not parse them from text; 429 `budget_exhausted` means a person calls her back, never a retry. `GET /v1/availability` returns `reason` (past, closed_by_owner, platform_blocked, not_a_tour_day, ask_a_person) which the booking sidecar reports. Offline, the client answers from `fixtures/`, refuses full/closed days the way the hub would, and appends to `runtime/*.jsonl`.

The preparer process (codex-mobile, `apps/hub-voice/preparer/**`) implements `PreparerDisplay.prepare(ref, change, banner)` with a headed Playwright browser against a local mock extranet, and calls `PreparerGate.commit(...)` only when the hub reports an approval; the gate is the only path to Save.

## Files

| File | Owns |
|---|---|
| `hub_voice/agent.py` | the livekit-agents worker: session wiring, four speaker tools, event logging; livekit imported lazily |
| `hub_voice/policy.py` | disclosure, handover lines, the speaker's hard rules; owner-mode instructions |
| `hub_voice/owner.py` | caller-id normalisation and hashing, owner/tourist classification (any doubt = tourist) |
| `hub_voice/demo.py`, `demo/` | the no-telephony voice demo: loopback token server with the agent dispatch embedded in the join token, browser page (vendored livekit-client, Apache-2.0), blackboard panel; demo owner mode gated by `SAUTI_DEMO_ALLOW_METADATA_MODE` |
| `hub_voice/preflight.py` | reachability of LiveKit, STT, LLM, TTS and the hub on loopback |
| `hub_voice/outbound.py` | the sauti-alert worker: clip library, alert requests, durable ledger (dedupe + daily cap), pure `plan_call`, WAV framing, poller, LiveKit dispatch and SIP dial (live only) |
| `hub_voice/blackboard.py`, `redact.py` | append-only per-call record, redaction, the speaker view |
| `hub_voice/sidecars/base.py` | `Turn`, `Advice`, `SidecarContext` (read-only), `run_sidecars` (budget, phases, fail-open) |
| `hub_voice/sidecars/{language,safety,booking,translation,escalator,preparer}.py` | the six sidecars; `preparer.py` also holds `PreparerGate` and the `PreparerDisplay` port |
| `hub_voice/hubclient.py` | `HubReadOnly` (queries) and `HubActions` (file a request), simulated twins |
| `hub_voice/simulate.py` | offline transcript driver |
| `fixtures/` | synthetic farm facts, calendar and a sample call; `tests/` | the rules above as tests |

Generated Swahili in fixtures is unreviewed and says so. No real phone number appears anywhere in this app.
