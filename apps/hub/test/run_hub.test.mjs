// The real-SMS runner (src/run_hub.mjs + transports/twilio_poll.mjs) against a FAKE Twilio: no network anywhere.
// Synthetic values only: the token is not a credential, numbers are in the UK drama range +44 7700 900xxx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URLSearchParams } from "node:url";
import {
  buildHub, cappedOutbox, ConfigError, createLogger, gitWorkTreeOf, loadConfig, loadEnvFile, main, mask, parseEnvText,
} from "../src/run_hub.mjs";
import { eatDate } from "../src/booking_requests.mjs";
import { createOutbox } from "../src/outbox.mjs";
import { openStore } from "../src/store.mjs";
import { createTwilioPoller, PollError } from "../src/transports/twilio_poll.mjs";

const HUB_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO = gitWorkTreeOf(HUB_DIR);
const RUNNER = join(HUB_DIR, "src", "run_hub.mjs");
const SID = "AC" + "0".repeat(32);
const TOKEN = "fake-token-for-tests-0123456789";
const KEY_SID = "SK" + "7".repeat(32);
const KEY_SECRET = "fake-api-key-secret-for-tests-42";
const HUB = "+447700900001";
const NOOR = "+447700900999";
const TOURIST = "+447700900456";
const TOURIST_B = "+447700900457";
const STRANGER = "+447700900666";
const START = new Date("2026-10-04T15:00:00Z");
const REQ = "Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people. Thanks, Claire";
const API = `https://api.twilio.com/2010-04-01/Accounts/${SID}`;

const tmp = () => mkdtempSync(join(tmpdir(), "sauti-runhub-"));
const rfc2822 = (d) => new Date(d).toUTCString().replace("GMT", "+0000");

/** In-memory Twilio: inbound messages listed by GET Messages.json (paged, newest first), POSTs recorded. */
function fakeTwilio() {
  const inbound = [];
  const posts = [];
  const gets = [];
  const failGets = []; // statuses to answer the next GETs with
  let n = 0;
  const hex = (i) => i.toString(16).padStart(32, "0");
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const reply = (status, json) => ({ status, text: async () => JSON.stringify(json) });
    if (init.method === "GET") {
      gets.push({ url: String(url), auth: init.headers?.Authorization, search: u.search });
      if (failGets.length) return reply(failGets.shift(), { code: 20003, message: `bad things for ${NOOR}` });
      const to = u.searchParams.get("To");
      const day = u.searchParams.get("DateSent>");
      const size = Number(u.searchParams.get("PageSize"));
      const page = Number(u.searchParams.get("Page") ?? 0);
      const all = inbound.filter((m) => m.to === to && new Date(m.date_sent).toISOString().slice(0, 10) >= day)
        .sort((a, b) => Date.parse(b.date_sent) - Date.parse(a.date_sent));
      const slice = all.slice(page * size, page * size + size);
      const more = (page + 1) * size < all.length;
      const q = new URLSearchParams(u.searchParams);
      q.set("Page", String(page + 1));
      q.set("PageToken", `PA${page + 1}`);
      return reply(200, { messages: slice, next_page_uri: more ? `${u.pathname}?${q}` : null, page });
    }
    const form = Object.fromEntries(new URLSearchParams(init.body));
    posts.push({ url: String(url), form });
    return reply(201, { sid: (u.pathname.endsWith("Calls.json") ? "CA" : "SM") + hex(++n + 0xf000) });
  };
  let m = 0;
  const text = (from, body, at = START, extra = {}) => {
    const msg = { sid: "SM" + hex(++m), from, to: HUB, body, direction: "inbound", date_sent: rfc2822(at), status: "received", ...extra };
    inbound.push(msg);
    return msg;
  };
  const smsTo = (num) => posts.filter((p) => p.url.endsWith("/Messages.json") && p.form.To === num).map((p) => p.form.Body);
  return { fetch, inbound, posts, gets, failGets, text, smsTo };
}

function liveEnv(dbPath, over = {}) {
  return {
    TWILIO_ACCOUNT_SID: SID, TWILIO_API_KEY_SID: KEY_SID, TWILIO_API_KEY_SECRET: KEY_SECRET, TWILIO_NUMBER: HUB, OWNER_PHONE: NOOR,
    HUB_DB_PATH: dbPath, ...over,
  };
}

/** A live-mode hub on a fake Twilio, a settable clock and captured logs. */
async function liveHub({ dir = tmp(), env = {}, twilio = fakeTwilio(), clock = { t: new Date(START) }, argv = ["--live"] } = {}) {
  const logs = [];
  const config = loadConfig({ argv, env: liveEnv(join(dir, "hub.db"), env), repoRoot: REPO });
  const built = await buildHub(config, { fetchImpl: twilio.fetch, now: () => clock.t, write: (l) => logs.push(l), tagger: false });
  await built.runner.start();
  return { ...built, dir, twilio, clock, logs, config };
}

const lastCode = (bodies) => {
  const m = /NDIYO ([A-Z]+) (\d+)/.exec(bodies.filter((b) => /NDIYO [A-Z]+ \d+/.test(b)).at(-1) ?? "");
  return m ? { id: m[1], code: m[2] } : null;
};

