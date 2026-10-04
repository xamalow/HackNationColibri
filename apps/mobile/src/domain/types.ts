export type OutboxStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'send_unknown'
  | 'delivered'
  | 'failed';

export type EvidenceVerdict = 'validated' | 'unverified' | 'rejected';

export type FeedbackOriginKind = 'imported' | 'synthetic_demo' | 'legacy_unknown';

export type FeedbackSource = {
  sourceId: string;
  fileName: string;
  rowNumber: number;
  contentHash: string;
  text: string;
  /** Declared by the import or selected by the owner; not language-ID proof. */
  language: string;
  importedAt: string;
  /** Every way these content-addressed rows entered storage, retained across duplicate imports. */
  origins: FeedbackOriginKind[];
};

export type OutboxItem = {
  actionId: string;
  status: OutboxStatus;
  recipientLabel: string;
  exactMessage: string;
  renderedDigest: string;
  updatedAt: string;
};

export const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'queued',
  'sending',
  'sent',
  'send_unknown',
  'delivered',
  'failed',
];
