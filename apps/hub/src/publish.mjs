// Availability / listing updates to booking platforms (README requirement 5), as queued outbound actions.
//
// Only an APPROVED change gets in: every change must carry { approved: true, approval_id, digest } (the approval
// record from the core's approveExact and the envelope digest it approved). Anything else is refused with
// PublishRefusedError before anything is written. A REQUIRED verifyApproval(change) hook makes the hub check the
// approval record in its own store as well.
//
// Per platform: one outbox row keyed by sha256(platform, kind, approval_id, digest). The row is written "queued",
// set to "sending" BEFORE the adapter call, then "sent" or "failed". A replay of the same approval never re-sends
// a "sent" row, and a row left in "sending" (crash mid-call) is reported "needs_reconcile", never resent blindly.
//
// Fail-safe (team plan, W5): if ANY platform fails, the affected days are blocked locally (kv "publish.blocked_days",
// read by the calendar/booking path) and a structured alert is returned and queued in kv "publish.alerts" for the
// module that renders alerts to Noor. Never risk a double booking.
//
// Adapters: simulated (JSONL log, default, synthetic:true), getyourguide and booking_com stubs (src/platforms/).
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { simulatedOutbound } from "./transports/simulated.mjs";
import { getYourGuideAdapter } from "./platforms/getyourguide.mjs";
import { bookingComAdapter } from "./platforms/booking_com.mjs";
export { NotConfiguredError, NotImplementedError, UnsupportedByPlatformError } from "./platforms/errors.mjs";

export const BLOCKED_DAYS_KV = "publish.blocked_days";
export const ALERTS_KV = "publish.alerts";
const HEX64_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PLATFORM_RE = /^[a-z0-9_]{1,32}$/;

export class PublishRefusedError extends Error {
  constructor(code, message) { super(message); this.name = "PublishRefusedError"; this.code = code; }
}

// ---------------------------------------------------------------- adapters

/** Default adapter: appends each outbound platform action to a JSONL log, marked synthetic. Works offline. */
export function simulatedPlatform(logPath, name = "simulated") {
  const out = simulatedOutbound(logPath);
  const send = (op) => async (item) => out.send({ ...item, platform: name, op, synthetic: true });
  return { name, configured: () => true, sendAvailability: send("availability"), sendListing: send("listing"), log: out.log };
}

/**
 * Adapter set chosen by config. SAUTI_PUBLISH_MODE=real selects the GYG + Booking.com adapters (which throw
 * NotConfiguredError without credentials); anything else (default) is the simulated JSONL adapter.
 */
export function platformAdapters({ env = process.env, logPath = fileURLToPath(new URL("../var/outbound/platform.jsonl", import.meta.url)) } = {}) {
  if (env.SAUTI_PUBLISH_MODE === "real") return { getyourguide: getYourGuideAdapter({ env }), booking_com: bookingComAdapter({ env }) };
  return { simulated: simulatedPlatform(logPath) };
}

// ---------------------------------------------------------------- validation

function isRealDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function requireApproved(change) {
  if (change === null || typeof change !== "object") throw new PublishRefusedError("not_approved", "change must be an object from an approved proposal");
  if (change.approved !== true) throw new PublishRefusedError("not_approved", "change is not approved");
  if (typeof change.approval_id !== "string" || change.approval_id.length < 1 || change.approval_id.length > 128) {
    throw new PublishRefusedError("missing_approval_id", "approval_id is required");
  }
  if (typeof change.digest !== "string" || !HEX64_RE.test(change.digest)) throw new PublishRefusedError("missing_digest", "digest (64 hex) is required");
}

function validatePlatforms(change, adapters) {
  const platforms = change.platforms ?? Object.keys(adapters);
  if (!Array.isArray(platforms) || platforms.length === 0) throw new PublishRefusedError("invalid_platforms", "platforms must be a non-empty array");
  for (const p of platforms) {
    if (typeof p !== "string" || !PLATFORM_RE.test(p)) throw new PublishRefusedError("invalid_platforms", "invalid platform name");
    if (!adapters[p]) throw new PublishRefusedError("unknown_platform", `no adapter for platform ${p}`);
  }
  return [...new Set(platforms)];
}

