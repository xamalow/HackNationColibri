import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import type { FeedbackSource } from '../domain/types';
import { listFeedbackSources, pickAndImportFeedback, setFeedbackLanguage } from '../import/feedbackImport';
import sw from '@sauti/experience/copy/sw.json';
import {
  getInstalledTranslationBundle,
  pickAndImportTranslationBundle,
  type InstalledTranslationBundle,
} from '../models/translationBundle';
import { releaseTranslationRuntime, translateEnglishForDisplay, type TranslationMeasurement } from '../models/translationRuntime';
import { TRANSLATION_MODEL_BYTES } from '../models/translationManifest';
import { palette } from '../theme';

type TranslationCardState = TranslationMeasurement | { translation: null; reason: 'runtime_error' };

export default function EvidenceScreen() {
  const [sources, setSources] = useState<FeedbackSource[]>([]);
  const [translationBundle, setTranslationBundle] = useState<InstalledTranslationBundle | null>(null);
  const [translations, setTranslations] = useState<Record<string, TranslationCardState>>({});
  const [busy, setBusy] = useState(false);
  const [updatingLanguage, setUpdatingLanguage] = useState<string | null>(null);
  const [importingTranslation, setImportingTranslation] = useState(false);
  const [translatingSource, setTranslatingSource] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [records, installedBundle] = await Promise.all([listFeedbackSources(), getInstalledTranslationBundle()]);
      setSources(records);
      setTranslationBundle(installedBundle);
    } catch (error) {
      Alert.alert('Evidence unavailable', error instanceof Error ? error.message : 'The local database could not be opened.');
    }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));
  useFocusEffect(useCallback(() => () => { void releaseTranslationRuntime(); }, []));

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

  const importTranslation = async () => {
    setImportingTranslation(true);
    try {
      const installed = await pickAndImportTranslationBundle();
      if (installed) {
        setTranslationBundle(installed);
        Alert.alert('Offline translation ready', 'The five model files passed their pinned size and SHA-256 checks. Translation runs on this phone.');
      }
    } catch (error) {
      Alert.alert('Model import failed', error instanceof Error ? error.message : 'The offline translation files could not be imported.');
    } finally {
      setImportingTranslation(false);
    }
  };

  const translateSource = async (source: FeedbackSource) => {
    setTranslatingSource(source.sourceId);
    try {
      const result = await translateEnglishForDisplay(source.text);
      setTranslations((current) => ({ ...current, [source.sourceId]: result }));
    } catch {
      setTranslations((current) => ({ ...current, [source.sourceId]: { translation: null, reason: 'runtime_error' } }));
    } finally {
      setTranslatingSource(null);
    }
  };

  return (
    <Screen>
      <PageTitle eyebrow="Original source text" title="Evidence" subtitle="Keep each imported comment intact and traceable before a theme or reply is considered." />
      <Notice tone="warning">No evidence is marked valid until Domain verifies its exact UTF-8 span against this source hash. Imported text is not edited or paraphrased.</Notice>
      <ActionButton label="Import CSV or JSON feedback" onPress={() => void importFeedback()} busy={busy} />
      {translationBundle ? (
        <>
          <Notice tone="success">Offline English → Swahili model installed · {(TRANSLATION_MODEL_BYTES / 1_000_000).toFixed(1)} MB. Checksums run before use.</Notice>
          <ActionButton label="Check or repair offline translation files" onPress={() => void importTranslation()} busy={importingTranslation} secondary />
        </>
      ) : (
        <>
          <Notice>Optional offline English-to-Swahili reading aid. It is display-only and cannot affect evidence, decisions, approvals, or messages.</Notice>
          <ActionButton label="Import the five offline translation files" onPress={() => void importTranslation()} busy={importingTranslation} />
        </>
      )}
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
          {source.language.toLowerCase().split('-')[0] === 'en' ? (
            <View style={styles.translationSection}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: translatingSource !== null }}
                disabled={translatingSource !== null}
                onPress={() => void translateSource(source)}
                style={styles.translationButton}
              >
                <Text style={styles.translationButtonText}>{translatingSource === source.sourceId ? 'Translating on this phone…' : 'Show Swahili reading aid'}</Text>
              </Pressable>
              {translations[source.sourceId]?.translation ? (
                <View style={styles.translationResult}>
                  <Text style={styles.translationLabel}>{sw.keys['free_text.machine_translation'].text}</Text>
                  <Text selectable style={styles.translationText}>{translations[source.sourceId]?.translation}</Text>
                </View>
              ) : translations[source.sourceId] ? (
                <Text style={styles.fallbackText}>
                  {translations[source.sourceId]?.reason === 'number_guard'
                    ? sw.keys['free_text.numbers_mismatch'].text
                    : sw.keys['free_text.ask_guide'].text}
                </Text>
              ) : null}
            </View>
          ) : source.language.toLowerCase().split('-')[0] !== 'sw' ? (
            <Text style={styles.fallbackText}>{sw.keys['free_text.ask_guide'].text}</Text>
          ) : null}
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
  translationSection: { gap: 8, borderLeftWidth: 3, borderLeftColor: palette.green, paddingLeft: 12 },
  translationButton: { alignSelf: 'flex-start', borderRadius: 14, backgroundColor: '#E7F0E8', paddingHorizontal: 12, paddingVertical: 8 },
  translationButtonText: { color: palette.green, fontSize: 12, fontWeight: '800' },
  translationResult: { gap: 4 },
  translationLabel: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  translationText: { color: palette.ink, fontSize: 15, lineHeight: 23 },
  fallbackText: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  languageLabel: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  languageOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  languageChip: { borderWidth: 1, borderColor: palette.line, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 7 },
  languageChipSelected: { backgroundColor: '#E7F0E8', borderColor: palette.green },
  languageChipText: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  languageChipTextSelected: { color: palette.green },
  hash: { color: palette.muted, fontSize: 10, fontVariant: ['tabular-nums'], lineHeight: 15 },
  sourceId: { color: palette.muted, fontSize: 10, lineHeight: 15 },
});
