import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { URLSearchParams } from "node:url";
import { openStore } from "../src/store.mjs";
import { createOutbox } from "../src/outbox.mjs";
import {
  EMPTY_TWIML, MAX_WEBHOOK_BYTES, NotConfiguredError, callTwiml, computeTwilioSignature, createTwilioTransport,
  createTwilioWebhook, fromEnv, parseForm, parseInboundWebhook, verifyTwilioSignature,
} from "../src/transports/twilio.mjs";

// Synthetic values only: not real credentials, placeholder numbers.
const SID = "AC" + "0".repeat(32);
const TOKEN = "test-token-not-a-secret";
const FROM = "+447700900001";
const NOOR = "+254700000030";
const CLIPS = "https://clips.example.test/sw/";
const KEY = "a".repeat(64);

/** A fake fetch that records requests and answers with the given status/json, or throws/hangs. */
function fakeFetch(reply = { status: 201, json: { sid: "SM" + "1".repeat(32) } }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    if (reply.throws) throw reply.throws;
    if (reply.hang) {
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return { status: reply.status, text: async () => JSON.stringify(reply.json ?? {}) };
  };
  fn.calls = calls;
  return fn;
}
const transport = (fetchImpl, over = {}) => createTwilioTransport({ accountSid: SID, authToken: TOKEN, from: FROM, clipBaseUrl: CLIPS, fetchImpl, ...over });

test("SMS: POST Messages.json, form-encoded To/From/Body, Basic auth, SID as ref, wasSent true afterwards", async () => {
  const f = fakeFetch();
  const t = transport(f, { statusCallbackUrl: "https://hub.example.test/twilio/status" });
  assert.equal(t.wasSent(KEY), null);
  const r = await t.send({ idempotency_key: KEY, channel: "sms", recipient: "0700000030", body: "SAUTI: Habari & karibu" });
  assert.equal(r.ref, "SM" + "1".repeat(32));
  assert.equal(f.calls.length, 1);
  const { url, init, form } = f.calls[0];
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
  assert.ok(init.signal, "a timeout signal is attached");
  assert.deepEqual(form, { To: NOOR, From: FROM, Body: "SAUTI: Habari & karibu", StatusCallback: "https://hub.example.test/twilio/status" });
  assert.equal(t.wasSent(KEY), true);
});

test("call: POST Calls.json with <Play> per clip at clipBaseUrl/<key>.wav, XML-escaped", async () => {
  const f = fakeFetch({ status: 201, json: { sid: "CA" + "2".repeat(32) } });
  const t = transport(f, { clipBaseUrl: "https://clips.example.test/a&b/" });
  const r = await t.send({ idempotency_key: KEY, channel: "call", recipient: NOOR, body: JSON.stringify(["visits.booked", "word.tarehe", "alert.see_sms"]) });
  assert.equal(r.ref, "CA" + "2".repeat(32));
  const { url, form } = f.calls[0];
  assert.match(url, /\/Calls\.json$/);
  assert.equal(form.To, NOOR);
  assert.equal(form.Twiml,
    "<Response><Play>https://clips.example.test/a&amp;b/visits.booked.wav</Play><Play>https://clips.example.test/a&amp;b/word.tarehe.wav</Play>" +
    "<Play>https://clips.example.test/a&amp;b/alert.see_sms.wav</Play></Response>");
  assert.equal(callTwiml(["x"], "https://c.example.test/'q\""), "<Response><Play>https://c.example.test/&apos;q&quot;/x.wav</Play></Response>");
});

test("call: availableClips skips clips that do not exist yet", async () => {
  const f = fakeFetch();
  const t = transport(f, { availableClips: ["visits.booked"] });
  await t.send({ idempotency_key: KEY, channel: "call", recipient: NOOR, body: JSON.stringify(["visits.booked", "alert.see_sms"]) });
  assert.equal(f.calls[0].form.Twiml, "<Response><Play>https://clips.example.test/sw/visits.booked.wav</Play></Response>");
});

