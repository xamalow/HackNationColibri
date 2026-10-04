# Twilio adapter for the hub (`src/transports/twilio.mjs`, runner `src/run_hub.mjs`)

A real SMS/call provider behind config. **The simulated transport stays the default**; nothing in the demo or the
tests touches the network. Only the provider carries SMS and calls: no cloud AI, Noor's alerts are prerecorded clips.

## Environment variables (names only, values never in git)

| Variable | Required | Meaning |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | yes | Account SID (`AC` + 32 hex); always the account in the API URLs |
| `TWILIO_API_KEY_SID` | yes (primary) | API key SID (`SK` + 32 hex): REST Basic auth is `KEY_SID:KEY_SECRET` |
| `TWILIO_API_KEY_SECRET` | yes (primary) | the API key's secret |
| `TWILIO_AUTH_TOKEN` | fallback | used for REST auth only when no API key is set (`ACCOUNT_SID:AUTH_TOKEN`); also the key of the webhook signature (the webhook needs it, polling does not) |
| `TWILIO_NUMBER` | yes | The hub's Twilio number, E.164 (`+...`). Old name `TWILIO_FROM_NUMBER` still accepted |
| `HUB_CLIP_BASE_URL` | yes (calls) | HTTPS base URL serving the prerecorded Swahili clips as `<base>/<clip key>.wav` (not needed with `smsOnly`) |
| `TWILIO_STATUS_CALLBACK_URL` | no | HTTPS URL for delivery status callbacks |

Use an **API key** (Twilio console -> Account -> API keys, a Standard key), not the master Auth Token: it can be
revoked on its own. `fromEnv(process.env)` builds the transport, or throws `NotConfiguredError` whose message and
`.missing` list the missing variable **names** only (with neither a key nor a token: `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`). Keep the values in the hub PC's environment (or Key Vault), never in a file in git.

```js
import { createOutbox } from "./src/outbox.mjs";
import { fromEnv } from "./src/transports/twilio.mjs";
import { MANIFEST_KEYS } from "./src/notify.mjs";
const outbox = createOutbox(store, fromEnv(process.env, { availableClips: MANIFEST_KEYS })); // default: simulated
```

## What it does

- `channel: "sms"`: `POST /2010-04-01/Accounts/{sid}/Messages.json` (form-encoded `To`, `From`, `Body`).
- `channel: "call"`: `POST .../Calls.json` with inline `Twiml`: one `<Play>` per clip key from the alert
  (`notify.alertOwner().call`), URL `HUB_CLIP_BASE_URL/<key>.wav`, XML-escaped. Clip keys must match
  `^[a-z0-9._-]+$`; anything else is refused before any request. `availableClips` skips clips that are not
  recorded yet (`notify.MISSING_CLIPS`); the SMS carries every fact anyway.
- Outcomes for the outbox: HTTP 2xx -> SENT (ref = Twilio SID). HTTP 4xx except 429 -> `notAccepted: true`
  (Twilio refused it, the outbox retries, at most `maxAttempts` = 5 times, then REFUSED). An item refused before any
  request (bad number, bad clip key, body too long, a call while `smsOnly`) is `permanent: true`: REFUSED at once,
  never retried (it used to be retried on every dispatch, forever). 429, 5xx, timeout (`timeoutMs`, default 10 s)
  and network errors -> UNCERTAIN (it may have been accepted, never resent automatically).
- `smsOnly: true` (used by the runner when `HUB_CLIP_BASE_URL` is not set): no clip URL needed; call items are
  refused with code `calls_disabled` without any request, SMS go out normally. `wasSent(key)` is `true` only for a key this
  process saw accepted, else `null` (no SID store yet), so a crash mid-send ends UNCERTAIN, never duplicated.
