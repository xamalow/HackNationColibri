// Twilio adapter for the hub's outbox (SMS + prerecorded-clip calls to Noor) and its inbound SMS webhook.
// Selected by config; the simulated transport stays the default. Credentials come from the environment only.
//
// Outbox transport contract (src/outbox.mjs): send({ idempotency_key, channel: "sms"|"call", recipient, body })
// -> { ref }; wasSent(key) -> true | false | null. A thrown error with notAccepted === true is retried by the
// outbox (Twilio provably refused it); any other error leaves the row UNCERTAIN (it may have been accepted).
//
// Mapping of Twilio outcomes:
//   2xx                         -> sent, ref = Twilio SID (recorded in memory for wasSent)
//   4xx except 429              -> notAccepted: true (Twilio validated and refused the request: retry is safe)
//   429, 5xx, timeout, network  -> no notAccepted (the request may have been accepted: UNCERTAIN, never resent)
//   invalid item (bad clip key, bad number, body too long) -> notAccepted: true, no network call
//
// Never logged or put in an error message: the auth token, phone numbers, message bodies. This module does not log.
/* global AbortController */
import { createHmac, timingSafeEqual } from "node:crypto";
import { clearTimeout, setTimeout } from "node:timers";
import { URLSearchParams } from "node:url";
import { normalizePhone } from "../commands.mjs";

const API = "https://api.twilio.com/2010-04-01";
export const CLIP_KEY_RE = /^[a-z0-9._-]+$/;
export const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_SMS_CHARS = 1600; // Twilio's limit for one Messages.json body
const MAX_CLIPS = 40;
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

export const ENV_VARS = Object.freeze({
  accountSid: "TWILIO_ACCOUNT_SID",
  authToken: "TWILIO_AUTH_TOKEN",
  from: "TWILIO_FROM_NUMBER",
  clipBaseUrl: "HUB_CLIP_BASE_URL",
});
export const OPTIONAL_ENV_VARS = Object.freeze({ statusCallbackUrl: "TWILIO_STATUS_CALLBACK_URL" });

/** Missing configuration. The message names the missing variables, never a value. */
export class NotConfiguredError extends Error {
  constructor(missing) {
    super(`Twilio transport not configured: missing ${missing.join(", ")}`);
    this.name = "NotConfiguredError";
    this.code = "not_configured";
    this.missing = missing;
    this.notAccepted = true; // nothing was sent
  }
}

/** A send that failed. `notAccepted: true` only when Twilio provably did not accept the request. */
export class TwilioSendError extends Error {
  constructor(code, { notAccepted = false, status = null, twilioCode = null } = {}) {
    super(`twilio ${code}${status ? ` (HTTP ${status}${twilioCode ? `, Twilio error ${twilioCode}` : ""})` : ""}`);
    this.name = "TwilioSendError";
    this.code = code;
    this.status = status;
    this.twilioCode = twilioCode;
    if (notAccepted) this.notAccepted = true;
  }
}

export function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

/** "+254700000030", "0700000030" -> "+254700000030"; null if not a phone number. */
export function toE164(raw) {
  const d = normalizePhone(raw);
  return d ? `+${d}` : null;
}

function httpsUrl(raw, name) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new TypeError(`${name} must be an https URL`); }
  if (u.protocol !== "https:") throw new TypeError(`${name} must be an https URL`);
  return u;
}

/** The call's TwiML: one <Play> per prerecorded clip, at <clipBaseUrl>/<key>.wav. Throws on an invalid key. */
export function callTwiml(clipKeys, clipBaseUrl) {
  if (!Array.isArray(clipKeys) || clipKeys.length === 0 || clipKeys.length > MAX_CLIPS) {
    throw new TwilioSendError("invalid_call", { notAccepted: true });
  }
  const base = String(clipBaseUrl).replace(/\/+$/, "");
  const plays = clipKeys.map((k) => {
    if (typeof k !== "string" || !CLIP_KEY_RE.test(k) || k.includes("..")) throw new TwilioSendError("invalid_clip_key", { notAccepted: true });
    return `<Play>${xmlEscape(`${base}/${k}.wav`)}</Play>`;
  });
  return `<Response>${plays.join("")}</Response>`;
}

/**
 * @param {object} cfg
 * @param {string} cfg.accountSid  "AC" + 32 hex
 * @param {string} cfg.authToken
 * @param {string} cfg.from        the hub's Twilio number (E.164)
 * @param {string} cfg.clipBaseUrl https base URL the clips are served from (Twilio fetches <base>/<key>.wav)
 * @param {string} [cfg.statusCallbackUrl] https URL for delivery status callbacks
 * @param {Iterable<string>} [cfg.availableClips] if given, clip keys not in it are skipped (notify.MISSING_CLIPS)
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {number} [cfg.timeoutMs]
 */
