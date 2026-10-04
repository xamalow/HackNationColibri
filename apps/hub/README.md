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

## Owner alert calls (pull API for hub-voice) (`src/owner_alert_calls.mjs`, served by `src/sync.mjs`)

Split agreed in the room (warden #47770): the hub decides WHEN to call Noor and WHICH clips (`notify.mjs`); hub-voice's
`sauti-alert` worker (`apps/hub-voice/hub_voice/outbound.py`) places the call through its LiveKit SIP trunk to the
number in ITS OWN config (`SAUTI_OWNER_E164`), plays exactly the listed clips and reports back. No LiveKit code in the
hub. The alert SMS to Noor goes out as before; the call is in addition.

Routing: `createHub({ alertCalls })` / `HUB_ALERT_CALLS` in `run_hub.mjs`: `pull` (default) queues the call here and the
Twilio adapter stays SMS-only (no `Calls.json`, even with `HUB_CLIP_BASE_URL`); `twilio` keeps the legacy TwiML call
through the outbox; `off` = SMS only.

Setup: `node apps/hub/src/sync.mjs pair sauti-alert-01` (token -> the worker's `HUB_TOKEN`), then
`node apps/hub/src/sync.mjs call-device sauti-alert-01` (kv `owner.call_device`), and on the worker
`SAUTI_OWNER_DEVICE_ID=sauti-alert-01`. The item's `device_id` IS that paired device id. `serve` reads
`HUB_MAX_ALERT_CALLS_PER_DAY` (default 6) and `HUB_ALERT_CALL_MAX_AGE_MINUTES` (default 120).

| Route | Answer |
|---|---|
| `GET /v1/owner-alerts/pending` | `200 { pending: [{ alert_id, device_id, clip_keys, urgent, created_at }], cap: { day, listed, max }, held: { missing_clips } }`; `{ pending: [], reason: "no_call_device" \| "no_owner_enrolled" }`; 403 `not_call_device` |
| `POST /v1/owner-alerts/{alert_id}/result` `{ status, played, missing, reason? }` | `200 { alert_id, state, changed }`; status: `refused\|simulated\|dispatched\|answered\|no_answer\|failed`; 400 / 403 / 404 `unknown_alert` / 409 `not_released` \| `already_final` |

Rules, each tested in `test/owner_alert_calls.test.mjs`:
- **One call per alert**: keyed by `alert_id` (the hub's `alert-<event id>`, or `alert-h<sha256>` when that id does not
  fit the worker's `[A-Za-z0-9._:-]{1,128}`); the same event or alert twice is one call.
- **Enrolled owner only**: queued only while kv `owner.phone` is set, bound to its sha256, listed only while the same
  number is enrolled. No number, hash of a number, or `to/number/phone/e164` field is ever served; no route takes a
  recipient (unknown fields are 400).
- **Daily cap** (farm day, EAT, durable in the store): at most `maxPerDay` calls are RELEASED per day; a call is
  released (stamped) the first time it is listed, so re-reading the list never releases more. Urgent first; the rest wait.
- **No retry storm**: the hub lists a call until a `dispatched` or final result arrives, then never again; it never asks
  for a second dial; a call older than `maxAgeMinutes` is no longer listed (the SMS carried every fact).
- **Clips**: listed only when every clip key is in the experience manifest (the worker refuses unknown keys and never
  plays half a sentence); otherwise held and counted in `held.missing_clips`. Today the `alert.*` clips in
  `notify.MISSING_CLIPS` are not recorded, so calls are held until the experience package adds them.
- **Results**: only from the call device, only for a released call, keys only from the listed `clip_keys`, `reason`
  kept only as a plain code (else `"other"`). Repeats are idempotent (`changed: false`); `dispatched` then
  `answered`/`no_answer`/`failed` are separate facts in that order; anything else after a final state is 409. Each
  accepted result is a hub event `owner_alert_call` (`alert_id, event_id, status, final, played, missing, reason`, no
  number) that Noor's app syncs from `/v1/events`.
- Auth: the sync server's bearer token (401); errors are value-free `{ error: { code, message } }`; bodies 4 KB max.
- Contract: the test reads the worker's `outbound.py`/`hubclient.py` (patterns, statuses, payload keys, the forbidden
  fields) and its `fixtures/pending_alerts.json`, and runs a port of `AlertRequest.parse` on what the hub serves.

## Decision (Carter, 2026-10-04 ~01:08 UTC)

YES to the hub. Guardrails: AI stays local on the hub PC; providers are transports behind config, simulated by
default; keys from env / Key Vault only; SMS approval = enrolled number + per-proposal one-time code (above);
listing/availability changes only from an approved, digest-bound action through a deterministic adapter (official
API or a scripted browser), never a free-roaming agent. Platform (codex) adds apps/hub to the workspace and lock.

## Run it (offline, synthetic data, simulated transports)

```bash
npm ci --prefix packages/core && npm run build --prefix packages/core   # once
npm ci --prefix contrib/max/langid                                      # once: tourist language + Max's feedback tagger
node --test apps/hub/test/*.test.mjs                                    # 252 tests (incl. demo:check)
npm run demo:check                                                      # every hub workflow, asserted (below)
npm run demo:hub                                                        # the two-phone demo page, http://127.0.0.1:5180/
node apps/hub/src/demo.mjs                                              # scripted end-to-end story, logs in apps/hub/var/demo/
```

## Live demo (two phones): `npm run demo:hub`

```bash
npm run demo:hub                          # = node apps/hub/src/demo_web.mjs [--port <n>]; open http://127.0.0.1:5180/
```

A local page with two phones driving the **real hub** with simulated SMS: the tourist's smartphone (Claire EN,
Jonas DE, Amina SW) and Noor's basic phone (Swahili SMS; owner-alert calls shown as "Simu kutoka Sauti" with their
clip keys and their state). Wide screen: both phones side by side plus the "What the hub decided" log; narrow screen:
tabs Noor | Tourist | Both. Works in airplane mode: the server binds 127.0.0.1 only, the page has no external asset
(system fonts, inline CSS/JS, a CSP that only allows this server), the store is in memory, outbound SMS go to
`apps/hub/var/demo-web/outbound.jsonl`. The page sees roles (noor, tourist1...), never a phone number. English glosses
appear only under fixed Swahili templates (marked "gloss"); nothing is machine-translated in the UI.

