import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { DecisionCard, StoredAction, StoredSource, ThemeSummary } from '@sauti/core';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { approveWithPin, recoverInterruptedSends, rejectProposal } from '../domain/actions';
import { listActions } from '../domain/coreDb';
import { isEnrolled } from '../domain/pin';
import { bi, proposeThanks, runW3, t, themeName } from '../domain/w3';
import { afterBookSlotApproved } from '../domain/visits';
import { proposalText, recipientLabel } from '../domain/display';
import { pickAndImportFeedback } from '../import/feedbackImport';
import { translateToSwahili } from '../models/gemma';
import { palette, spacing } from '../theme';

const REASON_TEXT: Record<string, string> = {
  wrong_pin: bi('PIN si sahihi. Hakuna kilichoidhinishwa.', 'Wrong PIN. Nothing was approved.'),
  locked: bi('Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.', 'Too many wrong tries. Wait, then try again.'),
  rendered_digest_mismatch: t('approval.stale'),
  fact_revision_mismatch: bi('Taarifa za shamba zimebadilika. Angalia pendekezo jipya.', 'Your farm details changed. See the new suggestion.'),
  expired: t('state.business.expired'),
  clock_suspect: t('screen.clock_suspect'),
  not_enrolled: bi('Weka PIN yako ya Sauti kwanza kwenye Shamba langu.', 'Set your Sauti PIN first in My farm.'),
};

function suggestionFor(card: DecisionCard): string {
  if (card.theme === 'directions' && card.direction === 'negative') {
    return bi('Uliza wageni ni sehemu gani ya maelekezo ilikuwa ngumu, kisha ongeza alama ya kutambulisha njia.',
      'Ask visitors which part of the directions was hard, then add a landmark to your directions.');
  }
  if (card.direction === 'negative') return bi('Waombe radhi wageni kwa upole na uulize jinsi ya kuboresha.', 'Apologise politely and ask how to improve.');
  return bi('Washukuru wageni walioandika hili, na uendelee kulifanya vizuri.', 'Thank the visitors who wrote this, and keep doing it well.');
}

