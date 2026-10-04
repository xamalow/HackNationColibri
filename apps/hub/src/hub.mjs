// The hub pipeline: every inbound channel -> store -> shared calendar (core) -> alert to Noor -> outbox;
// Noor's SMS -> one-time-code approval -> executor -> platforms; every step recorded as an event the app syncs.
//
// Guardrails (Carter, 2026-10-04): AI stays local; transports are simulated by default; an alert never triggers
// an action; an SMS approval needs Noor's enrolled number AND the per-proposal one-time code; platform changes run
// only from an approved, digest-bound proposal through a deterministic adapter.

import { join } from "node:path";
import { applyBookingEvent } from "./bookings.mjs";
import { handleOwnerSms } from "./commands.mjs";
import { gygApiSource, platformMailSource } from "./intake/platforms.mjs";
import { smsBatchToEvents } from "./intake/sms.mjs";
import { callToEvent, fixtureTranscriber } from "./intake/voice.mjs";
import { queueOwnerAlert } from "./notify.mjs";
import { blockedDays } from "./publish.mjs";
import { simulatedInbound } from "./transports/simulated.mjs";

export const CLOSED_DAYS_KV = "calendar.closed_days";

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

/**
 * @param {{ store, sheet, outbox, publisher, sources?: object[], now?: () => Date }} deps
 */
export function createHub({ store, sheet, outbox, publisher, sources = [], now = () => new Date() }) {
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

  /** Execute an approved proposal (only reachable through a redeemed one-time code). */
  async function execute(command) {
    const approval = { approved: true, approval_id: `${command.proposal_id}:${command.digest.slice(0, 12)}`, digest: command.digest };
    if (command.kind === "close_day" || command.kind === "reopen_day") {
      const open = command.kind === "reopen_day";
      store.transaction(() => {
        const closed = store.getKV(CLOSED_DAYS_KV, {});
        if (open) delete closed[command.change.date]; else closed[command.change.date] = { approval_id: approval.approval_id };
        store.setKV(CLOSED_DAYS_KV, closed);
      });
      return publisher.publishAvailability({ ...approval, days: [{ date: command.change.date, open }] });
    }
    if (command.kind === "capacity") {
      sheet.capacity_per_tour = command.change.capacity_per_tour;
      return publisher.publishListing({ ...approval, fields: { capacity_per_tour: command.change.capacity_per_tour } });
    }
    if (command.kind === "price") {
      sheet.price_per_person_kes = command.change.price_per_person.amount_minor / 100;
      return publisher.publishListing({ ...approval, fields: { price_per_person_kes: sheet.price_per_person_kes } });
    }
    return { ok: false, reason: `no executor for ${command.kind}` };
  }

  /** An SMS from any number to the hub's owner line. */
  async function ownerSms(sms) {
    const r = handleOwnerSms(store, sms, { now: now() });
    if (r.reply && r.recipient) outbox.enqueue({ channel: "sms", recipient: r.recipient, body: r.reply, cause_id: `reply:${now().toISOString()}`, sensitive: r.sensitive });
    let executed = null;
    if (r.command?.type === "approve") {
      executed = await execute(r.command);
      record("owner_approval", { proposal_id: r.command.proposal_id, kind: r.command.kind, ok: executed.ok ?? false, via: r.command.via });
      if (executed.alert) record("platform_alert", { id: executed.alert.id, kind: executed.alert.kind, blocked_days: executed.alert.blocked_days });
    } else if (r.command) {
      record(`owner_${r.command.type}`, { proposal_id: r.command.proposal_id, kind: r.command.kind });
    }
    await outbox.dispatch();
    return { command: r.command?.type ?? null, reply_sent: Boolean(r.reply), executed };
  }

  return { handleEvent, ingest, ownerSms, execute };
}