test("bad clip keys, recipients and channels are refused before any network call (notAccepted)", async () => {
  const f = fakeFetch();
  const t = transport(f);
  for (const body of [JSON.stringify(["../etc/passwd"]), JSON.stringify(["Visits.Booked"]), JSON.stringify(["a b"]),
    JSON.stringify(["x</Play><Dial>+254700000099</Dial>"]), JSON.stringify([]), "not json", JSON.stringify("visits.booked")]) {
    await assert.rejects(t.send({ idempotency_key: KEY, channel: "call", recipient: NOOR, body }), (e) => e.notAccepted === true, body);
  }
  await assert.rejects(t.send({ idempotency_key: KEY, channel: "sms", recipient: "nobody", body: "x" }), (e) => e.notAccepted === true);
  await assert.rejects(t.send({ idempotency_key: KEY, channel: "fax", recipient: NOOR, body: "x" }), (e) => e.notAccepted === true);
  await assert.rejects(t.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x".repeat(1601) }), (e) => e.notAccepted === true);
  assert.equal(f.calls.length, 0);
});

test("HTTP 400/401/404 -> notAccepted (retry is safe); 429/500/503 -> uncertain; error text never holds token or number", async () => {
  for (const status of [400, 401, 404]) {
    const t = transport(fakeFetch({ status, json: { code: 21211, message: `The 'To' number ${NOOR} is not valid` } }));
    await assert.rejects(t.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }), (e) => {
      assert.equal(e.notAccepted, true);
      assert.equal(e.status, status);
      assert.equal(e.twilioCode, 21211);
      assert.ok(!e.message.includes(TOKEN) && !e.message.includes("700000030"), e.message);
      return true;
    });
    assert.equal(t.wasSent(KEY), null);
  }
  for (const status of [429, 500, 503]) {
    const t = transport(fakeFetch({ status, json: {} }));
    await assert.rejects(t.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }), (e) => e.notAccepted === undefined && e.status === status);
  }
});

test("timeout and network errors -> uncertain (no notAccepted)", async () => {
  const slow = transport(fakeFetch({ hang: true }), { timeoutMs: 20 });
  await assert.rejects(slow.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }), (e) => e.code === "timeout" && e.notAccepted === undefined);
  const down = transport(fakeFetch({ throws: new TypeError("fetch failed") }));
  await assert.rejects(down.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }), (e) => e.code === "network_error" && e.notAccepted === undefined);
});

test("with the outbox: 400 -> FAILED (retried), 500 -> UNCERTAIN (never resent), 201 -> SENT", async () => {
  const store = openStore();
  let status = 400;
  const f = async () => ({ status, text: async () => JSON.stringify({ sid: "SM" + "3".repeat(32) }) });
  const outbox = createOutbox(store, transport(f), { now: () => new Date("2026-10-05T06:00:00Z") });
  const a = outbox.enqueue({ channel: "sms", recipient: NOOR, body: "a", cause_id: "t1" });
  assert.deepEqual((await outbox.dispatch()).map((r) => r.status), ["FAILED"]);
  status = 201;
  assert.deepEqual((await outbox.dispatch()).map((r) => r.status), ["SENT"]);
  assert.equal(outbox.get(a.key).status, "SENT");
  status = 500;
  outbox.enqueue({ channel: "sms", recipient: NOOR, body: "b", cause_id: "t2" });
  assert.deepEqual((await outbox.dispatch()).map((r) => r.status), ["UNCERTAIN"]);
  assert.deepEqual(await outbox.dispatch(), []);
});

test("fromEnv: names the missing variables only; builds the transport when complete", () => {
  assert.throws(() => fromEnv({ TWILIO_AUTH_TOKEN: TOKEN }), (e) => {
    assert.ok(e instanceof NotConfiguredError);
    assert.deepEqual(e.missing, ["TWILIO_ACCOUNT_SID", "TWILIO_NUMBER", "HUB_CLIP_BASE_URL"]);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  const t = fromEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM_NUMBER: FROM, HUB_CLIP_BASE_URL: CLIPS }, { fetchImpl: fakeFetch() });
  assert.equal(t.name, "twilio");
  assert.throws(() => transport(fakeFetch(), { clipBaseUrl: "http://clips.example.test" }), /https/);
  assert.throws(() => transport(fakeFetch(), { accountSid: "AC123" }), /accountSid/);
});

// ---------------------------------------------------------------------------------------------------------
const HOOK_URL = "https://hub.example.test/twilio/sms?lane=owner";
const inbound = () => ({
  AccountSid: SID, MessageSid: "SM" + "4".repeat(32), SmsSid: "SM" + "4".repeat(32), From: NOOR, To: FROM,
  Body: "LEO", NumMedia: "0", SmsStatus: "received",
});

