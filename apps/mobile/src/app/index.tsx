import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { DecisionCard, StoredAction, StoredSource, ThemeSummary } from '@sauti/core';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { approveWithPin, recoverInterruptedSends, rejectProposal } from '../domain/actions';
import { listActions } from '../domain/coreDb';
import { isEnrolled } from '../domain/pin';
import { proposeThanks, runW3, t, THEME_SW } from '../domain/w3';
import { pickAndImportFeedback } from '../import/feedbackImport';
import { palette, spacing } from '../theme';

const REASON_SW: Record<string, string> = {
  wrong_pin: 'PIN si sahihi. Hakuna kilichoidhinishwa.',
  locked: 'Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.',
  rendered_digest_mismatch: 'Kadi hii imebadilika. Tafadhali iangalie tena kabla ya kuamua.',
  fact_revision_mismatch: 'Taarifa za shamba zimebadilika. Angalia pendekezo jipya.',
  expired: 'Muda umepita, hautatumwa.',
  clock_suspect: 'Saa ya simu inaonekana si sahihi. Hakuna kitakachotumwa hadi irekebishwe.',
  not_enrolled: 'Weka PIN yako ya Sauti kwanza kwenye Shamba langu.',
};

function suggestionFor(card: DecisionCard): string {
  if (card.theme === 'directions' && card.direction === 'negative') return 'Uliza wageni ni sehemu gani ya maelekezo ilikuwa ngumu, kisha ongeza alama ya kutambulisha njia.';
  if (card.direction === 'negative') return 'Waombe radhi wageni kwa upole na uulize jinsi ya kuboresha.';
  return 'Washukuru wageni walioandika hili, na uendelee kulifanya vizuri.';
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
      Alert.alert('Sauti', error instanceof Error ? error.message : 'Hitilafu ya ndani.');
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
    setBusy(false);
    if (outcome.ok) {
      setPending(null);
      Alert.alert(t('state.business.approved'), t('state.transport.queued'));
      await refresh();
    } else {
      const left = outcome.unlock && !outcome.unlock.ok && outcome.unlock.attemptsLeft !== undefined ? ` (${outcome.unlock.attemptsLeft})` : '';
      setPinError((REASON_SW[outcome.reason] ?? outcome.reason) + left);
    }
  };

  return (
    <Screen>
      <PageTitle eyebrow="Sauti · bila mtandao" title={t('screen.today.title')} subtitle={t('screen.offline')} />
      {!enrolled ? <Notice tone="warning">{REASON_SW.not_enrolled}</Notice> : null}

      {proposals.map((p) => {
        const body = (p.envelope.payload as { body?: string }).body ?? '';
        return (
          <Card key={p.envelope.action_id} style={styles.proposal}>
            <Text style={styles.kicker}>{t('card.if_you_approve')}</Text>
            {p.envelope.recipient.channel === 'simulated' ? <Text style={styles.simulated}>{t('preview.simulated')}</Text> : null}
            <Text style={styles.meta}>{t('preview.to', { recipient: p.envelope.recipient.address })}</Text>
            <Text style={styles.body}>{body}</Text>
            <Text style={styles.unreviewed}>{t('preview.unreviewed')}</Text>
            <Text style={styles.state}>{t('state.business.proposed')}</Text>
            <ActionButton label={t('action.approve')} onPress={() => { setPinError(null); setPending(p); }} disabled={!enrolled} />
            <ActionButton label={t('action.reject')} secondary onPress={() => void rejectProposal(p).then(refresh)} />
          </Card>
        );
      })}

      <SectionTitle title={t('screen.evidence.title')} />
      {cards.length === 0 ? <Notice>{t('screen.empty')}</Notice> : null}
      {cards.map((card) => (
        <Card key={card.card_digest}>
          <Text style={styles.cardTitle}>
            {card.direction === 'negative' ? '▼ ' : card.direction === 'positive' ? '▲ ' : ''}{THEME_SW[card.theme] ?? card.theme}
          </Text>
          <Text style={styles.kicker}>{t('card.visitors_said')}</Text>
          <Text style={styles.meta}>{t('card.mentions', { count: card.comment_count })}</Text>
          {card.quotes.slice(0, 3).map((q) => (
            <Text key={`${q.message_id}-${q.start}`} style={styles.quote}>“{q.quote}” <Text style={styles.tag}>SYNTHETIC</Text></Text>
          ))}
          <Text style={styles.kicker}>{t('card.you_could_try')}</Text>
          <Text style={styles.body}>{t('card.prospective')} {suggestionFor(card)}</Text>
          <View style={styles.row}>
            <Pressable style={styles.choice} onPress={() => void tryCard(card)} accessibilityRole="button">
              <Text style={styles.choiceText}>Jaribu</Text>
            </Pressable>
            <Pressable style={styles.choice} onPress={() => Alert.alert(t('action.ask_someone'), t('free_text.ask_guide'))} accessibilityRole="button">
              <Text style={styles.choiceText}>{t('action.ask_someone')}</Text>
            </Pressable>
          </View>
        </Card>
      ))}

      {weak.map((th) => (
        <Card key={th.theme} style={styles.weak}>
          <Text style={styles.cardTitle}>{THEME_SW[th.theme] ?? th.theme}</Text>
          <Text style={styles.body}>{th.verdict === 'conflicting' ? t('finding.conflicting') : t('finding.not_enough')}</Text>
        </Card>
      ))}
      {askCount > 0 ? <Notice tone="warning">{t('finding.uncertain')} ({askCount})</Notice> : null}

      <ActionButton label="Leta maoni (faili)" secondary onPress={() => void pickAndImportFeedback().then(refresh)} />
      <Link href="/device" asChild><Text style={styles.link}>Ukaguzi wa simu (G1) →</Text></Link>

      <PinModal
        visible={pending !== null}
        title={t('approval.confirm')}
        preview={pending ? (pending.envelope.payload as { body?: string }).body : undefined}
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
  choice: { flex: 1, minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  choiceText: { color: palette.green, fontWeight: '800', fontSize: 16 },
  link: { color: palette.green, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
});
