import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import {
  createPublisher, simulatedPlatform, platformAdapters, blockedDays, pendingPublishAlerts, ackPublishAlerts,
  PublishRefusedError, NotConfiguredError,
} from "../src/publish.mjs";
import { getYourGuideAdapter, buildGygAvailabilityUpdate, GYG_ENV } from "../src/platforms/getyourguide.mjs";
import { bookingComAdapter, buildOtaHotelAvailNotif, BOOKING_COM_ENV } from "../src/platforms/booking_com.mjs";

const DIGEST = "d".repeat(64);
const approved = (extra = {}) => ({ approved: true, approval_id: "appr-1", digest: DIGEST, days: [{ date: "2026-10-12", open: false }, { date: "2026-10-13", open: true, capacity: 8 }], ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), "sauti-publish-"));
const outboxRows = (store) => store.db.prepare("SELECT channel, status FROM outbox ORDER BY channel").all().map((r) => ({ ...r }));

test("refuses anything that is not an approved change, writes nothing", async () => {
  const store = openStore();
  let calls = 0;
  const spy = { sendAvailability: async () => { calls++; return { ref: "x" }; }, sendListing: async () => { calls++; return { ref: "x" }; } };
  const pub = createPublisher({ store, adapters: { simulated: spy }, verifyApproval: () => true });
  const bad = [
    null, {}, { ...approved(), approved: false }, { ...approved(), approved: "true" }, { ...approved(), approval_id: undefined },
    { ...approved(), approval_id: "" }, { ...approved(), digest: undefined }, { ...approved(), digest: "abc" },
  ];
  for (const c of bad) await assert.rejects(pub.publishAvailability(c), PublishRefusedError);
  for (const c of bad) await assert.rejects(pub.publishListing(c && { ...c, fields: { price_kes: 2000 } }), PublishRefusedError);
  await assert.rejects(pub.publishAvailability(approved({ days: [{ date: "2026-02-30", open: false }] })), { code: "invalid_days" });
  await assert.rejects(pub.publishAvailability(approved({ platforms: ["airbnb"] })), { code: "unknown_platform" });
  await assert.rejects(pub.publishListing({ ...approved(), fields: { photo: { url: "x" } } }), { code: "invalid_fields" });
  const strict = createPublisher({ store, adapters: { simulated: spy }, verifyApproval: () => false });
  await assert.rejects(strict.publishAvailability(approved()), { code: "approval_not_found" });
  assert.equal(calls, 0);
  assert.deepEqual(outboxRows(store), []);
  assert.deepEqual(blockedDays(store), {});
});

test("approved availability goes to the simulated JSONL log once, marked synthetic", async () => {
  const dir = tmp();
  try {
    const store = openStore();
    const logPath = join(dir, "platform.jsonl");
    const pub = createPublisher({ store, adapters: { simulated: simulatedPlatform(logPath) }, verifyApproval: () => true });
    const r = await pub.publishAvailability(approved());
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocked_days, []);
    assert.equal(r.alert, null);
    assert.equal(r.results[0].status, "sent");
    const again = await pub.publishAvailability(approved());
    assert.equal(again.results[0].status, "already_sent");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].synthetic, true);
    assert.equal(lines[0].approval_id, "appr-1");
    assert.equal(lines[0].digest, DIGEST);
    assert.deepEqual(lines[0].days, approved().days);
    assert.deepEqual(outboxRows(store), [{ channel: "platform:simulated", status: "sent" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failed adapter -> affected days blocked locally + structured alert; a later success lifts the block", async () => {
  const store = openStore();
  let fail = true;
  const flaky = { sendAvailability: async () => { if (fail) throw Object.assign(new Error("HTTP 503 from upstream for +254700000000"), { code: "upstream_down", notAccepted: true }); return { ref: "ok" }; } };
  const good = { sendAvailability: async () => ({ ref: "g" }) };
  const pub = createPublisher({ store, adapters: { getyourguide: flaky, simulated: good }, verifyApproval: () => true });
  const r = await pub.publishAvailability(approved());
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked_days, ["2026-10-12", "2026-10-13"]);
  assert.equal(r.alert.type, "platform_sync_failed");
  assert.deepEqual(r.alert.platforms, [{ platform: "getyourguide", code: "upstream_down" }]);
  assert.deepEqual(r.alert.blocked_days, ["2026-10-12", "2026-10-13"]);
  assert.ok(!JSON.stringify(r).includes("+254"), "raw upstream error text is not echoed");
  assert.deepEqual(Object.keys(blockedDays(store)).sort(), ["2026-10-12", "2026-10-13"]);
  assert.equal(blockedDays(store)["2026-10-12"].reason, "platform_sync_failed");
  assert.equal(pendingPublishAlerts(store).length, 1);
  assert.deepEqual(outboxRows(store), [{ channel: "platform:getyourguide", status: "failed" }, { channel: "platform:simulated", status: "sent" }]);

  // Retry the same approval: the failed row is resent with the same key, the sent one is not resent.
  fail = false;
  const retry = await pub.publishAvailability(approved());
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.results.map((x) => x.status), ["sent", "already_sent"]);
  assert.deepEqual(blockedDays(store), {});
  ackPublishAlerts(store, [r.alert.id]);
  assert.equal(pendingPublishAlerts(store).length, 0);
});

