// The hub pipeline: every inbound channel -> store -> shared calendar (core) -> alert to Noor -> outbox;
// Noor's SMS -> one-time-code approval -> executor -> platforms; every step recorded as an event the app syncs.
//
// Max's plan (phone/SMS first, GetYourGuide later): a tourist texts the office line -> the hub checks availability
// by code and sends Noor a read-back with a one-time code -> Noor answers NDIYO / HAPANA / a suggestion -> the hub
// confirms or declines to the tourist in their language -> after the visit it asks (with Noor's yes) for feedback
// -> Noor gets the pain points in Swahili. Noor can also ask the hub (LEO, KESHO, WAGENI 17/10...) at any time.
//
// Guardrails (Carter, 2026-10-04): AI stays local; transports are simulated by default; an alert never triggers
// an action; an SMS approval needs Noor's enrolled number AND the per-proposal one-time code; platform changes run
// only from an approved, digest-bound proposal through a deterministic adapter.

import { join } from "node:path";
import { decideBookingRequest, eatDate, PROPOSAL_KIND as BOOKING_REQUEST, requestBooking } from "./booking_requests.mjs";
import { applyBookingEvent } from "./bookings.mjs";
import { handleOwnerSms, proposalDigest } from "./commands.mjs";
import {
  dueFeedbackRequests, executeApprovedFeedbackRequest, ingestFeedbackReply, KIND as FEEDBACK_REQUEST,
  proposeFeedbackRequest, queuePainPointDigest,
} from "./feedback/index.mjs";
import { gygApiSource, platformMailSource } from "./intake/platforms.mjs";
import { smsBatchToEvents } from "./intake/sms.mjs";
import { callToEvent, fixtureTranscriber } from "./intake/voice.mjs";
import { queueOwnerAlert } from "./notify.mjs";
import { answerOwnerQuery } from "./owner_queries.mjs";
import { blockedDays, createPublisher, platformAdapters } from "./publish.mjs";
import { simulatedInbound } from "./transports/simulated.mjs";

export const CLOSED_DAYS_KV = "calendar.closed_days";
const EXECUTED_KV = "proposal.executed.";
export const SHEET_OVERRIDES_KV = "sheet.overrides";
const FEEDBACK_PROPOSED_KV = "feedback.proposed.";
const TOURIST_REPLY_BUDGET_KV = "budget.tourist_auto_replies";
const QUERY_BUDGET_KV = "budget.owner_query_replies";

/**
 * Daily caps on SMS the hub sends WITHOUT a decision by Noor (each one costs money):
 * - fixed automatic replies to tourists (acknowledgement, "please give date and party size", "that day is full");
 * - answers to Noor's read-only queries (twilio subagent open issue 2: a spoofed sender could otherwise make the
 *   hub pay for many replies to her number). Messages Noor decided (NDIYO/HAPANA/suggestion) are never capped.
 */
export const HUB_LIMITS = Object.freeze({ maxTouristAutoRepliesPerDay: 50, maxQueryRepliesPerDay: 20 });

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
 * @param {{ store, sheet, outbox, adapters?: object, sources?: object[], now?: () => Date,
 *           tagger?: (messages: object[]) => object[], translator?: (text: string, o: object) => string|null,
 *           limits?: object }} deps
 *   tagger: Max's tagFeedback (contrib/max/tagger), injected so the hub does not depend on contrib; without it the
 *   pain-point digest is not built. translator: optional local MT for Noor's suggestions (booking_requests.mjs).
 */
