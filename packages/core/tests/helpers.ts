import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

import type { ApprovalRecord, ApprovalStore, ApprovalTx, AuditEntry, AuthenticatedSession, OutboxRow, StoredAction, TrustedOwner } from "../src/approval.js";
import type { Sha256 } from "../src/canon.js";
import { observeClock, type ClockReading } from "../src/clock.js";
import type { ActionEnvelope } from "../src/envelope.js";

export const sha256: Sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const CONTRACTS = resolve(HERE, "../../../contracts");
export const FIXTURES = join(CONTRACTS, "fixtures");

export function loadJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function listJson(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f));
}

export function goodEnvelope(): ActionEnvelope {
  return loadJson<ActionEnvelope>(join(FIXTURES, "good", "send_message_simulated.json"));
}

export function clockAt(iso: string, highWaterMs = 0): ClockReading {
  return observeClock({ highWaterMs }, Date.parse(iso));
}

export function storedAction(envelope: ActionEnvelope, overrides: Partial<StoredAction> = {}): StoredAction {
  return { envelope, business: "proposed", transport: "none", revoked_at: null, provider_ref: null, attempts: 0, ...overrides };
}

export const TENANT = "demo-farm-001";

/** The host-established owner session (what the keystore-backed unlock says). */
export const SESSION: AuthenticatedSession = {
  tenant_id: TENANT,
  owner_id: "demo-noor-001",
  device_id: "demo-android-001",
  unlock: "pin",
  session_id: "local-session-0001",
  authenticated_at: "2026-10-03T20:55:00Z",
};

export const TRUSTED: TrustedOwner = {
  tenant_id: TENANT,
  owner_id: "demo-noor-001",
  trusted_device_ids: new Set(["demo-android-001"]),
  allowed_unlock: new Set(["pin", "biometric"]),
  max_session_age_ms: 15 * 60 * 1000,
  revoked_session_ids: new Set(["local-session-revoked"]),
};

/**
 * In-memory store with real transaction semantics: all writes go to a copy and are
 * swapped in only when the function returns; a throw discards the copy. Optional
 * crash hooks simulate the process dying between writes.
 */
export class MemoryStore implements ApprovalStore {
  actions = new Map<string, StoredAction>();
  approvals = new Map<string, ApprovalRecord>();
  outbox = new Map<string, OutboxRow>();
  audit: AuditEntry[] = [];
  factRevision = 1;
  trusted: TrustedOwner | null = TRUSTED;
  session: AuthenticatedSession | null = SESSION;
  crashAfterApprovalInsert = false;
  crashAfterOutboxInsert = false;

  async transaction<T>(fn: (tx: ApprovalTx) => Promise<T>): Promise<T> {
    const actions = new Map(this.actions);
    const approvals = new Map(this.approvals);
    const outbox = new Map(this.outbox);
    const audit = [...this.audit];
    const self = this;
    const tx: ApprovalTx = {
      async getAction(id) {
        return actions.get(id) ?? null;
      },
      async getCurrentFactRevision() {
        return self.factRevision;
      },
      async getTrustedOwner() {
        return self.trusted;
      },
      async getOwnerSession() {
        return self.session;
      },
      async insertApproval(record) {
        if (approvals.has(record.action_id)) throw new Error("unique violation: approval for action exists");
        approvals.set(record.action_id, record);
        if (self.crashAfterApprovalInsert) throw new Error("simulated crash after approval insert");
      },
      async insertOutbox(row) {
        if (outbox.has(row.idempotency_key)) throw new Error("unique violation: idempotency_key exists");
        outbox.set(row.idempotency_key, row);
        if (self.crashAfterOutboxInsert) throw new Error("simulated crash after outbox insert");
      },
      async updateAction(action) {
        actions.set(action.envelope.action_id, action);
      },
      async appendAudit(entry) {
        audit.push(entry);
      },
    };
    const result = await fn(tx);
    this.actions = actions;
    this.approvals = approvals;
    this.outbox = outbox;
    this.audit = audit;
    return result;
  }
}