// ------------------------------------------------------------------------------------------------ env + config
test("env file: KEY=VALUE parsing (comments, export, quotes); refused inside a git working tree", () => {
  const { vars, badLines } = parseEnvText("# private\nexport A=1\nB = \"two words\"\nC='x#y'\nD=plain # comment\n\nnot a line\n");
  assert.deepEqual(vars, { A: "1", B: "two words", C: "x#y", D: "plain" });
  assert.deepEqual(badLines, [7]);

  const inside = join(HUB_DIR, "var", "test-envfile");
  mkdirSync(inside, { recursive: true });
  const f = join(inside, "hub.env");
  writeFileSync(f, `TWILIO_AUTH_TOKEN=${TOKEN}\n`);
  try {
    assert.throws(() => loadEnvFile(f), (e) => e instanceof ConfigError && /git working tree/.test(e.message) && !e.message.includes(TOKEN));
    assert.throws(() => loadConfig({ argv: ["--live"], env: { HUB_ENV_FILE: f }, repoRoot: REPO }), ConfigError);
  } finally { rmSync(inside, { recursive: true, force: true }); }

  const out = join(tmp(), "hub.env");
  writeFileSync(out, Object.entries(liveEnv(join(tmp(), "hub.db"))).map(([k, v]) => `${k}=${v}`).join("\n"));
  const c = loadConfig({ argv: ["--live"], env: { HUB_ENV_FILE: out, HUB_POLL_SECONDS: "3" }, repoRoot: REPO });
  assert.equal(c.mode, "live");
  assert.equal(c.apiKeySid, KEY_SID);
  assert.equal(c.apiKeySecret, KEY_SECRET);
  assert.equal(c.pollMs, 3000);
  assert.equal(c.maxOutboundPerDay, 100);
  assert.equal(c.clipBaseUrl, null);
});

test("config: missing variables named without values; DB inside the repo refused unless under apps/hub/var", () => {
  assert.throws(() => loadConfig({ argv: ["--live"], env: { TWILIO_AUTH_TOKEN: TOKEN }, repoRoot: REPO }), (e) => {
    assert.match(e.message, /missing TWILIO_ACCOUNT_SID, TWILIO_NUMBER, OWNER_PHONE, HUB_DB_PATH$/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  assert.throws(() => loadConfig({ argv: ["--live"], env: liveEnv(join(REPO, "hub.db")), repoRoot: REPO }), /HUB_DB_PATH/);
  assert.equal(loadConfig({ argv: ["--live"], env: liveEnv(join(REPO, "apps", "hub", "var", "x", "hub.db")), repoRoot: REPO }).mode, "live");
  assert.throws(() => loadConfig({ argv: ["--live", "--dry-run"], env: liveEnv(join(tmp(), "h.db")), repoRoot: REPO }), /conflicts/);
  assert.throws(() => loadConfig({ argv: ["--live"], env: liveEnv(join(tmp(), "h.db"), { OWNER_PHONE: "0700" }), repoRoot: REPO }), /E\.164/);
  // dry-run needs no Twilio variable, and HUB_DRY_RUN=1 selects it.
  assert.equal(loadConfig({ env: { HUB_DRY_RUN: "1", HUB_OWNER_PHONE: NOOR, HUB_DB_PATH: join(tmp(), "h.db") }, repoRoot: REPO }).mode, "dry-run");
});

// ------------------------------------------------------------------------------------------------ poller
test("poller: GET Messages.json with To, DateSent>=, PageSize and Basic auth; follows next_page_uri", async () => {
  const tw = fakeTwilio();
  for (let i = 0; i < 120; i++) tw.text(TOURIST, `m${i}`, new Date(START.getTime() + i * 1000));
  const p = createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: tw.fetch });
  const r = await p.list({ since: new Date("2026-10-04T08:00:00Z") });
  assert.equal(r.messages.length, 120);
  assert.equal(r.pages, 3);
  assert.equal(r.truncated, false);
  assert.equal(new Set(r.messages.map((m) => m.sid)).size, 120);
  const first = tw.gets[0];
  assert.ok(first.url.startsWith(`${API}/Messages.json?`));
  assert.match(first.search, /To=%2B447700900001/);
  assert.match(first.search, /DateSent%3E=2026-10-04/);
  assert.match(first.search, /PageSize=50/);
  assert.equal(first.auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
  assert.match(tw.gets[2].search, /Page=2/);

  const capped = createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: tw.fetch, maxPages: 2 });
  assert.equal((await capped.list({ since: START })).truncated, true);

  // a next page on another host or account is never followed (the credentials would go with it)
  const evil = async () => ({ status: 200, text: async () => JSON.stringify({ messages: [], next_page_uri: "https://evil.example.test/x" }) });
  await assert.rejects(createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: evil }).list({ since: START }), (e) => e.code === "bad_next_page");
});

test("poller errors: 429/5xx/timeout transient, 401 auth; messages carry no token, number or Twilio text", async () => {
  for (const [status, code, transient, auth] of [[429, "rate_limited", true, false], [503, "server_error", true, false], [401, "auth_failed", false, true], [404, "rejected", true, false]]) {
    const tw = fakeTwilio();
    tw.failGets.push(status);
    const p = createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: tw.fetch });
    await assert.rejects(p.list({ since: START }), (e) => {
      assert.ok(e instanceof PollError);
      assert.equal(e.code, code);
      assert.equal(e.auth, auth);
      if (status !== 404) assert.equal(e.transient, transient);
      for (const s of [TOKEN, NOOR, HUB, "bad things"]) assert.ok(!e.message.includes(s));
      return true;
    });
  }
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))));
  await assert.rejects(createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: hang, timeoutMs: 20 }).list({ since: START }), (e) => e.code === "timeout" && e.transient);
});

