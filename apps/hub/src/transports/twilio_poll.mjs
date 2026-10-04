// Inbound SMS for the hub by POLLING Twilio's Messages API (no webhook: nothing listens on the hub PC).
//   GET https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json?To=<hub number>&DateSent>=<YYYY-MM-DD>&PageSize=50
// following next_page_uri, HTTP Basic auth AccountSid:AuthToken, with a timeout. DateSent has day granularity, so
// the real guard against replays is the set of message SIDs already handled (createSeenStore, in the hub store kv).
//
// A dry-run poller (createFilePoller) reads the same message shape from a local JSONL file: no network at all.
// This module does not log. Error messages carry the HTTP status and Twilio's numeric error code only, never the
// token, a phone number or a body.
/* global AbortController */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { clearTimeout, setTimeout } from "node:timers";
import { URLSearchParams } from "node:url";
import { basicAuthHeader, credentialProblems } from "./twilio.mjs";

const API_ORIGIN = "https://api.twilio.com";

/**
 * Security (codex review): Basic auth is attached only to https://api.twilio.com + exactly
 * /2010-04-01/Accounts/<this AccountSid>/Messages.json. Anything else (http, another host or port, user info,
 * another account, another resource, path traversal, encoded dots or slashes) is refused BEFORE any request.
 * Requests use `redirect: "error"` and a 3xx answer is an error: credentials never follow a redirect.
 */
