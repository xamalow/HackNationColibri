# Runbook: talk to sauti-hub on the hub PC, no telephony

Goal (warden P0, 2026-10-04): someone sits at the hub PC, opens a browser page and TALKS to the voice agent as a tourist and as Noor, with faster-whisper, Gemma 4 and Chatterbox all running locally, a self-hosted LiveKit server on loopback, and the hub's booking API behind it. Twilio is not involved. Everything binds to 127.0.0.1.

Twenty to thirty minutes the first time, two minutes after that.

## 0. What runs where (all on the hub PC)

| Piece | Port (default) | Started by |
|---|---|---|
| LiveKit server (`livekit-server --dev`) | 7880 ws/http, 7881 rtc tcp, 50000-60000 udp, loopback | this runbook, step 1 |
| faster-whisper, OpenAI-compatible `/v1/audio/transcriptions` | warden's choice (e.g. 8001) | warden's stack |
| llama-server with Gemma 4, `--reasoning off` | warden's choice (e.g. 8080) | warden's stack |
| Chatterbox wrapper answering as model `tts-1`, wav 24 kHz | warden's choice (e.g. 8002) | warden's stack |
| apps/hub (`npm run`), the booking API | 8787 | hub runbook |
| sauti-hub worker (`python -m hub_voice.agent dev`) | connects to 7880 | step 4 |
| demo page + token server (`python -m hub_voice.demo serve`) | 8790 | step 5 |

The browser on the same PC connects to `ws://127.0.0.1:7880` directly; the agent joins the room because its dispatch is embedded in the join token.

## 1. LiveKit server (once)

Download the server for Windows from the LiveKit release page (asset `livekit_<version>_windows_amd64.zip`, v1.13.x at the time of writing; Apache-2.0), unzip `livekit-server.exe` into a tools folder, then run it in its own terminal:

```
livekit-server --dev --bind 127.0.0.1
```

Dev mode uses the key `devkey` and the secret `secret`; that is fine on loopback for a demo and nothing else. Leave this terminal open. If Windows Firewall asks, allow it on private networks only (it never needs to be reachable from the LAN). Linux/macOS: the matching tarball, same command.

## 2. Configure hub-voice (once)

```
cd apps/hub-voice
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install "livekit-agents[openai,silero,turn-detector]==1.8.4" python-dotenv==1.1.1
copy .env.example .env
```

Edit `.env`:

```
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
SAUTI_STT_BASE_URL=http://127.0.0.1:8001/v1      # the warden's faster-whisper port
SAUTI_LLM_BASE_URL=http://127.0.0.1:8080/v1      # llama-server, started with --reasoning off
SAUTI_LLM_MODEL=gemma-4-e4b-it                   # whatever name llama-server reports under /v1/models
SAUTI_TTS_BASE_URL=http://127.0.0.1:8002/v1      # the Chatterbox wrapper (model tts-1)
SAUTI_HUB_BASE_URL=http://127.0.0.1:8787         # apps/hub; leave empty to use the fixtures
HUB_TOKEN=                                       # the hub's paired-device bearer token, if the hub requires one
SAUTI_DEMO_ALLOW_METADATA_MODE=1                 # lets the demo page choose owner MODE (grants nothing); unset for real calls
```

Any URL that is not 127.0.0.1 / localhost is refused at start-up: all AI runs on this PC.

Then, once, the local models for voice activity and turn detection:

```
.venv\Scripts\python -m hub_voice.agent download-files
```

## 3. Preflight

```
.venv\Scripts\python -m hub_voice.preflight
```

Every configured piece must say READY (an unset URL says SIMULATED, which is fine for the hub; the three model servers must be ready for the agent to speak). Exit code 0 = go.

## 4. Start the agent (its own terminal)

```
.venv\Scripts\python -m hub_voice.agent dev
```

You should see the worker register with LiveKit as `sauti-hub` (explicit dispatch; it joins no room until a token asks for it).

## 5. Start the demo page (its own terminal) and talk

```
.venv\Scripts\python -m hub_voice.demo serve
```

Open http://127.0.0.1:8790 in Chrome or Edge on the hub PC (Firefox works too). Allow the microphone.

- **Call as a tourist**: the agent greets in Swahili and English, you ask for a visit ("Tunataka kuja Jumamosi, watu wawili"), it checks availability through the hub, reads the request back, files it, and says Noor will confirm. The right panel shows the sidecars' advice per turn; when a request is filed the banner WAITING FOR NOOR'S APPROVAL appears, the same moment the live listing view would prepare it.
- **Call as Noor's phone (demo mode)**: the agent answers in Swahili with her pending requests and the feedback summary; say "nitachelewa kidogo kwa ombi A" and it files a proposal and tells her the SMS code is on its way. Nothing you say by voice approves anything; there is no such tool.
- **Hang up** ends the room. Each call writes `runtime/blackboards/demo-<mode>-<id>.jsonl` (redacted); that file is the evidence for the call.

Owner mode on this page comes from the page's choice, honoured only because `SAUTI_DEMO_ALLOW_METADATA_MODE=1` is set in this `.env`; on a real phone line the enrolled caller id decides and metadata is ignored (tested).

## 6. If something is wrong

| Symptom | Check |
|---|---|
| Page says "Cannot start" | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` missing, or `LIVEKIT_URL` not loopback; the error names the setting, never a value |
| Connected, agent never speaks | the agent terminal: `model servers not configured` means an empty `SAUTI_*_BASE_URL`; otherwise look for the STT/LLM/TTS error, and run the preflight |
| Agent speaks English only | `SAUTI_STT_BASE_URL` server does not honour `language=sw`; the language sidecar still reports what it hears |
| Every answer is empty or very slow | llama-server without `--reasoning off`: Gemma 4 spends every token thinking (the translation aid withholds such answers; the speaker needs the flag) |
| Availability always "unknown" | hub not running or wrong `SAUTI_HUB_BASE_URL`; the agent still takes the request and says Noor will confirm |
| No audio from the agent in the browser | the `<audio>` element needs the first click; click "Call" again, or check the Chatterbox wrapper returns wav/pcm at 24 kHz for model `tts-1` |

## 7. Offline fallback (no models at all)

```
.venv\Scripts\python -m hub_voice.simulate fixtures/calls/booking_sw.jsonl
.venv\Scripts\python -m hub_voice.simulate fixtures/calls/owner_sw.jsonl --owner
```

Transcript in, blackboard out: the same sidecars, the same rules, no audio.
