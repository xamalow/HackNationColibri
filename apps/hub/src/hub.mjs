// The hub pipeline: every inbound channel -> store -> shared calendar (core) -> alert to Noor -> outbox;
// Noor's SMS -> one-time-code approval -> executor -> platforms; every step recorded as an event the app syncs.
//
// Guardrails (Carter, 2026-10-04): AI stays local; transports are simulated by default; an alert never triggers
// an action; an SMS approval needs Noor's enrolled number AND the per-proposal one-time code; platform changes run
// only from an approved, digest-bound proposal through a deterministic adapter.

import { join } from "node:path";
import { applyBookingEvent } from "./bookings.mjs";
import { handleOwnerSms, proposalDigest } from "./commands.mjs";
import { gygApiSource, platformMailSource } from "./intake/platforms.mjs";
import { smsBatchToEvents } from "./intake/sms.mjs";
import { callToEvent, fixtureTranscriber } from "./intake/voice.mjs";
import { queueOwnerAlert } from "./notify.mjs";
import { blockedDays, createPublisher, platformAdapters } from "./publish.mjs";
import { simulatedInbound } from "./transports/simulated.mjs";

export const CLOSED_DAYS_KV = "calendar.closed_days";
const EXECUTED_KV = "proposal.executed.";

/** Default simulated sources from a fixtures folder (inbound/{mail,gyg,sms,calls,transcripts}). */
export function simulatedSources(inboundDir) {
  const sms = simulatedInbound(join(inboundDir, "sms"));
  const calls = simulatedInbound(join(inboundDir, "calls"));
  const transcriber = fixtureTranscriber(join(inboundDir, "transcripts"));
  return [
    platformMailSource(join(inboundDir, "mail")),
    gygApiSource(join(inboundDir, "gyg")),
    { name: "sms_simulated", fetchEvents: (opts) => smsBatchToEvents(sms.fetch(), opts) },
    { name: "calls_simulated", fetchEvents: (opts) => Promise.all(calls.fetch().map((c) => callToEvent(c, transcriber, opts))) },
  ];
}

const dayUnavailable = (store, date) => Boolean(store.getKV(CLOSED_DAYS_KV, {})[date] || blockedDays(store)[date]);

/** The exact platform change an approved proposal stands for, rebuilt from the STORED body (never from a command). */
function changeFor(row) {
  const body = JSON.parse(row.body);
  const approval = { approved: true, approval_id: `${row.short_id}:${row.digest.slice(0, 12)}`, digest: row.digest };
  if (row.kind === "close_day" || row.kind === "reopen_day") {
    return { kind: "availability", ...approval, days: [{ date: body.date, open: row.kind === "reopen_day" }] };
  }
  if (row.kind === "capacity") return { kind: "listing", ...approval, fields: { capacity_per_tour: body.capacity_per_tour } };
  if (row.kind === "price") return { kind: "listing", ...approval, fields: { price_per_person_kes: body.price_per_person.amount_minor / 100 } };
  return null;
}

/**
 * Codex review (1): a publish is accepted only if the change equals what the STORED proposal, approved through the
 * one-time code, rebuilds to: same short id, state approved, digest recomputed from the stored body, same payload.
 */
export function storedApprovalVerifier(store) {
  return (change) => {
    const shortId = String(change?.approval_id ?? "").split(":")[0];
    const row = store.db.prepare("SELECT short_id, kind, digest, state, body FROM proposals WHERE short_id = ?").get(shortId);
    if (!row || row.state !== "approved") return false;
    if (proposalDigest(row.kind, JSON.parse(row.body)) !== row.digest || row.digest !== change.digest) return false;
    const expected = changeFor(row);
    if (!expected) return false;
    const exp = { ...expected };
    delete exp.kind;
    const got = { ...change };
    delete got.platforms;
    delete got.listing_id;
    return JSON.stringify(got) === JSON.stringify(exp);
  };
}

/**
 * @param {{ store, sheet, outbox, adapters?: object, sources?: object[], now?: () => Date }} deps
 */
