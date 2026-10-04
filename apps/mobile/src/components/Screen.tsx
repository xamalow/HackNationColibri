import { Feather } from '@expo/vector-icons';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, radius, shadow, spacing } from '../theme';

type IconName = ComponentProps<typeof Feather>['name'];

/**
 * Bilingual strings arrive as "Swahili (English)" (see bi()/t() in domain/w3). Split the trailing balanced
 * parenthetical so Swahili reads as the main line and the English sits underneath, smaller and muted.
 */
export function splitBi(text: string): [string, string | null] {
  const s = text.trimEnd();
  if (!s.endsWith(')')) return [text, null];
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] === ')') depth += 1;
    else if (s[i] === '(') {
      depth -= 1;
      if (depth === 0) {
        if (i < 2 || s[i - 1] !== ' ') return [text, null];
        return [s.slice(0, i - 1), s.slice(i + 1, -1)];
      }
    }
  }
  return [text, null];
}

export function Bi({ text, style, enStyle, center }: { text: string; style?: TextStyle | TextStyle[]; enStyle?: TextStyle; center?: boolean }) {
  const [sw, en] = splitBi(text);
  return (
    <View style={styles.bi}>
      <Text style={[style, center && styles.center]}>{sw}</Text>
      {en ? <Text style={[styles.en, enStyle, center && styles.center]}>{en}</Text> : null}
    </View>
  );
}

export function Screen({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md }]}>
      {children}
    </ScrollView>
  );
}

export function PageTitle({ eyebrow, title, subtitle, icon }: { eyebrow: string; title: string; subtitle?: string; icon?: IconName }) {
  const [sw, en] = splitBi(title);
  const [eyeSw] = splitBi(eyebrow);
  return (
    <View style={styles.heading}>
      <View style={styles.eyebrowRow}>
        <View style={styles.logo}><Feather name={icon ?? 'feather'} size={14} color={palette.white} /></View>
        <Text style={styles.eyebrow}>{eyeSw.toUpperCase()}</Text>
      </View>
      <Text style={styles.title}>{sw}</Text>
      {en ? <Text style={styles.titleEn}>{en}</Text> : null}
      {subtitle ? <Bi text={subtitle} style={styles.subtitle} enStyle={styles.subtitleEn} /> : null}
    </View>
  );
}

export function Card({ children, style, accent }: PropsWithChildren<{ style?: object; accent?: string }>) {
  return (
    <View style={[styles.card, style]}>
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      {children}
    </View>
  );
}

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const TONES: Record<Tone, { bg: string; fg: string; icon: IconName }> = {
  neutral: { bg: '#ECE8DF', fg: palette.muted, icon: 'info' },
  success: { bg: palette.greenSoft, fg: palette.green, icon: 'check-circle' },
  warning: { bg: palette.amberSoft, fg: palette.amber, icon: 'alert-triangle' },
  danger: { bg: palette.redSoft, fg: palette.red, icon: 'alert-octagon' },
  info: { bg: palette.blueSoft, fg: palette.blue, icon: 'info' },
};

/** Small status pill. Only the Swahili half is shown inside a pill; pass `en` to show it next to it. */
export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const c = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      {icon ? <Feather name={icon} size={11} color={c.fg} /> : null}
      <Text style={[styles.badgeText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
  busy = false,
  icon,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  danger?: boolean;
}) {
  const [sw, en] = splitBi(label);
  const fg = secondary ? (danger ? palette.red : palette.green) : palette.white;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondaryButton : danger ? styles.dangerButton : styles.primaryButton,
        secondary && danger && styles.secondaryDanger,
        pressed && styles.pressed,
        (disabled || busy) && styles.buttonDimmed,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : icon ? <Feather name={icon} size={18} color={fg} /> : null}
      <View style={styles.buttonLabel}>
        <Text style={[styles.buttonText, { color: fg }]} numberOfLines={2}>{sw}</Text>
        {en ? <Text style={[styles.buttonEn, { color: fg }]} numberOfLines={1}>{en}</Text> : null}
      </View>
    </Pressable>
  );
}

