import type { StoredAction } from '@sauti/core';
import { bi, getUiLang } from './w3';

/** Text stored as "Swahili (English)" (biBoth), shown in the chosen UI language. */
export function localizeStored(text: string): string {
  const lang = getUiLang();
  if (lang === 'both' || !text.endsWith(')')) return text;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(' && --depth === 0) {
      if (i < 1 || text[i - 1] !== ' ') return text;
      return lang === 'en' ? text.slice(i + 1, -1) : text.slice(0, i - 1);
    }
  }
  return text;
}

/** What Noor sees before approving: the message body for messages, the core's preview for other kinds. */
export function proposalText(a: StoredAction): string {
  const body = (a.envelope.payload as { body?: string }).body;
  return body ?? localizeStored(a.envelope.preview.text);
}

/** Human label for the recipient; the exact address stays in the envelope and the digest. */
export function recipientLabel(a: StoredAction): string {
  const r = a.envelope.recipient;
  if (r.channel === 'local') return bi('Kalenda yako (simu hii)', 'Your calendar (this phone)');
  if (r.channel === 'simulated') return bi('Mgeni aliyeandika maoni', 'The visitor who wrote the review');
  return r.address;
}