test("a row stuck in 'sending' (crash mid-call) is reported needs_reconcile, never resent, and blocks the days", async () => {
  const store = openStore();
  let calls = 0;
  const pub = createPublisher({ store, adapters: { simulated: { sendAvailability: async () => { calls++; return { ref: "s" }; } } }, verifyApproval: () => true });
  await pub.publishAvailability(approved());
  store.db.prepare("UPDATE outbox SET status = 'sending'").run();
  const r = await pub.publishAvailability(approved());
  assert.equal(calls, 1);
  assert.equal(r.results[0].status, "needs_reconcile");
  assert.deepEqual(r.blocked_days, ["2026-10-12", "2026-10-13"]);
});

test("real adapters throw NotConfigured without env vars; publish turns that into blocked days + alert", async () => {
  const env = {};
  const gyg = getYourGuideAdapter({ env });
  const bcom = bookingComAdapter({ env });
  assert.equal(gyg.configured(), false);
  await assert.rejects(gyg.sendAvailability({ days: approved().days }), (e) => e instanceof NotConfiguredError && e.missing.join() === GYG_ENV.join());
  await assert.rejects(bcom.sendAvailability({ days: approved().days }), (e) => e instanceof NotConfiguredError && e.code === "not_configured" && e.missing.join() === BOOKING_COM_ENV.join());
  await assert.rejects(gyg.sendListing({ fields: {} }), NotConfiguredError);

  const real = platformAdapters({ env: { SAUTI_PUBLISH_MODE: "real" } });
  assert.deepEqual(Object.keys(real), ["getyourguide", "booking_com"]);
  assert.deepEqual(Object.keys(platformAdapters({ env: {} })), ["simulated"], "simulated is the default");

  const store = openStore();
  const r = await createPublisher({ store, adapters: real, verifyApproval: () => true }).publishAvailability(approved());
  assert.equal(r.ok, false);
  assert.deepEqual(r.alert.platforms.map((p) => p.code), ["not_configured", "not_configured"]);
  assert.match(r.results[0].message, /GYG_SUPPLIER_API_KEY/);
  assert.deepEqual(r.blocked_days, ["2026-10-12", "2026-10-13"]);
});

test("configured stubs build the real payload but send nothing; listing content is unsupported by API", async () => {
  const env = Object.fromEntries([...GYG_ENV, ...BOOKING_COM_ENV].map((n) => [n, "test-value"]));
  await assert.rejects(getYourGuideAdapter({ env }).sendAvailability({ days: approved().days }), { code: "not_implemented" });
  await assert.rejects(getYourGuideAdapter({ env }).sendListing({ fields: {} }), { code: "unsupported_by_platform" });
  await assert.rejects(bookingComAdapter({ env }).sendAvailability({ days: approved().days }), { code: "not_implemented" });

  const body = buildGygAvailabilityUpdate({ productId: "P1", days: approved().days });
  assert.deepEqual(body.data.availabilities.map((a) => a.vacancies), [0, 8]);
  assert.equal(body.data.availabilities[0].dateTime, "2026-10-12T09:00:00+03:00");
  const xml = buildOtaHotelAvailNotif({ hotelId: "H<1>", roomId: "R1", days: approved().days });
  assert.match(xml, /Status="Close"/); assert.match(xml, /Status="Open"/); assert.match(xml, /HotelCode="H&lt;1&gt;"/);

  const store = openStore();
  const r = await createPublisher({ store, adapters: { getyourguide: getYourGuideAdapter({ env }) }, verifyApproval: () => true })
    .publishListing({ approved: true, approval_id: "appr-2", digest: DIGEST, fields: { price_kes: 2000 } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked_days, []);
  assert.equal(r.alert.advice, "apply_listing_change_manually");
});

test("codex review (3): a timeout after the call is UNCERTAIN, blocks the days and is never resent automatically", async () => {
  const store = openStore();
  let calls = 0;
  const timesOut = { sendAvailability: async () => { calls++; throw Object.assign(new Error("socket timeout"), { code: "timeout" }); } };
  const pub = createPublisher({ store, adapters: { getyourguide: timesOut }, verifyApproval: () => true });
  const r = await pub.publishAvailability(approved());
  assert.equal(r.ok, false);
  assert.equal(r.results[0].status, "uncertain");
  assert.deepEqual(r.blocked_days, ["2026-10-12", "2026-10-13"]);
  const again = await pub.publishAvailability(approved());
  assert.equal(again.results[0].status, "needs_reconcile");
  assert.equal(calls, 1, "an uncertain send is not repeated blindly");
});

test("codex review (1): no publisher without a verifier, and the verifier's refusal stops everything", async () => {
  const store = openStore();
  assert.throws(() => createPublisher({ store, adapters: { simulated: { sendAvailability: async () => ({ ref: "x" }) } } }), /verifyApproval/);
  let sent = 0;
  const pub = createPublisher({ store, adapters: { simulated: { sendAvailability: async () => { sent++; return { ref: "x" }; } } }, verifyApproval: () => false });
  await assert.rejects(pub.publishAvailability(approved()), { code: "approval_not_found" });
  assert.equal(sent, 0);
});
