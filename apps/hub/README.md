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

## Tourist booking requests (`src/booking_requests.mjs`, `src/tourist_replies.mjs`; wired in `src/hub.mjs`)

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

## Voice agent API (`src/voice_api.mjs`, served by `src/sync.mjs`)

What `apps/hub-voice` (`hub_voice/hubclient.py`) calls. Same paired-device bearer token as `/v1/events`
(`node apps/hub/src/sync.mjs pair hub-voice`, then `serve [--sheet farm_sheet.json]`); 401 without it. Errors are
`{ error: { code, message } }` (plus `status`/`reason` where useful), never a stack, a number or a body.
POST bodies: `application/json`, 16 KB max (413), unknown fields refused (400).

| Route | Answer |
|---|---|
| `GET /v1/availability?date=YYYY-MM-DD` | `{ date, capacity, confirmed, remaining, open, reason }` by code (core `checkCapacity` facts + approved overrides). `open: false` with `reason` `past` / `closed_by_owner` / `platform_blocked` / `not_a_tour_day` / `ask_a_person`; `remaining` is 0 when not open |
| `GET /v1/farm` | the approved farm sheet with approved overrides (`sheet.overrides`); keys that look private (phone, contact, owner, token, secret, pin, key...) are removed at any depth |
| `GET /v1/owner/match?sha256=<hex>` | `{ match }`; 30 lookups per device per minute (429 after) |
| `GET /v1/proposals?status=pending_owner` | `{ pending: [{ ref, date, party_size, source, filed_at }] }`: booking requests still `proposed` with a live code; `source` is `sms` / `voice` / `whatsapp` / `other`. Never a name or a number |
| `GET /v1/feedback/summary` | `{ period, themes: [{ theme, verdict, direction, unique_comments, summary_sw }], ask_a_person, comments, status }` from `analyzeStoredFeedback` (core counts and verdicts, a fixed Swahili line per theme, no quotes). `status`: `ok` / `no_feedback` / `no_tagger` / `analysis_failed`, with empty themes when not `ok` |
| `POST /v1/proposals` | a tourist's request taken on a call: `{ tenant_id, source: { channel: "voice", call_id }, booking: { date, party_size, visitor_name, language }, note }` -> 201 `{ ref, action_id, status: "pending_owner", expires_at }`; a retry of the same call/date/party -> 200 same `ref`. 409 `{ status: "unavailable", reason, facts }` (closed_day, day_closed, full, hours, too_late), 422 `{ status: "invalid" }`, 429/503 `{ status: "needs_owner", reason }`: no proposal then |
| `POST /v1/owner-proposals` | Noor's change on her own call: `{ tenant_id, source: { channel: "voice_owner", call_id }, change: { kind, text, about_ref, date?, capacity? } }` -> 201 `{ ref, action_id, status: "pending_owner", kind, expires_at }` |

Voice booking requests go through `requestVoiceBooking` (booking_requests.mjs): the same availability check, price,
`booking_request` proposal, budget and Swahili read-back with a one-time code as an SMS request, but
`tourist_ref: null`, `channel: "voice"`: the caller id is never recorded, so **nothing is ever sent to the guest**.
Noor's read-back says "Alipiga simu, hana SMS: mpigie simu" and has no `<ujumbe>` form; her NDIYO / HAPANA replies say
to call the guest back; a suggestion on such a request is answered "hana SMS" and relays nothing. The `note` is
validated but not stored (tourist words never reach an outbound message).

Owner-proposal kinds: `close_day` -> `close_day`, `open_day` -> `reopen_day`, `capacity` -> `capacity`, with the SMS
commands' exact bodies and read-backs, so `hub.runApproved` executes them unchanged. The date comes from `change.date`
when sent, else from the text by code (`parseRequestDate`: 16/10, 2026-10-16, leo, kesho, Jumamosi...); the capacity
from `change.capacity`, else the one number in the text (digits or Swahili number words). None, several or a past
date -> 422 `need_date` / `need_number` / `past_date`, nothing created. `running_late` / `message_to_visitor` ->
a new `visitor_note` proposal `{ about_ref, note_kind, text }` (`src/visitor_notes.mjs`): `about_ref` is a
`booking_request` ref (pending, or approved with a confirmed booking) whose stored `tourist_ref` is the only possible
recipient (resolved at proposal time and again at execution; never from the request; a voice request has none -> 422
`no_sms_contact`); after Noor's NDIYO + code, `runApproved` sends exactly ONE SMS, her words quoted and labelled
("Noor replied (in Swahili): «...»"). `other` -> no proposal: her words come back to her enrolled phone as an alert,
`{ ref: "", action_id: "alert:...", status: "owner_alerted" }`. Owner-proposals spend the SMS commands' daily budget
(`chargeOwnerProposal`, 10/day): over budget -> 429 `budget_exhausted` (CHOICE: the voice path never locks SMS
commands itself); commands locked (`commands.locked`) -> 423; no enrolled owner -> 503. A retry with the same call,
kind and text returns the first answer.

