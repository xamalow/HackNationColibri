import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { DecisionCard, StoredAction, StoredSource, ThemeSummary } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, LinkRow, Notice, PageTitle, Screen, SectionTitle, splitBi } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { approveWithPin, recoverInterruptedSends, rejectProposal } from '../domain/actions';
import { listActions } from '../domain/coreDb';
import { isEnrolled } from '../domain/pin';
import { bi, proposeThanks, runW3, t, themeName } from '../domain/w3';
import { afterBookSlotApproved } from '../domain/visits';
import { proposalText, recipientLabel } from '../domain/display';
import { pickAndImportFeedback } from '../import/feedbackImport';
import { translateToSwahili } from '../models/gemma';
import { useLang } from '../components/Lang';
import { palette, radius, shadow, spacing } from '../theme';

const reasonText = (): Record<string, string> => ({
  wrong_pin: bi('PIN si sahihi. Hakuna kilichoidhinishwa.', 'Wrong PIN. Nothing was approved.'),
  locked: bi('Umejaribu mara nyingi sana. Subiri kidogo kisha ujaribu tena.', 'Too many wrong tries. Wait, then try again.'),
  rendered_digest_mismatch: t('approval.stale'),
  fact_revision_mismatch: bi('Taarifa za shamba zimebadilika. Angalia pendekezo jipya.', 'Your farm details changed. See the new suggestion.'),
  expired: t('state.business.expired'),
  clock_suspect: t('screen.clock_suspect'),
  not_enrolled: bi('Weka PIN yako ya Sauti kwanza kwenye Shamba langu.', 'Set your Sauti PIN first in My farm.'),
});

function suggestionFor(card: DecisionCard): string {
  if (card.theme === 'directions' && card.direction === 'negative') {
    return bi('Uliza wageni ni sehemu gani ya maelekezo ilikuwa ngumu, kisha ongeza alama ya kutambulisha njia.',
      'Ask visitors which part of the directions was hard, then add a landmark to your directions.');
  }
  if (card.direction === 'negative') return bi('Waombe radhi wageni kwa upole na uulize jinsi ya kuboresha.', 'Apologise politely and ask how to improve.');
  return bi('Washukuru wageni walioandika hili, na uendelee kulifanya vizuri.', 'Thank the visitors who wrote this, and keep doing it well.');
}