function validateDays(days) {
  if (!Array.isArray(days) || days.length === 0 || days.length > 366) throw new PublishRefusedError("invalid_days", "days must be a non-empty array (max 366)");
  return days.map((d) => {
    if (!d || typeof d !== "object" || !isRealDate(d.date)) throw new PublishRefusedError("invalid_days", "each day needs a valid YYYY-MM-DD date");
    if (typeof d.open !== "boolean") throw new PublishRefusedError("invalid_days", "each day needs open: true|false");
    if (d.capacity !== undefined && !(Number.isInteger(d.capacity) && d.capacity >= 0 && d.capacity <= 200)) {
      throw new PublishRefusedError("invalid_days", "capacity must be an integer 0..200");
    }
    return d.capacity === undefined ? { date: d.date, open: d.open } : { date: d.date, open: d.open, capacity: d.capacity };
  });
}

function validateFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new PublishRefusedError("invalid_fields", "fields must be an object");
  const keys = Object.keys(fields);
  if (keys.length === 0 || keys.length > 40) throw new PublishRefusedError("invalid_fields", "fields must have 1..40 entries");
  for (const k of keys) {
    const v = fields[k];
    const ok = v === null || typeof v === "string" || typeof v === "boolean" || Number.isInteger(v);
    if (!ok || k.length > 64) throw new PublishRefusedError("invalid_fields", "field values must be string, integer, boolean or null");
  }
  return { ...fields };
}

// ---------------------------------------------------------------- publisher

/**
 * @param {object} opts
 * @param {ReturnType<import("./store.mjs").openStore>} opts.store
 * @param {Record<string, {sendAvailability: Function, sendListing: Function}>} [opts.adapters] default: platformAdapters()
 * @param {(change: object) => boolean} [opts.verifyApproval] extra check against the hub's approval records
 */