test("signature: matches an HMAC-SHA1 vector computed by hand; tampering or a wrong token is invalid", () => {
  const params = inbound();
  // Hand-built signing string: URL, then each param name+value in sorted name order.
  const signing = HOOK_URL + "AccountSid" + SID + "Body" + "LEO" + "From" + NOOR + "MessageSid" + params.MessageSid +
    "NumMedia" + "0" + "SmsSid" + params.SmsSid + "SmsStatus" + "received" + "To" + FROM;
  const vector = createHmac("sha1", TOKEN).update(signing).digest("base64");
  assert.equal(computeTwilioSignature(TOKEN, HOOK_URL, params), vector);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params, signature: vector }), true);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params: { ...params, Body: "FUNGA 12/10" }, signature: vector }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params: { ...params, From: "+254700000031" }, signature: vector }), false);
  assert.equal(verifyTwilioSignature({ authToken: "other", url: HOOK_URL, params, signature: vector }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: "https://evil.example.test/twilio/sms?lane=owner", params, signature: vector }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params, signature: "" }), false);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params, signature: vector.slice(0, -2) }), false);
  // Twilio may sign with the explicit default port.
  const withPort = computeTwilioSignature(TOKEN, "https://hub.example.test:443/twilio/sms?lane=owner", params);
  assert.equal(verifyTwilioSignature({ authToken: TOKEN, url: HOOK_URL, params, signature: withPort }), true);
  // Repeated keys: values sorted, each appended with its key.
  assert.equal(computeTwilioSignature(TOKEN, "https://x.example.test/", { A: ["2", "1"] }),
    createHmac("sha1", TOKEN).update("https://x.example.test/A1A2").digest("base64"));
  assert.deepEqual(parseForm("A=2&A=1&B=x%20y"), { A: ["2", "1"], B: "x y" });
});

test("parseInboundWebhook: verified SMS -> { from, to, text, provider_id }; bad signature or foreign account throws", () => {
  const params = inbound();
  const signature = computeTwilioSignature(TOKEN, HOOK_URL, params);
  assert.deepEqual(parseInboundWebhook({ params, authToken: TOKEN, url: HOOK_URL, signature, accountSid: SID }),
    { from: NOOR, to: FROM, text: "LEO", provider_id: params.MessageSid });
  assert.throws(() => parseInboundWebhook({ params: { ...params, Body: "x" }, authToken: TOKEN, url: HOOK_URL, signature }), /signature/);
  const foreign = { ...params, AccountSid: "AC" + "f".repeat(32) };
  assert.throws(() => parseInboundWebhook({ params: foreign, authToken: TOKEN, url: HOOK_URL, signature: computeTwilioSignature(TOKEN, HOOK_URL, foreign), accountSid: SID }), /signature/);
  const status = { AccountSid: SID, MessageSid: params.MessageSid, MessageStatus: "delivered" };
  assert.equal(parseInboundWebhook({ params: status, authToken: TOKEN, url: HOOK_URL, signature: computeTwilioSignature(TOKEN, HOOK_URL, status) }), null);
});

async function withServer(handler, fn) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { return await fn(server.address().port); } finally { server.close(); }
}
function post(port, path, body, headers = {}, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: data }));
    });
    req.on("error", (e) => (chunked && e.code === "ECONNRESET" ? undefined : reject(e)));
    if (!chunked) return req.end(body);
    for (let i = 0; i < body.length; i += 8192) req.write(body.slice(i, i + 8192)); // no Content-Length: streamed limit
    req.end();
  });
}

test("webhook: 403 on a bad signature (onSms not called), empty TwiML on a good one, 413 over 64 KB", async () => {
  const got = [];
  const handler = createTwilioWebhook({ authToken: TOKEN, publicUrl: "https://hub.example.test", accountSid: SID, onSms: (sms) => { got.push(sms); } });
  await withServer(handler, async (port) => {
    const params = inbound();
    const body = new URLSearchParams(params).toString();
    const good = computeTwilioSignature(TOKEN, HOOK_URL, params);

    const bad = await post(port, "/twilio/sms?lane=owner", body, { "X-Twilio-Signature": computeTwilioSignature("wrong", HOOK_URL, params) });
    assert.equal(bad.status, 403);
    const none = await post(port, "/twilio/sms?lane=owner", body);
    assert.equal(none.status, 403);
    const tampered = await post(port, "/twilio/sms?lane=owner", body.replace("Body=LEO", "Body=FUNGA"), { "X-Twilio-Signature": good });
    assert.equal(tampered.status, 403);
    assert.equal(got.length, 0);

    const ok = await post(port, "/twilio/sms?lane=owner", body, { "X-Twilio-Signature": good });
    assert.equal(ok.status, 200);
    assert.match(ok.type, /^text\/xml/);
    assert.equal(ok.body, EMPTY_TWIML);
    assert.match(ok.body, /<Response\/>$/);
    assert.deepEqual(got, [{ from: NOOR, to: FROM, text: "LEO", provider_id: params.MessageSid }]);

    const big = await post(port, "/twilio/sms?lane=owner", "Body=" + "x".repeat(MAX_WEBHOOK_BYTES + 10), { "X-Twilio-Signature": good });
    assert.equal(big.status, 413);
    const streamed = await post(port, "/twilio/sms?lane=owner", "Body=" + "x".repeat(MAX_WEBHOOK_BYTES + 10), { "X-Twilio-Signature": good }, { chunked: true });
    assert.equal(streamed.status, 413);
    assert.equal(got.length, 1);
  });
});

