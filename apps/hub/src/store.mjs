// Durable hub state in one SQLite file (node:sqlite). Parameterized SQL only.
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";

// Codex review (D): async work started inside a transaction callback carries that transaction's scope; once the
// transaction has ended (committed, rolled back or refused) any write from that scope is rejected, so a deferred
// write can never escape a rollback as a silent autocommit.
const scope = new AsyncLocalStorage();
function guardWrite(originScope) {
  if (scope.getStore()?.dead || originScope?.dead) throw new Error("write from a transaction scope that has ended (rolled back or refused)");
}

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
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA);
  // Every statement method can execute writes, including INSERT ... RETURNING through get/all/iterate.
  const db = {
    prepare(sql) {
      const st = raw.prepare(sql);
      return {
        run: (...a) => { guardWrite(); return st.run(...a); },
        get: (...a) => { guardWrite(); return st.get(...a); },
        all: (...a) => { guardWrite(); return st.all(...a); },
        iterate(...a) {
          guardWrite();
          const originScope = scope.getStore();
          const rows = st.iterate(...a);
          return {
            // Iteration is lazy. Keep its creating scope even if the iterator is consumed outside that scope.
            next(...args) { guardWrite(originScope); return rows.next(...args); },
            // Closing an iterator releases its statement; it does not execute another SQL step.
            return(...args) { return rows.return(...args); },
            [Symbol.iterator]() { return this; },
          };
        },
      };
    },
    exec(sql) { guardWrite(); return raw.exec(sql); },
    close() { raw.close(); },
  };
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
      const ctx = { dead: false };
      raw.exec("BEGIN IMMEDIATE");
      let out;
      try { out = scope.run(ctx, fn); } catch (e) { ctx.dead = true; raw.exec("ROLLBACK"); throw e; }
      if (out && typeof out.then === "function") {
        ctx.dead = true;
        raw.exec("ROLLBACK");
        throw new TypeError("store.transaction got an async callback: use store.transactionAsync");
      }
      raw.exec("COMMIT");
      ctx.dead = true; // deferred work started inside a committed transaction may not write outside it either
      return out;
    },
    /**
     * Async transaction (e.g. the core's ApprovalStore.transaction port): awaits the callback before COMMIT,
     * rolls back if it rejects, and is serialized so two async transactions never interleave on this connection.
     */
    transactionAsync(fn) {
      const run = () => {
        const ctx = { dead: false };
        return scope.run(ctx, async () => {
          raw.exec("BEGIN IMMEDIATE");
          try { const out = await fn(); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; } finally { ctx.dead = true; }
        });
      };
      const result = queue.then(run, run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    getKV(k, fallback = null) { const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : fallback; },
    setKV(k, v) { db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v)); },
    close() { raw.close(); },
  };
}