export function createHub({
  store, sheet, outbox, adapters = platformAdapters(), sources = [], now = () => new Date(),
  tagger = null, translator = null, limits = {},
}) {
  const lim = { ...HUB_LIMITS, ...limits };
  const verify = storedApprovalVerifier(store);
  const publisher = createPublisher({ store, adapters, verifyApproval: verify, now });
  // Codex review (B): approved capacity/price changes are persisted and re-applied on every start.
  Object.assign(sheet, store.getKV(SHEET_OVERRIDES_KV, {}));
  // The event kind is set last: a proposal's own `kind` (close_day, price...) is kept as `proposal_kind`.
  const record = (kind, { kind: proposalKind, ...body }) => store.addEvent({
    id: `${kind}:${body.id ?? body.proposal_id ?? body.event_id}:${now().toISOString()}`,
    channel: "hub", received_at: now().toISOString(), synthetic: Boolean(body.synthetic), ...body,
    ...(proposalKind ? { proposal_kind: proposalKind } : {}), kind,
  });
  const owner = () => store.getKV("owner.phone");

  /** Spend one unit of a daily budget (farm-time day): the unit's number that day, 0 when the cap is reached. */
  const spend = (kv, max) => {
    const day = eatDate(now());
    const b = store.getKV(kv, {});
    const used = b.day === day ? b.count ?? 0 : 0;
    if (used >= max) return 0;
    store.setKV(kv, { day, count: used + 1 });
    return used + 1;
  };

  /** A fixed automatic reply to a tourist (no decision by Noor in it), within the daily cap. */
  const autoReply = (recipient, body, causeId) => {
    if (!recipient || !body) return false;
    if (!spend(TOURIST_REPLY_BUDGET_KV, lim.maxTouristAutoRepliesPerDay)) return false;
    outbox.enqueue({ channel: "sms", recipient, body, cause_id: causeId });
    return true;
  };

  /**
   * A tourist's SMS to the office line. A reply from a number we asked for feedback is stored as data; anything
   * else is a booking request: parsed and checked by code, then put to Noor as a proposal with a one-time code.
   */
  function handleVisitorMessage(ev) {
    if (ingestFeedbackReply(store, ev, { now: now() })) {
      record("feedback_reply", { event_id: ev.id, synthetic: ev.synthetic });
      return { id: ev.id, action: "feedback_reply" };
    }
    const r = requestBooking(store, sheet, { event: ev, now: now() });
    // Neither a date nor a party size: a question ("how do we get there? is lunch included?"), not a request.
    // No automatic "send date and party size" reply then; Noor is alerted and answers (W2 drafts, she approves).
    const question = r.action === "ask_tourist" && ["date", "party_size"].every((f) => r.missing?.includes(f));
    let tourist_replied = false;
    if (r.action === "proposed") {
      outbox.enqueue({ channel: "sms", recipient: r.owner_recipient, body: r.owner_sms, cause_id: `booking_request:${r.proposal_id}`, sensitive: true });
      tourist_replied = autoReply(r.tourist_recipient, r.tourist_ack, `ack:${ev.id}`);
    } else if (r.reply && !question) {
      tourist_replied = autoReply(r.tourist_recipient, r.reply, `${r.action}:${ev.id}`);
    }
    // Every visitor message reaches Noor: as a read-back to decide (proposed), otherwise as an alert.
    const alerted = r.action === "proposed" || Boolean(queueOwnerAlert(store, outbox, ev, {}, { now: now() }));
    record("booking_request", {
      event_id: ev.id, outcome: question ? "question" : r.action, proposal_id: r.proposal_id ?? null, reason: r.reason ?? null,
      lang: r.lang ?? null, synthetic: ev.synthetic,
    });
    return {
      id: ev.id, action: question ? "question" : `request_${r.action}`, ...(r.proposal_id ? { proposal_id: r.proposal_id } : {}),
      ...(r.reason ? { reason: r.reason } : {}), tourist_replied, alerted,
    };
  }

  /** One inbound event through the pipeline. Returns what happened (for logs and the demo). */
  function handleEvent(ev) {
    if (!store.addEvent(ev)) return { id: ev.id, action: "duplicate_event" };
    if (ev.kind === "visitor_message") return handleVisitorMessage(ev);
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

  /**
   * After visits: one feedback request per past SMS-booked visit is PROPOSED to Noor (one-time code; nothing goes
   * to the tourist before her NDIYO), then Noor gets the Swahili pain-point digest when the stored replies changed.
   */
  function feedbackTick() {
    const proposed = [];
    const ownerPhone = owner();
    if (ownerPhone) {
      for (const b of dueFeedbackRequests(store, { now: now() })) {
        if (store.getKV(FEEDBACK_PROPOSED_KV + b.booking_id)) continue;
        const p = proposeFeedbackRequest(store, b, { now: now() });
        store.setKV(FEEDBACK_PROPOSED_KV + b.booking_id, p.short_id);
        outbox.enqueue({ channel: "sms", recipient: ownerPhone, body: p.readback, cause_id: `feedback_request:${p.short_id}`, sensitive: true });
        record("feedback_request", { proposal_id: p.short_id, booking_id: b.booking_id });
        proposed.push(p.short_id);
      }
    }
    const digest = tagger ? queuePainPointDigest(store, outbox, tagger, { now: now() }) : null;
    if (digest) record("feedback_digest", { id: digest.key.slice(0, 16), cards: digest.cards });
    return { proposed, digest: digest ? { cards: digest.cards } : null };
  }

  /** Pull every source once, process new events, run the feedback step, then send what is queued. */
  async function ingest() {
    const results = [];
    for (const src of sources) for (const ev of await src.fetchEvents({ now })) results.push(handleEvent(ev));
    const fb = feedbackTick();
    if (fb.proposed.length || fb.digest) results.push({ feedback: fb });
    results.push(...(await outbox.dispatch()).map((r) => ({ outbox: r.status })));
    return results;
  }

  /** Apply one approved proposal (loaded from the store). Local effects are idempotent; publishing is idempotent. */
  async function executeStored(row) {
    const change = changeFor(row);
    if (!change) return { ok: false, reason: `no executor for ${row.kind}` };
    // Codex review (A): verify the stored approval and digest BEFORE any local effect.
    const candidate = { ...change };
    delete candidate.kind;
    if (!verify(candidate)) return { ok: false, reason: "approval_invalid" };
    const body = JSON.parse(row.body);
    if (row.kind === "close_day" || row.kind === "reopen_day") {
      store.transaction(() => {
        const closed = store.getKV(CLOSED_DAYS_KV, {});
        if (row.kind === "reopen_day") delete closed[body.date];
        else closed[body.date] = { approval_id: change.approval_id };
        store.setKV(CLOSED_DAYS_KV, closed);
      });
    } else if (row.kind === "capacity" || row.kind === "price") {
      const field = row.kind === "capacity"
        ? { capacity_per_tour: body.capacity_per_tour }
        : { price_per_person_kes: body.price_per_person.amount_minor / 100 };
      store.transaction(() => store.setKV(SHEET_OVERRIDES_KV, { ...store.getKV(SHEET_OVERRIDES_KV, {}), ...field }));
      Object.assign(sheet, field);
    }
    const { kind, ...payload } = change;
    return kind === "availability" ? publisher.publishAvailability(payload) : publisher.publishListing(payload);
  }

  /**
   * Noor's decision on a tourist's booking request: decideBookingRequest re-reads the stored proposal (state and
   * digest), re-checks availability by code and writes the booking; the hub only queues the resulting SMS.
   * Idempotent: the outbox keys on (recipient, body, cause), and a repeated decision returns `already`.
   */
  function applyBookingDecision(row, decision) {
    const d = decideBookingRequest(store, sheet, row, decision, now(), { translator });
    if (!d.ok) return d;
    const tag = decision.type === "suggest" ? `suggest:${now().toISOString()}` : d.outcome;
    if (d.tourist_sms && d.tourist_recipient) {
      outbox.enqueue({ channel: "sms", recipient: d.tourist_recipient, body: d.tourist_sms, cause_id: `booking_request:${d.proposal_id}:${tag}` });
    }
    if (d.owner_sms && owner()) {
      outbox.enqueue({ channel: "sms", recipient: owner(), body: d.owner_sms, cause_id: `booking_request:${d.proposal_id}:owner:${tag}` });
    }
    if (d.booking && !d.already) record("booking_confirmed", { id: d.booking.booking_id, date: d.booking.request.date, party_size: d.booking.request.party_size });
    return { ok: true, outcome: d.outcome, booking_id: d.booking?.booking_id ?? null };
  }

  /** Run the stored, decided work for one proposal row, by kind. */
  async function executeDecided(row) {
    if (row.kind === BOOKING_REQUEST) return applyBookingDecision(row, { type: row.state === "approved" ? "approve" : "reject" });
    if (row.kind === FEEDBACK_REQUEST) {
      return executeApprovedFeedbackRequest(store, outbox, { type: "approve", kind: row.kind, proposal_id: row.short_id, digest: row.digest }, { now: now() });
    }
    return executeStored(row);
  }

  /**
   * Codex review (2): decided work is durable. Redeeming the code already persisted state 'approved' (HAPANA on a
   * booking request persisted 'rejected'); this runs every decided proposal not yet executed (after each SMS and
   * at startup), so a crash in between loses nothing.
   */
  async function runApproved() {
    const rows = store.db.prepare(
      "SELECT short_id, kind, digest, state, body FROM proposals WHERE state = 'approved' OR (state = 'rejected' AND kind = ?) ORDER BY short_id",
    ).all(BOOKING_REQUEST);
    const done = [];
    for (const row of rows) {
      if (store.getKV(EXECUTED_KV + row.short_id)) continue;
      const result = await executeDecided(row);
      store.setKV(EXECUTED_KV + row.short_id, { ok: Boolean(result.ok), at: now().toISOString() });
      record(row.state === "approved" ? "owner_approval" : "owner_decline", {
        proposal_id: row.short_id, kind: row.kind, ok: Boolean(result.ok), via: "sms_one_time_code",
      });
      if (result.alert) record("platform_alert", { id: result.alert.id, kind: result.alert.kind, blocked_days: result.alert.blocked_days });
      done.push({ proposal_id: row.short_id, kind: row.kind, ...result });
    }
    return done;
  }

  /** At process start: resolve uncertain outbound rows, then finish decided work interrupted by a crash. */
  async function recover() {
    const outboxRows = await outbox.recover();
    const executed = await runApproved();
    return { outbox: outboxRows, executed };
  }

  /**
   * An SMS from any number to the hub's owner line. A read-only query (LEO, KESHO, WAGENI 17/10...) is answered
   * to Noor's ENROLLED number only; anything else is a command (one-time codes, commands.mjs).
   */
  async function ownerSms(sms) {
    const q = answerOwnerQuery(store, sheet, sms, now());
    if (q) {
      const n = spend(QUERY_BUDGET_KV, lim.maxQueryRepliesPerDay);
      if (n) outbox.enqueue({ channel: "sms", recipient: q.recipient, body: q.reply, cause_id: `query:${eatDate(now())}:${n}` });
      await outbox.dispatch();
      return { command: "query", query: q.query, reply_sent: Boolean(n), executed: null };
    }
    const r = handleOwnerSms(store, sms, { now: now() });
    if (r.reply && r.recipient) {
      outbox.enqueue({ channel: "sms", recipient: r.recipient, body: r.reply, cause_id: `reply:${now().toISOString()}`, sensitive: r.sensitive });
    }
    let relayed = null;
    if (r.command?.type === "suggest") {
      // Noor's words to the tourist ("A 482113 nitachelewa kidogo"): the code was checked, not spent.
      relayed = applyBookingDecision({ short_id: r.command.proposal_id, digest: r.command.digest }, { type: "suggest", text: r.command.text });
    }
    if (r.command && r.command.type !== "approve") record(`owner_${r.command.type}`, { proposal_id: r.command.proposal_id, kind: r.command.kind });
    // The command object never drives execution: only proposals stored as approved (or declined) do.
    const executed = await runApproved();
    await outbox.dispatch();
    return { command: r.command?.type ?? null, reply_sent: Boolean(r.reply), executed: executed[0] ?? null, ...(relayed ? { relayed } : {}) };
  }

  return { handleEvent, ingest, ownerSms, runApproved, recover, feedbackTick, publisher };
}