// ------------------------------------------------------------------------------------------------ runner
test("routing: Noor's enrolled number -> owner path; a tourist -> visitor event 'twilio:<sid>'; a stranger gets nothing", async () => {
  const h = await liveHub();
  h.twilio.text(NOOR, "LEO");
  const t = h.twilio.text(TOURIST, REQ);
  h.twilio.text(STRANGER, "NDIYO A 123456");
  const r = await h.runner.cycle();
  assert.equal(r.error, null);
  assert.deepEqual(r.poll.handled.map((x) => x.route), ["owner", "visitor", "visitor"]); // one line: a stranger is a visitor
  assert.ok(h.store.db.prepare("SELECT 1 FROM events WHERE id = ?").get(`twilio:${t.sid}`), "visitor event stored under twilio:<sid>");
  const ev = JSON.parse(h.store.db.prepare("SELECT body FROM events WHERE id = ?").get(`twilio:${t.sid}`).body);
  assert.equal(ev.synthetic, false);
  assert.equal(ev.channel, "sms");
  assert.ok(h.twilio.smsTo(NOOR).length >= 2, "Noor got her LEO answer and the read-back");
  assert.ok(lastCode(h.twilio.smsTo(NOOR)));
  assert.equal(h.twilio.smsTo(TOURIST).length, 1, "the tourist got the fixed acknowledgement");
  assert.equal(h.twilio.smsTo(STRANGER).length, 0, "F1: no reply to an unknown sender pretending to be Noor");
  // every outbound SMS went through the REST adapter: From = hub number, Basic auth endpoint
  assert.ok(h.twilio.posts.every((p) => p.url === `${API}/Messages.json` && p.form.From === HUB));
  h.close();
});

test("dedupe by SID across restarts (file store): nothing replayed, nothing lost, old backlog not processed", async () => {
  const dir = tmp();
  const tw = fakeTwilio();
  const clock = { t: new Date(START) };
  tw.text(TOURIST_B, "Can we come on Saturday 17 October? 2 people", new Date(START.getTime() - 3 * 3600_000)); // before the first start
  tw.text(TOURIST, REQ, new Date(START.getTime() - 60_000));
  let h = await liveHub({ dir, twilio: tw, clock });
  await h.runner.cycle();
  const postsAfterFirst = tw.posts.length;
  assert.equal(tw.smsTo(TOURIST).length, 1);
  assert.equal(tw.smsTo(TOURIST_B).length, 0, "a message older than the first-start backlog is not processed");
  h.close();

  clock.t = new Date(START.getTime() + 10 * 60_000);
  h = await liveHub({ dir, twilio: tw, clock });
  await h.runner.cycle();
  assert.equal(tw.posts.length, postsAfterFirst, "restart: the same messages are not processed again");
  tw.text(TOURIST_B, "Can we come on Saturday 17 October? 2 people", new Date(clock.t.getTime() - 1000));
  await h.runner.cycle();
  assert.equal(tw.smsTo(TOURIST_B).length, 1, "a new message after the restart is processed");
  await h.runner.cycle();
  assert.equal(tw.smsTo(TOURIST_B).length, 1);
  assert.equal(h.runner.seen.size(), 2, "SIDs older than the floor are pruned (bounded set)");
  h.close();
});

test("calls to Noor without HUB_CLIP_BASE_URL: skipped (REFUSED once), never retried, SMS still sent", async () => {
  const h = await liveHub();
  h.twilio.text(TOURIST, "Hi, how do we get to the farm from Machakos town? Is lunch included?"); // a question -> owner alert (SMS + call)
  await h.runner.cycle();
  await h.runner.cycle();
  await h.runner.cycle();
  assert.equal(h.twilio.posts.filter((p) => p.url.endsWith("/Calls.json")).length, 0);
  assert.ok(h.twilio.smsTo(NOOR).length >= 1, "the alert SMS reached Noor");
  const statuses = h.store.db.prepare("SELECT channel, status FROM outbox").all();
  assert.ok(statuses.some((s) => s.channel === "call" && s.status === "REFUSED"));
  assert.equal(h.outbox.pending(), 0, "nothing left to retry forever");
  assert.equal(h.logs.filter((l) => /calls to Noor skipped/.test(l)).length, 1);
  h.close();

  // with a clip URL a call goes out as TwiML <Play> clips ...
  const c = await liveHub({ env: { HUB_CLIP_BASE_URL: "https://clips.example.test/sw" } });
  c.outbox.enqueue({ channel: "call", recipient: NOOR, body: JSON.stringify(["visits.booked", "alert.see_sms"]), cause_id: "t-call" });
  await c.runner.cycle();
  const call = c.twilio.posts.find((p) => p.url.endsWith("/Calls.json"));
  assert.ok(call && /<Play>https:\/\/clips\.example\.test\/sw\/visits\.booked\.wav<\/Play>/.test(call.form.Twiml) && call.form.To === NOOR);
  // ... but a call whose clips are all still unrecorded (notify.MISSING_CLIPS) is refused once, not retried forever
  c.twilio.text(TOURIST, "Hi, how do we get to the farm from Machakos town? Is lunch included?");
  await c.runner.cycle();
  await c.runner.cycle();
  assert.equal(c.twilio.posts.filter((p) => p.url.endsWith("/Calls.json")).length, 1);
  assert.equal(c.outbox.pending(), 0);
  assert.ok(c.logs.some((l) => /out call \w+ REFUSED \(invalid_call\)/.test(l)));
  c.close();
});