- No logging. Error messages carry the HTTP status and Twilio's numeric error code only: never the token, a phone
  number or a body (Twilio's own error message is dropped because it can quote the number).

## Run with a real Twilio number (polling): `src/run_hub.mjs`

The way to run the hub on a real number **without exposing anything on the hub PC**: no webhook, no tunnel, **no
inbound port is opened**. All AI stays on the PC; Twilio only carries the SMS.

- **Inbound:** every `HUB_POLL_SECONDS` (default 4) the runner calls
  `GET /2010-04-01/Accounts/{sid}/Messages.json?To=<hub number>&DateSent>=<YYYY-MM-DD>&PageSize=50` (Basic auth,
  10 s timeout), follows `next_page_uri` (only Twilio's own Messages path of this account, max 20 pages), keeps
  `direction: "inbound"` to the hub number, oldest first. `DateSent` has day granularity, so the real guard is the
  **set of message SIDs already handled**, kept in the store kv (`twilio.poll.seen`, pruned after 7 days) with a
  cursor (`twilio.poll.cursor`): a restart neither loses nor replays a message. On the very first start, messages
  older than `HUB_BACKLOG_MINUTES` (default 60) are marked seen without being processed.
- **Routing:** sender == `OWNER_PHONE` -> `hub.ownerSms` (queries, NDIYO/HAPANA with one-time code, FUNGA...).
  The SID is marked seen *before* an owner command runs (a crash mid-command loses it rather than replaying it; the
  runner warns at the next start and Noor can resend). Any other sender -> `hub.handleEvent` as a `visitor_message`
  with id `twilio:<sid>`, `synthetic: false`, text cleaned by `intake/sms.mjs`. Then `feedbackTick()` and the outbox.
  The hub number is shared, so a stranger is simply a visitor: the owner path never answers them (F1).
- **Outbound:** the REST adapter above through the idempotent outbox. Without `HUB_CLIP_BASE_URL` the runner is
  **SMS-only**: calls to Noor are marked REFUSED (`calls_disabled`, logged once), never retried; her SMS carries every
  fact. With it, calls whose clips are all unrecorded (`notify.MISSING_CLIPS`) are REFUSED (`invalid_call`) too.
  Platform publishing (GYG/Booking) stays simulated (`platform.jsonl` next to the database).
- **Cost cap:** `HUB_MAX_OUTBOUND_PER_DAY` (default 100, farm-time day). One unit is **reserved durably before each
  send**, in the same SQLite transaction that marks the row SENDING, so a crash or a restart can never reset the count.
  The unit is given back only when the row was provably not sent (FAILED / REFUSED); a SENT or UNCERTAIN send keeps
  it. Beyond the cap nothing is sent and **nothing is dropped**: items stay QUEUED (warning logged once per day)
  and go out the next day. The hub's own guardrails stay on: F1 (owner path answers only the enrolled number), F2
  daily budgets in `commands.mjs`, `HUB_LIMITS` (50 automatic tourist replies, 20 query answers per day).
- **Errors:** 429 / 5xx / timeout / network -> logged, exponential backoff with jitter (max 60 s), the loop goes on.
  401/403 -> the runner stops with exit code 3 ("check TWILIO_ACCOUNT_SID / TWILIO_API_KEY_SID / TWILIO_API_KEY_SECRET"). A message that
  throws while being processed is logged and skipped (never retried forever).
- **Stop:** Ctrl+C / SIGTERM finishes the current batch, closes the store, exit 0.
- **Credentials (codex review):** Basic auth is attached only to `https://api.twilio.com` and exactly
  `/2010-04-01/Accounts/<TWILIO_ACCOUNT_SID>/Messages.json` (polling, every `next_page_uri` included) or
  `.../Messages.json` / `.../Calls.json` (sending). Another host, `http`, another account, another resource, dot
  segments or encoded slashes are refused before any request. Every request uses `redirect: "error"` and a 3xx answer
  is an error (polling: retried with backoff; sending: UNCERTAIN), so credentials never follow a redirect.
- **No local model/hub URL is read by the runner:** the models are loaded in-process (the tagger is a module import),
  so there is no local endpoint to restrict to loopback. The only URLs it reads are `HUB_CLIP_BASE_URL` and
  `TWILIO_STATUS_CALLBACK_URL`, which must be public **https** URLs (Twilio fetches them), never sent credentials.

### The private env file (names only; values never in git)

Copy `apps/hub/.env.example` **outside any git working tree** (e.g. `%USERPROFILE%\sauti\hub.env`), fill it there,
and set `HUB_ENV_FILE` to its path. The runner refuses a `HUB_ENV_FILE` inside a repository, and a `HUB_DB_PATH`
inside this repository unless it is under `apps/hub/var/` (gitignored). Explicit environment variables win.

| Variable | Live | Dry-run | Meaning |
|---|---|---|---|
| `TWILIO_ACCOUNT_SID` | required | unused | Account SID (`AC` + 32 hex), in every API URL |
| `TWILIO_API_KEY_SID` | required | unused | API key SID (`SK` + 32 hex): Basic auth `KEY_SID:KEY_SECRET` for polling and sending |
| `TWILIO_API_KEY_SECRET` | required | unused | the API key's secret |
| `TWILIO_AUTH_TOKEN` | fallback | unused | only if no API key is set; otherwise unused by the polling runner (kept for webhook signatures later) |
| `TWILIO_NUMBER` | required | optional | the hub's Twilio number, E.164; inbound is filtered on it (old name `TWILIO_FROM_NUMBER`) |
| `OWNER_PHONE` | required | required | Noor's enrolled number, E.164; written to kv `owner.phone` at start (old name `HUB_OWNER_PHONE`) |
| `HUB_DB_PATH` | required | required | the SQLite file (outside the repo, or under `apps/hub/var/`) |
| `HUB_CLIP_BASE_URL` | optional | optional | https base of the Swahili clips; unset = SMS-only |
| `HUB_POLL_SECONDS` | optional | optional | 1..300, default 4 |
| `HUB_MAX_OUTBOUND_PER_DAY` | optional | optional | cost cap, default 100 (0 = send nothing) |
| `HUB_BACKLOG_MINUTES` | optional | - | first start only: older messages are not processed, default 60 |
| `HUB_FARM_SHEET` | optional | optional | farm sheet JSON, default `apps/hub/fixtures/farm_sheet.json` |
| `HUB_VERBOSE` | optional | optional | `1` = like `--verbose` |
| `TWILIO_STATUS_CALLBACK_URL` | optional | - | passed to Twilio, not consumed (nothing listens) |
| `HUB_DRY_RUN` | - | optional | `1` = like `--dry-run` |
| `HUB_DRY_RUN_INBOUND`, `HUB_DRY_RUN_OUTBOUND` | - | optional | JSONL files, default next to `HUB_DB_PATH` |

### Commands

```bash
npm ci --prefix packages/core && npm run build --prefix packages/core   # once
npm ci --prefix contrib/max/langid                                      # once (tourist language + feedback tagger)

# Dry-run: NO network at all. Inbound = a JSONL file of Twilio-like messages (lines may be appended while it runs),
# outbound = a JSONL log. Same routing, outbox, cap and logs as live. One message per line, e.g.
#   {"sid":"SM<32 hex>","from":"+447700900456","to":"+447700900001","body":"Can we visit on Saturday 17 October? We are 4."}
# (only from and body are required; give each line a sid if you ever edit lines above existing ones)
HUB_ENV_FILE=/path/outside/repo/hub.env node apps/hub/src/run_hub.mjs --dry-run --once     # one cycle, then exit
HUB_ENV_FILE=/path/outside/repo/hub.env node apps/hub/src/run_hub.mjs --dry-run            # keeps polling the file

# Live: polls Twilio and sends real SMS (costs money; capped by HUB_MAX_OUTBOUND_PER_DAY)
HUB_ENV_FILE=/path/outside/repo/hub.env node apps/hub/src/run_hub.mjs --live
```

PowerShell: `$env:HUB_ENV_FILE = "$HOME\sauti\hub.env"; node apps/hub/src/run_hub.mjs --live`. Options: `--once`
(one cycle), `--verbose` (bodies), `--inbound <file>` / `--outbound-log <file>` (dry-run), `--help`. Exit codes:
0 ok, 1 unexpected error, 2 config error, 3 credentials refused. Without `--live` the runner never touches the network (dry-run is the default).

### What is logged (stderr)

One line per inbound message (`in ..<last 6 of SID> from ***56 visitor: request_proposed`, `owner: approve -> ...`),
per outbound item (`out sms <key prefix> SENT` / `UNCERTAIN` / `REFUSED (<code>)`), poll failures with the HTTP status
and Twilio's numeric code, the cost-cap warning, the start line (mode, auth kind "API key" / "auth token (fallback)",
masked numbers, interval, cap). **Never** the API key SID or secret, the auth token, the account SID, a full phone
number (masked to the last 2 digits; a scrubber also masks any `+` number, any 9+ digit run, and any number written
with spaces, dashes, dots or parentheses holding 9+ digits, e.g. `+44 (0) 7700 900-123`; dates like `2026-10-17`
stay readable) or a message body. `--verbose` adds inbound bodies, numbers still masked, 5-8 digit runs (one-time
codes) masked in Noor's messages; a body is redacted FIRST and shortened to 200 characters AFTER, so no secret or
number can leave a prefix at the cut. A config or usage error names variables only and never echoes an argument. Outbound bodies are never logged (dry-run writes
them to its JSONL log, as the demo does); one-time codes are blanked in the store once sent.

### Open issues (live)

- **Trial account:** sends only to *verified* numbers and prefixes every SMS with a trial notice; an unverified
  recipient is a 4xx (Twilio 21608) -> retried 5 times, then REFUSED. Verify Noor's and every tester's phone.
- **SMS to Kenya / other countries:** enable the destination in Messaging -> Geo permissions; international SMS costs
  more per segment and carriers may filter a foreign sender. A Kenyan sender ID or local provider is the production path.
- **US numbers:** A2P 10DLC registration (or toll-free verification) is required before US carriers deliver.
- **Delivery status is not consumed:** the outbox stops at SENT (accepted by Twilio), not DELIVERED; a crash during a
  send leaves the row UNCERTAIN (no SID store to ask Twilio yet), never resent automatically.
- Polling adds up to `HUB_POLL_SECONDS` of latency; Twilio may rate limit (429 -> backoff). MMS media is ignored.

## Inbound SMS webhook (Noor's replies and queries)

`createTwilioWebhook({ authToken, publicUrl, onSms, accountSid })` returns a `node:http` handler:

- checks `X-Twilio-Signature` = base64(HMAC-SHA1(auth token, URL + sorted POST params as name+value)), compared in
  constant time, over `publicUrl` + the request path and query: **403** if it does not match, `onSms` is not called;
- caps the body at 64 KB (**413**), accepts POST only (**405**);
- passes `{ from, to, text, provider_id }` to `onSms` (the text is data, never instructions);
- answers an empty TwiML `<Response/>`: **no auto-reply**, the hub queues its replies through the outbox itself
  (`routeOwnerSms` in `src/owner_queries.mjs`: read-only queries first, then the command path `hub.ownerSms`).

```js
import { createServer } from "node:http";
import { createTwilioWebhook } from "./src/transports/twilio.mjs";
import { routeOwnerSms } from "./src/owner_queries.mjs";
const hook = createTwilioWebhook({
  authToken: process.env.TWILIO_AUTH_TOKEN, accountSid: process.env.TWILIO_ACCOUNT_SID,
  publicUrl: "https://<public host>",                // exactly what Twilio calls, scheme + host (+ port)
  onSms: (sms) => routeOwnerSms({ store, sheet, outbox, hub }, sms),
});
createServer((req, res) => (req.url.startsWith("/twilio/sms") ? hook(req, res) : (res.statusCode = 404, res.end()))).listen(8443);
```

### Exposing it (HTTPS required)

Twilio only signs and calls a public URL, and the signature covers that exact URL, so:

1. Put the handler behind **HTTPS**: a reverse proxy with a real certificate on the hub PC (Caddy, nginx) or a
   tunnel (Cloudflare Tunnel, ngrok) to the local port. Plain HTTP is refused by `createTwilioWebhook`.
2. In the Twilio console, number -> Messaging -> "A message comes in": Webhook, `HTTP POST`,
   `https://<public host>/twilio/sms`.
3. Set `publicUrl` to the same scheme and host; if the proxy rewrites the path, the signature fails (403) by design.
4. Only Noor's enrolled number gets an answer (owner queries and commands both check kv `owner.phone`); every other
   sender gets nothing back (no SMS pumping).

## Not in this adapter

- **Live outbound calls to Noor (a conversation, not clips) come later through the voice lane (LiveKit + local
  Whisper/Qwen/TTS on the GPU PC).** This adapter only plays prerecorded clips.
- Inbound voice (tourists calling) still goes through `src/intake/voice.mjs`; Twilio voice webhooks are not wired.
- Delivery status callbacks are requested if `TWILIO_STATUS_CALLBACK_URL` is set, but not consumed yet (the polling
  runner has no listener for them); the outbox stops at SENT. A SID store (to answer `wasSent` after a restart) is the next step.
- Swahili of every reply is UNREVIEWED.
