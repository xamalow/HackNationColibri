// Owner alert calls as a PULL queue for hub-voice's "sauti-alert" worker (warden #47770; worker merged in #65-#67).
//
// The hub decides WHEN to call and WHICH clips (notify.mjs); hub-voice places the call through its LiveKit SIP trunk
// to the number in ITS OWN configuration (SAUTI_OWNER_E164) and reports back. No LiveKit code here, and in this mode
// the Twilio adapter never sees a call (it stays SMS-only).
//
//   GET  /v1/owner-alerts/pending            -> 200 { pending: [{ alert_id, device_id, clip_keys, urgent, created_at }],
//                                                     cap: { day, listed, max } }      (call device only; never a number)
//   POST /v1/owner-alerts/{alert_id}/result  <- { status, played, missing, reason? }
//                                            -> 200 { alert_id, state, changed }
//
// Shapes are exactly what apps/hub-voice/hub_voice/{hubclient,outbound}.py parse and send (contract test:
// test/owner_alert_calls.test.mjs). Rules this module keeps, each tested:
// - One call per alert: the row is keyed by alert_id (UNIQUE, INSERT OR IGNORE); queueing the same alert twice is a no-op.
// - Enrolled owner only: a call is queued only while kv owner.phone is set, bound to the sha256 of that number, and
//   listed only while the enrolled number is still the same. The number itself is never stored here, never listed,
//   never accepted from a request: no route takes a recipient. Items carry only the call device id (see below).
// - The call device: kv "owner.call_device" names the ONE paired device (sync.mjs pair) that places owner calls; it
//   is the item's device_id, which the worker compares with its SAUTI_OWNER_DEVICE_ID. Only that device may read the
//   pending list or post results (403 otherwise); no designated device -> nothing is listed.
// - Daily cap (farm day, EAT): at most `maxPerDay` (default 6) calls are RELEASED to the worker per day. A call is
//   released (stamped listed_day, durable) the first time it appears in a pending list; re-reading the list returns
//   the same released calls and never releases more than the cap. Unreleased calls wait (urgent first) and age out.
// - No retry storm: the hub lists a call until a "dispatched" or terminal result arrives, then never again; the hub
//   never asks for a second dial. A call older than `maxAgeMinutes` (default 120) is no longer listed (the SMS
//   already carried every fact). The worker's own ledger dedupes by alert_id on top of this.
// - Clips: a call is listed only if every clip key is in the experience manifest (the worker refuses unknown keys
//   and never plays half a sentence); otherwise it is held (count reported as held.missing_clips) and the SMS stands.
// - Results: only from the call device, only for a released call, status from a closed set, keys only from the
//   listed clip_keys. A repeated result is idempotent (200, changed: false); "dispatched" then "answered" /
//   "no_answer" / "failed" are separate facts accepted in that order; anything else after a final state is 409.
//   Every accepted result becomes a hub event (kind "owner_alert_call", no number) that Noor's app syncs.
// - Errors are JSON { error: { code, message } }, value-free (an id or a body is never echoed). This module does not log.
import { createHash } from "node:crypto";
import { normalizePhone } from "./commands.mjs";

/** The farm day (East Africa Time, UTC+3, no DST) of an instant, YYYY-MM-DD. Same rule as booking_requests.eatDate. */
const eatDate = (t) => new Date(t.getTime() + 3 * 3600_000).toISOString().slice(0, 10);