export function createTwilioTransport({
  accountSid, authToken, from, statusCallbackUrl, clipBaseUrl, availableClips,
  fetchImpl = globalThis.fetch, timeoutMs = 10_000,
} = {}) {
  const missing = Object.entries({ accountSid, authToken, from, clipBaseUrl }).filter(([, v]) => !v).map(([k]) => ENV_VARS[k]);
  if (missing.length) throw new NotConfiguredError(missing);
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw new TypeError("accountSid must be AC followed by 32 hex characters");
  const fromE164 = toE164(from);
  if (!fromE164 || !String(from).trim().startsWith("+")) throw new TypeError("from must be an E.164 number (+...)");
  const clipBase = httpsUrl(clipBaseUrl, "clipBaseUrl").toString();
  const statusCallback = statusCallbackUrl ? httpsUrl(statusCallbackUrl, "statusCallbackUrl").toString() : null;
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive integer");
  const clipFilter = availableClips ? new Set(availableClips) : null;
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const sids = new Map(); // idempotency_key -> Twilio SID (or "accepted"), this process only

  async function post(resource, form) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(`${API}/Accounts/${accountSid}/${resource}.json`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal,
      });
      text = await res.text().catch(() => "");
    } catch (e) {
      // Aborted or network failure: the request may have reached Twilio. Never retried automatically.
      throw new TwilioSendError(controller.signal.aborted || e?.name === "AbortError" ? "timeout" : "network_error");
    } finally {
      clearTimeout(timer);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (res.status >= 200 && res.status < 300) return json;
    const twilioCode = Number.isInteger(json?.code) ? json.code : null; // Twilio's message is not echoed (it can hold a number)
    const rejected = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new TwilioSendError(rejected ? "rejected" : res.status === 429 ? "rate_limited" : "server_error", { notAccepted: rejected, status: res.status, twilioCode });
  }

  return {
    name: "twilio",
    async send({ idempotency_key, channel, recipient, body } = {}) {
      if (typeof idempotency_key !== "string" || !idempotency_key) throw new TwilioSendError("invalid_item", { notAccepted: true });
      const to = toE164(recipient);
      if (!to) throw new TwilioSendError("invalid_recipient", { notAccepted: true });
      let resource;
      const form = { To: to, From: fromE164 };
      if (channel === "sms") {
        if (typeof body !== "string" || !body || body.length > MAX_SMS_CHARS) throw new TwilioSendError("invalid_body", { notAccepted: true });
        resource = "Messages";
        form.Body = body;
      } else if (channel === "call") {
        let keys;
        try { keys = typeof body === "string" ? JSON.parse(body) : body; } catch { throw new TwilioSendError("invalid_call", { notAccepted: true }); }
        if (Array.isArray(keys) && clipFilter) keys = keys.filter((k) => clipFilter.has(k));
        resource = "Calls";
        form.Twiml = callTwiml(keys, clipBase);
      } else {
        throw new TwilioSendError("unsupported_channel", { notAccepted: true });
      }
      if (statusCallback) form.StatusCallback = statusCallback;
      const json = await post(resource, form);
      const sid = typeof json?.sid === "string" ? json.sid : null;
      sids.set(idempotency_key, sid ?? "accepted");
      return { ref: sid };
    },
    /** true if this process saw Twilio accept the key; null otherwise (no SID store: cannot tell). */
    wasSent(key) { return sids.has(key) ? true : null; },
  };
}