test("webhook: onSms failure -> 500 without details; config is checked", async () => {
  const handler = createTwilioWebhook({ authToken: TOKEN, publicUrl: "https://hub.example.test", onSms: () => { throw new Error(`secret ${TOKEN}`); } });
  await withServer(handler, async (port) => {
    const params = inbound();
    const r = await post(port, "/twilio/sms?lane=owner", new URLSearchParams(params).toString(), { "X-Twilio-Signature": computeTwilioSignature(TOKEN, HOOK_URL, params) });
    assert.equal(r.status, 500);
    assert.ok(!r.body.includes(TOKEN));
  });
  assert.throws(() => createTwilioWebhook({ publicUrl: "https://hub.example.test", onSms: () => {} }), NotConfiguredError);
  assert.throws(() => createTwilioWebhook({ authToken: TOKEN, publicUrl: "http://hub.example.test", onSms: () => {} }), /https/);
});

test("smsOnly: no clip URL needed; a call is refused (calls_disabled, permanent) without any request; SMS still sent", async () => {
  const f = fakeFetch();
  assert.throws(() => createTwilioTransport({ accountSid: SID, authToken: TOKEN, from: FROM, fetchImpl: f }), NotConfiguredError);
  const t = createTwilioTransport({ accountSid: SID, authToken: TOKEN, from: FROM, fetchImpl: f, smsOnly: true });
  await assert.rejects(t.send({ idempotency_key: KEY, channel: "call", recipient: NOOR, body: JSON.stringify(["visits.booked"]) }),
    (e) => e.code === "calls_disabled" && e.notAccepted === true && e.permanent === true);
  assert.equal(f.calls.length, 0);
  await t.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" });
  assert.equal(f.calls.length, 1);
  // refusals before any request are permanent; an HTTP 4xx from Twilio is not (the outbox retries it, up to maxAttempts)
  await assert.rejects(t.send({ idempotency_key: KEY, channel: "sms", recipient: "nobody", body: "x" }), (e) => e.permanent === true);
  const r400 = createTwilioTransport({ accountSid: SID, authToken: TOKEN, from: FROM, smsOnly: true, fetchImpl: fakeFetch({ status: 400, json: { code: 21211 } }) });
  await assert.rejects(r400.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }), (e) => e.notAccepted === true && e.permanent === undefined);
});

test("security: POSTs use redirect: \"error\" to api.twilio.com only; a 3xx is UNCERTAIN, never followed", async () => {
  const f = fakeFetch();
  await transport(f).send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" });
  assert.equal(f.calls[0].init.redirect, "error");
  assert.ok(f.calls[0].url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SID}/`));
  let n = 0;
  const r = async () => { n++; return { status: 307, headers: { location: "https://evil.example.test/" }, text: async () => "" }; };
  await assert.rejects(transport(r).send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" }),
    (e) => e.code === "redirect_refused" && e.notAccepted === undefined && e.status === 307);
  assert.equal(n, 1);
});

test("API key (primary): Authorization is Basic base64(KEY_SID:KEY_SECRET) while the URL keeps the ACCOUNT SID", async () => {
  const KEY_SID = "SK" + "5".repeat(32);
  const KEY_SECRET = "fake-key-secret-not-real";
  const f = fakeFetch();
  const t = fromEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY_SID, TWILIO_API_KEY_SECRET: KEY_SECRET, TWILIO_NUMBER: FROM, TWILIO_AUTH_TOKEN: TOKEN },
    { fetchImpl: f, smsOnly: true });
  await t.send({ idempotency_key: KEY, channel: "sms", recipient: NOOR, body: "x" });
  assert.equal(f.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${KEY_SID}:${KEY_SECRET}`).toString("base64")}`);
  assert.equal(f.calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
  // neither a key nor a token: the missing NAMES only; half a key names the missing half
  assert.throws(() => fromEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_NUMBER: FROM }, { smsOnly: true }),
    (e) => e instanceof NotConfiguredError && JSON.stringify(e.missing) === JSON.stringify(["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]));
  assert.throws(() => fromEnv({ TWILIO_ACCOUNT_SID: SID, TWILIO_NUMBER: FROM, TWILIO_API_KEY_SID: KEY_SID, TWILIO_AUTH_TOKEN: TOKEN }, { smsOnly: true }),
    (e) => JSON.stringify(e.missing) === JSON.stringify(["TWILIO_API_KEY_SECRET"]) && !e.message.includes(KEY_SID) && !e.message.includes(TOKEN));
  assert.throws(() => createTwilioTransport({ accountSid: SID, apiKeySid: "AC" + "5".repeat(32), apiKeySecret: KEY_SECRET, from: FROM, smsOnly: true, fetchImpl: f }), /SK/);
});