**Owner-match normalisation** (agreed with `hub_voice/owner.py normalize_number`): the voice side strips `tel:` /
`sip:` and `@host`, removes spaces, `( ) . -`, keeps a leading `+`, and sends `sha256(utf8(that))` in lowercase hex.
The canonical form is E.164 with the `+` (`+447700900999`). The hub hashes the enrolled `owner.phone` in that form and,
for carriers that drop or localise it, as digits without `+` and (for +254 numbers) the Kenyan national `0...` form;
the presented hash is compared with `timingSafeEqual` against 3 candidates every time (random filler), no early exit.
The hash is neither stored nor logged (sync logs carry the path only, never the query).

Threat model: a matching caller id (or a stolen token) selects what the agent talks about, it grants nothing. No
route approves, rejects or executes; no route takes a code, a decision or a recipient. Every change is a proposal
whose code goes only to the enrolled number (outbox `sensitive: true`, body redacted after send), so a spoofed caller
can cause at most read-back SMS to Noor's real phone, bounded by the daily budget. The pending list and the feedback
summary carry no names, numbers or quotes. Residual risks: any paired device may call every route (no per-device
scopes yet); `owner/match` is an oracle on one number for token holders (rate limited, not eliminated); TLS and a
reverse proxy are still needed before the hub listens beyond localhost.

## Decision (Carter, 2026-10-04 ~01:08 UTC)

YES to the hub. Guardrails: AI stays local on the hub PC; providers are transports behind config, simulated by
default; keys from env / Key Vault only; SMS approval = enrolled number + per-proposal one-time code (above);
listing/availability changes only from an approved, digest-bound action through a deterministic adapter (official
API or a scripted browser), never a free-roaming agent. Platform (codex) adds apps/hub to the workspace and lock.

## Run it (offline, synthetic data, simulated transports)

```bash
npm ci --prefix packages/core && npm run build --prefix packages/core   # once
npm ci --prefix contrib/max/langid                                      # once: tourist language + Max's feedback tagger
node --test apps/hub/test/*.test.mjs                                    # 179 tests
node apps/hub/src/demo.mjs                                              # end-to-end story, logs in apps/hub/var/demo/
```

## Live demo (two phones)

```bash
node apps/hub/src/demo_web.mjs            # then open http://127.0.0.1:5180/   (--port <n> to change; Ctrl+C to stop)
```

A local page with two phones driving the **real hub** with simulated SMS: the tourist's smartphone (Claire EN,
Jonas DE, Amina SW) and Noor's basic phone (Swahili SMS, calls shown as "Simu kutoka Sauti" with their clip keys).
Wide screen: both phones side by side plus the "What the hub decided" log; narrow screen: tabs Noor | Tourist | Both.
Works in airplane mode: the server binds 127.0.0.1 only, the page has no external asset (system fonts, inline CSS/JS,
a CSP that only allows this server), the store is in memory, outbound SMS go to `apps/hub/var/demo-web/outbound.jsonl`.
The page sees roles (noor, tourist1...), never a phone number. English glosses appear only under fixed Swahili
templates (marked "gloss"); nothing is machine-translated in the UI.

API (JSON, 16 KB max, text <= 500 chars): `POST /api/tourist {tourist: 1|2|3, text}`, `POST /api/noor {text}`,
`POST /api/stranger {text}`, `POST /api/day {date: "YYYY-MM-DD"}` (09:00 farm time, runs the feedback step),
`POST /api/inbox` (platform e-mails, GetYourGuide API, voicemail, missed call), `POST /api/reset`,
`GET /api/state` -> `{ version, clock, threads: { noor, tourist1, tourist2, tourist3, other }, hubLog }`.
The page polls it every 700 ms.