export function SectionTitle({ title, trailing, count }: { title: string; trailing?: ReactNode; count?: number }) {
  const [sw, en] = splitBi(title);
  return (
    <View style={styles.sectionRow}>
      <View style={styles.sectionLeft}>
        <Text style={styles.sectionTitle}>{sw}{count !== undefined ? <Text style={styles.sectionCount}>  {count}</Text> : null}</Text>
        {en ? <Text style={styles.sectionEn}>{en}</Text> : null}
      </View>
      {trailing}
    </View>
  );
}

export function Notice({ children, tone = 'neutral' }: PropsWithChildren<{ tone?: Tone }>) {
  const c = TONES[tone];
  const text = typeof children === 'string' ? children : null;
  return (
    <View style={[styles.notice, { backgroundColor: c.bg }]}>
      <Feather name={c.icon} size={18} color={c.fg} style={styles.noticeIcon} />
      <View style={styles.flex}>
        {text ? <Bi text={text} style={[styles.noticeText, { color: palette.ink }]} enStyle={styles.noticeEn} /> : <Text style={styles.noticeText}>{children}</Text>}
      </View>
    </View>
  );
}

/** A tappable row that navigates (used for the hidden device / Gemma check screens). */
export function LinkRow({ label, icon, onPress }: { label: string; icon: IconName; onPress: () => void }) {
  const [sw, en] = splitBi(label);
  return (
    <Pressable onPress={onPress} accessibilityRole="link" style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}>
      <View style={styles.linkIcon}><Feather name={icon} size={18} color={palette.green} /></View>
      <View style={styles.flex}>
        <Text style={styles.linkText}>{sw}</Text>
        {en ? <Text style={styles.linkEn}>{en}</Text> : null}
      </View>
      <Feather name="chevron-right" size={20} color={palette.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  bi: { gap: 2 },
  en: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  scroll: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: spacing.md, paddingBottom: 48, gap: spacing.md },
  heading: { gap: 2, marginBottom: spacing.xs, paddingHorizontal: 4 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.sm },
  logo: { width: 24, height: 24, borderRadius: 7, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { color: palette.green, fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
  title: { color: palette.ink, fontSize: 34, fontWeight: '800', letterSpacing: -0.8 },
  titleEn: { color: palette.faint, fontSize: 17, fontWeight: '600', marginTop: -2 },
  subtitle: { color: palette.muted, fontSize: 15, lineHeight: 21, marginTop: spacing.sm },
  subtitleEn: { color: palette.faint, fontSize: 13 },
  card: { borderRadius: radius.lg, padding: spacing.md, backgroundColor: palette.surface, gap: spacing.sm, overflow: 'hidden', ...shadow },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99 },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  button: { minHeight: 54, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primaryButton: { backgroundColor: palette.green },
  dangerButton: { backgroundColor: palette.red },
  secondaryButton: { backgroundColor: palette.greenSoft },
  secondaryDanger: { backgroundColor: palette.redSoft },
  buttonLabel: { alignItems: 'center', flexShrink: 1 },
  buttonText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
  buttonEn: { fontSize: 11, fontWeight: '600', opacity: 0.8, textAlign: 'center' },
  pressed: { opacity: 0.8, transform: [{ scale: 0.99 }] },
  buttonDimmed: { opacity: 0.45 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: spacing.md, paddingHorizontal: 4 },
  sectionLeft: { flexShrink: 1 },
  sectionTitle: { color: palette.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  sectionCount: { color: palette.faint, fontSize: 17, fontWeight: '700' },
  sectionEn: { color: palette.faint, fontSize: 13, fontWeight: '600' },
  notice: { borderRadius: radius.md, padding: spacing.md, flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  noticeIcon: { marginTop: 1 },
  noticeText: { color: palette.ink, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  noticeEn: { color: palette.muted, fontSize: 12, lineHeight: 17 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: palette.surface, borderRadius: radius.md, padding: spacing.sm, minHeight: 56, ...shadow },
  linkIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: palette.greenSoft, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontSize: 15, fontWeight: '700', color: palette.ink },
  linkEn: { fontSize: 12, color: palette.muted },
});
