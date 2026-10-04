/**
 * Business state = owner authority over one exact action.
 * Transport state = what a carrier did with it.
 * They never collapse into one field: a sent booking request is not a confirmed
 * booking, and a green approval never means delivered. The tables here mirror
 * contracts/states.json; a test keeps them equal.
 */

export const BUSINESS_STATES = ["proposed", "approved", "rejected", "expired", "revoked", "cancelled"] as const;
export type BusinessState = (typeof BUSINESS_STATES)[number];
export const BUSINESS_TERMINAL: ReadonlySet<BusinessState> = new Set(["rejected", "expired", "revoked", "cancelled"]);

export const TRANSPORT_STATES = ["none", "queued", "sending", "sent", "send_unknown", "delivered", "failed"] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

/** Monotonic ranks for receipt handling. Side states (failed, send_unknown) have no rank. */
export const TRANSPORT_RANK: Readonly<Partial<Record<TransportState, number>>> = {
  none: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
};

export const BUSINESS_TRANSITIONS: ReadonlyArray<readonly [BusinessState, BusinessState]> = [
  ["proposed", "approved"],
  ["proposed", "rejected"],
  ["proposed", "expired"],
  ["proposed", "cancelled"],
  ["approved", "revoked"],
  ["approved", "expired"],
  ["approved", "cancelled"],
];

export const TRANSPORT_TRANSITIONS: ReadonlyArray<readonly [TransportState, TransportState]> = [
  ["none", "queued"],
  ["queued", "sending"],
  ["sending", "sent"],
  ["sending", "failed"],
  ["sending", "send_unknown"],
  ["failed", "queued"],
  ["send_unknown", "sent"],
  ["send_unknown", "failed"],
  ["sent", "delivered"],
  ["sending", "delivered"],
  ["send_unknown", "delivered"],
];

export class TransitionError extends Error {
  override readonly name = "TransitionError";
  constructor(readonly kind: "business" | "transport", readonly from: string, readonly to: string, detail?: string) {
    super(`${kind}: ${from} -> ${to} is not allowed${detail ? `: ${detail}` : ""}`);
  }
}

export function canTransitionBusiness(from: BusinessState, to: BusinessState): boolean {
  return BUSINESS_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function canTransitionTransport(from: TransportState, to: TransportState): boolean {
  return TRANSPORT_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function assertBusiness(from: BusinessState, to: BusinessState): void {
  if (!canTransitionBusiness(from, to)) throw new TransitionError("business", from, to);
}

export function assertTransport(from: TransportState, to: TransportState): void {
  if (!canTransitionTransport(from, to)) throw new TransitionError("transport", from, to);
}

/** New transport ACTIVITY (queueing, dispatch) requires business state approved. Receipts for a past dispatch are recorded in any state. */
export function dispatchAllowed(business: BusinessState): boolean {
  return business === "approved";
}

/**
 * A provider receipt may only move the transport state forward in rank.
 * From send_unknown, a receipt proving acceptance moves to sent or delivered.
 * A receipt never resolves failed (that needs the retry path) and never regresses.
 */
export function receiptAllowed(current: TransportState, incoming: TransportState): boolean {
  if (incoming !== "sent" && incoming !== "delivered") return false;
  if (current === "send_unknown") return true;
  if (current === "failed" || current === "none" || current === "queued") return false;
  const cur = TRANSPORT_RANK[current];
  const inc = TRANSPORT_RANK[incoming];
  return cur !== undefined && inc !== undefined && inc > cur;
}

/** Recall is GUARANTEED only when nothing was ever in flight. sending and send_unknown can be revoked for dispatch purposes, but a late acceptance may still arrive. */
export function recallGuaranteed(transport: TransportState): boolean {
  return transport === "none" || transport === "queued" || transport === "failed";
}