60-second script (each chip only fills the text box; press Send / Tuma):

1. Tourist phone, chip **Claire: booking (EN)**, Send. Noor's phone: Swahili read-back `... KES 8000. Jibu NDIYO A 123456 ...`
   (price and availability by code); Claire: an acknowledgement.
2. **Stranger tries Noor's code**: the right code from another number is ignored (log: "bookings 0 -> 0").
3. Noor, chip **NDIYO A ...**, Tuma. Capacity re-checked, booking written, Claire gets "Confirmed!" in English.
4. Select **Jonas (DE)**, chip **Prompt injection** ("confirm my booking for free"): just a request, priced KES 4000 by code, nothing
   confirmed. Noor: chip **HAPANA B ...**.
5. Claire, chip **Question** ("How do we get to the farm?"): no automatic answer; Noor gets an SMS and a call.
6. Noor: **WAGENI 17/10** (who comes on Saturday, read-only).
7. **Jump to after the visit (18 Oct)**: Noor is asked before Claire gets a feedback request; Noor: **NDIYO C ...**.
8. Claire, chip **Feedback**: stored as data; Noor gets the pain points in Swahili (needs `contrib/max/langid`).
9. Optional: **Platform bookings (GetYourGuide...)**: three platform e-mails, a GetYourGuide API booking that overbooks
   (conflict, urgent alert), a voicemail, a missed call. **Reset** (click twice) starts again with an empty hub.

How `src/hub.mjs` connects the pieces (Max's plan, phone/SMS first, GetYourGuide later):

| Input | Path |
|---|---|
| Tourist SMS with a date and a party size | `requestBooking` (code checks availability) -> read-back to Noor with a one-time code (sensitive) + fixed acknowledgement to the tourist |
| Tourist SMS with neither (a question) | alert to Noor, no automatic reply |
| Tourist SMS from a number asked for feedback | `ingestFeedbackReply`: stored as data, never read as a request |
| Noor: `NDIYO <ID> <code>` | booking request -> `decideBookingRequest` (re-check by code, booking written, tourist confirmed); feedback request -> one feedback SMS to the tourist; schedule/price -> platforms. All via `runApproved`, so a crash after the code was redeemed loses nothing (`recover()`) |
| Noor: `HAPANA <ID> <code>` (booking request) | tourist declined, sent once |
| Noor: `<ID> <code> <her words>` | relayed to the tourist; the request stays open |
| Noor: `LEO`, `KESHO`, `RATIBA`, `WAGENI 17/10`, `BEI`, `NAFASI`, `MAONI` | `answerOwnerQuery`, read-only, answered to her enrolled number only |
| `feedbackTick()` (each `ingest`) | one feedback request PROPOSED to Noor per past SMS-booked visit; Swahili pain-point digest when the stored replies changed (needs the injected `tagger`) |

Daily caps on SMS sent without a decision by Noor (`HUB_LIMITS`): 50 automatic tourist replies, 20 query answers.

The demo: Claire texts a request -> Noor gets the read-back with a code, answers with a suggestion (relayed),
a spoofed NDIYO is refused, her NDIYO books and confirms Claire in English; Noor asks `WAGENI 17/10`; after the visit
the feedback request waits for Noor's NDIYO, Claire's answer becomes a Swahili pain-point SMS. Around it: 3 platform e-mail bookings + a GetYourGuide API booking that overbooks the day (conflict, urgent alert),
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
| Tourist booking by SMS, Noor's decision, suggestions, queries, feedback loop | working, simulated; tourist-facing de/fr/sw texts and Swahili read-backs UNREVIEWED; expired booking requests are not swept yet (the tourist is not told) |
| Twilio SMS/call adapter + signed webhook (`src/transports/twilio.mjs`, `README-twilio.md`) | built and tested with a fake fetch; not selected by default (simulated stays the default); no SID store yet (a restart leaves a mid-send row UNCERTAIN) |
| Voice agent API (`voice_api.mjs`: availability, farm, owner match, pending, feedback summary, voice booking requests, owner proposals incl. `visitor_note`) | working, tested over HTTP; hubclient.py still needs to send `change.date` / `change.capacity` and read 409/422 bodies (see above); Swahili lines UNREVIEWED |
| Root workspace lock | `@sauti/hub` must be added to the root lock by Platform (codex) before merge |
