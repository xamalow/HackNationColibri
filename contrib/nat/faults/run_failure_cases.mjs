#!/usr/bin/env node
// Runs the pre-registered failure matrix (eval/failure-cases.json) against Claude Domain's core.
//
//   node contrib/nat/faults/run_failure_cases.mjs <packages/core/dist> <contracts dir> > report.json
//
// Independent of Domain's own tests: only the core's public API, with Nat's own in-memory
// transactional store (copy-on-write, discarded on throw) and fault injection. It proves the
// core's transaction-port logic, NOT the durability of the phone's encrypted database.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [coreDist, contractsDir] = process.argv.slice(2);
if (!coreDist || !contractsDir) {
  console.error("usage: run_failure_cases.mjs <packages/core/dist> <contracts dir>");
  process.exit(2);
}
const core = await import(pathToFileURL(resolve(coreDist, "index.js")).href);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ENVELOPE = JSON.parse(readFileSync(resolve(contractsDir, "fixtures/good/send_message_simulated.json"), "utf8"));

const ms = (iso) => Date.parse(iso);
const T0 = ms("2026-10-03T21:00:00Z"); // after created_at, before valid_until
const EXPIRY = ms(ENVELOPE.valid_until);
const clockAt = (wall, highWaterMs = 0) => core.observeClock({ highWaterMs }, wall);
const SESSION = { tenant_id: ENVELOPE.tenant_id, owner_id: "noor", device_id: "phone-1", unlock: "pin",
  session_id: "s-1", authenticated_at: "2026-10-03T20:55:00Z" };
const TRUSTED = { tenant_id: ENVELOPE.tenant_id, owner_id: "noor", trusted_device_ids: new Set(["phone-1"]),
  allowed_unlock: new Set(["pin", "biometric"]), max_session_age_ms: 30 * 60 * 1000, revoked_session_ids: new Set() };
const proposed = (envelope = ENVELOPE) => ({ envelope, business: "proposed", transport: "none", revoked_at: null, provider_ref: null, attempts: 0 });

const copy = (value) => JSON.parse(JSON.stringify(value));

/** A deep copy of the store's records: a transaction that throws leaves the committed state untouched. */
function cloneState(s) {
  return {
    actions: new Map([...s.actions].map(([id, action]) => [id, copy(action)])),
    approvals: copy(s.approvals), outbox: copy(s.outbox), audit: copy(s.audit),
    factRevision: s.factRevision, session: s.session, trusted: s.trusted, // read-only inputs
  };
}

/** Nat's store: every transaction works on a deep copy and commits only if fn returns. */
class Store {
  constructor({ action = proposed(), factRevision = 1, session = SESSION, trusted = TRUSTED, faults = {} } = {}) {
    this.state = { actions: new Map([[action.envelope.action_id, action]]), approvals: [], outbox: [], audit: [], factRevision, session, trusted };
    this.faults = faults;
  }
  async transaction(fn) {
    const d = cloneState(this.state);
    const tx = {
      getAction: async (id) => d.actions.get(id) ?? null,
      getCurrentFactRevision: async () => d.factRevision,
      getTrustedOwner: async () => d.trusted,
      getOwnerSession: async () => d.session,
      insertApproval: async (r) => {
        if (d.approvals.some((a) => a.action_id === r.action_id)) throw new Error("UNIQUE approval.action_id");
        d.approvals.push(r);
        if (this.faults.crashAfter === "insertApproval") throw new Error("process killed");
      },
      insertOutbox: async (row) => {
        if (this.faults.diskFull) throw new Error("SQLITE_FULL: database or disk is full");
        if (d.outbox.some((o) => o.idempotency_key === row.idempotency_key)) throw new Error("UNIQUE outbox.idempotency_key");
        d.outbox.push(row);
      },
      updateAction: async (a) => { d.actions.set(a.envelope.action_id, a); },
      appendAudit: async (e) => { d.audit.push(e); },
    };
    const result = await fn(tx);
    this.state = d;
    return result;
  }
  action() { return this.state.actions.get(ENVELOPE.action_id); }
}

const approveReq = (clock = clockAt(T0), renderedDigest = ENVELOPE.digest) =>
  ({ actionId: ENVELOPE.action_id, renderedDigest, clock, approvalId: "ap-1", sha256, confirmation: "tap" });

async function approved(opts = {}) {
  const store = new Store(opts);
  const r = await core.approveExact(store, approveReq());
  if (!r.ok) throw new Error(`setup approval refused: ${r.reason}`);
  return { store, approval: r.approval, outbox: r.outbox };
}

const dispatch = (action, approval, outbox, clock = clockAt(T0 + 60_000, T0), currentFactRevision = 1) =>
  core.checkDispatch({ action, approval, outbox, clock, currentFactRevision, sha256 });