export function createPublisher({ store, adapters = platformAdapters(), verifyApproval, now = () => new Date() } = {}) {
  if (!store) throw new Error("createPublisher needs a store");
  // Codex review (1): publishing is bound to a stored, approved proposal. There is no default: a publisher without
  // a verifier would trust caller-supplied approved/id/digest fields.
  if (typeof verifyApproval !== "function") throw new Error("createPublisher needs verifyApproval(change) bound to stored approvals");
  const getRow = store.db.prepare("SELECT status, body FROM outbox WHERE idempotency_key = ?");
  const insertRow = store.db.prepare(
    "INSERT OR IGNORE INTO outbox (idempotency_key, channel, recipient, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)",
  );
  const setStatus = store.db.prepare("UPDATE outbox SET status = ?, updated_at = ? WHERE idempotency_key = ?");

  async function publish(kind, change, payload) {
    if (verifyApproval(change) !== true) throw new PublishRefusedError("approval_not_found", "approval record not found, not approved, or content differs");
    const platforms = validatePlatforms(change, adapters);
    const results = [];
    for (const platform of platforms) {
      const key = createHash("sha256").update(`sauti.publish.v1\0${platform}\0${kind}\0${change.approval_id}\0${change.digest}`).digest("hex");
      const item = { idempotency_key: key, kind, approval_id: change.approval_id, digest: change.digest, ...payload };
      // Queue (or find) the row and claim it for sending in one transaction: the pinned body is what is sent.
      const claim = store.transaction(() => {
        const at = now().toISOString();
        insertRow.run(key, `platform:${platform}`, platform, JSON.stringify(item), at, at);
        const row = getRow.get(key);
        if (row.status === "sent") return { skip: "already_sent" };
        if (row.status === "sending" || row.status === "uncertain") return { skip: "needs_reconcile" };
        setStatus.run("sending", at, key);
        return { body: JSON.parse(row.body) };
      });
      if (claim.skip) { results.push({ platform, status: claim.skip, idempotency_key: key }); continue; }
      const adapter = adapters[platform];
      try {
        const sent = await (kind === "availability" ? adapter.sendAvailability(claim.body) : adapter.sendListing(claim.body));
        setStatus.run("sent", now().toISOString(), key);
        results.push({ platform, status: "sent", ref: sent?.ref ?? null, idempotency_key: key, simulated: platform === "simulated" });
      } catch (err) {
        const code = typeof err?.code === "string" && /^[a-z_]{1,40}$/.test(err.code) ? err.code : "platform_error";
        // Codex review (3): only a PROVEN non-acceptance may be retried. A timeout or unknown error after the call may
        // have been accepted upstream: it stays "uncertain" (needs_reconcile), never resent automatically.
        const provenNotAccepted = err?.notAccepted === true || ["not_configured", "not_implemented", "unsupported_by_platform"].includes(code);
        setStatus.run(provenNotAccepted ? "failed" : "uncertain", now().toISOString(), key);
        // Our adapter errors carry safe messages (env var NAMES only); anything else is not echoed.
        const safe = ["not_configured", "not_implemented", "unsupported_by_platform"].includes(code);
        results.push({ platform, status: provenNotAccepted ? "failed" : "uncertain", code, ...(safe ? { message: err.message } : {}), idempotency_key: key });
      }
    }
    return failSafe(kind, change, payload, results);
  }

  function failSafe(kind, change, payload, results) {
    const failed = results.filter((r) => ["failed", "uncertain", "needs_reconcile"].includes(r.status));
    const dates = kind === "availability" ? payload.days.map((d) => d.date) : [];
    const at = now().toISOString();
    if (failed.length === 0) {
      // Every platform is in step for this approval: lift blocks this approval had placed.
      if (dates.length) store.transaction(() => {
        const blocked = store.getKV(BLOCKED_DAYS_KV, {});
        for (const d of dates) if (blocked[d]?.approval_id === change.approval_id) delete blocked[d];
        store.setKV(BLOCKED_DAYS_KV, blocked);
      });
      return { ok: true, results, blocked_days: [], alert: null };
    }
    const alert = {
      id: randomUUID(),
      type: "platform_sync_failed",
      severity: "high",
      kind,
      approval_id: change.approval_id,
      digest: change.digest,
      platforms: failed.map((r) => ({ platform: r.platform, code: r.code ?? r.status })),
      blocked_days: dates,
      // Facts for the renderer (notify.mjs builds the Swahili text): code-made, no model, no PII.
      advice: kind === "availability" ? "days_blocked_locally_check_platform" : "apply_listing_change_manually",
      created_at: at,
    };
    store.transaction(() => {
      if (dates.length) {
        const blocked = store.getKV(BLOCKED_DAYS_KV, {});
        for (const d of dates) blocked[d] = { reason: "platform_sync_failed", approval_id: change.approval_id, platforms: alert.platforms.map((p) => p.platform), since: at };
        store.setKV(BLOCKED_DAYS_KV, blocked);
      }
      const alerts = store.getKV(ALERTS_KV, []);
      alerts.push(alert);
      store.setKV(ALERTS_KV, alerts.slice(-500));
    });
    return { ok: false, results, blocked_days: dates, alert };
  }

  return {
    /** change: { approved: true, approval_id, digest, days: [{ date, open, capacity? }], platforms?, listing_id? } */
    async publishAvailability(change) {
      requireApproved(change);
      const days = validateDays(change.days);
      return publish("availability", change, { days, listing_id: typeof change.listing_id === "string" ? change.listing_id.slice(0, 128) : null });
    },
    /** change: { approved: true, approval_id, digest, fields: { key: string|int|bool|null }, platforms?, listing_id? } */
    async publishListing(change) {
      requireApproved(change);
      const fields = validateFields(change.fields);
      return publish("listing", change, { fields, listing_id: typeof change.listing_id === "string" ? change.listing_id.slice(0, 128) : null });
    },
  };
}

/** Days the calendar must treat as unavailable until a platform sync succeeds. */
export function blockedDays(store) { return store.getKV(BLOCKED_DAYS_KV, {}); }

/** Alerts for the rendering module; it removes what it has delivered with ackPublishAlerts. */
export function pendingPublishAlerts(store) { return store.getKV(ALERTS_KV, []); }
export function ackPublishAlerts(store, ids) {
  const drop = new Set(ids);
  store.transaction(() => store.setKV(ALERTS_KV, store.getKV(ALERTS_KV, []).filter((a) => !drop.has(a.id))));
}
