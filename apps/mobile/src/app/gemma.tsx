import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { activeVariant, loadGemma, translateToSwahili, verifyGemma } from '../models/gemma';
import { bi, t } from '../domain/w3';
import { palette, spacing } from '../theme';

const SAMPLE = 'Lovely coffee tour and a warm welcome, but the directions from the market were confusing.';

/** Gemma 4 E4B device check (Carter #47612): integrity, load, one translation, measured on this phone. */
export default function GemmaScreen() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState<'verify' | 'run' | null>(null);
  const log = (l: string) => setLines((prev) => [...prev, l]);

  const verify = async () => {
    setBusy('verify');
    const r = await verifyGemma();
    log(r.ok ? `OK ${r.label}: size + sampled SHA-256 in ${r.ms} ms · audio ${r.withAudio ? 'yes' : 'no'}` : `FAILED: ${r.reason}`);
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

  return (
    <Screen>
      <PageTitle eyebrow="Sauti · Gemma 4" title={bi('Ukaguzi wa Gemma 4', 'Gemma 4 check')} subtitle={activeVariant() ? `${activeVariant()!.label} · ${activeVariant()!.license} · ${(activeVariant()!.model.bytes / 1e9).toFixed(2)} GB` : bi('Hakuna modeli kwenye simu', 'No model on this phone')} />
      <Notice>{bi('Weka simu kwenye hali ya ndege kabla ya jaribio.', 'Put the phone in airplane mode before the test.')}</Notice>
      <Card style={styles.card}>
        <ActionButton label={bi('Kagua faili', 'Verify files')} onPress={() => void verify()} busy={busy === 'verify'} secondary />
        <ActionButton label={bi('Pakia na tafsiri', 'Load and translate')} onPress={() => void run()} busy={busy === 'run'} />
      </Card>
      <SectionTitle title={bi('Maandishi ya asili', 'Original text')} />
      <Card><Text style={styles.body}>{SAMPLE} <Text style={styles.tag}>SYNTHETIC</Text></Text></Card>
      <SectionTitle title={t('free_text.machine_translation')} />
      <Card style={styles.card}>
        {lines.length === 0 ? <Text style={styles.meta}>—</Text> : lines.map((l, i) => <Text key={i} style={styles.body}>{l}</Text>)}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { fontSize: 16, color: palette.ink, lineHeight: 23 },
  meta: { fontSize: 15, color: palette.muted },
  tag: { fontSize: 11, color: palette.amber, fontWeight: '800' },
});