export function createHub({ store, sheet, outbox, adapters = platformAdapters(), sources = [], now = () => new Date() }) {
  const publisher = createPublisher({ store, adapters, verifyApproval: storedApprovalVerifier(store), now });
  // The event kind is set last: a proposal's own `kind` (close_day, price...) is kept as `proposal_kind`.
  const record = (kind, { kind: proposalKind, ...body }) => store.addEvent({
    id: `${kind}:${body.id ?? body.proposal_id ?? body.event_id}:${now().toISOString()}`,
    channel: "hub", received_at: now().toISOString(), synthetic: Boolean(body.synthetic), ...body,
    ...(proposalKind ? { proposal_kind: proposalKind } : {}), kind,
  });

  /** One inbound event through the pipeline. Returns what happened (for logs and the demo). */
  function handleEvent(ev) {
    if (!store.addEvent(ev)) return { id: ev.id, action: "duplicate_event" };
    let outcome;
    if (ev.kind === "booking" && dayUnavailable(store, ev.booking.date)) {
      // Noor closed the day, or a platform sync failed: the platform already sold it, so Noor must know.
      outcome = { action: "conflict", reason: "day_unavailable" };
    } else {
      outcome = applyBookingEvent(store, sheet, ev);
    }
    if (outcome.action === "duplicate" && !outcome.differs) return { id: ev.id, ...outcome };
    const facts = {};
    if (outcome.action === "confirmed") facts.capacity = { booked: sheet.capacity_per_tour - outcome.remaining_after, capacity: sheet.capacity_per_tour };
    if (outcome.action === "conflict") facts.conflict = { booked: null, capacity: sheet.capacity_per_tour };
    const alert = queueOwnerAlert(store, outbox, ev, facts, { now: now() });
    record("owner_alert", { event_id: ev.id, outcome: outcome.action, sms: alert?.sms ?? null, synthetic: ev.synthetic });
    return { id: ev.id, ...outcome, alerted: Boolean(alert) };
  }

  /** Pull every source once, process new events, then send what is queued. */
  async function ingest() {
    const results = [];
    for (const src of sources) for (const ev of await src.fetchEvents({ now })) results.push(handleEvent(ev));
    results.push(...(await outbox.dispatch()).map((r) => ({ outbox: r.status })));
    return results;
  }

  /** Apply one approved proposal (loaded from the store). Local effects are idempotent; publishing is idempotent. */
  async function executeStored(row) {
    const change = changeFor(row);
    if (!change) return { ok: false, reason: `no executor for ${row.kind}` };
    const body = JSON.parse(row.body);
    if (row.kind === "close_day" || row.kind === "reopen_day") {
      store.transaction(() => {
        const closed = store.getKV(CLOSED_DAYS_KV, {});
        if (row.kind === "reopen_day") delete closed[body.date];
        else closed[body.date] = { approval_id: change.approval_id };
        store.setKV(CLOSED_DAYS_KV, closed);
      });
    } else if (row.kind === "capacity") {
      sheet.capacity_per_tour = body.capacity_per_tour;
    } else if (row.kind === "price") {
      sheet.price_per_person_kes = body.price_per_person.amount_minor / 100;
    }
    const { kind, ...payload } = change;
    return kind === "availability" ? publisher.publishAvailability(payload) : publisher.publishListing(payload);
  }

  /**
   * Codex review (2): approved work is durable. Redeeming the code already persisted state 'approved'; this runs
   * every approved proposal not yet executed (after each SMS and at startup), so a crash in between loses nothing.
   */
  async function runApproved() {
    const rows = store.db.prepare("SELECT short_id, kind, digest, state, body FROM proposals WHERE state = 'approved' ORDER BY short_id").all();
    const done = [];
    for (const row of rows) {
      if (store.getKV(EXECUTED_KV + row.short_id)) continue;
      const result = await executeStored(row);
      store.setKV(EXECUTED_KV + row.short_id, { ok: Boolean(result.ok), at: now().toISOString() });
      record("owner_approval", { proposal_id: row.short_id, kind: row.kind, ok: Boolean(result.ok), via: "sms_one_time_code" });
      if (result.alert) record("platform_alert", { id: result.alert.id, kind: result.alert.kind, blocked_days: result.alert.blocked_days });
      done.push({ proposal_id: row.short_id, ...result });
    }
    return done;
  }

  /** At process start: resolve uncertain outbound rows, then finish approved work interrupted by a crash. */
  async function recover() {
    const outboxRows = await outbox.recover();
    const executed = await runApproved();
    return { outbox: outboxRows, executed };
  }

  /** An SMS from any number to the hub's owner line. */
  async function ownerSms(sms) {
    const r = handleOwnerSms(store, sms, { now: now() });
    if (r.reply && r.recipient) {
      outbox.enqueue({ channel: "sms", recipient: r.recipient, body: r.reply, cause_id: `reply:${now().toISOString()}`, sensitive: r.sensitive });
    }
    if (r.command && r.command.type !== "approve") record(`owner_${r.command.type}`, { proposal_id: r.command.proposal_id, kind: r.command.kind });
    // The command object never drives execution: only proposals stored as approved do.
    const executed = await runApproved();
    await outbox.dispatch();
    return { command: r.command?.type ?? null, reply_sent: Boolean(r.reply), executed: executed[0] ?? null };
  }

  return { handleEvent, ingest, ownerSms, runApproved, recover, publisher };
}
