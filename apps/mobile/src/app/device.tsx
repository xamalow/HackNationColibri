import * as Crypto from 'expo-crypto';
import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { countFeedbackSources, pickAndImportFeedback } from '../import/feedbackImport';
import {
  getInstalledModel,
  pickAndImportCandidateModel,
  runLocalQwenSuggestion,
  type InferenceEvidence,
  type InstalledModel,
} from '../models/modelManager';
import { getSqlCipherVersion, readRestartProbe, recordRestartProbe } from '../storage/secureDatabase';
import { palette, spacing } from '../theme';

const BOOT_ID = Crypto.randomUUID();

export default function TodayScreen() {
  const [feedbackCount, setFeedbackCount] = useState(0);
  const [model, setModel] = useState<InstalledModel | null>(null);
  const [cipherVersion, setCipherVersion] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [previousProbe, setPreviousProbe] = useState<{ marker: string; bootId: string } | null>(null);
  const [busy, setBusy] = useState<'import' | 'model' | 'inference' | 'probe' | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<InferenceEvidence | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [count, installed, cipher, probe] = await Promise.all([
        countFeedbackSources(), getInstalledModel(), getSqlCipherVersion(), readRestartProbe(),
      ]);
      setFeedbackCount(count);
      setModel(installed);
      setCipherVersion(cipher);
      setPreviousProbe(probe);
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Local encrypted storage could not be opened.');
    }
  }, []);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const importFeedback = async () => {
    setBusy('import');
    try {
      const result = await pickAndImportFeedback();
      if (result.imported > 0 || result.skipped > 0) {
        Alert.alert('Feedback imported', `${result.imported} new source(s) added. ${result.skipped} duplicate(s) skipped.`);
      }
      await refresh();
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'The file could not be imported.');
    } finally {
      setBusy(null);
    }
  };

  const importModel = async () => {
    setBusy('model');
    setProgress('Preparing the local model import…');
    try {
      const installed = await pickAndImportCandidateModel((copied, total) => {
        setProgress(`Verifying ${Math.floor((copied / total) * 100)}% · ${(copied / 1024 / 1024).toFixed(0)} MiB`);
      });
      if (installed) setModel(installed);
      await refresh();
    } catch (error) {
      Alert.alert('Model import failed', error instanceof Error ? error.message : 'The selected model could not be verified.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const runSuggestion = async () => {
    setBusy('inference');
    try {
      const { listFeedbackSources } = await import('../import/feedbackImport');
      const source = (await listFeedbackSources(1))[0];
      if (!source) throw new Error('Import feedback first so the model can produce a local suggestion.');
      setSuggestion(await runLocalQwenSuggestion(source.text));
    } catch (error) {
      Alert.alert('Local suggestion unavailable', error instanceof Error ? error.message : 'The model could not run.');
    } finally {
      setBusy(null);
    }
  };

  const saveRestartProbe = async () => {
    setBusy('probe');
    try {
      await recordRestartProbe(BOOT_ID);
      await refresh();
      Alert.alert('Encrypted marker saved', 'Force close the app, open it again, and check that the marker below is still present.');
    } catch (error) {
      Alert.alert('Storage check failed', error instanceof Error ? error.message : 'The marker could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const survivedRestart = previousProbe !== null && previousProbe.bootId !== BOOT_ID;

  return (
    <Screen>
      <PageTitle eyebrow="Sauti Host · W3 feedback" title="Today" subtitle="Listen to visitor feedback, ground every decision in its source, and keep owner approval in control." />

      <Card style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroDot} />
          <Text style={styles.heroKicker}>LOCAL WORKSPACE</Text>
        </View>
        <Text style={styles.heroTitle}>{feedbackCount === 0 ? 'Start with real feedback.' : `${feedbackCount} feedback source${feedbackCount === 1 ? '' : 's'} on this device.`}</Text>
        <Text style={styles.body}>Imported text stays in the encrypted local database. Model output is shown as an unverified suggestion and never becomes an owner decision.</Text>
        <ActionButton label="Import feedback file" onPress={() => void importFeedback()} busy={busy === 'import'} />
        <Link href="/evidence" asChild><Text style={styles.textLink}>Review source evidence →</Text></Link>
      </Card>

      <SectionTitle title="Grounding status" />
      <Card>
        <Text style={styles.cardTitle}>No Swahili decision is made here yet</Text>
        <Text style={styles.body}>The deterministic Domain tagger and exact-span evidence validator must approve a source before an owner can approve a message. Qwen is only a suggestion engine.</Text>
        <Notice tone="warning">The frozen Domain/Platform contract is not yet bound in this build. No message can be approved or queued from this screen.</Notice>
      </Card>

      <SectionTitle title="Local Qwen model" />
      <Card>
        <Text style={styles.cardTitle}>{model ? 'Pinned candidate installed' : 'Model not installed'}</Text>
        <Text style={styles.body}>Qwen3 0.6B Q8_0 · Apache-2.0 · 639.4 MB. The selected file is copied locally and checked against its manifest SHA-256 before use. There is no download or network fallback in inference.</Text>
        {model ? <Text style={styles.mono}>SHA-256 {model.sha256}</Text> : null}
        <ActionButton label={model ? 'Replace verified model' : 'Import pinned Qwen model'} onPress={() => void importModel()} secondary busy={busy === 'model'} />
        {progress ? <Text accessibilityLiveRegion="polite" style={styles.body}>{progress}</Text> : null}
        <ActionButton label="Run local suggestion" onPress={() => void runSuggestion()} disabled={!model || feedbackCount === 0} busy={busy === 'inference'} />
        {suggestion ? (
          <View style={styles.suggestion}>
            <Text style={styles.suggestionLabel}>UNVERIFIED MODEL SUGGESTION</Text>
            <Text style={styles.suggestionText}>{suggestion.response || 'The model returned no text.'}</Text>
            <Text style={styles.mono}>{suggestion.loadMs === null ? 'Model already loaded' : `Load ${suggestion.loadMs} ms`} · {suggestion.integrityMs === null ? 'model hash verified at import' : `integrity check ${suggestion.integrityMs} ms`} · inference {suggestion.inferenceElapsedMs} ms · prompt {suggestion.promptMs} ms · generation {suggestion.generationMs} ms · {suggestion.tokensPerSecond.toFixed(1)} tokens/s</Text>
            <Text style={styles.mono}>{suggestion.runtimeVersion} · {suggestion.platform} · n_ctx {suggestion.contextTokens} · CPU threads {suggestion.cpuThreads} · GPU layers {suggestion.gpuLayers}</Text>
          </View>
        ) : null}
      </Card>

      <SectionTitle title="Encrypted storage check" />
      <Card>
        {cipherVersion ? <Notice tone="success">SQLCipher {cipherVersion} opened successfully. The database key is held in device secure storage.</Notice> : null}
        {storageError ? <Notice tone="warning">Encrypted database unavailable: {storageError}</Notice> : null}
        {previousProbe ? (
          <Notice tone={survivedRestart ? 'success' : 'neutral'}>
            {survivedRestart ? 'Marker persisted from a previous app session.' : 'Marker saved in this app session.'} Marker {previousProbe.marker.slice(0, 8)}…
          </Notice>
        ) : <Text style={styles.body}>Write a private marker, then force close and reopen the app to confirm it survives.</Text>}
        <ActionButton label="Write persistence marker" onPress={() => void saveRestartProbe()} secondary busy={busy === 'probe'} disabled={Boolean(storageError)} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: '#E7F0E8', borderColor: '#C8DCCE', padding: spacing.lg },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heroDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: palette.green },
  heroKicker: { color: palette.green, fontWeight: '800', letterSpacing: 1, fontSize: 10 },
  heroTitle: { color: palette.ink, fontSize: 22, fontWeight: '800', lineHeight: 28 },
  cardTitle: { color: palette.ink, fontWeight: '800', fontSize: 16 },
  body: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  textLink: { color: palette.green, fontSize: 14, fontWeight: '800', paddingVertical: 5 },
  mono: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'], lineHeight: 17 },
  suggestion: { borderTopWidth: 1, borderTopColor: palette.line, paddingTop: 12, gap: 7 },
  suggestionLabel: { color: palette.amber, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  suggestionText: { color: palette.ink, fontSize: 15, lineHeight: 22 },
});