export const CALL_DEVICE_KV = "owner.call_device";
export const ALERT_CALL_DEFAULTS = Object.freeze({ maxPerDay: 6, maxAgeMinutes: 120 });
/** What the worker may report (hub_voice/outbound.py RESULT_STATUSES). */
export const RESULT_STATUSES = Object.freeze(["refused", "simulated", "dispatched", "answered", "no_answer", "failed"]);
const FINAL = new Set(["refused", "simulated", "answered", "no_answer", "failed"]);
const AFTER_DISPATCH = new Set(["answered", "no_answer", "failed"]);
export const ALERT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/; // outbound.py ALERT_ID
export const CLIP_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/; // outbound.py CLIP_KEY
export const MAX_CLIPS = 20; // outbound.py MAX_CLIPS
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/; // sync.mjs pairDevice
const REASON_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ROUTE_RE = /^\/v1\/owner-alerts\/([^/]*)\/result$/;
export const ALERT_CALL_MAX_BODY_BYTES = 4 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_alert_calls (
  alert_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, kind TEXT NOT NULL, urgent INTEGER NOT NULL, clip_keys TEXT NOT NULL,
  clips_ready INTEGER NOT NULL, owner_sha256 TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
  listed_day TEXT, listed_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_alert_call_results (
  alert_id TEXT NOT NULL, status TEXT NOT NULL, played TEXT NOT NULL, missing TEXT NOT NULL, reason TEXT,
  device_id TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY (alert_id, status));
`;
const ready = new WeakSet();
export function ensureAlertCallSchema(store) {
  if (ready.has(store)) return;
  store.db.exec(SCHEMA);
  ready.add(store);
}

/** sha256 of the enrolled number in its canonical "+<digits>" form (the number is never stored here). */
export function ownerRef(phone) {
  const digits = normalizePhone(phone);
  return digits ? createHash("sha256").update(`+${digits}`, "utf8").digest("hex") : null;
}

/** The public alert id: the hub's alert row id when it fits the worker's pattern, else an opaque hash of it. */
export function publicAlertId(alertRowId) {
  const s = String(alertRowId);
  return ALERT_ID_RE.test(s) ? s : `alert-h${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Queue the owner-alert call for hub-voice, once per alert. Called by notify.queueOwnerAlert in "pull" mode.
 * @param {{ alertRowId: string, event_id: string, kind: string, urgent: boolean, clips: string[], knownClips: Set<string>,
 *           now?: Date }} a
 * @returns {{ alert_id: string, created: boolean, clips_ready: boolean } | null} null when no owner is enrolled
 */
export function queueAlertCall(store, { alertRowId, event_id, kind, urgent, clips, knownClips, now = new Date() }) {
  ensureAlertCallSchema(store);
  const ref = ownerRef(store.getKV("owner.phone"));
  if (!ref) return null;
  const keys = Array.isArray(clips) ? clips.filter((k) => typeof k === "string") : [];
  const clipsReady = keys.length > 0 && keys.length <= MAX_CLIPS && keys.every((k) => CLIP_KEY_RE.test(k) && knownClips.has(k));
  const alert_id = publicAlertId(alertRowId);
  const at = now.toISOString();
  const created = store.db.prepare(
    `INSERT OR IGNORE INTO owner_alert_calls (alert_id, event_id, kind, urgent, clip_keys, clips_ready, owner_sha256, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(alert_id, String(event_id), String(kind), urgent ? 1 : 0, JSON.stringify(keys), clipsReady ? 1 : 0, ref, at, at).changes === 1;
  return { alert_id, created, clips_ready: clipsReady };
}

/** Designate the paired device that places owner calls (its id is the worker's SAUTI_OWNER_DEVICE_ID). */
export function setCallDevice(store, deviceId) {
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) throw new Error("device id must match [A-Za-z0-9._-]{1,64}");
  const paired = (store.getKV("sync.tokens", []) ?? []).some((t) => t?.device_id === deviceId);
  if (!paired) throw new Error("that device is not paired: pair it first (sync.mjs pair <device-id>)");
  store.setKV(CALL_DEVICE_KV, deviceId);
}

/** One call row as the module sees it (tests, the demo). Never a number. */
export function alertCallState(store, alertId) {
  ensureAlertCallSchema(store);
  const r = store.db.prepare("SELECT alert_id, event_id, kind, urgent, clip_keys, clips_ready, state, created_at, listed_day FROM owner_alert_calls WHERE alert_id = ?").get(alertId);
  if (!r) return null;
  const results = store.db.prepare("SELECT status, played, missing, reason, received_at FROM owner_alert_call_results WHERE alert_id = ? ORDER BY rowid").all(alertId)
    .map((x) => ({ status: x.status, played: JSON.parse(x.played), missing: JSON.parse(x.missing), reason: x.reason, received_at: x.received_at }));
  return { ...r, urgent: Boolean(r.urgent), clips_ready: Boolean(r.clips_ready), clip_keys: JSON.parse(r.clip_keys), results };
}

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

function keyList(v, name, allowed) {
  if (!Array.isArray(v) || v.length > MAX_CLIPS) fail(400, `invalid_${name}`, `${name} must be a list of at most ${MAX_CLIPS} clip keys`);
  for (const k of v) {
    if (typeof k !== "string" || !CLIP_KEY_RE.test(k)) fail(400, `invalid_${name}`, `${name} must hold clip keys`);
    if (!allowed.has(k)) fail(400, `invalid_${name}`, `${name} holds a key that was not listed for this call`);
  }
  return v;
}

/**
 * @param {{ store, now?: () => Date, maxPerDay?: number, maxAgeMinutes?: number }} deps
 * @returns {{ handle: (req: { method: string, url: URL, device: string, readBody: () => Promise<unknown> }) => Promise<{status:number, body:object}|null>,
 *            pending: (device: string) => object, result: (alertId: string, body: unknown, device: string) => object }}
 */
export function createOwnerAlertCallApi({ store, now = () => new Date(), maxPerDay = ALERT_CALL_DEFAULTS.maxPerDay, maxAgeMinutes = ALERT_CALL_DEFAULTS.maxAgeMinutes } = {}) {
  if (!store) throw new Error("createOwnerAlertCallApi needs a store");
  if (!Number.isInteger(maxPerDay) || maxPerDay < 0 || maxPerDay > 200) throw new TypeError("maxPerDay must be an integer 0..200");
  if (!Number.isInteger(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 24 * 60) throw new TypeError("maxAgeMinutes must be an integer 1..1440");
  ensureAlertCallSchema(store);
  const db = store.db;

  function requireCallDevice(device) {
    const callDevice = store.getKV(CALL_DEVICE_KV);
    if (!callDevice) return null;
    if (device !== callDevice) fail(403, "not_call_device", "this device does not place owner calls");
    return callDevice;
  }

  /** The calls released to the worker (stamping new releases under the daily cap, in one transaction). */
  function pending(device) {
    const day = eatDate(now());
    const callDevice = requireCallDevice(device);
    const cap = () => ({ day, listed: db.prepare("SELECT COUNT(*) AS n FROM owner_alert_calls WHERE listed_day = ?").get(day).n, max: maxPerDay });
    if (!callDevice) return { pending: [], cap: cap(), reason: "no_call_device" };
    const ref = ownerRef(store.getKV("owner.phone"));
    if (!ref) return { pending: [], cap: cap(), reason: "no_owner_enrolled" };
    const t = now();
    const since = new Date(t.getTime() - maxAgeMinutes * 60_000).toISOString();
    return store.transaction(() => {
      const rows = db.prepare(
        `SELECT alert_id, urgent, clip_keys, created_at, listed_day FROM owner_alert_calls
         WHERE state = 'pending' AND clips_ready = 1 AND owner_sha256 = ? AND created_at >= ?
         ORDER BY urgent DESC, created_at, alert_id`,
      ).all(ref, since);
      let listed = cap().listed;
      const out = [];
      for (const r of rows) {
        if (!r.listed_day) {
          if (listed >= maxPerDay) continue;
          db.prepare("UPDATE owner_alert_calls SET listed_day = ?, listed_at = ?, updated_at = ? WHERE alert_id = ? AND listed_day IS NULL")
            .run(day, t.toISOString(), t.toISOString(), r.alert_id);
          listed++;
        }
        out.push({ alert_id: r.alert_id, device_id: callDevice, clip_keys: JSON.parse(r.clip_keys), urgent: Boolean(r.urgent), created_at: r.created_at });
      }
      const held = db.prepare("SELECT COUNT(*) AS n FROM owner_alert_calls WHERE state = 'pending' AND clips_ready = 0 AND created_at >= ?").get(since).n;
      return { pending: out, cap: { day, listed, max: maxPerDay }, held: { missing_clips: held } };
    });
  }

  function result(alertId, raw, device) {
    if (typeof alertId !== "string" || !ALERT_ID_RE.test(alertId)) fail(400, "invalid_alert_id", "alert id has an invalid format");
    if (!requireCallDevice(device)) fail(403, "not_call_device", "no device is designated to place owner calls");
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(400, "invalid_body", "body must be a JSON object");
    for (const k of Object.keys(raw)) if (!["status", "played", "missing", "reason"].includes(k)) fail(400, "unknown_field", "unknown field in body");
    if (!RESULT_STATUSES.includes(raw.status)) fail(400, "invalid_status", `status must be one of ${RESULT_STATUSES.join(", ")}`);
    if (raw.reason !== undefined && (typeof raw.reason !== "string" || raw.reason.length > 64)) fail(400, "invalid_reason", "reason must be a string of at most 64 characters");
    // A reason that is not a plain code (it could carry anything) is kept as "other": never stored or synced verbatim.
    const reason = raw.reason === undefined || raw.reason === "" ? null : REASON_RE.test(raw.reason) ? raw.reason : "other";

    return store.transaction(() => {
      const row = db.prepare("SELECT alert_id, event_id, clip_keys, state, listed_day FROM owner_alert_calls WHERE alert_id = ?").get(alertId);
      if (!row) fail(404, "unknown_alert", "no such owner alert call");
      const listedKeys = new Set(JSON.parse(row.clip_keys));
      const played = keyList(raw.played, "played", listedKeys);
      const missing = keyList(raw.missing, "missing", listedKeys);
      const status = raw.status;
      const repeat = db.prepare("SELECT status FROM owner_alert_call_results WHERE alert_id = ? AND status = ?").get(alertId, status);
      if (repeat) return { alert_id: alertId, state: row.state, changed: false }; // the same fact again: nothing changes
      if (!row.listed_day) fail(409, "not_released", "this call was never listed to a worker");
      const ok = row.state === "pending" || (row.state === "dispatched" && AFTER_DISPATCH.has(status));
      if (!ok) fail(409, "already_final", "this call already has a final result");
      const at = now().toISOString();
      db.prepare("INSERT INTO owner_alert_call_results (alert_id, status, played, missing, reason, device_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(alertId, status, JSON.stringify(played), JSON.stringify(missing), reason, device, at);
      db.prepare("UPDATE owner_alert_calls SET state = ?, updated_at = ? WHERE alert_id = ?").run(status, at, alertId);
      // Noor's app sees what happened to the call (no number, no free text).
      store.addEvent({
        id: `owner_alert_call:${alertId}:${status}`, kind: "owner_alert_call", channel: "hub", received_at: at, synthetic: false,
        alert_id: alertId, event_id: row.event_id, status, final: FINAL.has(status), played, missing, reason,
      });
      return { alert_id: alertId, state: status, changed: true };
    });
  }

  async function handle({ method, url, device, readBody }) {
    const path = url.pathname;
    if (path !== "/v1/owner-alerts/pending" && !path.startsWith("/v1/owner-alerts/")) return null;
    try {
      if (path === "/v1/owner-alerts/pending") {
        if (method !== "GET") fail(405, "method_not_allowed", "use GET");
        return { status: 200, body: pending(device) };
      }
      const m = ROUTE_RE.exec(path);
      if (!m) fail(404, "not_found", "no such route");
      if (method !== "POST") fail(405, "method_not_allowed", "use POST");
      let id;
      try { id = decodeURIComponent(m[1]); } catch { fail(400, "invalid_alert_id", "alert id has an invalid format"); }
      if (!ALERT_ID_RE.test(id)) fail(400, "invalid_alert_id", "alert id has an invalid format");
      requireCallDevice(device);
      return { status: 200, body: result(id, await readBody(), device) };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: { code: err.code, message: err.message } } };
      throw err;
    }
  }

  return { handle, pending, result };
}
