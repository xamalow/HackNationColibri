import * as Crypto from 'expo-crypto';
import {
  analyzeFeedback,
  buildDecisionCards,
  ingestMessages,
  proposeFollowUp,
  formatTimestamp,
  type DecisionCard,
  type FeedbackAnalysis,
  type StoredSource,
} from '@sauti/core';
import sw from '@sauti/experience/copy/sw.json';
import en from '@sauti/experience/copy/en.json';
import { listFeedbackSources } from '../import/feedbackImport';
import { isSyntheticDemoOnly } from '../storage/feedbackOrigins';
import { tagFeedback, type TaggerOutput } from '../vendor/max/tag_feedback';
import { appendAudit, coreDb, insertProposedAction, sha256, TENANT_ID } from './coreDb';
import type { MissingInfoQuestion } from './missingInfo';

const SUPPORTED = new Set(['sw', 'en', 'de', 'fr']);

export type W3Result = {
  analysis: FeedbackAnalysis;
  cards: DecisionCard[];
  sources: Map<string, StoredSource>;
  rejected: number;
  /** Max's tagger output per message (what code read, no model). */
  tagged: TaggerOutput;
  /** Source ids of the bundled SYNTHETIC demo rows; only these get the SYNTHETIC label. */
  synthetic: Set<string>;
};

/**
 * W3 steps 1-5 on this phone. Themes come from Max's deterministic tagger (Domain decision #47521);
 * the core validates every quote against the immutable original and counts unique comments.
 * Nothing here calls a model or the network.
 */
export async function runW3(): Promise<W3Result> {
  const stored = await listFeedbackSources(500);
  const incoming = stored.map((s) => ({
    id: s.sourceId,
    source: 'direct_review',
    external_id: s.sourceId,
    received_at: s.importedAt,
    text: s.text,
    ...(SUPPORTED.has(s.language) ? { lang: s.language } : {}),
  }));
  const ingested = ingestMessages(incoming, sha256);
  const tagged = tagFeedback(
    [...ingested.sources.values()].map((s) => ({ id: s.source_id, text: s.text, lang: s.language })),
  );
  const analysis = analyzeFeedback(tagged, ingested.sources, sha256, { supportedLanguages: SUPPORTED });
  const cards = buildDecisionCards(analysis, sha256);
  const synthetic = new Set(stored.filter((s) => isSyntheticDemoOnly(s.origins)).map((s) => s.sourceId));
  return { analysis, cards, sources: ingested.sources, rejected: ingested.rejected.length, tagged, synthetic };
}

type CopyKey = keyof typeof sw.keys;
const fill = (text: string, vars: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));

/**
 * UI language (demo toggle EN | SW | SW+EN, components/Lang.tsx). Message BODIES sent to visitors never follow it
 * (see tSw / tEn), and text stored inside an envelope uses the fixed both-language form (tBoth / biBoth), so a
 * digest never depends on the toggle.
 */
export type UiLang = 'en' | 'sw' | 'both';
let uiLang: UiLang = 'en';
export const getUiLang = (): UiLang => uiLang;
export const setUiLangValue = (lang: UiLang): void => { uiLang = lang; };

export const tSw = (key: CopyKey, vars: Record<string, string | number> = {}): string => fill(sw.keys[key].text, vars);
export const tEn = (key: CopyKey, vars: Record<string, string | number> = {}): string =>
  fill(en.keys[key as keyof typeof en.keys]?.text ?? '', vars);
/** Stored text: always "Swahili (English)". */
export const biBoth = (swText: string, enText: string): string => (enText && enText !== swText ? `${swText} (${enText})` : swText);
export const tBoth = (key: CopyKey, vars: Record<string, string | number> = {}): string => biBoth(tSw(key, vars), tEn(key, vars));
/** Screen text in the chosen UI language. */
export const bi = (swText: string, enText: string): string =>
  uiLang === 'en' ? enText || swText : uiLang === 'sw' ? swText : biBoth(swText, enText);
export const t = (key: CopyKey, vars: Record<string, string | number> = {}): string => bi(tSw(key, vars), tEn(key, vars));