export default function LeoScreen() {
  useLang();
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
      setPinError((reasonText()[outcome.reason] ?? outcome.reason) + left);
    }
  };

  const router = useRouter();
  const negatives = cards.filter((c) => c.direction === 'negative').length;

  return (
    <Screen>
      <PageTitle icon="sun" eyebrow="Sauti Host" title={t('screen.today.title')} />
      <View style={styles.offline}>
        <Feather name="wifi-off" size={14} color={palette.green} />
        <Text style={styles.offlineText}>{bi('Inafanya kazi bila mtandao', 'Works offline')}</Text>
      </View>

      <View style={styles.stats}>
        <Stat value={proposals.length} label={bi('Zinasubiri', 'Waiting')} tone={proposals.length ? palette.amber : palette.faint} />
        <Stat value={cards.length} label={bi('Mada', 'Findings')} tone={palette.green} />
        <Stat value={negatives} label={bi('Shida', 'Problems')} tone={negatives ? palette.red : palette.faint} />
      </View>

      {!enrolled ? <Notice tone="warning">{reasonText().not_enrolled}</Notice> : null}

      {proposals.length > 0 ? <SectionTitle title={t('card.if_you_approve')} count={proposals.length} /> : null}
      {proposals.map((p) => (
        <Card key={p.envelope.action_id} accent={palette.amber}>
          <View style={styles.badges}>
            <Badge label={splitBi(t('state.business.proposed'))[0]} tone="warning" icon="clock" />
            {p.envelope.recipient.channel === 'simulated' ? <Badge label={bi('MAJARIBIO TU', 'TEST ONLY')} tone="danger" icon="slash" /> : null}
          </View>
          <View style={styles.toRow}>
            <Text style={styles.toLabel}>{bi('Kwa', 'To')}</Text>
            <Bi text={recipientLabel(p)} style={styles.toValue} enStyle={styles.small} />
          </View>
          <View style={styles.bubble}>
            <Text style={styles.bubbleText}>{proposalText(p)}</Text>
          </View>
          <View style={styles.inlineNote}>
            <Feather name="eye-off" size={12} color={palette.faint} />
            <Text style={styles.small}>{t('preview.unreviewed')}</Text>
          </View>
          {p.envelope.recipient.channel === 'simulated' ? <Text style={styles.simNote}>{t('preview.simulated')}</Text> : null}
          <View style={styles.row}>
            <View style={styles.flex}><ActionButton label={t('action.reject')} secondary danger icon="x" onPress={() => void rejectProposal(p).then(refresh)} /></View>
            <View style={styles.flex2}><ActionButton label={t('action.approve')} icon="lock" onPress={() => { setPinError(null); setPending(p); }} disabled={!enrolled} /></View>
          </View>
        </Card>
      ))}

      <SectionTitle title={t('screen.evidence.title')} count={cards.length} />
      {cards.length === 0 ? <Notice>{t('screen.empty')}</Notice> : null}
      {cards.map((card) => {
        const neg = card.direction === 'negative';
        const pos = card.direction === 'positive';
        const color = neg ? palette.red : pos ? palette.green : palette.muted;
        return (
          <Card key={card.card_digest} accent={color}>
            <View style={styles.cardHead}>
              <View style={[styles.themeIcon, { backgroundColor: neg ? palette.redSoft : pos ? palette.greenSoft : palette.surfaceAlt }]}>
                <Feather name={neg ? 'trending-down' : pos ? 'trending-up' : 'minus'} size={20} color={color} />
              </View>
              <View style={styles.flex}>
                <Bi text={themeName(card.theme)} style={styles.cardTitle} enStyle={styles.cardTitleEn} />
              </View>
              <View style={[styles.countPill, { backgroundColor: neg ? palette.redSoft : palette.greenSoft }]}>
                <Text style={[styles.countText, { color }]}>{card.comment_count}</Text>
                <Feather name="message-circle" size={12} color={color} />
              </View>
            </View>

            <Bi text={t('card.visitors_said')} style={styles.kicker} enStyle={styles.kickerEn} />
            {card.quotes.slice(0, 3).map((q) => {
              const lang = sources.get(q.message_id)?.language;
              return (
                <View key={`${q.message_id}-${q.start}`} style={[styles.quoteBox, { borderLeftColor: color }]}>
                  <Text style={styles.quote}>“{q.quote}”</Text>
                  <View style={styles.quoteMeta}>
                    {lang ? <Text style={styles.lang}>{lang.toUpperCase()}</Text> : null}
                    <Text style={styles.synthetic}>SYNTHETIC</Text>
                    <View style={styles.flex} />
                    {!translations[q.message_id] && lang !== 'sw' ? (
                      <Pressable onPress={() => void translate(q.message_id)} accessibilityRole="button" hitSlop={10} style={styles.translateBtn}>
                        <Feather name="globe" size={12} color={palette.green} />
                        <Text style={styles.translateLink}>{bi('Tafsiri', 'Translate')}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {translations[q.message_id] ? (
                    <View style={styles.translation}>
                      <Text style={styles.translationLabel}>GEMMA 4 · {t('free_text.machine_translation')}</Text>
                      <Text style={styles.translationText}>{translations[q.message_id]}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
            <Text style={styles.small}>{t('card.mentions', { count: card.comment_count })}</Text>

            <View style={styles.suggestion}>
              <View style={styles.suggestionHead}>
                <Feather name="zap" size={14} color={palette.green} />
                <Bi text={t('card.you_could_try')} style={styles.kickerGreen} enStyle={styles.kickerEn} />
              </View>
              <Bi text={suggestionFor(card)} style={styles.body} enStyle={styles.bodyEn} />
              <Text style={styles.small}>{t('card.prospective')}</Text>
            </View>
            <View style={styles.row}>
              <View style={styles.flex}><ActionButton label={t('action.ask_someone')} secondary icon="users" onPress={() => Alert.alert(t('action.ask_someone'), t('free_text.ask_guide'))} /></View>
              <View style={styles.flex}><ActionButton label={bi('Jaribu', 'Try')} icon="send" onPress={() => void tryCard(card)} /></View>
            </View>
          </Card>
        );
      })}

      {weak.length > 0 ? <SectionTitle title={bi('Haijulikani bado', 'Not clear yet')} count={weak.length} /> : null}
      {weak.map((th) => (
        <View key={th.theme} style={styles.weak}>
          <Feather name="help-circle" size={18} color={palette.faint} />
          <View style={styles.flex}>
            <Bi text={themeName(th.theme)} style={styles.weakTitle} enStyle={styles.small} />
            <Text style={styles.small}>{th.verdict === 'conflicting' ? t('finding.conflicting') : t('finding.not_enough')}</Text>
          </View>
        </View>
      ))}
      {askCount > 0 ? <Notice tone="warning">{`${t('finding.uncertain')} · ${askCount}`}</Notice> : null}

      <SectionTitle title={bi('Zana', 'Tools')} />
      <LinkRow icon="upload" label={bi('Leta maoni (faili)', 'Import feedback file')} onPress={() => void pickAndImportFeedback().then(refresh)} />
      <LinkRow icon="cpu" label={bi('Ukaguzi wa Gemma 4', 'Gemma 4 check')} onPress={() => router.push('/gemma')} />
      <LinkRow icon="shield" label={bi('Ukaguzi wa simu (G1)', 'Phone check (G1)')} onPress={() => router.push('/device')} />

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

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  const [sw, en] = splitBi(label);
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: tone }]}>{value}</Text>
      <Text style={styles.statLabel}>{sw}</Text>
      {en ? <Text style={styles.statEn}>{en}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flex2: { flex: 1.6 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: palette.greenSoft, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, marginTop: -6, marginLeft: 4 },
  offlineText: { fontSize: 12, fontWeight: '700', color: palette.green },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, backgroundColor: palette.surface, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, ...shadow },
  statValue: { fontSize: 30, fontWeight: '800', letterSpacing: -1 },
  statLabel: { fontSize: 13, fontWeight: '700', color: palette.ink },
  statEn: { fontSize: 11, color: palette.faint },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  toLabel: { fontSize: 12, fontWeight: '800', color: palette.faint, marginTop: 2, letterSpacing: 0.5 },
  toValue: { fontSize: 15, fontWeight: '700', color: palette.ink },
  bubble: { backgroundColor: palette.greenSoft, borderRadius: radius.md, borderTopLeftRadius: 4, padding: spacing.md },
  bubbleText: { fontSize: 17, lineHeight: 25, color: palette.greenDeep },
  inlineNote: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  simNote: { fontSize: 12, fontWeight: '700', color: palette.red },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  themeIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 20, fontWeight: '800', color: palette.ink, letterSpacing: -0.3 },
  cardTitleEn: { fontSize: 13, color: palette.muted, fontWeight: '600' },
  countPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 99 },
  countText: { fontSize: 15, fontWeight: '800' },
  kicker: { fontSize: 12, fontWeight: '800', color: palette.muted, textTransform: 'uppercase', letterSpacing: 0.8, marginTop: spacing.xs },
  kickerGreen: { fontSize: 12, fontWeight: '800', color: palette.green, textTransform: 'uppercase', letterSpacing: 0.8 },
  kickerEn: { fontSize: 11, color: palette.faint },
  quoteBox: { borderLeftWidth: 3, paddingLeft: spacing.sm, paddingVertical: 2, gap: 6 },
  quote: { fontSize: 16, color: palette.ink, fontStyle: 'italic', lineHeight: 23 },
  quoteMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lang: { fontSize: 10, fontWeight: '800', color: palette.blue, backgroundColor: palette.blueSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' },
  synthetic: { fontSize: 10, fontWeight: '800', color: palette.amber, backgroundColor: palette.amberSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' },
  translateBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, backgroundColor: palette.greenSoft },
  translateLink: { fontSize: 12, color: palette.green, fontWeight: '800' },
  translation: { backgroundColor: palette.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm, gap: 3 },
  translationLabel: { fontSize: 10, fontWeight: '800', color: palette.faint, letterSpacing: 0.5 },
  translationText: { fontSize: 15, color: palette.green, lineHeight: 21 },
  suggestion: { backgroundColor: palette.surfaceAlt, borderRadius: radius.md, padding: spacing.md, gap: 6, marginTop: spacing.xs },
  suggestionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  body: { fontSize: 16, color: palette.ink, lineHeight: 23, fontWeight: '600' },
  bodyEn: { fontSize: 13, color: palette.muted, lineHeight: 18 },
  small: { fontSize: 12, color: palette.muted, lineHeight: 17 },
  weak: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', backgroundColor: palette.surfaceAlt, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: palette.line, borderStyle: 'dashed' },
  weakTitle: { fontSize: 15, fontWeight: '700', color: palette.ink },
});
