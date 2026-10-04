// Idempotent dispatch of outbound SMS and calls through a transport (simulated by default).
//
// Row lifecycle (store table `outbox`):
//   QUEUED --mark (committed)--> SENDING --transport.send ok--> SENT
//                                        --send threw, error.notAccepted === true--> FAILED (retried, same key)
//                                        --notAccepted and (error.permanent === true or maxAttempts reached)--> REFUSED
//                                        --send threw otherwise--> UNCERTAIN (never resent automatically)
//   REFUSED is final: the item was provably never sent and is not retried (e.g. a call while no clip URL is
//   configured, an invalid number, or a provider that refused it maxAttempts times). Before this state existed, an
//   item refused before the request was retried on every dispatch, forever.
//   on restart, SENDING --transport.wasSent(key)--> true: SENT | false: QUEUED (proven not sent) | else: UNCERTAIN
//
// idempotency_key = sha256 over (channel, recipient, body, cause_id), length-prefixed so fields cannot collide.
// The same logical message enqueued twice is one row and is sent at most once.
// Transport contract: send(item) -> { ref } (sync or async); wasSent(key) -> true | false (definitive) | null (unknown).
// Recipient numbers and bodies are never logged; this module does not log at all.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { simulatedOutbound } from "./transports/simulated.mjs";

export const STATUS = Object.freeze({
  QUEUED: "QUEUED", SENDING: "SENDING", SENT: "SENT", FAILED: "FAILED", UNCERTAIN: "UNCERTAIN", REFUSED: "REFUSED",
});
export const DEFAULT_MAX_ATTEMPTS = 5;
export const CHANNELS = new Set(["sms", "call"]);
const SENSITIVE_PREFIX = "outbox.sensitive.";
const ATTEMPTS_PREFIX = "outbox.attempts.";
const REDACTED = "[redacted after send]";

export function idempotencyKey({ channel, recipient, body, cause_id }) {
  const h = createHash("sha256");
  for (const part of [channel, recipient, body, cause_id]) {
    const buf = Buffer.from(String(part ?? ""), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    h.update(len).update(buf);
  }
  return h.digest("hex");
}

export const DEFAULT_SIM_LOG = fileURLToPath(new URL("../var/outbound.jsonl", import.meta.url));

/**
 * @param store   openStore() result
 * @param transport outbound transport; defaults to the simulated JSONL log
 * @param {{ now?: () => Date, maxAttempts?: number }} [opts] maxAttempts: provider refusals (notAccepted) before REFUSED
 */
export function createOutbox(store, transport = simulatedOutbound(DEFAULT_SIM_LOG), { now = () => new Date(), maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");
  const db = store.db;
  const ts = () => now().toISOString();
  const setStatus = (key, to, from) => db.prepare(
    `UPDATE outbox SET status = ?, updated_at = ? WHERE idempotency_key = ? AND status IN (${from.map(() => "?").join(", ")})`,
  ).run(to, ts(), key, ...from).changes === 1;
  const redactIfSensitive = (key) => {
    if (store.getKV(SENSITIVE_PREFIX + key) === null) return;
    store.transaction(() => {
      db.prepare("UPDATE outbox SET body = ? WHERE idempotency_key = ?").run(REDACTED, key);
      db.prepare("DELETE FROM kv WHERE k = ?").run(SENSITIVE_PREFIX + key);
    });
  };

  return {
    /**
     * Queue a message once. `sensitive: true` (e.g. a read-back carrying a one-time code) blanks the stored
     * body once the row is SENT or UNCERTAIN, so the code does not linger in the database.
     * @returns {{ key: string, created: boolean }}
     */
    enqueue({ channel, recipient, body, cause_id, sensitive = false }) {
      if (!CHANNELS.has(channel)) throw new Error("unsupported channel");
      if (!recipient || typeof body !== "string" || !body || !cause_id) throw new Error("incomplete outbound item");
      const key = idempotencyKey({ channel, recipient, body, cause_id });
      return store.transaction(() => {
        const created = db.prepare(
          "INSERT OR IGNORE INTO outbox (idempotency_key, channel, recipient, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(key, channel, recipient, body, STATUS.QUEUED, ts(), ts()).changes === 1;
        if (created && sensitive) store.setKV(SENSITIVE_PREFIX + key, true);
        return { key, created };
      });
    },

    get(key) {
      return db.prepare("SELECT idempotency_key, channel, status, created_at, updated_at FROM outbox WHERE idempotency_key = ?").get(key) ?? null;
    },

    list(status) {
      return db.prepare("SELECT idempotency_key, channel, status FROM outbox WHERE status = ? ORDER BY created_at, idempotency_key").all(status);
    },

    /** Number of rows waiting to be sent (QUEUED or FAILED). */
    pending() {
      return db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status IN (?, ?)").get(STATUS.QUEUED, STATUS.FAILED).n;
    },

    /**
     * Send every QUEUED or FAILED row once, oldest first; with `max`, at most that many rows (the rest stay queued,
     * e.g. under a daily cost cap). Returns [{ key, status, channel, reason? }] (reason: the error code, no details).
     */
    async dispatch({ max = Infinity } = {}) {
      const rows = db.prepare(
        "SELECT idempotency_key, channel, recipient, body FROM outbox WHERE status IN (?, ?) ORDER BY created_at, idempotency_key",
      ).all(STATUS.QUEUED, STATUS.FAILED);
      const results = [];
      for (const row of rows) {
        if (results.length >= max) break;
        const key = row.idempotency_key;
        // Persist SENDING before the provider call; if another worker got here first, skip.
        if (!store.transaction(() => setStatus(key, STATUS.SENDING, [STATUS.QUEUED, STATUS.FAILED]))) continue;
        let status;
        let reason;
        try {
          await transport.send({ idempotency_key: key, channel: row.channel, recipient: row.recipient, body: row.body });
          status = STATUS.SENT;
        } catch (e) {
          reason = typeof e?.code === "string" ? e.code : "error";
          if (e && e.notAccepted === true) {
            const attempts = (store.getKV(ATTEMPTS_PREFIX + key, 0) ?? 0) + 1;
            status = e.permanent === true || attempts >= maxAttempts ? STATUS.REFUSED : STATUS.FAILED;
            if (status === STATUS.FAILED) store.setKV(ATTEMPTS_PREFIX + key, attempts);
          } else {
            status = STATUS.UNCERTAIN;
          }
        }
        setStatus(key, status, [STATUS.SENDING]);
        if (status !== STATUS.FAILED) {
          db.prepare("DELETE FROM kv WHERE k = ?").run(ATTEMPTS_PREFIX + key);
          redactIfSensitive(key);
        }
        results.push({ key, status, channel: row.channel, ...(reason ? { reason } : {}) });
      }
      return results;
    },

    /** Call once at process start, before dispatch(): resolve rows left in SENDING by a crash. */
    async recover() {
      const rows = db.prepare("SELECT idempotency_key FROM outbox WHERE status = ?").all(STATUS.SENDING);
      const results = [];
      for (const { idempotency_key: key } of rows) {
        let sent;
        try { sent = await transport.wasSent(key); } catch { sent = null; }
        const status = sent === true ? STATUS.SENT : sent === false ? STATUS.QUEUED : STATUS.UNCERTAIN;
        setStatus(key, status, [STATUS.SENDING]);
        if (status !== STATUS.QUEUED) redactIfSensitive(key);
        results.push({ key, status });
      }
      return results;
    },
  };
}
