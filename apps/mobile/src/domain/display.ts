import type { StoredAction } from '@sauti/core';
import { bi } from './w3';

/** What Noor sees before approving: the message body for messages, the core's preview for other kinds. */
export function proposalText(a: StoredAction): string {
  const body = (a.envelope.payload as { body?: string }).body;
  return body ?? a.envelope.preview.text;
}

/** Human label for the recipient; the exact address stays in the envelope and the digest. */
export function recipientLabel(a: StoredAction): string {
  const r = a.envelope.recipient;
  if (r.channel === 'local') return bi('Kalenda yako (simu hii)', 'Your calendar (this phone)');
  if (r.channel === 'simulated') return bi('Mgeni aliyeandika maoni', 'The visitor who wrote the review');
  return r.address;
}