/**
 * Theme names shown to Noor. Not yet in packages/experience (asked xam-claude to add theme.* keys);
 * machine-drafted Swahili, UNREVIEWED.
 */
const THEMES: Record<string, [string, string]> = {
  coffee: ['Kahawa', 'Coffee'],
  farm_walk: ['Matembezi shambani', 'Farm walk'],
  guide: ['Mwongozo', 'Guide'],
  host: ['Ukarimu', 'Host welcome'],
  directions: ['Maelekezo ya kufika', 'Directions'],
  food: ['Chakula', 'Food'],
  price: ['Bei', 'Price'],
  timing: ['Muda', 'Timing'],
  booking: ['Kuhifadhi nafasi', 'Booking'],
  facilities: ['Huduma', 'Facilities'],
  buy_coffee: ['Kununua kahawa', 'Buying coffee'],
};
export const themeName = (theme: string): string => {
  const pair = THEMES[theme];
  return pair ? bi(pair[0], pair[1]) : theme;
};

/**
 * A follow-up for one decision card, addressed to one visitor who wrote a supporting comment, on the
 * SIMULATED channel (W3 reviews have no phone number; nothing reaches a real person). The body is
 * Experience copy in the visitor's language when we have it (sw or en), else Swahili.
 */
export async function proposeThanks(card: DecisionCard, sources: Map<string, StoredSource>): Promise<{ ok: true; actionId: string } | { ok: false; reason: string }> {
  const targetId = card.supporting_source_ids.find((id) => ['sw', 'en'].includes(sources.get(id)?.language ?? '')) ?? card.supporting_source_ids[0];
  if (!targetId) return { ok: false, reason: 'card_without_supporting_comment' };
  const language = sources.get(targetId)?.language === 'en' ? 'en' : 'sw';
  const key: CopyKey = card.direction !== 'negative'
    ? 'template.thanks_positive'
    : card.theme === 'directions' ? 'template.ask_which_direction_step' : 'template.thanks_polite_disagree';
  const body = language === 'en' ? tEn(key) : tSw(key);
  const recipient = { channel: 'simulated' as const, address: `SIMULATED:${targetId}`, language };
  const preview = [
    tBoth('preview.simulated'),
    `${tBoth('preview.to', { recipient: recipient.address })}`,
    `${tBoth('preview.channel', { channel: tBoth('channel.simulated') })}`,
    `${tBoth('preview.body', { body })}`,
    tBoth('preview.unreviewed'),
  ].join(' ');
  const db = await coreDb();
  const factRow = (await db.execute('SELECT revision FROM sauti_facts WHERE tenant_id = ?;', [TENANT_ID])).rows[0];
  const factRevision = typeof factRow?.revision === 'number' ? factRow.revision : 1;
  const actionId = Crypto.randomUUID();
  const result = proposeFollowUp(
    {
      card,
      sources,
      template: { template_id: key, body, body_language: language, preview_text: preview, render_locale: 'sw-KE' },
      recipient,
      tenant_id: TENANT_ID,
      action_id: actionId,
      fact_revision: factRevision,
      owner_fact_numbers: [],
      created_at_ms: Date.now(),
      valid_for_ms: 24 * 3600 * 1000,
    },
    sha256,
  );
  if (!result.ok) return { ok: false, reason: `${result.reason}: ${result.detail}` };
  await insertProposedAction(result.envelope, card.card_digest);
  return { ok: true, actionId };
}

/** W3 step 5: Noor answers a decision card with "ask someone". Recorded in the audit log; nothing is sent. */
export async function recordAskSomeone(card: DecisionCard): Promise<void> {
  await appendAudit({ at: formatTimestamp(Date.now()), action_id: card.card_digest, event: `w3_decision_ask_someone:${card.theme}` });
}

/** W3 missing-evidence path: record the owner's request without turning uncertainty into an action. */
export async function recordAskForMissingInfo(question: MissingInfoQuestion): Promise<void> {
  await appendAudit({
    at: formatTimestamp(Date.now()),
    action_id: question.id,
    event: 'w3_missing_info_ask',
    detail: question.reason,
  });
}