export default function LeoScreen() {
  const [enrolled, setEnrolled] = useState(true);
  const [cards, setCards] = useState<DecisionCard[]>([]);
  const [weak, setWeak] = useState<ThemeSummary[]>([]);
  const [askCount, setAskCount] = useState(0);
  const [sources, setSources] = useState<Map<string, StoredSource>>(new Map());
  const [proposals, setProposals] = useState<StoredAction[]>([]);
  const [pending, setPending] = useState<StoredAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [translations, setTranslations] = useState<Record<string, string>>({});

  const translate = async (messageId: string) => {
    const original = sources.get(messageId)?.text;
    if (!original) return;
    setTranslations((m) => ({ ...m, [messageId]: '…' }));
    try {
      const tr = await translateToSwahili(original);
      setTranslations((m) => ({ ...m, [messageId]: tr.ok ? tr.text : bi('Tafsiri imefichwa: haiaminiki.', `Translation hidden: not reliable (${tr.reason}).`) }));
    } catch (error) {
      setTranslations((m) => ({ ...m, [messageId]: error instanceof Error ? error.message : 'Gemma error' }));
    }
  };

  const refresh = useCallback(async () => {
    try {
      await recoverInterruptedSends();
      setEnrolled(await isEnrolled());
      const w3 = await runW3();
      setCards(w3.cards);
      setWeak(w3.analysis.themes.filter((th) => th.verdict === 'insufficient' || th.verdict === 'conflicting'));
      setAskCount(w3.analysis.ask_a_person.length);
      setSources(w3.sources);
      setProposals((await listActions()).filter((a) => a.business === 'proposed'));
    } catch (error) {
      Alert.alert('Sauti', error instanceof Error ? error.message : bi('Hitilafu ya ndani.', 'Internal error.'));
    }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const tryCard = async (card: DecisionCard) => {
    const made = await proposeThanks(card, sources);
    if (!made.ok) Alert.alert(t('finding.uncertain'), made.reason);
    await refresh();
  };

  const approve = async (pin: string) => {
    if (!pending) return;
    setBusy(true);
    setPinError(null);
    const outcome = await approveWithPin(pending, pin);
    if (outcome.ok && pending.envelope.kind === 'book_slot') {
      const after = await afterBookSlotApproved({ ...pending, business: 'approved', transport: 'queued' });
      if (!after.ok) Alert.alert(t('finding.uncertain'), after.reason);
    }
    setBusy(false);
    if (outcome.ok) {
      setPending(null);
      Alert.alert(t('state.business.approved'), pending.envelope.kind === 'book_slot'
        ? bi('Nafasi imehifadhiwa kwenye kalenda. Ujumbe kwa mgeni unasubiri idhini yako.', 'Slot saved in the calendar. The visitor message waits for your approval.')
        : t('state.transport.queued'));
      await refresh();
    } else {
      const left = outcome.unlock && !outcome.unlock.ok && outcome.unlock.attemptsLeft !== undefined ? ` (${outcome.unlock.attemptsLeft})` : '';
      setPinError((REASON_TEXT[outcome.reason] ?? outcome.reason) + left);
    }
  };

  return (
    <Screen>
      <PageTitle eyebrow={bi('Sauti · bila mtandao', 'Sauti · offline')} title={t('screen.today.title')} subtitle={t('screen.offline')} />
      {!enrolled ? <Notice tone="warning">{REASON_TEXT.not_enrolled}</Notice> : null}

      {proposals.map((p) => (
        <Card key={p.envelope.action_id} style={styles.proposal}>
          <Text style={styles.kicker}>{t('card.if_you_approve')}</Text>
          {p.envelope.recipient.channel === 'simulated' ? <Text style={styles.simulated}>{t('preview.simulated')}</Text> : null}
          <Text style={styles.meta}>{t('preview.to', { recipient: recipientLabel(p) })}</Text>
          <Text style={styles.body}>{proposalText(p)}</Text>
          <Text style={styles.unreviewed}>{t('preview.unreviewed')}</Text>
          <Text style={styles.state}>{t('state.business.proposed')}</Text>
          <ActionButton label={t('action.approve')} onPress={() => { setPinError(null); setPending(p); }} disabled={!enrolled} />
          <ActionButton label={t('action.reject')} secondary onPress={() => void rejectProposal(p).then(refresh)} />
        </Card>
      ))}

      <SectionTitle title={t('screen.evidence.title')} />
      {cards.length === 0 ? <Notice>{t('screen.empty')}</Notice> : null}
      {cards.map((card) => (
        <Card key={card.card_digest}>
          <Text style={styles.cardTitle}>
            {card.direction === 'negative' ? '▼ ' : card.direction === 'positive' ? '▲ ' : ''}{themeName(card.theme)}
          </Text>
          <Text style={styles.kicker}>{t('card.visitors_said')}</Text>
          <Text style={styles.meta}>{t('card.mentions', { count: card.comment_count })}</Text>
          {card.quotes.slice(0, 3).map((q) => (
            <View key={`${q.message_id}-${q.start}`}>
              <Text style={styles.quote}>“{q.quote}” <Text style={styles.tag}>SYNTHETIC</Text></Text>
              {translations[q.message_id] ? (
                <Text style={styles.translation}>{t('free_text.machine_translation')}: {translations[q.message_id]}</Text>
              ) : sources.get(q.message_id)?.language !== 'sw' ? (
                <Pressable onPress={() => void translate(q.message_id)} accessibilityRole="button">
                  <Text style={styles.translateLink}>{bi('Tafsiri', 'Translate')} →</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          <Text style={styles.kicker}>{t('card.you_could_try')}</Text>
          <Text style={styles.body}>{t('card.prospective')} {suggestionFor(card)}</Text>
          <View style={styles.row}>
            <Pressable style={styles.choice} onPress={() => void tryCard(card)} accessibilityRole="button">
              <Text style={styles.choiceText}>{bi('Jaribu', 'Try')}</Text>
            </Pressable>
            <Pressable style={styles.choice} onPress={() => Alert.alert(t('action.ask_someone'), t('free_text.ask_guide'))} accessibilityRole="button">
              <Text style={styles.choiceText}>{t('action.ask_someone')}</Text>
            </Pressable>
          </View>
        </Card>
      ))}

      {weak.map((th) => (
        <Card key={th.theme} style={styles.weak}>
          <Text style={styles.cardTitle}>{themeName(th.theme)}</Text>
          <Text style={styles.body}>{th.verdict === 'conflicting' ? t('finding.conflicting') : t('finding.not_enough')}</Text>
        </Card>
      ))}
      {askCount > 0 ? <Notice tone="warning">{t('finding.uncertain')} ({askCount})</Notice> : null}

      <ActionButton label={bi('Leta maoni (faili)', 'Import feedback file')} secondary onPress={() => void pickAndImportFeedback().then(refresh)} />
      <Link href="/device" asChild><Text style={styles.link}>{bi('Ukaguzi wa simu (G1)', 'Phone check (G1)')} →</Text></Link>
      <Link href="/gemma" asChild><Text style={styles.link}>{bi('Ukaguzi wa Gemma 4', 'Gemma 4 check')} →</Text></Link>

      <PinModal
        visible={pending !== null}
        title={t('approval.confirm')}
        preview={pending ? proposalText(pending) : undefined}
        busy={busy}
        error={pinError}
        onSubmit={(pin) => void approve(pin)}
        onCancel={() => setPending(null)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  proposal: { borderColor: palette.green, borderWidth: 2, gap: spacing.xs },
  weak: { opacity: 0.85 },
  kicker: { fontSize: 13, fontWeight: '800', color: palette.amber, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.xs },
  cardTitle: { fontSize: 21, fontWeight: '800', color: palette.ink },
  meta: { fontSize: 15, color: palette.muted },
  body: { fontSize: 17, color: palette.ink, lineHeight: 24 },
  quote: { fontSize: 16, color: palette.ink, fontStyle: 'italic', lineHeight: 23 },
  tag: { fontSize: 11, fontStyle: 'normal', color: palette.amber, fontWeight: '800' },
  simulated: { fontSize: 13, fontWeight: '800', color: palette.red },
  unreviewed: { fontSize: 13, color: palette.muted },
  state: { fontSize: 15, fontWeight: '700', color: palette.ink },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  choice: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: palette.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xs },
  choiceText: { color: palette.green, fontWeight: '800', fontSize: 16, textAlign: 'center' },
  translation: { fontSize: 15, color: palette.green, lineHeight: 22, marginTop: 2 },
  translateLink: { fontSize: 14, color: palette.green, fontWeight: '700', marginTop: 2 },
  link: { color: palette.green, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
});
