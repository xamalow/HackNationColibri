# @sauti/hub: the tourism-office hub (Max lane, scope requested by Max 2026-10-04)

An always-on, on-premises device at the tourism office (a PC or mini-PC with power, a phone line through a
telephony provider, and intermittent internet). It is the "brain" between tourists, booking platforms and Noor.
**No cloud AI:** every model (Whisper, Qwen, Opus-MT) runs on the hub; providers only carry calls, SMS and e-mail.
**Simulated transports are the default**, so the whole flow runs offline for the demo; real providers are
adapters selected by config, credentials from environment variables only (never git).

```
 Tourist phone call ──► telephony provider ──► [hub] intake/voice ──► local Whisper ──► W2 understanding
 Tourist SMS        ──► telephony provider ──► [hub] intake/sms   ─────────────────────► W2 understanding
 GYG/Airbnb/Booking ──► notification e-mail / GYG API ──► [hub] intake/platforms ──► booking request
                                                   │
                                     @sauti/core (bookings, capacity, approvals, outbox)
                                                   │
        ┌──────────────── owner alert (no approval: it informs Noor, acts on nobody's behalf) ──┐
        ▼                                                                                        ▼
 Noor's basic phone: SMS in Swahili + voice call of prerecorded Swahili clips          Noor's app (offline
        │                                                                              dashboard) syncs from
        └── Noor replies by SMS: "NDIYO A 1234" / "HAPANA A" / "FUNGA 12/10 1234" ...   the hub when online
                         │
          [hub] commands: exact approval (registered number + Sauti PIN) ──► outbox ──► tourist reply,
                                                                             GYG/Booking availability/listing
```

## The five requirements and where they live

| # | Requirement (Max) | Module | Approval |
|---|---|---|---|
| 1 | Tourists call the farm number; the hub answers | `src/intake/voice.mjs` (IVR script: greeting + record voicemail; Whisper transcript) | none to answer; any reply is a proposal |
| 2 | Online bookings are fetched | `src/intake/platforms.mjs` (GYG/Airbnb/Booking notification e-mails, GYG supplier API) | platform bookings are already confirmed by the platform: the hub blocks the slot everywhere |
| 3 | Noor is warned of every booking by SMS and call | `src/notify.mjs` (owner_alert: Swahili SMS + clip sequence call) | none: an alert informs Noor, it does not act on her behalf |
| 4 | Noor's app is her offline dashboard, synced when online | `src/sync.mjs` (HTTP: events since cursor; owner actions in) | app approvals use the core's PIN session |
| 5 | Noor changes her schedule any way; platforms update | `src/commands.mjs` (SMS/voice commands) + `src/publish.mjs` (GYG/Booking adapters) | **required**: exact proposal ID + PIN, then queued |

## Module contracts (every module is a plain ES module, no build step, Node >= 22.13)

- `src/store.mjs`: durable state in `node:sqlite` (one file): `events`, `bookings`, `proposals`, `outbox`,
  `alerts`, `owner`, `cursor`. Parameterized SQL only. `openStore(path)`.
- `src/transports/simulated.mjs`: inbound folders (calls, sms, mail, gyg) and outbound JSONL logs (sms, calls,
  platform). Every simulated item carries `"synthetic": true`. Real adapters (`africastalking.mjs`, `gyg.mjs`)
  implement the same interface: `fetch() -> InboundItem[]`, `send(OutboundItem) -> { ref }`, `wasSent(key)`.
- `src/intake/*.mjs`: turn inbound items into `HubEvent` = `{ id, kind: "visitor_message" | "booking" |
  "voicemail" | "missed_call", channel, received_at, text?, lang?, booking?: { platform, ref, date, party_size,
  visitor_name }, synthetic }`. Text is data, never instructions.
- `src/notify.mjs`: `alertOwner(event) -> { sms: string (Swahili), call: string[] (clip keys from
  packages/experience/audio/manifest.json) }`. Facts in alerts come from code (date, party size, platform),
  never from a model or a translation.
- `src/commands.mjs`: parses Noor's SMS: `NDIYO <ID> <PIN>`, `HAPANA <ID>`, `FUNGA <date> <PIN>` (close a day),
  `NAFASI <n> <PIN>` (capacity), `BEI <amount> <PIN>` (price). Only from Noor's registered number; PIN checked
  in constant time; anything else -> "Sikuelewa" (not understood) reply, nothing happens.
- `src/publish.mjs`: availability/listing updates to GYG/Booking as queued actions after approval.
- `src/sync.mjs`: `node:http` server: `GET /v1/events?since=<cursor>` and `POST /v1/owner-actions`, bearer token
  per paired device, no PII in logs.

## Open design point for Domain (fable-5.1-nav)

The core accepts approval only inside a PIN session on a trusted device. Noor approving **from her basic phone**
needs either (a) the hub as the trusted device, with the PIN carried in the SMS ("NDIYO A 1234") and her
registered number checked, or (b) SMS replies only *request* actions that she confirms later in the app.
This skeleton implements (a) behind a flag, defaulting to (b) until Domain decides.
