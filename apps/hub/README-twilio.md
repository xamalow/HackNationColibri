# Twilio adapter for the hub (`src/transports/twilio.mjs`)

A real SMS/call provider behind config. **The simulated transport stays the default**; nothing in the demo or the
tests touches the network. Only the provider carries SMS and calls: no cloud AI, Noor's alerts are prerecorded clips.

## Environment variables (names only, values never in git)

| Variable | Required | Meaning |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | yes | Account SID (`AC` + 32 hex) |
| `TWILIO_AUTH_TOKEN` | yes | Auth token: Basic auth for the REST API and the key of the webhook signature |
| `TWILIO_FROM_NUMBER` | yes | The hub's Twilio number, E.164 (`+...`) |
| `HUB_CLIP_BASE_URL` | yes | HTTPS base URL serving the prerecorded Swahili clips as `<base>/<clip key>.wav` |
| `TWILIO_STATUS_CALLBACK_URL` | no | HTTPS URL for delivery status callbacks |

`fromEnv(process.env)` builds the transport, or throws `NotConfiguredError` whose message and `.missing` list the
missing variable **names** only. Keep the values in the hub PC's environment (or Key Vault), never in a file in git.

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
  (Twilio refused it, the outbox retries). 429, 5xx, timeout (`timeoutMs`, default 10 s) and network errors ->
  UNCERTAIN (it may have been accepted, never resent automatically). `wasSent(key)` is `true` only for a key this
  process saw accepted, else `null` (no SID store yet), so a crash mid-send ends UNCERTAIN, never duplicated.
- No logging. Error messages carry the HTTP status and Twilio's numeric error code only: never the token, a phone
  number or a body (Twilio's own error message is dropped because it can quote the number).

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
- Delivery status callbacks are requested if `TWILIO_STATUS_CALLBACK_URL` is set, but not consumed yet; the outbox
  stops at SENT. A SID store (to answer `wasSent` after a restart) is the next step.
- Swahili of every reply is UNREVIEWED.