Demo choices (Max): the after-visit feedback question goes to the visitor automatically (`createHub({ autoFeedback:
true })` in `demo_web.mjs` only; the library default stays `false`, i.e. Noor approves each feedback request); a
tourist's details may arrive over several SMS (conversation memory, 48 h, code-parsed fields only) and relative days
work ("the next day", "le lendemain", "siku inayofuata"); owner-alert calls take the product path (`alertCalls: "pull"`,
queued for hub-voice) and show as **held** while the `alert.*` clips are not recorded (`notify.MISSING_CLIPS`); the SMS
carries every fact.

**Guided demo** (the yellow button, 7 clicks, no safety showcase): 1 Claire books Saturday 17/10 for 4 by SMS ->
Noor's Swahili read-back with a one-time code and the price by code; 2 Noor's NDIYO -> "Confirmed!" with time and total;
3 Amina (Swahili) and Jonas book, Noor approves both; 4 Noor texts `WAGENI 17/10` (3 groups, 8 people, 2 places left);
5 the clock moves to the day after the visit -> each visitor gets the feedback question in their language; 6 three
answers -> one Swahili pain-point summary to Noor; 7 Noor texts `MAONI` and gets it again. Free play stays possible with
the chips and text boxes; the extra control buttons (day jump, sample feedback, platform inbox, stranger) are hidden
but their API routes remain.

API (JSON, 16 KB max, text <= 500 chars): `POST /api/tourist {tourist: 1|2|3, text}`, `POST /api/noor {text}`,
`POST /api/stranger {text}`, `POST /api/day {date: "YYYY-MM-DD"}` (09:00 farm time, runs the feedback step),
`POST /api/inbox` (platform e-mails, GetYourGuide API, voicemail, missed call), `POST /api/sample-feedback`,
`POST /api/guided/next`, `POST /api/reset`,
`GET /api/state` -> `{ version, clock, tagger, threads: { noor, tourist1, tourist2, tourist3, other }, hubLog, guided }`.
The page polls it every 700 ms.

## `npm run demo:check` (`scripts/demo_check.mjs`; `test/demo_check.test.mjs` runs it under `node --test` for CI)

Starts the demo server in-process (port 0, fresh var dir), drives it ONLY through the page's HTTP API, resets the hub
before each workflow and prints one PASS / FAIL line per workflow, then a summary; exit 0 only when all pass, exit 2
with the install command when a prerequisite (Node >= 22.13, the core build, the langid deps) is missing. Expected
prices and capacity come from `fixtures/farm_sheet.json`, never from the answers under test. `--verbose` prints every
message; `--no-nat` skips Nat's suites.