export function assertTwilioMessagesUrl(raw, accountSid) {
  const s = String(raw ?? "");
  const rawPath = s.split(/[?#]/)[0];
  // backslashes, encoded dot/slash/backslash, dot segments: refused before URL normalization could hide them
  if (/\\|%2e|%2f|%5c|\/\.\.?(\/|$)/i.test(rawPath)) throw new PollError("bad_url", { transient: false });
  let u;
  try { u = new URL(s); } catch { throw new PollError("bad_url", { transient: false }); }
  if (u.protocol !== "https:" || u.origin !== API_ORIGIN || u.username || u.password || u.hash
    || u.pathname !== `/2010-04-01/Accounts/${accountSid}/Messages.json`) {
    throw new PollError("bad_url", { transient: false });
  }
  return u.toString();
}
export const MESSAGE_SID_RE = /^(SM|MM)[0-9a-fA-F]{32}$/;
const MAX_PAGE_SIZE = 1000; // Twilio's maximum

/** A failed poll. `transient`: retry with backoff. `auth`: the credentials were refused (401/403). */
export class PollError extends Error {
  constructor(code, { status = null, twilioCode = null, transient = true } = {}) {
    super(`twilio poll ${code}${status ? ` (HTTP ${status}${twilioCode ? `, Twilio error ${twilioCode}` : ""})` : ""}`);
    this.name = "PollError";
    this.code = code;
    this.status = status;
    this.twilioCode = twilioCode;
    this.transient = transient;
    this.auth = status === 401 || status === 403;
  }
}

/** UTC calendar day of a Date, as Twilio's DateSent filter expects it. */
export function twilioDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** ISO timestamp from Twilio's RFC 2822 date ("Sat, 03 Oct 2026 10:00:00 +0000") or an ISO string; null otherwise. */
export function parseTwilioDate(v) {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * One Twilio message resource -> { sid, from, to, body, direction, status, sent_at } (sent_at ISO or null), or null when it
 * is not a usable message (no valid SID or sender). The body is untrusted data, cleaned later by the intake.
 */
export function normalizeMessage(m) {
  if (!m || typeof m !== "object") return null;
  const sid = typeof m.sid === "string" && MESSAGE_SID_RE.test(m.sid) ? m.sid : null;
  if (!sid || typeof m.from !== "string" || !m.from) return null;
  return {
    sid,
    from: m.from,
    to: typeof m.to === "string" ? m.to : null,
    body: typeof m.body === "string" ? m.body : "",
    direction: typeof m.direction === "string" ? m.direction : "inbound",
    status: typeof m.status === "string" ? m.status : null,
    sent_at: parseTwilioDate(m.date_sent) ?? parseTwilioDate(m.date_created),
  };
}

/**
 * @param {object} cfg
 * @param {string} cfg.accountSid "AC" + 32 hex (always in the URL)
 * @param {string} [cfg.apiKeySid]  "SK" + 32 hex: the PRIMARY credential, with apiKeySecret
 * @param {string} [cfg.apiKeySecret]
 * @param {string} [cfg.authToken]  fallback credential when no API key is given
 * @param {string} cfg.to          the hub's Twilio number (E.164): only messages sent TO it are listed
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {number} [cfg.timeoutMs]  per request
 * @param {number} [cfg.pageSize]
 * @param {number} [cfg.maxPages]   pages followed per poll; beyond it the result is marked `truncated`
 */
export function createTwilioPoller({
  accountSid, apiKeySid, apiKeySecret, authToken, to, fetchImpl = globalThis.fetch, timeoutMs = 10_000, pageSize = 50, maxPages = 20,
} = {}) {
  if (!/^AC[0-9a-fA-F]{32}$/.test(String(accountSid ?? ""))) throw new TypeError("accountSid must be AC followed by 32 hex characters");
  const credMissing = credentialProblems({ apiKeySid, apiKeySecret, authToken });
  if (credMissing.length) throw new TypeError(`missing credentials: ${credMissing.join(", ")} (or authToken)`);
  if (!/^\+[1-9]\d{6,14}$/.test(String(to ?? ""))) throw new TypeError("to must be an E.164 number (+...)");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new TypeError("pageSize must be 1..1000");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError("maxPages must be a positive integer");
  const auth = basicAuthHeader({ accountSid, apiKeySid, apiKeySecret, authToken });
  const path = `/2010-04-01/Accounts/${accountSid}/Messages.json`;

  async function get(rawUrl) {
    const url = assertTwilioMessagesUrl(rawUrl, accountSid); // checked before the credentials are attached
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(url, {
        method: "GET", headers: { Authorization: auth, Accept: "application/json" }, redirect: "error", signal: controller.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new PollError(controller.signal.aborted || e?.name === "AbortError" ? "timeout" : "network_error");
    } finally {
      clearTimeout(timer);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (res.status >= 200 && res.status < 300) {
      if (!json || !Array.isArray(json.messages)) throw new PollError("bad_response", { status: res.status });
      return json;
    }
    if (res.status >= 300 && res.status < 400) throw new PollError("redirect_refused", { status: res.status, transient: false });
    const twilioCode = Number.isInteger(json?.code) ? json.code : null; // Twilio's message text is not echoed
    if (res.status === 429) throw new PollError("rate_limited", { status: 429, twilioCode });
    if (res.status >= 500) throw new PollError("server_error", { status: res.status, twilioCode });
    const authFail = res.status === 401 || res.status === 403;
    throw new PollError(authFail ? "auth_failed" : "rejected", { status: res.status, twilioCode, transient: !authFail });
  }

  /** Only Twilio's own next page of this account's Messages list is followed (never another host or path). */
  function nextUrl(uri) {
    if (typeof uri !== "string" || !uri) return null;
    if (!uri.startsWith(`${path}?`)) throw new PollError("bad_next_page", { transient: false });
    try { return assertTwilioMessagesUrl(`${API_ORIGIN}${uri}`, accountSid); } catch { throw new PollError("bad_next_page", { transient: false }); }
  }

  return {
    name: "twilio_poll",
    /**
     * Every message sent to the hub number since the UTC day of `since` (all pages, up to maxPages).
     * @param {{ since: Date }} opts
     * @returns {Promise<{ messages: object[], truncated: boolean, pages: number }>}
     */
    async list({ since }) {
      const q = new URLSearchParams();
      q.set("To", to);
      q.set("DateSent>", twilioDay(since)); // serialized as DateSent%3E=YYYY-MM-DD, i.e. DateSent>=
      q.set("PageSize", String(pageSize));
      let url = `${API_ORIGIN}${path}?${q.toString()}`;
      const messages = [];
      let pages = 0;
      while (url && pages < maxPages) {
        const json = await get(url);
        pages++;
        messages.push(...json.messages);
        url = nextUrl(json.next_page_uri);
      }
      return { messages, truncated: Boolean(url), pages };
    },
  };
}

/**
 * Dry-run inbound: a local JSONL file, one Twilio-like message per line, e.g.
 *   {"sid":"SM...","from":"+447700900101","to":"+447700900001","body":"Hello ...","date_sent":"2026-10-04T15:00:00Z"}
 * Only `from` and `body` are required. A line without a valid `sid` gets one derived from its line number and
 * content (so give each line a sid if you edit the file above existing lines). Bad lines are counted, not thrown.
 * The file may be appended to while the runner is polling. No network.
 */
export function createFilePoller(filePath) {
  return {
    name: "file_poll",
    async list() {
      if (!existsSync(filePath)) return { messages: [], truncated: false, pages: 0, bad_lines: 0 };
      const messages = [];
      let bad = 0;
      readFileSync(filePath, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!line.trim() || line.trim().startsWith("//")) return;
        let m;
        try { m = JSON.parse(line); } catch { bad++; return; }
        if (!m || typeof m !== "object" || Array.isArray(m)) { bad++; return; }
        const sid = typeof m.sid === "string" && MESSAGE_SID_RE.test(m.sid)
          ? m.sid
          : `SM${createHash("sha256").update(`${i}\u0000${line}`).digest("hex").slice(0, 32)}`;
        messages.push({ direction: "inbound", ...m, sid });
      });
      return { messages, truncated: false, pages: 1, bad_lines: bad };
    },
  };
}

export const SEEN_KV = "twilio.poll.seen";

/**
 * Message SIDs already handled, persisted in the hub store kv as { sid: ISO time }, so a restart neither loses nor
 * replays a message. Bounded: prune(floor) drops SIDs older than the oldest message the runner would still accept.
 */
export function createSeenStore(store, kv = SEEN_KV) {
  return {
    has(sid) { return Object.hasOwn(store.getKV(kv, {}), sid); },
    add(sid, atIso) {
      store.transaction(() => store.setKV(kv, { ...store.getKV(kv, {}), [sid]: atIso }));
    },
    /** Drop SIDs whose time is before `floorMs`. Returns how many were dropped. */
    prune(floorMs) {
      return store.transaction(() => {
        const all = store.getKV(kv, {});
        const keep = Object.fromEntries(Object.entries(all).filter(([, at]) => !(Date.parse(at) < floorMs)));
        const dropped = Object.keys(all).length - Object.keys(keep).length;
        if (dropped) store.setKV(kv, keep);
        return dropped;
      });
    },
    size() { return Object.keys(store.getKV(kv, {})).length; },
  };
}
