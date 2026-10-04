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
        └── Noor replies by SMS: "FUNGA 12/10" -> read-back -> "NDIYO A 482113" / "HAPANA A"   the hub when online
                         │
          [hub] commands: enrolled number + per-proposal one-time code ──► outbox ──► tourist reply,
                                                                             GYG/Booking availability/listing
```

## The five requirements and where they live

| # | Requirement (Max) | Module | Approval |
|---|---|---|---|
| 1 | Tourists call the farm number; the hub answers | `src/intake/voice.mjs` (IVR script: greeting + record voicemail; Whisper transcript) | none to answer; any reply is a proposal |
| 2 | Online bookings are fetched | `src/intake/platforms.mjs` (GYG/Airbnb/Booking notification e-mails, GYG supplier API) | platform bookings are already confirmed by the platform: the hub blocks the slot everywhere |
| 3 | Noor is warned of every booking by SMS and call | `src/notify.mjs` (owner_alert: Swahili SMS + clip sequence call) | none: an alert informs Noor, it does not act on her behalf |
| 4 | Noor's app is her offline dashboard, synced when online | `src/sync.mjs` (HTTP: events since cursor; owner actions in) | app approvals use the core's PIN session |
| 5 | Noor changes her schedule any way; platforms update | `src/commands.mjs` (SMS/voice commands) + `src/publish.mjs` (GYG/Booking adapters) | **required**: enrolled number + per-proposal one-time code (hashed, digest-bound, single-use, expiring), then queued |

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

## Tourist booking requests (`src/booking_requests.mjs`, `src/tourist_replies.mjs`; not yet wired into hub.mjs)

```
tourist SMS / voice agent ─► requestBooking(store, sheet, { event, now })
   parseBookingRequest (code, en/de/fr/sw) ─ missing / ambiguous ─► { action: "ask_tourist", reply }      (no proposal)
   checkAvailability (core checkCapacity + kv calendar.closed_days + blocked days) ─► { action: "unavailable", reply }
   createProposal("booking_request", { date, time, party_size, price_kes_total, tourist_ref, lang, ... })
      ─► { action: "proposed", owner_sms (Swahili read-back + one-time code, sensitive), tourist_ack }
Noor: "NDIYO A 482113" | "HAPANA A 482113" | "A 482113 nitachelewa kidogo"   (enrolled number + code, commands.mjs)
   ─► decideBookingRequest(store, sheet, proposalRow, { type: "approve" | "reject" | "suggest", text }, now, { translator? })
      approve: capacity re-checked by code, booking "direct:<ID>" inserted in one transaction -> confirmed SMS
               (or "unavailable" to the tourist + an explanation to Noor if the day filled up / was closed meanwhile)
      reject:  polite decline; suggest: Noor's words relayed verbatim ("Noor replied (in Swahili): «...»"), plus a
               labelled machine translation only if a translator is injected. A suggestion does not spend the code:
               the request stays pending until NDIYO / HAPANA.
```

Guardrails: the suggestion form and HAPANA on a `booking_request` need the one-time code (they answer a tourist on
Noor's behalf); the code is verified without being spent (`verifyCode`) and a wrong one counts toward the lockout.
Replies are fixed templates (UNREVIEWED de/fr/sw) filled only from structured fields; tourist text never enters them.
Language: `contrib/max/langid` (`npm ci --prefix contrib/max/langid`); undetermined -> English + `lang_fallback`.

## Decision (Carter, 2026-10-04 ~01:08 UTC)

YES to the hub. Guardrails: AI stays local on the hub PC; providers are transports behind config, simulated by
default; keys from env / Key Vault only; SMS approval = enrolled number + per-proposal one-time code (above);
listing/availability changes only from an approved, digest-bound action through a deterministic adapter (official
API or a scripted browser), never a free-roaming agent. Platform (codex) adds apps/hub to the workspace and lock.

## Run it (offline, synthetic data, simulated transports)

```bash
npm ci --prefix packages/core && npm run build --prefix packages/core   # once
node --test apps/hub/test/*.test.mjs                                    # 119 tests (langid deps: npm ci --prefix contrib/max/langid)
node apps/hub/src/demo.mjs                                              # end-to-end story, logs in apps/hub/var/demo/
```

The demo: 3 platform e-mail bookings + a GetYourGuide API booking that overbooks the day (conflict, urgent alert),
tourist SMS/WhatsApp, a voicemail and a missed call -> Swahili SMS + clip-sequence calls to Noor; Noor texts
`FUNGA 2026-10-16` -> read-back with a one-time code; a spoofed number and a wrong code are refused; her code closes
the day and updates the platforms (simulated adapter); the code cannot be reused; a later booking on that day is a
conflict; her app pairs and pulls every event over the sync API (401 without the token).

## Status and open items

| Area | State |
|---|---|
| Intake (platform e-mails, GYG API, SMS/WhatsApp, voicemail, missed call) | working, simulated; e-mail formats are synthetic guesses until real notifications are seen; DKIM/SPF check needed in the real mail fetcher |
| Shared calendar (core `checkCapacity`), cross-channel conflicts, closed/blocked days | working |
| Alerts to Noor (Swahili SMS <= 160 GSM-7 + prerecorded clip calls) | working; clips listed in `notify.MISSING_CLIPS` must be added to packages/experience; Swahili UNREVIEWED |
| SMS commands + per-proposal one-time code (Carter's guardrail) | working, tested (spoof, wrong, expired, reused, cross-proposal, content-changed) |
| Outbox (idempotent, restart-safe, sensitive bodies redacted) | working |
| Platform publish (approved-only, digest-bound, fail-safe blocks days) | simulated; GYG/Booking.com adapters are documented stubs (supplier/partner access needed); Booking.com missing from the contract channels |
| Sync API for Noor's app | working on localhost; needs TLS (or a reverse proxy) and auth rate limiting before real use |
| Live phone conversation (LiveKit + local Whisper/Qwen/Chatterbox) | next: recipe from warden in the room; runs on a GPU PC, not the Max laptop |
| Root workspace lock | `@sauti/hub` must be added to the root lock by Platform (codex) before merge |