| # | Workflow asserted |
|---|---|
| 1 | booking -> Noor's read-back with a 6-digit code and the price by code -> `NDIYO <id> <code>` -> "Confirmed!" with time and total; the replayed code executes nothing (WAGENI still 1 group) |
| 2 | `HAPANA <id> <code>` -> polite decline to the tourist, nothing booked, the spent code cannot approve |
| 3 | `<id> <code> <her words>` -> relayed verbatim ("Noor replied (in Swahili): «...»"), request still open, later NDIYO confirms |
| 4 | `FUNGA 15/10` -> read-back -> NDIYO closes the day; a request for that day is answered "no tour" by code and Noor is told |
| 5 | capacity race: two requests that each fit alone; Noor approves both -> seats never exceed capacity, the second tourist is told how many places are left, Noor gets the reason (and no contradicting "Mgeni atapata uthibitisho") |
| 6 | feedback loop: 3 visits -> day jump -> the question goes to each visitor automatically, once -> replies -> Swahili pain-point digest to Noor -> `MAONI` returns it |
| 7 | owner alert: platform inbox (GYG overbooking = urgent conflict) and a visitor question -> Swahili SMS to Noor, one call per alert queued for hub-voice, **held** while its clips are not recorded |
| 8 | guided demo: 7 clicks on `/api/guided/next`, ends with the MAONI summary; no safety-showcase step |
| page | page served with its CSP, no banner; `/api/state` holds no phone number |
| nat1, nat2 | Nat's independent suites `eval/hub/booking_flow_suite.mjs` and `eval/hub/sms_approval_suite.mjs` (15/15 each) |

## How `src/hub.mjs` connects the pieces

Max's plan, phone/SMS first, GetYourGuide later:

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
| Owner alert calls for hub-voice (`owner_alert_calls.mjs`: pull API, one per alert, daily cap, enrolled owner only) | working, tested over HTTP with a contract test against the worker; calls are held until the `alert.*` clips are recorded |
| SMS commands + per-proposal one-time code (Carter's guardrail) | working, tested (spoof, wrong, expired, reused, cross-proposal, content-changed) |
| Outbox (idempotent, restart-safe, sensitive bodies redacted) | working; an item refused before any request, or refused 5 times by the provider, ends REFUSED (no endless retry) |
| Platform publish (approved-only, digest-bound, fail-safe blocks days) | simulated; GYG/Booking.com adapters are documented stubs (supplier/partner access needed); Booking.com missing from the contract channels |
| Sync API for Noor's app | working on localhost; needs TLS (or a reverse proxy) and auth rate limiting before real use |
| Live phone conversation (LiveKit + local Whisper/Qwen/Chatterbox) | next: recipe from warden in the room; runs on a GPU PC, not the Max laptop |
| Tourist booking by SMS, Noor's decision, suggestions, queries, feedback loop | working, simulated; tourist-facing de/fr/sw texts and Swahili read-backs UNREVIEWED; expired booking requests are not swept yet (the tourist is not told) |
| Twilio SMS/call adapter + signed webhook (`src/transports/twilio.mjs`, `README-twilio.md`) | built and tested with a fake fetch; not selected by default (simulated stays the default); no SID store yet (a restart leaves a mid-send row UNCERTAIN) |
| Real-SMS runner (`src/run_hub.mjs`: inbound by polling Twilio's Messages API, no inbound port; outbound via the adapter; daily cost cap; `--dry-run` / `--live`) | tested with a fake Twilio (`test/run_hub.test.mjs`, incl. the booking story through polling + REST); not run live from here; see `README-twilio.md` "Run with a real Twilio number" |
| Voice agent API (`voice_api.mjs`: availability, farm, owner match, pending, feedback summary, voice booking requests, owner proposals incl. `visitor_note`) | working, tested over HTTP; hubclient.py still needs to send `change.date` / `change.capacity` and read 409/422 bodies (see above); Swahili lines UNREVIEWED |
| Two-phone demo page (`demo_web.mjs`, `npm run demo:hub`) + `npm run demo:check` | working offline; every workflow above asserted through the page's API on each `node --test` run; calls shown as held until the alert clips are recorded |
| Root workspace lock | `@sauti/hub` must be added to the root lock by Platform (codex) before merge |
