import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import type { FeedbackSource } from '../domain/types';
import { listFeedbackSources, pickAndImportFeedback, setFeedbackLanguage } from '../import/feedbackImport';
import { palette } from '../theme';

export default function EvidenceScreen() {
  const [sources, setSources] = useState<FeedbackSource[]>([]);
  const [busy, setBusy] = useState(false);
  const [updatingLanguage, setUpdatingLanguage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSources(await listFeedbackSources());
    } catch (error) {
      Alert.alert('Evidence unavailable', error instanceof Error ? error.message : 'The local database could not be opened.');
    }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const importFeedback = async () => {
    setBusy(true);
    try {
      const result = await pickAndImportFeedback();
      if (result.imported > 0 || result.skipped > 0) Alert.alert('Import complete', `${result.imported} new source(s); ${result.skipped} duplicate(s) skipped.`);
      await refresh();
    } catch (error) {
      Alert.alert('Import failed', error instanceof Error ? error.message : 'The file could not be imported.');
    } finally {
      setBusy(false);
    }
  };

  const chooseLanguage = async (sourceId: string, language: 'sw' | 'en' | 'de' | 'fr' | 'und') => {
    setUpdatingLanguage(sourceId);
    try {
      await setFeedbackLanguage(sourceId, language);
      await refresh();
    } catch (error) {
      Alert.alert('Language not saved', error instanceof Error ? error.message : 'The source language could not be saved.');
    } finally {
      setUpdatingLanguage(null);
    }
  };

  return (
    <Screen>
      <PageTitle eyebrow="Original source text" title="Evidence" subtitle="Keep each imported comment intact and traceable before a theme or reply is considered." />
      <Notice tone="warning">No evidence is marked valid until Domain verifies its exact UTF-8 span against this source hash. Imported text is not edited or paraphrased.</Notice>
      <ActionButton label="Import CSV or JSON feedback" onPress={() => void importFeedback()} busy={busy} />
      <SectionTitle title={`Source records · ${sources.length}`} />
      {sources.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>No source records yet</Text><Text style={styles.body}>Import a CSV or JSON file with a feedback, text, comment, review, message, or notes field.</Text></Card>
      ) : sources.map((source) => (
        <Card key={source.sourceId}>
          <View style={styles.recordHeader}>
            <Text style={styles.recordTitle} numberOfLines={1}>{source.fileName} · row {source.rowNumber}</Text>
            <Text style={styles.status}>SOURCE</Text>
          </View>
          <Text selectable style={styles.quote}>“{source.text}”</Text>
          <Text style={styles.languageLabel}>Declared language · {source.language} · not verified</Text>
          <View style={styles.languageOptions} accessibilityLabel="Set declared source language">
            {(['sw', 'en', 'de', 'fr', 'und'] as const).map((language) => {
              const selected = source.language.toLowerCase().split('-')[0] === language;
              return (
                <Pressable
                  key={language}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: updatingLanguage === source.sourceId }}
                  disabled={updatingLanguage === source.sourceId}
                  onPress={() => void chooseLanguage(source.sourceId, language)}
                  style={[styles.languageChip, selected ? styles.languageChipSelected : null]}
                >
                  <Text style={[styles.languageChipText, selected ? styles.languageChipTextSelected : null]}>{language.toUpperCase()}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hash}>SHA-256 · {source.contentHash}</Text>
          <Text style={styles.sourceId}>Source ID · {source.sourceId}</Text>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  body: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  recordHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  recordTitle: { flex: 1, color: palette.ink, fontSize: 13, fontWeight: '800' },
  status: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  quote: { color: palette.ink, fontSize: 16, lineHeight: 25 },
  languageLabel: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  languageOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  languageChip: { borderWidth: 1, borderColor: palette.line, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 7 },
  languageChipSelected: { backgroundColor: '#E7F0E8', borderColor: palette.green },
  languageChipText: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  languageChipTextSelected: { color: palette.green },
  hash: { color: palette.muted, fontSize: 10, fontVariant: ['tabular-nums'], lineHeight: 15 },
  sourceId: { color: palette.muted, fontSize: 10, lineHeight: 15 },
});