test("cost cap: beyond HUB_MAX_OUTBOUND_PER_DAY nothing is sent, items stay QUEUED (warned), sent the next day", async () => {
  const h = await liveHub({ env: { HUB_MAX_OUTBOUND_PER_DAY: "1" } });
  h.twilio.text(TOURIST, REQ);
  await h.runner.cycle();
  assert.equal(h.twilio.posts.length, 1);
  assert.ok(h.outbox.pending() >= 1, "the rest is still queued, not dropped");
  await h.runner.cycle();
  assert.equal(h.twilio.posts.length, 1);
  assert.equal(h.logs.filter((l) => /cost cap reached/.test(l)).length, 1, "warned once per day");
  h.clock.t = new Date(START.getTime() + 24 * 3600_000);
  await h.runner.cycle();
  assert.equal(h.twilio.posts.length, 2);
  h.close();
});

test("transient poll errors never crash the loop (backoff); refused credentials stop it with exit 3", async () => {
  const h = await liveHub();
  h.twilio.failGets.push(500, 429);
  const delays = [];
  let rounds = 0;
  const sleep = async (ms) => { delays.push(ms); if (++rounds === 3) h.runner.stop(); };
  assert.equal(await h.runner.run({ sleep }), 0);
  assert.equal(delays.length, 3);
  assert.ok(delays[0] > 4000 && delays[1] > delays[0] * 1.1, `backoff grows: ${delays}`);
  assert.equal(delays[2], 4000, "back to the normal interval after a good poll");
  assert.equal(h.logs.filter((l) => /poll failed/.test(l)).length, 2);
  h.twilio.failGets.push(401);
  assert.equal(await h.runner.run({ sleep }), 3);
  h.close();
});

test("logs: no token, no full phone number, no body at info; --verbose shows bodies with numbers and codes masked", async () => {
  const quiet = await liveHub();
  quiet.twilio.text(TOURIST, `${REQ} Call me on ${TOURIST_B}`);
  await quiet.runner.cycle();
  const p = lastCode(quiet.twilio.smsTo(NOOR));
  quiet.twilio.text(NOOR, `NDIYO ${p.id} ${p.code}`, new Date(START.getTime() + 1000));
  await quiet.runner.cycle();
  const all = quiet.logs.join("\n");
  for (const s of [TOKEN, SID, KEY_SID, KEY_SECRET, NOOR, TOURIST, TOURIST_B, HUB, NOOR.slice(1), TOURIST.slice(1), "Claire", p.code]) assert.ok(!all.includes(s), `leaked ${s}`);
  assert.match(all, /from \*\*\*56 visitor: request_proposed/);
  assert.match(all, /from \*\*\*99 owner: approve/);
  quiet.close();

  const loud = await liveHub({ argv: ["--live", "--verbose"] });
  loud.twilio.text(TOURIST, `${REQ} Call me on ${TOURIST_B}`);
  await loud.runner.cycle();
  const q = lastCode(loud.twilio.smsTo(NOOR));
  loud.twilio.text(NOOR, `NDIYO ${q.id} ${q.code}`, new Date(START.getTime() + 1000));
  await loud.runner.cycle();
  const v = loud.logs.join("\n");
  assert.match(v, /Claire/, "verbose shows the body");
  for (const s of [TOKEN, KEY_SID, KEY_SECRET, NOOR, TOURIST, TOURIST_B, q.code]) assert.ok(!v.includes(s), `verbose leaked ${s}`);
  assert.equal(mask("+447700900123"), "***23");
  const lg = []; createLogger({ write: (l) => lg.push(l), secrets: [TOKEN] }).info(`x ${TOKEN} 447700900322 +447700900321`);
  assert.ok(!lg[0].includes(TOKEN) && !lg[0].includes("447700900322") && !lg[0].includes("+447700900321"));
  loud.close();
});

// ------------------------------------------------------------------------------------------------ the booking story
test("Nat's main booking scenario through polling + REST: request -> read-back with code -> NDIYO -> confirmation", async () => {
  const h = await liveHub();
  h.twilio.text(TOURIST, REQ);
  await h.runner.cycle();
  const readback = h.twilio.smsTo(NOOR).at(-1);
  const p = lastCode(h.twilio.smsTo(NOOR));
  assert.ok(p, "Noor's read-back carries an id and a one-time code");
  assert.match(readback, /8[ ,.]?000/, "total computed by code (4 x 2000)");
  assert.ok(!readback.includes(TOURIST.slice(-7)), "the tourist's number is never sent to Noor");
  assert.equal(h.twilio.smsTo(TOURIST).length, 1);
  assert.ok(!/Confirmed!/.test(h.twilio.smsTo(TOURIST)[0]), "an acknowledgement, not a confirmation");
  assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM bookings").get().n, 0);
  // the code in the stored outbox row was blanked once sent
  assert.ok(!h.store.db.prepare("SELECT body FROM outbox").all().some((r) => r.body.includes(p.code)));

  h.clock.t = new Date(START.getTime() + 5 * 60_000);
  h.twilio.text(NOOR, `NDIYO ${p.id} ${p.code}`, h.clock.t);
  await h.runner.cycle();
  const b = h.store.db.prepare("SELECT date, party_size FROM bookings").all();
  assert.deepEqual(b.map((x) => ({ ...x })), [{ date: "2026-10-17", party_size: 4 }]);
  const conf = h.twilio.smsTo(TOURIST).at(-1);
  assert.match(conf, /Confirmed!/);
  assert.match(conf, /8[ ,.]?000/);

  const before = h.twilio.posts.length;
  await h.runner.cycle();
  await h.runner.cycle();
  assert.equal(h.twilio.posts.length, before, "polling the same messages again sends nothing more");
  h.close();
});