/** Build the transport from environment variables (names in ENV_VARS). Throws NotConfiguredError naming what is missing. */
export function fromEnv(env = process.env, opts = {}) {
  const missing = Object.values(ENV_VARS).filter((name) => !env[name]);
  if (missing.length) throw new NotConfiguredError(missing);
  return createTwilioTransport({
    accountSid: env[ENV_VARS.accountSid],
    authToken: env[ENV_VARS.authToken],
    from: env[ENV_VARS.from],
    clipBaseUrl: env[ENV_VARS.clipBaseUrl],
    statusCallbackUrl: env[OPTIONAL_ENV_VARS.statusCallbackUrl] || undefined,
    ...opts,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Inbound webhook.
/** Twilio's signature: base64(HMAC-SHA1(authToken, url + sorted params as key+value; array values sorted)). */
export function computeTwilioSignature(authToken, url, params = {}) {
  let data = String(url);
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (Array.isArray(v)) for (const x of [...v].map(String).sort()) data += key + x;
    else data += key + String(v ?? "");
  }
  return createHmac("sha1", String(authToken)).update(data, "utf8").digest("base64");
}

/** The same URL with and without the default https port (Twilio may sign either form). */
function urlVariants(url) {
  const out = [String(url)];
  try {
    const u = new URL(String(url));
    if (u.protocol === "https:" && !u.port) out.push(String(url).replace(/^(https:\/\/[^/?#]+)/, "$1:443"));
    if (u.protocol === "https:" && /^https:\/\/[^/?#]+:443(?=[/?#]|$)/.test(String(url))) out.push(String(url).replace(/:443(?=[/?#]|$)/, ""));
  } catch { /* the plain url is still tried */ }
  return out;
}

/** Constant-time check of an X-Twilio-Signature header. */
export function verifyTwilioSignature({ authToken, url, params = {}, signature } = {}) {
  if (!authToken || !url || typeof signature !== "string" || !signature) return false;
  const got = Buffer.from(signature, "utf8");
  let ok = false;
  for (const u of urlVariants(url)) {
    const expected = Buffer.from(computeTwilioSignature(authToken, u, params), "utf8");
    if (expected.length === got.length && timingSafeEqual(expected, got)) ok = true;
  }
  return ok;
}

export class BadSignatureError extends Error {
  constructor() { super("invalid Twilio signature"); this.name = "BadSignatureError"; this.code = "bad_signature"; }
}

/**
 * Verified inbound SMS -> { from, to, text, provider_id }. Throws BadSignatureError if the signature is invalid
 * (or the AccountSid is not ours, when accountSid is given). Returns null for a valid non-SMS payload
 * (e.g. a delivery status callback). The text is data, never instructions.
 */
export function parseInboundWebhook({ params, authToken, url, signature, accountSid } = {}) {
  if (!params || typeof params !== "object") throw new BadSignatureError();
  if (!verifyTwilioSignature({ authToken, url, params, signature })) throw new BadSignatureError();
  if (accountSid && params.AccountSid !== accountSid) throw new BadSignatureError();
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const sid = one(params.MessageSid) ?? one(params.SmsSid);
  const body = one(params.Body);
  const from = one(params.From);
  if (typeof sid !== "string" || typeof body !== "string" || typeof from !== "string") return null;
  return { from, to: typeof one(params.To) === "string" ? one(params.To) : null, text: body.slice(0, MAX_SMS_CHARS), provider_id: sid };
}

/** application/x-www-form-urlencoded -> params object (repeated keys become arrays). */
export function parseForm(raw) {
  const params = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    if (k in params) params[k] = Array.isArray(params[k]) ? [...params[k], v] : [params[k], v];
    else params[k] = v;
  }
  return params;
}

/**
 * node:http handler for Twilio's inbound SMS webhook. Validates X-Twilio-Signature against publicUrl + the request
 * path (the URL Twilio was configured with, HTTPS), caps the body at 64 KB, hands a verified SMS to onSms, and
 * answers an empty TwiML <Response/>: no auto-reply, the hub queues its replies through the outbox itself.
 * 403 on a bad signature (onSms is not called), 405 for non-POST, 413 for a large body, 500 if onSms throws.
 * @param {{ authToken: string, publicUrl: string, onSms: (sms) => unknown, accountSid?: string }} cfg
 */
export function createTwilioWebhook({ authToken, publicUrl, onSms, accountSid } = {}) {
  if (!authToken) throw new NotConfiguredError([ENV_VARS.authToken]);
  const base = httpsUrl(publicUrl, "publicUrl");
  if (typeof onSms !== "function") throw new TypeError("onSms must be a function");
  const reply = (res, status, body = "", type = "text/plain; charset=utf-8", extra = {}) => {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
    res.end(body);
  };

  return function twilioWebhook(req, res) {
    if (req.method !== "POST") return reply(res, 405, "method not allowed", undefined, { Allow: "POST" });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      reply(res, 413, "payload too large", undefined, { Connection: "close" });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_WEBHOOK_BYTES) {
        done = true;
        chunks.length = 0;
        reply(res, 413, "payload too large", undefined, { Connection: "close" });
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("error", () => { done = true; reply(res, 400, "bad request"); });
    req.on("end", async () => {
      if (done) return;
      done = true;
      const params = parseForm(Buffer.concat(chunks).toString("utf8"));
      const url = new URL(req.url ?? "/", base).toString();
      const signature = req.headers["x-twilio-signature"];
      let sms;
      try {
        sms = parseInboundWebhook({ params, authToken, url, signature: typeof signature === "string" ? signature : "", accountSid });
      } catch {
        return reply(res, 403, "forbidden");
      }
      try {
        if (sms) await onSms(sms);
      } catch {
        return reply(res, 500, "error");
      }
      reply(res, 200, EMPTY_TWIML, "text/xml; charset=utf-8");
    });
  };
}
