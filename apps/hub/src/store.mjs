// Durable hub state in one SQLite file (node:sqlite). Parameterized SQL only.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL, received_at TEXT NOT NULL,
  body TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (
  booking_id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_ref TEXT, date TEXT NOT NULL,
  party_size INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
  UNIQUE (platform, external_ref));
CREATE TABLE IF NOT EXISTS proposals (
  short_id TEXT PRIMARY KEY, kind TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, sms TEXT NOT NULL, call TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (event_id));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  let queue = Promise.resolve(); // serializes transactionAsync
  const nextSeq = () => (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events").get().n);
  return {
    db,
    /** Insert an event once (dedupe on id). Returns true if new. */
    addEvent(ev) {
      const r = db.prepare(
        "INSERT OR IGNORE INTO events (id, kind, channel, received_at, body, synthetic, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ev.id, ev.kind, ev.channel, ev.received_at, JSON.stringify(ev), ev.synthetic ? 1 : 0, nextSeq());
      return r.changes === 1;
    },
    eventsSince(seq = 0) {
      return db.prepare("SELECT seq, body FROM events WHERE seq > ? ORDER BY seq").all(seq)
        .map((r) => ({ seq: r.seq, ...JSON.parse(r.body) }));
    },
    /** Synchronous transaction. An async callback is refused (rolled back): use transactionAsync for that. */
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      let out;
      try { out = fn(); } catch (e) { db.exec("ROLLBACK"); throw e; }
      if (out && typeof out.then === "function") {
        db.exec("ROLLBACK");
        throw new TypeError("store.transaction got an async callback: use store.transactionAsync");
      }
      db.exec("COMMIT");
      return out;
    },
    /**
     * Async transaction (e.g. the core's ApprovalStore.transaction port): awaits the callback before COMMIT,
     * rolls back if it rejects, and is serialized so two async transactions never interleave on this connection.
     */
    transactionAsync(fn) {
      const run = async () => {
        db.exec("BEGIN IMMEDIATE");
        try { const out = await fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    getKV(k, fallback = null) { const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : fallback; },
    setKV(k, v) { db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v)); },
    close() { db.close(); },
  };
}
