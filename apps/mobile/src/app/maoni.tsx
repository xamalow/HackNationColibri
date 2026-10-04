import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import type { StoredSource } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { useLang } from '../components/Lang';
import { loadDemoFeedback } from '../import/feedbackImport';
import { activeVariant, loadGemma, translateToSwahili, type Translation } from '../models/gemma';
import { bi, runW3, t, themeName } from '../domain/w3';
import type { TaggerLabel } from '../vendor/max/tag_feedback';
import { palette, radius, spacing } from '../theme';

type Row = { source: StoredSource; labels: TaggerLabel[]; untagged: string | null };
type Tr = Translation | 'running';

// Kept across tab switches for the demo; display only, never stored, counted or sent.
const translations = new Map<string, Tr>();
let modelLoadMs: number | null = null;

/**
 * The demo script's translation shot (packages/experience/demo/DEMO_SCRIPT.md 0:45-1:40), per review, top to bottom:
 * 1. what CODE read (Max's fixed tagger: theme + sentiment, no model), 2. Gemma 4 machine translation into Swahili,
 * made on this phone, labelled, hidden when a number changed, 3. the original, unchanged.
 */
export default function MaoniScreen() {
  useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [, setTick] = useState(0);
  const [busyAll, setBusyAll] = useState(false);
  const [loadMs, setLoadMs] = useState<number | null>(modelLoadMs);
  const rerender = () => setTick((n) => n + 1);

  const refresh = useCallback(async () => {
    const w3 = await runW3();
    setRows([...w3.sources.values()].map((source) => ({
      source,
      labels: w3.tagged.labels.filter((l) => l.message_id === source.source_id),
      untagged: w3.tagged.untagged.find((u) => u.message_id === source.source_id)?.reason ?? null,
    })));
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const translateOne = async (s: StoredSource) => {
    translations.set(s.source_id, 'running');
    rerender();
    try {
      if (modelLoadMs === null) {
        const load = await loadGemma();
        modelLoadMs = load.loadMs;
        setLoadMs(load.loadMs);
      }
      translations.set(s.source_id, await translateToSwahili(s.text));
    } catch (error) {
      translations.delete(s.source_id);
      Alert.alert('Gemma 4', error instanceof Error ? error.message : String(error));
    }
    rerender();
  };

  const translateAll = async () => {
    setBusyAll(true);
    for (const r of rows) {
      if (r.source.language !== 'sw' && !translations.has(r.source.source_id)) await translateOne(r.source);
    }
    setBusyAll(false);
  };

  const demo = async () => {
    const out = await loadDemoFeedback();
    await refresh();
    Alert.alert('SYNTHETIC', bi(`Maoni ${out.imported} ya majaribio yameongezwa.`, `${out.imported} synthetic reviews added.`));
  };

  const v = activeVariant();
  const done = [...translations.values()].filter((x): x is Translation => x !== 'running' && x.ok);
  const avgTps = done.length ? done.reduce((a, x) => a + (x.ok ? x.tokensPerSecond : 0), 0) / done.length : null;

  return (
    <Screen>
      <PageTitle icon="message-square" eyebrow="Sauti Host" title={bi('Maoni ya wageni', 'Visitor reviews')} subtitle={bi('Kila ujumbe unatafsiriwa kwenye simu hii, bila mtandao.', 'Every message is translated on this phone, offline.')} />

      <View style={styles.model}>
        <View style={styles.modelIcon}><Feather name="cpu" size={20} color={palette.white} /></View>
        <View style={styles.flex}>
          <Text style={styles.modelName}>{v ? v.label : bi('Hakuna modeli kwenye simu', 'No model on this phone')}</Text>
          <Text style={styles.modelMeta}>
            {bi('Kwenye simu', 'On this phone')} · {v?.license ?? '-'}
            {loadMs !== null ? ` · ${bi('imepakiwa', 'loaded')} ${(loadMs / 1000).toFixed(1)} s` : ''}
            {avgTps !== null ? ` · ${avgTps.toFixed(1)} tok/s` : ''}
          </Text>
        </View>
        <Feather name="wifi-off" size={18} color="#B8D4C7" />
      </View>

      {rows.length === 0 ? (
        <Card>
          <Bi text={t('screen.empty')} style={styles.body} />
          <ActionButton icon="download" label={bi('Pakia maoni ya majaribio (SYNTHETIC)', 'Load demo reviews (SYNTHETIC)')} onPress={() => void demo()} />
        </Card>
      ) : (
        <ActionButton icon="globe" busy={busyAll} disabled={!v} label={bi('Tafsiri yote kwenye simu (Gemma 4)', 'Translate all on this phone (Gemma 4)')} onPress={() => void translateAll()} />
      )}
      <Notice tone="info">{bi('Maandishi ya wageni ni data, si maagizo. Tafsiri ni msaada wa kusoma tu: bei, tarehe na idadi zinatoka kwenye programu.', 'Visitor text is data, never instructions. Translation is a reading aid only: prices, dates and counts come from code.')}</Notice>

      {rows.length > 0 ? <SectionTitle title={bi('Maoni', 'Reviews')} count={rows.length} /> : null}
      {rows.map(({ source, labels, untagged }) => {
        const tr = translations.get(source.source_id);
        const isSw = source.language === 'sw';
        return (
          <Card key={source.source_id}>
            <View style={styles.badges}>
              <Badge label={(source.language ?? 'und').toUpperCase()} tone="info" icon="globe" />
              <Badge label="SYNTHETIC" tone="warning" />
            </View>

            <View style={styles.step}>
              <StepHead n={1} icon="code" title={bi('Programu ilisoma (bila modeli)', 'What code read (no model)')} />
              {labels.length ? labels.map((l, i) => (
                <View key={i} style={styles.labelRow}>
                  <Feather name={l.sentiment === 'negative' ? 'trending-down' : l.sentiment === 'positive' ? 'trending-up' : 'minus'} size={15} color={l.sentiment === 'negative' ? palette.red : l.sentiment === 'positive' ? palette.green : palette.muted} />
                  <Text style={styles.labelText}>
                    {themeName(l.theme)} · <Text style={{ color: l.sentiment === 'negative' ? palette.red : l.sentiment === 'positive' ? palette.green : palette.muted }}>{l.sentiment === 'negative' ? bi('hasi', 'negative') : l.sentiment === 'positive' ? bi('chanya', 'positive') : bi('kawaida', 'neutral')}</Text>
                  </Text>
                </View>
              )) : (
                <Text style={styles.muted}>{bi('Hakuna mada inayojulikana. Haijahesabiwa; hakuna hatua iliyoundwa.', 'No known theme. Not counted; no action created.')}{untagged ? ` (${untagged})` : ''}</Text>
              )}
            </View>

            <View style={[styles.step, styles.aiStep]}>
              <StepHead n={2} icon="cpu" title={`Gemma 4 · ${t('free_text.machine_translation')}`} />
              {isSw ? (
                <Text style={styles.muted}>{bi('Tayari ni Kiswahili.', 'Already Swahili.')}</Text>
              ) : tr === 'running' ? (
                <Text style={styles.muted}>{bi('Inatafsiri kwenye simu…', 'Translating on the phone…')}</Text>
              ) : tr && tr.ok ? (
                <>
                  <Text style={styles.translation}>{tr.text}</Text>
                  <Text style={styles.metric}>{(tr.ms / 1000).toFixed(1)} s · {tr.tokensPerSecond.toFixed(1)} tok/s · {bi('bila mtandao', 'offline')}</Text>
                </>
              ) : tr ? (
                <View style={styles.guard}>
                  <Feather name="alert-triangle" size={14} color={palette.red} />
                  <Text style={styles.guardText}>{tr.reason === 'number_changed' ? bi('Namba hazilingani: soma ujumbe asili.', 'Numbers do not match: read the original.') : bi('Tafsiri imefichwa: haiaminiki.', 'Translation hidden: not reliable.')}</Text>
                </View>
              ) : (
                <ActionButton secondary icon="globe" disabled={!v} label={bi('Tafsiri', 'Translate')} onPress={() => void translateOne(source)} />
              )}
            </View>

            <View style={styles.step}>
              <StepHead n={3} icon="file-text" title={bi('Maandishi ya asili', 'Original, unchanged')} />
              <Text style={styles.original}>“{source.text}”</Text>
            </View>
          </Card>
        );
      })}

      {rows.length > 0 ? <ActionButton secondary icon="download" label={bi('Pakia maoni ya majaribio (SYNTHETIC)', 'Load demo reviews (SYNTHETIC)')} onPress={() => void demo()} /> : null}
    </Screen>
  );
}

function StepHead({ n, icon, title }: { n: number; icon: 'code' | 'cpu' | 'file-text'; title: string }) {
  return (
    <View style={styles.stepHead}>
      <View style={styles.stepNum}><Text style={styles.stepNumText}>{n}</Text></View>
      <Feather name={icon} size={13} color={palette.muted} />
      <View style={styles.flex}><Bi text={title} style={styles.stepTitle} enStyle={styles.stepTitleEn} /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { fontSize: 16, color: palette.ink, fontWeight: '600' },
  model: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: palette.greenDeep, borderRadius: radius.lg, padding: spacing.md },
  modelIcon: { width: 44, height: 44, borderRadius: 13, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  modelName: { fontSize: 16, fontWeight: '800', color: palette.white },
  modelMeta: { fontSize: 12, color: '#B8D4C7', marginTop: 2 },
  badges: { flexDirection: 'row', gap: 6 },
  step: { gap: 6 },
  aiStep: { backgroundColor: palette.greenSoft, borderRadius: radius.md, padding: spacing.sm },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepNum: { width: 18, height: 18, borderRadius: 9, backgroundColor: palette.ink, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { color: palette.white, fontSize: 10, fontWeight: '800' },
  stepTitle: { fontSize: 11, fontWeight: '800', color: palette.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
  stepTitleEn: { fontSize: 10, color: palette.faint },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labelText: { fontSize: 15, fontWeight: '700', color: palette.ink },
  muted: { fontSize: 13, color: palette.muted, lineHeight: 18 },
  translation: { fontSize: 16, color: palette.greenDeep, lineHeight: 23, fontWeight: '600' },
  metric: { fontSize: 11, color: palette.green, fontFamily: 'Menlo' },
  guard: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  guardText: { fontSize: 14, color: palette.red, fontWeight: '700', flex: 1 },
  original: { fontSize: 15, color: palette.ink, fontStyle: 'italic', lineHeight: 22 },
});
