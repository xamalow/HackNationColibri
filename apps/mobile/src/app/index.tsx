import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { digest, type DecisionCard, type StoredAction, type StoredSource, type ThemeSummary } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, LinkRow, Notice, PageTitle, Screen, splitBi } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { approveWithPin, recoverInterruptedSends, rejectProposal } from '../domain/actions';
import { listActions, listAskedCards, listAskedQuestions, sha256 } from '../domain/coreDb';
import { isEnrolled } from '../domain/pin';
import { bi, proposeThanks, recordAskForMissingInfo, recordAskSomeone, runW3, t, themeName } from '../domain/w3';
import { afterBookSlotApproved } from '../domain/visits';
import { proposalText, recipientLabel } from '../domain/display';
import { buildMissingInfoQuestions, type MissingInfoQuestion } from '../domain/missingInfo';
import { runExclusive } from '../domain/actionGate';
import { loadDemoData } from '../demo/loadDemo';
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
  approval_conflict: bi('Idhini imegongana na mabadiliko mengine. Pakia upya Leo kisha ujaribu tena.', 'Approval conflict. Reload Today and try again.'),
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

function missingInfoPrompt(question: MissingInfoQuestion): string {
  const subject = question.theme ? themeName(question.theme) : bi('mada hii', 'this topic');
  switch (question.reason) {
    case 'insufficient_feedback':
      return bi(`Maoni hayatoshi kuhusu ${subject}. Muulize mtu kabla ya kuamua.`, `There is not enough feedback about ${subject}. Ask a person before deciding.`);
    case 'contradictory_reviews':
      return bi(`Wageni hawakubaliani kuhusu ${subject}. Muulize mtu kabla ya kuamua.`, `Visitors disagree about ${subject}. Ask a person before deciding.`);
    case 'unsupported_language':
      return bi('Baadhi ya maoni yako katika lugha inayohitaji msaada wa mtu.', 'Some feedback is in a language that needs human review.');
    case 'evidence_invalid':
      return bi('Baadhi ya ushahidi haukuweza kuthibitishwa dhidi ya maoni asili.', 'Some evidence could not be checked against the original feedback.');
    case 'structured_output_failure':
      return bi('Uchambuzi haukupita ukaguzi. Hakuna hitimisho lililotolewa.', 'The analysis did not pass validation. No finding was concluded.');
  }
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
  const [askedCards, setAskedCards] = useState<Set<string>>(new Set());
  const [missingQuestions, setMissingQuestions] = useState<MissingInfoQuestion[]>([]);
  const [askedQuestionIds, setAskedQuestionIds] = useState<Set<string>>(new Set());
  const activeActions = useRef(new Set<string>());
  const [busyActions, setBusyActions] = useState<Set<string>>(new Set());

  const performAction = async (key: string, action: () => Promise<void>) => {
    try {
      await runExclusive(activeActions.current, key, action, setBusyActions);
    } catch (error) {
      Alert.alert('Sauti', error instanceof Error ? error.message : String(error));
    }
  };
  const [synthetic, setSynthetic] = useState<Set<string>>(new Set());

  const translate = async (messageId: string) => {
    const original = sources.get(messageId)?.text;
    if (!original) return;
    setTranslations((m) => ({ ...m, [messageId]: '…' }));
    try {
      const tr = await translateToSwahili(original);
      setTranslations((m) => ({ ...m, [messageId]: tr.ok ? tr.text : bi('Tafsiri imefichwa: haiaminiki.', `Translation hidden: not reliable (${tr.reason}).`) }));
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Gemma error';
      setTranslations((m) => ({ ...m, [messageId]: msg === 'not_verified' ? bi('Thibitisha modeli kwanza (Ukaguzi wa Gemma 4).', 'Verify the model first (Gemma 4 check).') : msg }));
    }
  };

  const refresh = useCallback(async () => {
    try {
      await recoverInterruptedSends();
      setEnrolled(await isEnrolled());
      const w3 = await runW3();
      setCards(w3.cards);
      setWeak(w3.analysis.themes.filter((th) => th.verdict === 'insufficient' || th.verdict === 'conflicting'));
      const questions = buildMissingInfoQuestions(w3.analysis, (domain, value) => digest(domain, value, sha256));
      setMissingQuestions(questions);
      setAskCount(questions.length);
      setSources(w3.sources);
      setSynthetic(w3.synthetic);
      setProposals((await listActions()).filter((a) => a.business === 'proposed'));
      setAskedCards(await listAskedCards());
      setAskedQuestionIds(await listAskedQuestions());
    } catch (error) {
      Alert.alert('Sauti', error instanceof Error ? error.message : bi('Hitilafu ya ndani.', 'Internal error.'));
    }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const tryCard = async (card: DecisionCard) => {
    await performAction(`try:${card.card_digest}`, async () => {
      const made = await proposeThanks(card, sources);
      await refresh();
      if (!made.ok) {
        Alert.alert(t('finding.uncertain'), made.reason);
        return;
      }
      scrollTop.current?.();
      Alert.alert(bi('Pendekezo limeundwa', 'Proposal created'), bi('Liko juu ya Leo. Hakuna kilichotumwa: liidhinishe kwa PIN yako.', 'It is at the top of Today. Nothing was sent: approve it with your PIN.'));
    });
  };

  const reject = async (p: StoredAction) => {
    await performAction(`reject:${p.envelope.action_id}`, async () => {
      await rejectProposal(p);
      await refresh();
      Alert.alert(t('state.business.rejected'), bi('Hakuna kitakachotumwa.', 'Nothing will be sent.'));
    });
  };

  const askSomeone = async (card: DecisionCard) => {
    await performAction(`ask:${card.card_digest}`, async () => {
      await recordAskSomeone(card);
      setAskedCards((m) => new Set(m).add(card.card_digest));
      Alert.alert(t('action.ask_someone'), t('free_text.ask_guide'));
    });
  };

  const loadDemo = async () => {
    await performAction('load-demo', async () => {
      const out = await loadDemoData();
      await refresh();
      Alert.alert('SYNTHETIC', bi(`Maoni ${out.reviews} ya majaribio yameongezwa${out.farmLoaded ? ' + shamba la majaribio' : ''}.`, `${out.reviews} synthetic reviews added${out.farmLoaded ? ' + demo farm' : ''}.`));
    });
  };

  const importFile = async () => {
    await performAction('import-feedback', async () => {
      const out = await pickAndImportFeedback();
      await refresh();
      if (out.imported || out.skipped) Alert.alert(bi('Maoni', 'Reviews'), bi(`${out.imported} mapya, ${out.skipped} yaliyorudiwa.`, `${out.imported} new, ${out.skipped} duplicates.`));
    });
  };

  const askForMissingInfo = async (question: MissingInfoQuestion) => {
    await performAction(`ask-missing:${question.id}`, async () => {
      await recordAskForMissingInfo(question);
      setAskedQuestionIds((current) => new Set(current).add(question.id));
      Alert.alert(t('action.ask_someone'), t('free_text.ask_guide'));
    });
  };

  const approve = async (pin: string) => {
    if (!pending) return;
    await performAction(`approve:${pending.envelope.action_id}`, async () => {
      setBusy(true);
      setPinError(null);
      try {
        const outcome = await approveWithPin(pending, pin);
        if (outcome.ok && pending.envelope.kind === 'book_slot') {
          const after = await afterBookSlotApproved({ ...pending, business: 'approved', transport: 'queued' });
          if (!after.ok) Alert.alert(t('finding.uncertain'), after.reason);
        }
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
      } finally {
        setBusy(false);
      }
    });
  };

  const router = useRouter();
  const scrollTop = useRef<(() => void) | null>(null);

  const approvePressed = (p: StoredAction) => {
    if (!enrolled) {
      Alert.alert('PIN', reasonText().not_enrolled, [
        { text: bi('Acha', 'Cancel'), style: 'cancel' },
        { text: bi('Weka PIN', 'Set PIN'), onPress: () => router.push('/shamba') },
      ]);
      return;
    }
    setPinError(null);
    setPending(p);
  };

  return (
    <Screen scrollRef={scrollTop}>
      <PageTitle icon="sun" eyebrow={bi('Sauti Host · bila mtandao', 'Sauti Host · offline')} title={t('screen.today.title')} />

      {proposals.map((p) => (
        <Card key={p.envelope.action_id} accent={palette.amber}>
          <View style={styles.badges}>
            <Badge label={splitBi(t('state.business.proposed'))[0]} tone="warning" icon="clock" />
            {p.envelope.recipient.channel === 'simulated' ? <Badge label={bi('MAJARIBIO TU', 'TEST ONLY')} tone="danger" icon="slash" /> : null}
          </View>
          <Text style={styles.small}>{bi('Kwa', 'To')}: {recipientLabel(p)}</Text>
          <View style={styles.bubble}><Text style={styles.bubbleText}>{proposalText(p)}</Text></View>
          <Text style={styles.small}>{t('preview.unreviewed')}</Text>
          <View style={styles.row}>
            <View style={styles.flex}><ActionButton label={t('action.reject')} secondary danger icon="x" onPress={() => void reject(p)} busy={busyActions.has(`reject:${p.envelope.action_id}`)} /></View>
            <View style={styles.flex2}><ActionButton label={t('action.approve')} icon="lock" onPress={() => approvePressed(p)} /></View>
          </View>
        </Card>
      ))}

      {cards.length === 0 ? (
        <Card>
          <Bi text={t('screen.empty')} style={styles.body} enStyle={styles.bodyEn} />
          <ActionButton icon="download" label={bi('Pakia maoni ya majaribio (SYNTHETIC)', 'Load demo reviews (SYNTHETIC)')} onPress={() => void loadDemo()} busy={busyActions.has('load-demo')} />
        </Card>
      ) : null}
      {cards.map((card) => {
        const neg = card.direction === 'negative';
        const pos = card.direction === 'positive';
        const color = neg ? palette.red : pos ? palette.green : palette.muted;
        const asked = askedCards.has(card.card_digest);
        return (
          <Card key={card.card_digest} accent={color}>
            <View style={styles.cardHead}>
              <Feather name={neg ? 'trending-down' : pos ? 'trending-up' : 'minus'} size={20} color={color} />
              <View style={styles.flex}><Bi text={themeName(card.theme)} style={styles.cardTitle} enStyle={styles.cardTitleEn} /></View>
              <Text style={[styles.countText, { color }]}>{card.comment_count} <Feather name="message-circle" size={13} color={color} /></Text>
            </View>
            {card.quotes.slice(0, 2).map((q) => {
              const lang = sources.get(q.message_id)?.language;
              return (
                <View key={`${q.message_id}-${q.start}`} style={[styles.quoteBox, { borderLeftColor: color }]}>
                  <Text style={styles.quote}>“{q.quote}”{synthetic.has(q.message_id) ? <Text style={styles.synthetic}> SYNTHETIC</Text> : null}</Text>
                  {translations[q.message_id] ? (
                    <Text style={styles.translationText}>{translations[q.message_id]} <Text style={styles.translationLabel}>· Gemma 4</Text></Text>
                  ) : lang !== 'sw' ? (
                    <Pressable onPress={() => void translate(q.message_id)} accessibilityRole="button" hitSlop={10}>
                      <Text style={styles.translateLink}>{bi('Tafsiri kwa Kiswahili', 'Translate to Swahili')} →</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            <Text style={styles.body}>{suggestionFor(card)}</Text>
            <Text style={styles.small}>{t('card.prospective')}</Text>
            {asked ? (
              <Notice tone="info">{bi('Umeamua kumuuliza mtu. Imeandikwa.', 'You chose to ask someone. Recorded.')}</Notice>
            ) : (
              <View style={styles.row}>
                <View style={styles.flex}><ActionButton label={t('action.ask_someone')} secondary icon="users" onPress={() => void askSomeone(card)} busy={busyActions.has(`ask:${card.card_digest}`)} /></View>
                <View style={styles.flex}><ActionButton label={bi('Jaribu', 'Try')} icon="send" onPress={() => void tryCard(card)} busy={busyActions.has(`try:${card.card_digest}`)} /></View>
              </View>
            )}
          </Card>
        );
      })}

      {weak.length > 0 ? (
        <View style={styles.weak}>
          <Feather name="help-circle" size={16} color={palette.faint} />
          <Text style={[styles.small, styles.flex]}>
            {t('finding.not_enough')} {weak.map((th) => splitBi(themeName(th.theme))[0]).join(', ')}
          </Text>
        </View>
      ) : null}
      {askCount > 0 ? <Notice tone="warning">{`${t('finding.uncertain')} · ${askCount}`}</Notice> : null}

      {missingQuestions.map((question) => (
        <Card key={question.id} accent={palette.blue}>
          <Bi text={missingInfoPrompt(question)} style={styles.body} enStyle={styles.bodyEn} />
          {askedQuestionIds.has(question.id) ? (
            <Notice tone="info">{bi('Umeomba msaada kuhusu ushahidi huu. Uamuzi bado haujafanywa.', 'You asked for help with this evidence. No decision was made.')}</Notice>
          ) : (
            <ActionButton
              label={t('action.ask_someone')}
              secondary
              icon="users"
              busy={busyActions.has(`ask-missing:${question.id}`)}
              onPress={() => void askForMissingInfo(question)}
            />
          )}
        </Card>
      ))}

      <LinkRow icon="cpu" label={bi('Ukaguzi wa Gemma 4', 'Gemma 4 check')} onPress={() => router.push('/gemma')} />
      <ActionButton icon="upload" secondary label={bi('Leta maoni (faili)', 'Import feedback file')} onPress={() => void importFile()} busy={busyActions.has('import-feedback')} />

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