test("dry-run end to end: JSONL inbound, JSONL outbound, no network at all", async () => {
  const dir = tmp();
  const inbound = join(dir, "inbound.jsonl");
  const clock = { t: new Date(START) };
  writeFileSync(inbound, JSON.stringify({ from: TOURIST, to: HUB, body: REQ, date_sent: START.toISOString() }) + "\nnot json\n");
  const env = { HUB_DRY_RUN: "1", HUB_OWNER_PHONE: NOOR, HUB_DB_PATH: join(dir, "hub.db"), HUB_DRY_RUN_INBOUND: inbound, TWILIO_FROM_NUMBER: HUB };
  const logs = [];
  let network = 0;
  const deps = {
    fetchImpl: () => { network++; throw new Error("no network in dry-run"); }, now: () => clock.t,
    write: (l) => logs.push(l), tagger: false, noSignals: true, repoRoot: REPO,
  };
  assert.equal(await main(["--once"], env, deps), 0);
  const out = () => readFileSync(join(dir, "dry-run-outbound.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const p = lastCode(out().filter((m) => m.recipient === NOOR).map((m) => m.body));
  assert.ok(p);
  assert.equal(out().filter((m) => m.recipient === TOURIST).length, 1);

  appendFileSync(inbound, JSON.stringify({ sid: "SM" + "e".repeat(32), from: NOOR, to: HUB, body: `NDIYO ${p.id} ${p.code}`, date_sent: START.toISOString() }) + "\n");
  assert.equal(await main(["--once"], env, deps), 0);
  assert.equal(await main(["--once"], env, deps), 0, "a third run replays nothing");
  assert.equal(out().filter((m) => m.recipient === TOURIST && /Confirmed!/.test(m.body)).length, 1);
  assert.equal(network, 0);
  const all = logs.join("\n");
  for (const s of [NOOR, TOURIST, HUB, p.code]) assert.ok(!all.includes(s), `leaked ${s}`);
  assert.match(all, /mode dry-run/);
});

test("CLI: --dry-run --once with a private env file outside the repo; refused inside; exit codes", () => {
  const dir = tmp();
  const envFile = join(dir, "hub.env");
  writeFileSync(envFile, [`HUB_OWNER_PHONE=${NOOR}`, `HUB_DB_PATH=${join(dir, "hub.db")}`, `TWILIO_FROM_NUMBER=${HUB}`, `TWILIO_AUTH_TOKEN=${TOKEN}`].join("\n"));
  // real clock in a child process: a message without a date, so the outcome does not depend on today's date
  writeFileSync(join(dir, "dry-run-inbound.jsonl"), JSON.stringify({ from: TOURIST, to: HUB, body: "Hello, can we visit the farm? We are 4 people." }) + "\n");
  const run = (args) => {
    const r = spawnSync(process.execPath, [RUNNER, ...args], { env: { ...process.env, HUB_ENV_FILE: envFile }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, err: `${r.stdout}${r.stderr}` };
  };
  const ok = run(["--dry-run", "--once"]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.err, /mode dry-run/);
  const sent = readFileSync(join(dir, "dry-run-outbound.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(sent.length >= 1 && sent.every((m) => m.simulated === true));
  for (const s of [NOOR, TOURIST, HUB, TOKEN]) assert.ok(!ok.err.includes(s), `leaked ${s}`);
  const bad = run(["--live", "--once"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /missing TWILIO_ACCOUNT_SID/);
  assert.ok(!bad.err.includes(TOKEN));
});

// ------------------------------------------------------------------------------------------------ security (codex review)
test("security: credentials only to https://api.twilio.com/.../Accounts/<our sid>/Messages.json; redirects never followed", async () => {
  const OTHER = "AC" + "1".repeat(32);
  const bad = [
    "https://evil.example.test/2010-04-01/Accounts/" + SID + "/Messages.json?Page=1",
    `/2010-04-01/Accounts/${OTHER}/Messages.json?Page=1`,
    `/2010-04-01/Accounts/${SID}/Messages.json/../../${OTHER}/Messages.json?Page=1`,
    `/2010-04-01/Accounts/${SID}/Messages.json%2F..%2F..?Page=1`,
    `//evil.example.test/2010-04-01/Accounts/${SID}/Messages.json?Page=1`,
    `/2010-04-01/Accounts/${SID}/Calls.json?Page=1`,
    `http://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?Page=1`,
  ];
  for (const next of bad) {
    const seen = [];
    const f = async (url, init) => {
      seen.push({ url: String(url), auth: init.headers?.Authorization, redirect: init.redirect });
      return { status: 200, text: async () => JSON.stringify({ messages: [], next_page_uri: next }) };
    };
    await assert.rejects(createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: f }).list({ since: START }),
      (e) => e instanceof PollError && e.code === "bad_next_page", next);
    assert.equal(seen.length, 1, `no second request (no credentials sent) for ${next}`);
    assert.ok(seen[0].url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json?`));
    assert.equal(seen[0].redirect, "error");
  }
  // a 3xx answer is an error, its Location is never requested
  let n = 0;
  const redirecting = async () => { n++; return { status: 302, headers: { location: "https://evil.example.test/" }, text: async () => "" }; };
  await assert.rejects(createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: redirecting }).list({ since: START }),
    (e) => e.code === "redirect_refused" && e.status === 302);
  assert.equal(n, 1);
  // a fetch that enforces redirect: "error" throws: a network error, retried with backoff, never followed
  const enforcing = async (_u, init) => { assert.equal(init.redirect, "error"); throw new TypeError("fetch failed: redirect"); };
  await assert.rejects(createTwilioPoller({ accountSid: SID, authToken: TOKEN, to: HUB, fetchImpl: enforcing }).list({ since: START }), (e) => e.code === "network_error");
  // every request of a whole live cycle (polling GET and REST POST) carried redirect: "error"
  const tw = fakeTwilio();
  const inits = [];
  const h = await liveHub({ twilio: { ...tw, fetch: (u, i) => { inits.push(i); return tw.fetch(u, i); } } });
  tw.text(TOURIST, REQ);
  await h.runner.cycle();
  assert.ok(inits.length >= 3 && inits.every((i) => i.redirect === "error"));
  h.close();
});

// ------------------------------------------------------------------------------------------------ codex review of PR #63
test("cost cap survives a crash: the unit is reserved durably BEFORE the send (cap 1, crash, reopen -> 1 send)", async () => {
  const path = join(tmp(), "hub.db");
  const sent = [];
  const transport = { send: (it) => { sent.push(it.idempotency_key); return { ref: "x" }; }, wasSent: (k) => sent.includes(k) };
  const log = createLogger({ write: () => {} });
  const now = () => START;
  const item = (c) => ({ channel: "sms", recipient: TOURIST, body: `msg ${c}`, cause_id: c });
  let s = openStore(path);
  const setKV = s.setKV;
  s.setKV = (k, v) => { if (k === "runner.outbound_per_day") throw new Error("simulated crash"); return setKV(k, v); };
  let raw = createOutbox(s, transport, { now });
  raw.enqueue(item("a"));
  raw.enqueue(item("b"));
  await cappedOutbox(raw, s, { maxPerDay: 1, now, log }).dispatch().catch(() => { /* the process "dies" here */ });
  s.close();
  s = openStore(path);
  raw = createOutbox(s, transport, { now });
  await raw.recover();
  const ob = cappedOutbox(raw, s, { maxPerDay: 1, now, log });
  await ob.dispatch();
  await ob.dispatch();
  assert.equal(sent.length, 1, "never more than the cap on the same day, even across a crash and a reopen");
  assert.equal(raw.pending(), 1, "the other item stays QUEUED");
  s.close();
});

test("cost cap: a provably refused send gives its unit back; an UNCERTAIN send keeps it", async () => {
  const s = openStore();
  let mode = "refuse";
  const sent = [];
  const transport = {
    send: (it) => {
      if (mode === "refuse") throw Object.assign(new Error("r"), { code: "rejected", notAccepted: true });
      if (mode === "timeout") throw Object.assign(new Error("t"), { code: "timeout" });
      sent.push(it.body);
      return { ref: "x" };
    },
    wasSent: () => null,
  };
  const now = () => START;
  const raw = createOutbox(s, transport, { now });
  const ob = cappedOutbox(raw, s, { maxPerDay: 1, now, log: createLogger({ write: () => {} }) });
  raw.enqueue({ channel: "sms", recipient: TOURIST, body: "a", cause_id: "a" });
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), ["FAILED"]);
  mode = "timeout";
  assert.deepEqual((await ob.dispatch()).map((r) => r.status), ["UNCERTAIN"], "the refused attempt did not use the day's unit");
  mode = "ok";
  raw.enqueue({ channel: "sms", recipient: TOURIST, body: "b", cause_id: "b" });
  assert.deepEqual(await ob.dispatch(), [], "the uncertain send keeps its unit: cap reached");
  assert.deepEqual(sent, []);
});

test("an unknown argument is never echoed (name or value): --auth-token=<marker>", async () => {
  const MARKER = "MARKER-SECRET-0042";
  for (const argv of [[`--auth-token=${MARKER}`], ["--live", MARKER], [`/tmp/${MARKER}`]]) {
    const out = [];
    assert.equal(await main(argv, {}, { write: (l) => out.push(l), noSignals: true, repoRoot: REPO }), 2);
    assert.ok(out.length > 0 && !out.join("\n").includes("MARKER"), out.join("\n"));
  }
});

test("--verbose bodies: secrets redacted BEFORE shortening; formatted phone numbers masked; dates kept", () => {
  const lines = [];
  const L = createLogger({ write: (l) => lines.push(l), verbose: true, secrets: [TOKEN] });
  L.body("in", `${"x".repeat(190)} ${TOKEN}`);
  assert.ok(!lines.at(-1).includes(TOKEN.slice(0, 6)), `token prefix leaked: ${lines.at(-1)}`);
  const forms = ["+44 7700 900123", "+44-7700-900-123", "(+44) 7700 900123", "+44 (0) 7700 900 123", "07700 900123",
    "(07700) 900-123", "+44.7700.900.123", "0712 345 678", "+254 712-345-678"];
  for (const f of forms) {
    L.body("in", `call me on ${f} please`);
    L.info(`note ${f}`);
    for (const l of lines.slice(-2)) {
      assert.ok(!l.includes(f), `${f} visible: ${l}`);
      assert.ok(!/7700|900[ -.]?1|345[ -]?678/.test(l.replace(/^\S+ /, "")), `${f} digits visible: ${l}`);
    }
  }
  L.body("in", "Saturday 2026-10-17 at 09:00, we are 4 people, KES 8000");
  assert.match(lines.at(-1), /2026-10-17 at 09:00, we are 4 people, KES 8000/);
  assert.match(lines.at(-1), /^\d{4}-\d{2}-\d{2}T/, "the timestamp prefix is untouched");
});

// ------------------------------------------------------------------------------------------------ codex follow-ups on #63
// The farm day is EAT (UTC+3): 2026-10-04T20:59:59Z is 23:59:59 on day A (2026-10-04); 21:00:01Z is day B (2026-10-05).
const DAY_A_END = new Date("2026-10-04T20:59:59Z");
const DAY_B = new Date("2026-10-05T00:00:01+03:00");

/** A transport that records the farm day of each provider handoff; `hooks.onSend(item, n)` may delay, fail or move the clock. */
function dayCountingTransport(clock, hooks = {}) {
  const handoffs = [];
  return {
    handoffs,
    perDay: () => handoffs.reduce((acc, h) => ({ ...acc, [h.day]: (acc[h.day] ?? 0) + 1 }), {}),
    async send(item) {
      handoffs.push({ day: eatDate(clock.t), body: item.body });
      if (hooks.onSend) await hooks.onSend(item, handoffs.length);
      return { ref: `ref-${handoffs.length}` };
    },
    wasSent: () => null,
  };
}

test("cost cap counted per item's farm day: a send crossing midnight cannot let a day exceed the cap (codex #47763)", async () => {
  const s = openStore();
  const clock = { t: new Date(DAY_A_END) };
  const tr = dayCountingTransport(clock, {
    // the first handoff starts at 23:59:59 EAT; the clock passes midnight while the provider answers
    onSend: async (_item, n) => { if (n === 1) { await Promise.resolve(); clock.t = new Date(DAY_B); } },
  });
  const now = () => clock.t;
  const raw = createOutbox(s, tr, { now });
  for (const c of ["a", "b", "c", "d"]) raw.enqueue({ channel: "sms", recipient: TOURIST, body: `msg ${c}`, cause_id: c });
  const ob = cappedOutbox(raw, s, { maxPerDay: 2, now, log: createLogger({ write: () => {} }) });
  await ob.dispatch();
  await ob.dispatch();
  await ob.dispatch();
  assert.deepEqual(tr.perDay(), { "2026-10-04": 1, "2026-10-05": 2 }, "at most 2 handoffs per farm day");
  assert.equal(raw.pending(), 1, "the rest stays QUEUED, not dropped");
  assert.equal(raw.list("QUEUED").length, 1);
  clock.t = new Date(DAY_B.getTime() + 24 * 3600_000);
  await ob.dispatch();
  assert.equal(tr.perDay()["2026-10-06"], 1, "it goes out the next farm day");
  s.close();
});

test("cost cap: a delayed failure releases the unit of the farm day it was RESERVED on, never another day's", async () => {
  const notAccepted = () => Object.assign(new Error("r"), { code: "rejected", notAccepted: true });
  const log = createLogger({ write: () => {} });

  // (1) one dispatch: reserved at 23:59:59 on day A, refused after midnight; the next items are day B's budget.
  {
    const s = openStore();
    const clock = { t: new Date(DAY_A_END) };
    const tr = dayCountingTransport(clock, {
      onSend: async (_item, n) => { if (n === 1) { await Promise.resolve(); clock.t = new Date(DAY_B); throw notAccepted(); } },
    });
    const now = () => clock.t;
    const raw = createOutbox(s, tr, { now });
    for (const c of ["x1", "x2", "x3", "x4"]) raw.enqueue({ channel: "sms", recipient: TOURIST, body: `msg ${c}`, cause_id: c });
    const ob = cappedOutbox(raw, s, { maxPerDay: 2, now, log });
    assert.deepEqual((await ob.dispatch()).map((r) => r.status), ["FAILED", "SENT", "SENT"]);
    await ob.dispatch();
    await ob.dispatch();
    const dayB = tr.handoffs.filter((h) => h.day === "2026-10-05").length;
    assert.equal(dayB, 2, "day B: exactly its cap, the day-A unit released by the failure was not erased into day B's count");
    assert.equal(raw.pending(), 2, "the refused item (FAILED) and the last one wait for the next day");
    s.close();
  }

  // (2) two dispatches overlap: X reserved on day A hangs; Y is sent on day B; then X is refused. Day B keeps Y's unit.
  {
    const s = openStore();
    const clock = { t: new Date(DAY_A_END) };
    let refuseX;
    const tr = dayCountingTransport(clock, {
      onSend: (item) => (item.body === "msg X" && !refuseX ? new Promise((_, reject) => { refuseX = () => reject(notAccepted()); }) : undefined),
    });
    const now = () => clock.t;
    const raw = createOutbox(s, tr, { now });
    const ob = cappedOutbox(raw, s, { maxPerDay: 2, now, log });
    raw.enqueue({ channel: "sms", recipient: TOURIST, body: "msg X", cause_id: "X" });
    const first = ob.dispatch(); // X claimed and reserved on day A, the provider has not answered yet
    await Promise.resolve();
    clock.t = new Date(DAY_B);
    raw.enqueue({ channel: "sms", recipient: TOURIST, body: "msg Y", cause_id: "Y" });
    assert.deepEqual((await ob.dispatch()).map((r) => r.status), ["SENT"], "Y uses one of day B's units");
    refuseX(); // the failure is processed on day B
    assert.deepEqual((await first).map((r) => r.status), ["FAILED"]);
    for (const c of ["Z1", "Z2"]) raw.enqueue({ channel: "sms", recipient: TOURIST, body: `msg ${c}`, cause_id: c });
    await ob.dispatch();
    await ob.dispatch();
    const dayB = tr.handoffs.filter((h) => h.day === "2026-10-05").map((h) => h.body);
    assert.deepEqual(dayB, ["msg Y", "msg X"], "the release went to day A: day B had 1 unit left, not 2");
    assert.equal(raw.pending(), 2);
    s.close();
  }
});

test("--verbose bodies: a secret straddling the 200 or the 2000 character boundary never leaves a prefix", async () => {
  const MARKER = "UNLOGGED_TEST_TOKEN"; // synthetic, held as a secret by the env below
  const prefixes = Array.from({ length: MARKER.length - 2 }, (_, i) => MARKER.slice(0, i + 3)); // "UNL" .. the whole marker
  const leaks = (line) => prefixes.filter((p) => line.includes(p));
  const h = await liveHub({ argv: ["--live", "--verbose"], env: { TWILIO_AUTH_TOKEN: MARKER } });
  const cases = [];
  for (const at of [2000, 200]) {
    for (let d = -MARKER.length - 2; d <= 2; d++) {
      cases.push("Call".padEnd(at + d, " ") + MARKER); // whitespace collapse moves the cut, as in codex's repro
      cases.push("x".repeat(at + d) + MARKER);
      cases.push(`${"Call ".repeat(Math.max(1, Math.floor((at + d) / 5)))}${MARKER} tail`);
    }
  }
  assert.ok(cases.includes("Call".padEnd(1992, " ") + MARKER), "codex's exact repro is covered");
  for (const text of cases) {
    const n = h.logs.length;
    h.log.body("visitor", text);
    const line = h.logs.slice(n).join("\n");
    assert.ok(line.length > 0, "verbose prints the body");
    assert.deepEqual(leaks(line), [], `marker prefix visible for a ${text.length}-char body: ${line.slice(-60)}`);
  }
  // end to end: the same body arriving by SMS
  h.twilio.text(TOURIST, "Call".padEnd(1992, " ") + MARKER);
  await h.runner.cycle();
  assert.deepEqual(leaks(h.logs.join("\n")), []);
  h.close();
});

// ------------------------------------------------------------------------------------------------ API key auth (warden)
test("API key auth: polling GET and REST POST carry Basic base64(KEY_SID:KEY_SECRET); URLs keep the ACCOUNT SID", async () => {
  const tw = fakeTwilio();
  const seen = [];
  const h = await liveHub({ twilio: { ...tw, fetch: (u, i) => { seen.push({ url: String(u), auth: i.headers.Authorization }); return tw.fetch(u, i); } } });
  tw.text(TOURIST, REQ);
  await h.runner.cycle();
  const expected = `Basic ${Buffer.from(`${KEY_SID}:${KEY_SECRET}`).toString("base64")}`;
  assert.ok(seen.some((r) => r.url.includes("/Messages.json?")) && seen.some((r) => !r.url.includes("?")), "both a GET and a POST");
  for (const r of seen) {
    assert.equal(r.auth, expected);
    assert.ok(r.url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${SID}/`));
  }
  assert.match(h.logs.join("\n"), /auth API key/);
  for (const s of [KEY_SID, KEY_SECRET]) assert.ok(!h.logs.join("\n").includes(s));
  h.close();
});

test("auth config: no key and no token is a config error naming only variable names; token and old names still work", async () => {
  const db = join(tmp(), "h.db");
  const base = { TWILIO_ACCOUNT_SID: SID, TWILIO_NUMBER: HUB, OWNER_PHONE: NOOR, HUB_DB_PATH: db };
  assert.throws(() => loadConfig({ argv: ["--live"], env: base, repoRoot: REPO }), (e) => {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /^missing TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET \(or the fallback TWILIO_AUTH_TOKEN instead of the API key\)$/);
    for (const v of [SID, HUB, NOOR, db]) assert.ok(!e.message.includes(v));
    return true;
  });
  assert.throws(() => loadConfig({ argv: ["--live"], env: { ...base, TWILIO_API_KEY_SID: KEY_SID }, repoRoot: REPO }),
    (e) => /^missing TWILIO_API_KEY_SECRET$/.test(e.message) && !e.message.includes(KEY_SID));
  assert.throws(() => loadConfig({ argv: ["--live"], env: { ...base, TWILIO_API_KEY_SID: "AC" + "7".repeat(32), TWILIO_API_KEY_SECRET: KEY_SECRET }, repoRoot: REPO }),
    (e) => /TWILIO_API_KEY_SID must be SK/.test(e.message) && !e.message.includes(KEY_SECRET));
  // fallback: the auth token, under the old variable names
  const old = { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM_NUMBER: HUB, HUB_OWNER_PHONE: NOOR, HUB_DB_PATH: db };
  const c = loadConfig({ argv: ["--live"], env: old, repoRoot: REPO });
  assert.deepEqual([c.apiKeySid, c.authToken, c.from, c.ownerPhone], [null, TOKEN, HUB, NOOR]);
  const tw = fakeTwilio();
  const auths = [];
  const logs = [];
  const built = await buildHub(c, { fetchImpl: (u, i) => { auths.push(i.headers.Authorization); return tw.fetch(u, i); }, now: () => START, write: (l) => logs.push(l), tagger: false });
  await built.runner.cycle();
  assert.deepEqual([...new Set(auths)], [`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`]);
  assert.match(logs.join("\n"), /auth auth token \(fallback\)/);
  built.close();
});
