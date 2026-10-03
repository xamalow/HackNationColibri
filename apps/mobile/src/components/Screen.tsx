import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { palette, spacing } from '../theme';

export function Screen({ children }: PropsWithChildren) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {children}
    </ScrollView>
  );
}

export function PageTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function ActionButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondaryButton : styles.primaryButton,
        (pressed || disabled || busy) && styles.buttonDimmed,
      ]}
    >
      {busy ? <ActivityIndicator color={secondary ? palette.green : palette.white} /> : null}
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

export function SectionTitle({ title, trailing }: { title: string; trailing?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {trailing}
    </View>
  );
}

export function Notice({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' }>) {
  const toneStyle = tone === 'success' ? styles.noticeSuccess : tone === 'warning' ? styles.noticeWarning : styles.noticeNeutral;
  return <View style={[styles.notice, toneStyle]}><Text style={styles.noticeText}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: 44, gap: spacing.md },
  heading: { gap: 5, marginBottom: spacing.sm },
  eyebrow: { color: palette.green, fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },
  title: { color: palette.ink, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: palette.muted, fontSize: 15, lineHeight: 22, maxWidth: 520 },
  card: { borderRadius: 20, padding: spacing.md, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, gap: spacing.sm },
  button: { minHeight: 50, borderRadius: 14, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primaryButton: { backgroundColor: palette.green },
  secondaryButton: { backgroundColor: palette.greenSoft, borderWidth: 1, borderColor: '#C5DBCF' },
  buttonText: { color: palette.white, fontSize: 15, fontWeight: '700' },
  secondaryButtonText: { color: palette.green },
  buttonDimmed: { opacity: 0.55 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.sm },
  sectionTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' },
  notice: { borderRadius: 14, padding: spacing.md, borderWidth: 1 },
  noticeNeutral: { backgroundColor: '#EDF0EB', borderColor: palette.line },
  noticeSuccess: { backgroundColor: palette.greenSoft, borderColor: '#C5DBCF' },
  noticeWarning: { backgroundColor: palette.amberSoft, borderColor: '#E8D7B1' },
  noticeText: { color: palette.ink, fontSize: 13, lineHeight: 19 },
});
