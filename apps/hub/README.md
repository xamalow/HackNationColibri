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
- `src/commands.mjs`: parses Noor's SMS: `NDIYO <ID> <code>` (approve), `HAPANA <ID>` (reject),
  `FUNGA <date>` / `FUNGUA <date>` (close / reopen a day), `NAFASI <n>` (capacity), `BEI <amount>` (price),
  `MSAADA` (help). **Carter's guardrail (2026-10-04):** an SMS "NDIYO" counts only from Noor's enrolled number AND
  with the per-proposal **one-time code** the hub sent in its own read-back SMS ("Jibu NDIYO B 4821"): random,
  stored hashed, bound to the proposal id and content digest, single-use, expiring, constant-time compare, lockout
  after 5 wrong codes. Noor-initiated changes only create a proposal + read-back; alerts never trigger actions.
  Anything else -> a fixed "Sikuelewa" reply, nothing happens.
- `src/publish.mjs`: availability/listing updates to GYG/Booking as queued actions after approval.
- `src/sync.mjs`: `node:http` server: `GET /v1/events?since=<cursor>` and `POST /v1/owner-actions`, bearer token
  per paired device, no PII in logs.

## Decision (Carter, 2026-10-04 ~01:08 UTC)

YES to the hub. Guardrails: AI stays local on the hub PC; providers are transports behind config, simulated by
default; keys from env / Key Vault only; SMS approval = enrolled number + per-proposal one-time code (above);
listing/availability changes only from an approved, digest-bound action through a deterministic adapter (official
API or a scripted browser), never a free-roaming agent. Platform (codex) adds apps/hub to the workspace and lock.
