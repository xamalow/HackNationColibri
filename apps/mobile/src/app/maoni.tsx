import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StoredSource } from '@sauti/core';
import { ActionButton, Bi, Card, PageTitle, Screen, splitBi } from '../components/Screen';
import { useLang } from '../components/Lang';
import { loadDemoFeedback } from '../import/feedbackImport';
import { activeVariant, loadGemma, translateToSwahili, type Translation } from '../models/gemma';
import { bi, runW3, t, themeName } from '../domain/w3';
import type { TaggerLabel } from '../vendor/max/tag_feedback';
import { palette, radius, spacing } from '../theme';

type Row = { source: StoredSource; labels: TaggerLabel[] };
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
      const msg = error instanceof Error ? error.message : String(error);
      Alert.alert('Gemma 4', msg === 'not_verified'
        ? bi('Thibitisha modeli kwanza: Leo → Ukaguzi wa Gemma 4 → SHA-256 kamili.', 'Verify the model first: Today → Gemma 4 check → full SHA-256.')
        : msg);
    }
    rerender();
  };

  const translateAll = async () => {
    if (!activeVariant()) {
      Alert.alert('Gemma 4', bi('Hakuna modeli kwenye simu hii.', 'No model on this phone.'));
      return;
    }
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
      <PageTitle icon="message-square" eyebrow="Sauti Host" title={bi('Maoni ya wageni', 'Visitor reviews')} />

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
        <ActionButton icon="globe" busy={busyAll} label={bi('Tafsiri yote kwenye simu (Gemma 4)', 'Translate all on this phone (Gemma 4)')} onPress={() => void translateAll()} />
      )}

      {rows.map(({ source, labels }) => {
        const tr = translations.get(source.source_id);
        const isSw = source.language === 'sw';
        return (
          <Card key={source.source_id}>
            <View style={styles.chips}>
              <Text style={styles.lang}>{(source.language ?? 'und').toUpperCase()}</Text>
              {labels.map((l, i) => (
                <Text key={i} style={[styles.chip, { color: l.sentiment === 'negative' ? palette.red : l.sentiment === 'positive' ? palette.green : palette.muted }]}>
                  {l.sentiment === 'negative' ? '▼' : l.sentiment === 'positive' ? '▲' : '•'} {splitBi(themeName(l.theme))[0]}
                </Text>
              ))}
              {!labels.length ? <Text style={styles.chip}>{bi('hakuna mada · haijahesabiwa', 'no theme · not counted')}</Text> : null}
              <View style={styles.flex} />
              <Text style={styles.synthetic}>SYNTHETIC</Text>
            </View>
            <Text style={styles.original}>“{source.text}”</Text>
            {isSw ? null : tr === 'running' ? (
              <View style={styles.aiStep}><ActivityIndicator color={palette.green} /><Text style={styles.muted}>{bi('Gemma 4 inatafsiri kwenye simu…', 'Gemma 4 translating on the phone…')}</Text></View>
            ) : tr && tr.ok ? (
              <View style={styles.aiStep}>
                <Text style={styles.translation}>{tr.text}</Text>
                <Text style={styles.metric}>Gemma 4 · {(tr.ms / 1000).toFixed(1)} s · {tr.tokensPerSecond.toFixed(1)} tok/s · {bi('bila mtandao', 'offline')}</Text>
              </View>
            ) : tr ? (
              <View style={styles.guard}>
                <Feather name="alert-triangle" size={14} color={palette.red} />
                <Text style={styles.guardText}>{tr.reason === 'number_changed' ? bi('Namba hazilingani: soma ujumbe asili.', 'Numbers do not match: read the original.') : bi('Tafsiri imefichwa: haiaminiki.', 'Translation hidden: not reliable.')}</Text>
              </View>
            ) : (
              <Pressable onPress={() => void translateOne(source)} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.translateLink}>{bi('Tafsiri kwa Kiswahili', 'Translate to Swahili')} →</Text>
              </Pressable>
            )}
          </Card>
        );
      })}

      {rows.length > 0 ? <Text style={styles.footer}>{bi('Tafsiri ni msaada wa kusoma tu: bei, tarehe na idadi zinatoka kwenye programu.', 'Translation is a reading aid only: prices, dates and counts come from code.')}</Text> : null}
      {rows.length > 0 ? <ActionButton secondary icon="download" label={bi('Pakia maoni ya majaribio (SYNTHETIC)', 'Load demo reviews (SYNTHETIC)')} onPress={() => void demo()} /> : null}
    </Screen>
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
  aiStep: { backgroundColor: palette.greenSoft, borderRadius: radius.md, padding: spacing.sm, gap: 4 },
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chip: { fontSize: 13, fontWeight: '700', color: palette.muted },
  lang: { fontSize: 10, fontWeight: '800', color: palette.blue, backgroundColor: palette.blueSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, overflow: 'hidden' },
  synthetic: { fontSize: 10, fontWeight: '800', color: palette.amber },
  translateLink: { fontSize: 14, color: palette.green, fontWeight: '800' },
  footer: { fontSize: 12, color: palette.faint, textAlign: 'center', paddingHorizontal: spacing.md },
  original: { fontSize: 15, color: palette.ink, fontStyle: 'italic', lineHeight: 22 },
});
