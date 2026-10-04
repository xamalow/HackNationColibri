import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type {
  ActionEnvelope,
  ApprovalRecord,
  ApprovalStore,
  ApprovalTx,
  AuditEntry,
  AuthenticatedSession,
  ClockReading,
  ClockState,
  OutboxRow,
  StoredAction,
  TrustedOwner,
  UnlockMethod,
} from '@sauti/core';
import { observeClock } from '@sauti/core';
import { bytesToHex } from '../crypto/hash';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { getSecureDatabase } from '../storage/secureDatabase';
import { AsyncMutex } from './asyncMutex';

/** Single-owner demo tenant. One phone = one farm in v1. */
export const TENANT_ID = 'noor-farm-001';
export const OWNER_ID = 'noor';
const DEVICE_ID_KEY = 'sauti-host.device_id.v1';

type Db = Awaited<ReturnType<typeof getSecureDatabase>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const approvalTransactionMutex = new AsyncMutex();

/** Host SHA-256 port for @sauti/core: raw bytes in, lowercase hex out. */
export const sha256 = (bytes: Uint8Array): string => bytesToHex(nobleSha256(bytes));

let schemaReady: Promise<void> | null = null;

export async function coreDb(): Promise<Db> {
  const db = await getSecureDatabase();
  schemaReady ??= db.transaction(async (tx) => {
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_actions (
      action_id TEXT PRIMARY KEY NOT NULL, envelope_json TEXT NOT NULL, business TEXT NOT NULL,
      transport TEXT NOT NULL, revoked_at TEXT, provider_ref TEXT, attempts INTEGER NOT NULL,
      card_digest TEXT, created_at TEXT NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_approvals (
      action_id TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_outbox (
      idempotency_key TEXT PRIMARY KEY NOT NULL, action_id TEXT NOT NULL UNIQUE, row_json TEXT NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_owner (
      tenant_id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, device_ids_json TEXT NOT NULL,
      allowed_unlock_json TEXT NOT NULL, max_session_age_ms INTEGER NOT NULL, revoked_sessions_json TEXT NOT NULL,
      pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, pin_iterations INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL DEFAULT 0, lock_round INTEGER NOT NULL DEFAULT 0, lock_until_ms INTEGER NOT NULL DEFAULT 0,
      enrolled_at TEXT NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_session (
      tenant_id TEXT PRIMARY KEY NOT NULL, session_json TEXT NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1), high_water_ms INTEGER NOT NULL);`);
    await tx.execute(`CREATE TABLE IF NOT EXISTS sauti_facts (
      tenant_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, sheet_json TEXT);`);
  });
  await schemaReady;
  return db;
}

export async function getDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = `ios-${Crypto.randomUUID()}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  return created;
}

/** Monotonic high-water clock: persisted so a clock rolled back after restart is still detected. */
export async function readClock(): Promise<ClockReading> {
  const db = await coreDb();
  const row = (await db.execute('SELECT high_water_ms FROM sauti_clock WHERE id = 1;')).rows[0];
  const state: ClockState = { highWaterMs: typeof row?.high_water_ms === 'number' ? row.high_water_ms : 0 };
  const reading = observeClock(state, Date.now());
  await db.execute(
    'INSERT INTO sauti_clock (id, high_water_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET high_water_ms = excluded.high_water_ms;',
    [reading.state.highWaterMs],
  );
  return reading;
}

function rowToAction(row: Record<string, unknown>): StoredAction {
  return {
    envelope: JSON.parse(String(row.envelope_json)) as ActionEnvelope,
    business: row.business as StoredAction['business'],
    transport: row.transport as StoredAction['transport'],
    revoked_at: (row.revoked_at as string | null) ?? null,
    provider_ref: (row.provider_ref as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
  };
}

export type OwnerRow = {
  trusted: TrustedOwner;
  pinSalt: string;
  pinHash: string;
  pinIterations: number;
  failedAttempts: number;
  lockRound: number;
  lockUntilMs: number;
};

export function rowToOwner(row: Record<string, unknown>): OwnerRow {
  return {
    trusted: {
      tenant_id: String(row.tenant_id),
      owner_id: String(row.owner_id),
      trusted_device_ids: new Set(JSON.parse(String(row.device_ids_json)) as string[]),
      allowed_unlock: new Set(JSON.parse(String(row.allowed_unlock_json)) as UnlockMethod[]),
      max_session_age_ms: Number(row.max_session_age_ms),
      revoked_session_ids: new Set(JSON.parse(String(row.revoked_sessions_json)) as string[]),
    },
    pinSalt: String(row.pin_salt),
    pinHash: String(row.pin_hash),
    pinIterations: Number(row.pin_iterations),
    failedAttempts: Number(row.failed_attempts),
    lockRound: Number(row.lock_round),
    lockUntilMs: Number(row.lock_until_ms),
  };
}

export async function readOwner(): Promise<OwnerRow | null> {
  const db = await coreDb();
  const row = (await db.execute('SELECT * FROM sauti_owner WHERE tenant_id = ?;', [TENANT_ID])).rows[0];
  return row ? rowToOwner(row) : null;
}

/** ApprovalTx over one SQLCipher transaction (op-sqlite runs it as BEGIN ... COMMIT, rolled back on throw). */
function txAdapter(tx: Tx): ApprovalTx {
  return {
    async getAction(actionId) {
      const row = (await tx.execute('SELECT * FROM sauti_actions WHERE action_id = ?;', [actionId])).rows[0];
      return row ? rowToAction(row) : null;
    },
    async getCurrentFactRevision(tenantId) {
      const row = (await tx.execute('SELECT revision FROM sauti_facts WHERE tenant_id = ?;', [tenantId])).rows[0];
      return typeof row?.revision === 'number' ? row.revision : 1;
    },
    async getTrustedOwner(tenantId) {
      const row = (await tx.execute('SELECT * FROM sauti_owner WHERE tenant_id = ?;', [tenantId])).rows[0];
      return row ? rowToOwner(row).trusted : null;
    },
    async getOwnerSession(tenantId) {
      const row = (await tx.execute('SELECT session_json FROM sauti_session WHERE tenant_id = ?;', [tenantId])).rows[0];
      return row ? (JSON.parse(String(row.session_json)) as AuthenticatedSession) : null;
    },
    async insertApproval(record: ApprovalRecord) {
      await tx.execute('INSERT INTO sauti_approvals (action_id, record_json) VALUES (?, ?);', [record.action_id, JSON.stringify(record)]);
    },
    async insertOutbox(row: OutboxRow) {
      await tx.execute('INSERT INTO sauti_outbox (idempotency_key, action_id, row_json) VALUES (?, ?, ?);', [row.idempotency_key, row.action_id, JSON.stringify(row)]);
    },
    async updateAction(action: StoredAction) {
      await tx.execute(
        'UPDATE sauti_actions SET business = ?, transport = ?, revoked_at = ?, provider_ref = ?, attempts = ? WHERE action_id = ?;',
        [action.business, action.transport, action.revoked_at, action.provider_ref, action.attempts, action.envelope.action_id],
      );
    },
    async appendAudit(entry: AuditEntry) {
      await tx.execute('INSERT INTO sauti_audit (at, action_id, event, detail) VALUES (?, ?, ?, ?);', [entry.at, entry.action_id, entry.event, entry.detail ?? null]);
    },
  };
}

export async function approvalStore(): Promise<ApprovalStore> {
  const db = await coreDb();
  return {
    async transaction<T>(fn: (tx: ApprovalTx) => Promise<T>): Promise<T> {
      return approvalTransactionMutex.run(async () => {
        let result: T | undefined;
        await db.transaction(async (tx) => {
          result = await fn(txAdapter(tx));
        });
        return result as T;
      });
    },
  };
}

export async function insertProposedAction(envelope: ActionEnvelope, cardDigest: string | null): Promise<void> {
  const db = await coreDb();
  await db.execute(
    `INSERT INTO sauti_actions (action_id, envelope_json, business, transport, revoked_at, provider_ref, attempts, card_digest, created_at)
     VALUES (?, ?, 'proposed', 'none', NULL, NULL, 0, ?, ?);`,
    [envelope.action_id, JSON.stringify(envelope), cardDigest, envelope.created_at],
  );
}

export async function listActions(): Promise<StoredAction[]> {
  const db = await coreDb();
  return (await db.execute('SELECT * FROM sauti_actions ORDER BY created_at DESC;')).rows.map(rowToAction);
}

export async function getAction(actionId: string): Promise<StoredAction | null> {
  const db = await coreDb();
  const row = (await db.execute('SELECT * FROM sauti_actions WHERE action_id = ?;', [actionId])).rows[0];
  return row ? rowToAction(row) : null;
}

export async function getApprovalAndOutbox(actionId: string): Promise<{ approval: ApprovalRecord | null; outbox: OutboxRow | null }> {
  const db = await coreDb();
  const a = (await db.execute('SELECT record_json FROM sauti_approvals WHERE action_id = ?;', [actionId])).rows[0];
  const o = (await db.execute('SELECT row_json FROM sauti_outbox WHERE action_id = ?;', [actionId])).rows[0];
  return {
    approval: a ? (JSON.parse(String(a.record_json)) as ApprovalRecord) : null,
    outbox: o ? (JSON.parse(String(o.row_json)) as OutboxRow) : null,
  };
}

/** Persist a transport transition (dispatch worker). Single statement, so it is atomic on its own. */
export async function saveAction(action: StoredAction): Promise<void> {
  const db = await coreDb();
  await db.execute(
    'UPDATE sauti_actions SET business = ?, transport = ?, revoked_at = ?, provider_ref = ?, attempts = ? WHERE action_id = ?;',
    [action.business, action.transport, action.revoked_at, action.provider_ref, action.attempts, action.envelope.action_id],
  );
}

/** Decision-card digests Noor answered with "ask someone" (W3 step 5, recorded in the audit log). */
export async function listAskedCards(): Promise<Set<string>> {
  const db = await coreDb();
  const rows = (await db.execute("SELECT action_id FROM sauti_audit WHERE event LIKE 'w3_decision_ask_someone:%';")).rows;
  return new Set(rows.map((r) => String(r.action_id)));
}

/** Evidence-bound missing-info questions Noor already chose to raise with a person. */
export async function listAskedQuestions(): Promise<Set<string>> {
  const db = await coreDb();
  const rows = (await db.execute("SELECT action_id FROM sauti_audit WHERE event = 'w3_missing_info_ask';")).rows;
  return new Set(rows.map((r) => String(r.action_id)));
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  const db = await coreDb();
  await db.execute('INSERT INTO sauti_audit (at, action_id, event, detail) VALUES (?, ?, ?, ?);', [entry.at, entry.action_id, entry.event, entry.detail ?? null]);
}