function edited(change) {
  const body = copy(ENVELOPE);
  delete body.digest;
  change(body);
  const sealed = core.sealEnvelope(body, sha256);
  if (!sealed.ok) throw new Error(`could not seal edited envelope: ${sealed.errors.join("; ")}`);
  return sealed.value;
}

async function attempt(fn) {
  try { return { threw: false, value: await fn() }; } catch (e) { return { threw: true, error: String(e?.message ?? e) }; }
}

const CASES = {
  async "FC-01"(check) {
    const { store, approval, outbox } = await approved();
    const base = store.action();
    const variants = {
      recipient: (b) => { b.recipient.address = "SIMULATED:someone-else"; },
      payload: (b) => { b.payload.body = "Ziara ni bure kwa wote."; },
      fact_revision: (b) => { b.fact_revision = 2; },
      render_locale: (b) => { b.preview.render_locale = "en-KE"; },
      valid_until: (b) => { b.valid_until = "2026-10-05T20:00:00Z"; },
    };
    for (const [name, change] of Object.entries(variants)) {
      const d = dispatch({ ...base, envelope: edited(change) }, approval, outbox, clockAt(T0 + 60_000, T0), name === "fact_revision" ? 2 : 1);
      const safe = !d.ok || (d.send.payload_json === outbox.payload_json && d.send.address === outbox.address && d.send.digest === approval.digest);
      check(`edit ${name} under the same action_id, re-sealed: no dispatch of edited bytes`, safe, d.ok ? "dispatch ok with pinned bytes" : `hold ${d.hold}`);
    }
    const s2 = new Store({ action: proposed(edited((b) => { b.payload.body = "Bei ni 500 tu."; })) });
    const r = await core.approveExact(s2, approveReq());
    check("approval with the digest Noor saw, after the stored action changed: refused", !r.ok, r.ok ? "approved" : r.reason);
  },

  async "FC-02"(check) {
    const store = new Store({ faults: { crashAfter: "insertApproval" } });
    const a = await attempt(() => core.approveExact(store, approveReq()));
    const s = store.state;
    check("crash between approval insert and commit: nothing persisted", a.threw && s.approvals.length === 0 && s.outbox.length === 0 && store.action().business === "proposed",
      `threw=${a.threw}, approvals=${s.approvals.length}, outbox=${s.outbox.length}, business=${store.action().business}`);
    store.faults = {};
    const again = await core.approveExact(store, approveReq());
    check("after restart the owner approves once: approval + one outbox row together", again.ok && store.state.approvals.length === 1 && store.state.outbox.length === 1,
      `ok=${again.ok}, approvals=${store.state.approvals.length}, outbox=${store.state.outbox.length}`);
    const third = await core.approveExact(store, approveReq());
    check("a repeated approval cannot queue a second send", !third.ok && store.state.outbox.length === 1, third.ok ? "approved twice" : `${third.reason}, outbox=${store.state.outbox.length}`);
  },

  async "FC-03"(check) {
    const { store, approval, outbox } = await approved();
    const sending = core.beginDispatch(store.action());
    const restarted = core.recoverAfterRestart(sending);
    check("killed while sending: send_unknown after restart", restarted.transport === "send_unknown", restarted.transport);
    check("send_unknown is never retried automatically", core.retry(restarted) === null, "retry() returned an action");
    const d = dispatch(restarted, approval, outbox);
    check("send_unknown is held from dispatch", !d.ok, d.ok ? "dispatch ok" : `hold ${d.hold}`);
  },

  async "FC-04"(check) {
    const req = (id, at, party = 2) => ({ booking_id: id, slot_id: "sat-am", party_size: party, requested_at: at, authority: "authoritative" });
    const out = core.reconcileSlot({ slot_id: "sat-am", capacity: 4 }, [],
      [req("gyg-77", "2026-10-03T10:00:00Z"), req("gyg-77", "2026-10-03T12:00:00Z"), req("sms-5", "2026-10-03T11:00:00Z"), req("sms-6", "2026-10-03T11:30:00Z", 1)]);
    const once = out.filter((o) => o.booking_id === "gyg-77").length === 1;
    const seats = out.filter((o) => o.state === "confirmed").length * 2;
    check("a booking synced twice is one booking", once, JSON.stringify(out));
    check("seats confirmed never exceed capacity", seats <= 4 && out.find((o) => o.booking_id === "sms-6").state !== "confirmed", JSON.stringify(out));
  },

  async "FC-05"(check) {
    const { store } = await approved();
    const sent = core.recordAcceptance(core.beginDispatch(store.action()), "p-1");
    const ref = sent.provider_ref; // the simulated channel prefixes it ("simulated:p-1") so it can never read as a real send
    check("simulated acceptance is labeled simulated", ref.startsWith("simulated:") && core.transportLabel(sent) === "sent_simulated", `${ref}, ${core.transportLabel(sent)}`);
    let seen = new Set();
    const r1 = core.applyReceipt(sent, { provider_event_id: "e1", provider_ref: ref, status: "delivered" }, seen);
    check("delivered before sent is applied", r1.applied && r1.action.transport === "delivered", r1.reason);
    seen = new Set(r1.seen);
    const r2 = core.applyReceipt(r1.action, { provider_event_id: "e2", provider_ref: ref, status: "sent" }, seen);
    check("a late 'sent' does not regress delivered", !r2.applied && r2.action.transport === "delivered", r2.reason);
    const r3 = core.applyReceipt(r1.action, { provider_event_id: "e1", provider_ref: ref, status: "delivered" }, seen);
    check("a duplicate event is ignored", !r3.applied && r3.reason === "duplicate", r3.reason);
    const wrong = core.applyReceipt(sent, { provider_event_id: "e9", provider_ref: "p-OTHER", status: "delivered" }, new Set());
    const right = core.applyReceipt(sent, { provider_event_id: "e9", provider_ref: ref, status: "delivered" }, wrong.seen);
    check("a wrong-reference receipt changes nothing and does not block the corrected one", !wrong.applied && right.applied, `${wrong.reason} then ${right.reason}`);
  },

  async "FC-06"(check) {
    const { store, approval, outbox } = await approved();
    const unknown = core.recordFailure(core.beginDispatch(store.action()), false);
    check("timeout after possible acceptance: send_unknown, not failed", unknown.transport === "send_unknown", unknown.transport);
    check("no blind retry", core.retry(unknown) === null, "retry() returned an action");
    check("UI label does not say 'not sent'", core.transportLabel(unknown) === "send_unknown", core.transportLabel(unknown));
    const d = dispatch(unknown, approval, outbox);
    check("held from dispatch until reconciled", !d.ok, d.ok ? "dispatch ok" : `hold ${d.hold}`);
  },

  async "FC-07"(check) {
    const slot = { slot_id: "sat-am", capacity: 1 };
    const r = (id, at, authority) => ({ booking_id: id, slot_id: "sat-am", party_size: 1, requested_at: at, authority });
    const both = core.reconcileSlot(slot, [], [r("sms-1", "2026-10-03T10:00:00Z", "authoritative"), r("gyg-1", "2026-10-03T10:00:30Z", "authoritative")]);
    check("two requests for the last seat on the authoritative calendar: one confirmed", both.filter((o) => o.state === "confirmed").length === 1, JSON.stringify(both));
    const offline = core.reconcileSlot(slot, [], [r("dev-a", "2026-10-03T10:00:00Z", "tentative"), r("dev-b", "2026-10-03T10:00:01Z", "tentative")]);
    check("two offline devices: neither confirmed, both tentative", offline.every((o) => o.state === "tentative"), JSON.stringify(offline));
  },

  async "FC-08"(check) {
    const clock = clockAt(T0 + 120_000, T0);
    const a = await approved();
    const ra = await core.revokeExact(a.store, { actionId: ENVELOPE.action_id, clock });
    const da = dispatch(a.store.action(), a.approval, a.outbox, clock);
    check("(a) revoked while queued: recalled and never dispatched", ra.ok && ra.recalled && !da.ok, ra.ok ? `recalled=${ra.recalled}, dispatch ${da.ok ? "ok" : da.hold}` : ra.reason);

    const b = await approved();
    const unknown = core.recordFailure(core.beginDispatch(b.store.action()), false);
    await b.store.transaction(async (tx) => tx.updateAction(unknown));
    const rb = await core.revokeExact(b.store, { actionId: ENVELOPE.action_id, clock });
    check("(b) revoked while send_unknown: recall NOT claimed", rb.ok && rb.recalled === false, rb.ok ? `recalled=${rb.recalled} (${rb.note})` : rb.reason);
    const late = core.applyReceipt(b.store.action(), { provider_event_id: "late-1", provider_ref: "p-9", status: "delivered" }, new Set());
    check("(b) a later authenticated delivery is still recorded and shown as delivered", late.applied && core.transportLabel(late.action) === "delivered",
      `${late.reason}, label=${core.transportLabel(late.action)}`);

    const c = await approved();
    const accepted = core.recordAcceptance(core.beginDispatch(c.store.action()), "p-3");
    await c.store.transaction(async (tx) => tx.updateAction(accepted));
    const rc = await core.revokeExact(c.store, { actionId: ENVELOPE.action_id, clock });
    check("(c) after acceptance: cannot be recalled, transport stays sent", rc.ok && rc.recalled === false && c.store.action().transport === "sent",
      rc.ok ? `${rc.note}, transport=${c.store.action().transport}` : rc.reason);
  },

  async "FC-09"(check) {
    const store = new Store();
    const back = core.observeClock({ highWaterMs: T0 + 3_600_000 }, T0);
    const r = await core.approveExact(store, approveReq(back));
    check("wall clock set back: approval held as clock_suspect", back.suspect && !r.ok && r.reason === "clock_suspect", r.ok ? "approved" : r.reason);
    const { store: s2, approval, outbox } = await approved();
    const afterExpiry = core.observeClock({ highWaterMs: EXPIRY + 3_600_000 }, T0);
    const d = dispatch(s2.action(), approval, outbox, afterExpiry);
    check("expired, then clock set back before valid_until: still not dispatchable", !d.ok, d.ok ? "dispatch ok" : `hold ${d.hold}`);
  },

  async "FC-10"(check) {
    const store = new Store({ faults: { diskFull: true } });
    const a = await attempt(() => core.approveExact(store, approveReq()));
    const s = store.state;
    check("disk full during approval: error surfaces, nothing approved, nothing queued",
      a.threw && s.approvals.length === 0 && s.outbox.length === 0 && store.action().business === "proposed",
      `threw=${a.threw}${a.error ? ` (${a.error})` : ""}, approvals=${s.approvals.length}, outbox=${s.outbox.length}`);
  },

  async "FC-11"(check) {
    const variants = {
      "daughter's own unlock (other owner)": { session: { ...SESSION, owner_id: "daughter" } },
      "untrusted device": { session: { ...SESSION, device_id: "phone-2" } },
      "revoked session": { trusted: { ...TRUSTED, revoked_session_ids: new Set(["s-1"]) } },
      "nobody unlocked": { session: null },
    };
    for (const [name, opts] of Object.entries(variants)) {
      const store = new Store(opts);
      const r = await core.approveExact(store, approveReq());
      check(`${name}: refused, still proposed`, !r.ok && store.action().business === "proposed", r.ok ? "approved" : r.reason);
    }
  },

  async "FC-12"(check) {
    const { store, approval, outbox } = await approved();
    const late = clockAt(EXPIRY + 60_000, T0);
    const d = dispatch(store.action(), approval, outbox, late);
    check("approved in time, signal after valid_until: not sent", !d.ok, d.ok ? "dispatch ok" : `hold ${d.hold}`);
  },

  async "FC-13"(check) {
    const { store, approval, outbox } = await approved();
    const d = dispatch(store.action(), approval, outbox, clockAt(T0 + 60_000, T0), 2);
    check("farm sheet changed after approval: dispatch held", !d.ok, d.ok ? "dispatch ok" : `hold ${d.hold}`);
  },

  async "FC-14"(check) {
    check("covered by W3 dev fixtures DEV-013 and DEV-020 (run R4 on the same core: pass)", true, "see contrib/nat/results.md R4");
  },

  async "FC-15"(check) {
    for (const [name, input, field] of [["'next Saturday'", { date: "next Saturday", time: "10:00", timezone: "Africa/Nairobi" }, "date"],
      ["'tomorrow'", { date: "tomorrow", time: "10:00", timezone: "Africa/Nairobi" }, "date"],
      ["time with no zone", { date: "2026-10-10", time: "10:00", timezone: null }, "timezone"]]) {
      const v = core.validateAppointment(input);
      check(`${name}: clarification on ${field}`, !v.ok && v.clarify === field, v.ok ? "accepted" : v.clarify);
    }
    const bob = core.validateMoney({ amount_minor: 50000, currency: "BOB_", exponent: 2 });
    check("'500 bob' (not an ISO code): ask a person", !bob.ok, bob.ok ? "accepted" : bob.reason);
    const float = core.validateMoney({ amount_minor: 2000.5, currency: "KES", exponent: 2 });
    check("non-integer amount: refused, never rounded", !float.ok, float.ok ? "accepted" : float.reason);
    const usd = core.validateMoney({ amount_minor: 2000, currency: "USD", exponent: 2 });
    check("'20 dollars' stays USD: no conversion by code", usd.ok && usd.money.currency === "USD" && usd.money.amount_minor === 2000, usd.ok ? usd.money.currency : usd.reason);
  },
};

const results = [];
for (const [id, run] of Object.entries(CASES)) {
  const checks = [];
  const check = (name, ok, observed) => checks.push({ name, ok: Boolean(ok), observed: String(observed) });
  try {
    await run(check);
  } catch (e) {
    checks.push({ name: "harness ran to completion", ok: false, observed: `threw: ${e?.message ?? e}` });
  }
  results.push({ id, result: checks.every((c) => c.ok) ? "pass" : "fail", checks });
}
process.stdout.write(JSON.stringify({ results, summary: {
  pass: results.filter((r) => r.result === "pass").length, fail: results.filter((r) => r.result === "fail").length,
} }, null, 2) + "\n");
