import { Feather } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { activeVariant, fullVerifyGemma, loadGemma, translateToSwahili, verifiedRecord } from '../models/gemma';
import { bi, t } from '../domain/w3';
import { useLang } from '../components/Lang';
import { palette, spacing } from '../theme';

const SAMPLE = 'Lovely coffee tour and a warm welcome, but the directions from the market were confusing.';

/** Gemma 4 E4B device check (Carter #47612): integrity, load, one translation, measured on this phone. */
export default function GemmaScreen() {
  useLang();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<'verify' | 'run' | null>(null);
  const log = (l: string) => setLines((prev) => [...prev, l]);

  const [progress, setProgress] = useState<number | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  useEffect(() => {
    void verifiedRecord().then((r) => setVerified(r ? `${r.verifiedAt.slice(0, 16).replace('T', ' ')} · ${(r.verifiedMs / 60000).toFixed(1)} min` : null));
  }, []);

  const verify = async () => {
    setBusy('verify');
    setProgress(0);
    let last = 0;
    const r = await fullVerifyGemma((f) => { if (f - last >= 0.005 || f === 1) { last = f; setProgress(f); } });
    log(r.ok ? `OK ${r.label}: full SHA-256 on this phone in ${(r.ms / 1000).toFixed(0)} s` : `FAILED: ${r.reason}`);
    if (r.ok) setVerified(`${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${(r.ms / 60000).toFixed(1)} min`);
    setProgress(null);
    setBusy(null);
  };

  const run = async () => {
    setBusy('run');
    try {
      const load = await loadGemma();
      log(load.reused ? 'Model already loaded' : `Cold load ${load.loadMs} ms (n_gpu_layers 99, n_ctx 2048)`);
      const tr = await translateToSwahili(SAMPLE);
      log(tr.ok ? `Translation ${tr.ms} ms · ${tr.tokensPerSecond.toFixed(1)} tok/s\n${tr.text}` : `Translation hidden (${tr.reason}) after ${tr.ms} ms`);
    } catch (e) {
      log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(null);
  };

  const v = activeVariant();
  return (
    <Screen>
      <PageTitle icon="cpu" eyebrow="Sauti · Gemma 4" title={bi('Ukaguzi wa Gemma 4', 'Gemma 4 check')} />
      <View style={styles.model}>
        <View style={styles.modelIcon}><Feather name="cpu" size={22} color={palette.white} /></View>
        <View style={styles.flex}>
          <Text style={styles.modelName}>{v ? v.label : bi('Hakuna modeli kwenye simu', 'No model on this phone')}</Text>
          {v ? <Text style={styles.modelMeta}>{v.license} · {(v.model.bytes / 1e9).toFixed(2)} GB · {bi('kwenye simu', 'on device')}</Text> : null}
        </View>
      </View>
      {verified ? (
        <Notice tone="success">{bi(`SHA-256 kamili imethibitishwa kwenye simu hii: ${verified}`, `Full SHA-256 verified on this phone: ${verified}`)}</Notice>
      ) : (
        <Notice tone="warning">{bi('Gemma haitapakiwa mpaka SHA-256 kamili ithibitishwe kwenye simu hii (mara moja, dakika kadhaa).', 'Gemma will not load until its full SHA-256 is verified on this phone (once, a few minutes).')}</Notice>
      )}
      {progress !== null ? (
        <View style={styles.bar}><View style={[styles.barFill, { width: `${Math.round(progress * 100)}%` }]} /><Text style={styles.barText}>SHA-256 {Math.round(progress * 100)}%</Text></View>
      ) : null}
      <Notice tone="info">{bi('Weka simu kwenye hali ya ndege kabla ya jaribio.', 'Put the phone in airplane mode before the test.')}</Notice>
      <View style={styles.row}>
        <View style={styles.flex}><ActionButton icon="shield" label={bi('Thibitisha SHA-256 kamili', 'Verify full SHA-256')} onPress={() => void verify()} busy={busy === 'verify'} secondary /></View>
        <View style={styles.flex}><ActionButton icon="play" label={bi('Pakia na tafsiri', 'Load and translate')} onPress={() => void run()} busy={busy === 'run'} disabled={!verified} /></View>
      </View>
      <SectionTitle title={bi('Maandishi ya asili', 'Original text')} />
      <Card>
        <Text style={styles.quote}>“{SAMPLE}”</Text>
        <Text style={styles.tag}>EN · SYNTHETIC</Text>
      </Card>
      <SectionTitle title={t('free_text.machine_translation')} />
      <View style={styles.console}>
        {lines.length === 0 ? <Text style={styles.consoleMuted}>$ {bi('inasubiri', 'waiting')}…</Text> : lines.map((l, i) => (
          <Text key={i} style={[styles.consoleLine, l.startsWith('FAILED') || l.startsWith('ERROR') ? styles.consoleBad : l.startsWith('OK') ? styles.consoleOk : null]}>{l}</Text>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm },
  model: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: palette.greenDeep, borderRadius: 20, padding: spacing.md },
  modelIcon: { width: 48, height: 48, borderRadius: 14, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  modelName: { fontSize: 17, fontWeight: '800', color: palette.white },
  modelMeta: { fontSize: 13, color: '#B8D4C7', marginTop: 2 },
  quote: { fontSize: 17, color: palette.ink, fontStyle: 'italic', lineHeight: 24 },
  tag: { fontSize: 10, color: palette.amber, fontWeight: '800', letterSpacing: 0.5 },
  bar: { height: 28, borderRadius: 14, backgroundColor: palette.surfaceAlt, overflow: 'hidden', justifyContent: 'center' },
  barFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: palette.green },
  barText: { textAlign: 'center', fontSize: 12, fontWeight: '800', color: palette.ink },
  console: { backgroundColor: '#14201B', borderRadius: 16, padding: spacing.md, gap: spacing.sm, minHeight: 90 },
  consoleLine: { fontFamily: 'Menlo', fontSize: 13, lineHeight: 19, color: '#E6EFE9' },
  consoleMuted: { fontFamily: 'Menlo', fontSize: 13, color: '#6E8379' },
  consoleOk: { color: '#7FD6A8' },
  consoleBad: { color: '#F2A497' },
});
