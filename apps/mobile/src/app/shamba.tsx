import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Weekday } from '@sauti/core';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { formFromSheet, readFacts, saveFarmSheet, type FarmForm } from '../domain/farm';
import { enrollPin, isEnrolled, isValidPin } from '../domain/pin';
import { bi, t } from '../domain/w3';
import { palette, spacing } from '../theme';

const DAYS: [Weekday, string, string][] = [
  ['mon', 'Jtatu', 'Mon'], ['tue', 'Jnne', 'Tue'], ['wed', 'Jtano', 'Wed'], ['thu', 'Alh', 'Thu'],
  ['fri', 'Ijm', 'Fri'], ['sat', 'Jmos', 'Sat'], ['sun', 'Jpili', 'Sun'],
];

function Field({ label, value, onChange, numeric, placeholder }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={numeric ? 'number-pad' : 'default'} placeholder={placeholder} style={styles.input} accessibilityLabel={label} />
    </View>
  );
}

/** Shamba langu: Sauti PIN enrollment + the farm sheet (W1 facts), validated by code in @sauti/core. */
export default function ShambaScreen() {
  const [enrolled, setEnrolled] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FarmForm>(formFromSheet(null));
  const [revision, setRevision] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setEnrolled(await isEnrolled());
    const facts = await readFacts();
    setRevision(facts?.revision ?? null);
    setForm(formFromSheet(facts?.sheet ?? null));
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const enroll = async () => {
    if (!isValidPin(first) || first !== second) {
      Alert.alert('PIN', bi('Weka tarakimu nne, mara mbili, zinazofanana.', 'Enter the same 4 digits twice.'));
      return;
    }
    setBusy(true);
    const out = await enrollPin(first);
    setBusy(false);
    setFirst('');
    setSecond('');
    if (out.ok) {
      Alert.alert('PIN', bi(`PIN imehifadhiwa (${out.ms} ms).`, `PIN saved (${out.ms} ms).`));
      await refresh();
    } else Alert.alert('PIN', out.error);
  };

  const save = async () => {
    const out = await saveFarmSheet(form);
    if (!out.ok) {
      Alert.alert(t('finding.uncertain'), out.errors.join('\n'));
      return;
    }
    Alert.alert(t('screen.farm.title'), t('farm.revision', { revision: out.revision.revision }));
    await refresh();
  };

  const set = (k: keyof FarmForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (d: Weekday) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] }));

  return (
    <Screen>
      <PageTitle eyebrow="Sauti" title={t('screen.farm.title')} subtitle={t('farm.save_confirm')} />

      <SectionTitle title={bi('PIN ya Sauti', 'Sauti PIN')} />
      {enrolled ? (
        <Notice tone="success">{bi('PIN ya Sauti imewekwa kwenye simu hii. Noor pekee anaweza kuidhinisha.', 'The Sauti PIN is set on this phone. Only Noor can approve.')}</Notice>
      ) : (
        <Card style={styles.card}>
          <Text style={styles.body}>{t('approval.pin_setup')}</Text>
          <TextInput value={first} onChangeText={(v) => setFirst(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} style={styles.pin} accessibilityLabel={bi('PIN mpya', 'New PIN')} />
          <TextInput value={second} onChangeText={(v) => setSecond(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} style={styles.pin} accessibilityLabel={bi('Rudia PIN', 'Repeat PIN')} />
          <ActionButton label={bi('Hifadhi PIN', 'Save PIN')} onPress={() => void enroll()} busy={busy} />
        </Card>
      )}

      <SectionTitle title={bi('Taarifa za shamba', 'Farm details')} trailing={revision ? <Text style={styles.meta}>{t('farm.revision', { revision })}</Text> : null} />
      <Card style={styles.card}>
        <Field label={t('farm.price')} value={form.price} onChange={set('price')} numeric placeholder="2000" />
        <Field label={t('farm.capacity')} value={form.capacity} onChange={set('capacity')} numeric placeholder="10" />
        <Text style={styles.label}>{t('farm.days')}</Text>
        <View style={styles.days}>
          {DAYS.map(([code, swName, enName]) => (
            <Pressable key={code} onPress={() => toggleDay(code)} style={[styles.day, form.days.includes(code) && styles.dayOn]} accessibilityRole="checkbox" accessibilityState={{ checked: form.days.includes(code) }}>
              <Text style={[styles.dayText, form.days.includes(code) && styles.dayTextOn]}>{swName}{'\n'}({enName})</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.row}>
          <View style={styles.half}><Field label={bi('Kuanzia (HH:MM)', 'From (HH:MM)')} value={form.start} onChange={set('start')} placeholder="09:00" /></View>
          <View style={styles.half}><Field label={bi('Hadi (HH:MM)', 'To (HH:MM)')} value={form.end} onChange={set('end')} placeholder="15:00" /></View>
        </View>
        <Field label={t('farm.directions')} value={form.directions} onChange={set('directions')} />
        <Field label={`${t('farm.inclusions')} · ${bi('tenganisha kwa koma', 'separate with commas')}`} value={form.inclusions} onChange={set('inclusions')} />
        <Text style={styles.meta}>{t('farm.changed_voids')}</Text>
        <ActionButton label={bi('Hifadhi taarifa za shamba', 'Save farm details')} onPress={() => void save()} />
      </Card>

      <Notice>{t('approval.pin_forgotten')}</Notice>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { fontSize: 17, color: palette.ink, lineHeight: 24 },
  meta: { fontSize: 14, color: palette.muted },
  label: { fontSize: 14, fontWeight: '700', color: palette.ink },
  field: { gap: 4 },
  input: { fontSize: 17, borderWidth: 1, borderColor: palette.line, borderRadius: 10, paddingHorizontal: spacing.sm, paddingVertical: 10, color: palette.ink, backgroundColor: palette.surface },
  pin: { fontSize: 28, letterSpacing: 14, textAlign: 'center', borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingVertical: spacing.sm, color: palette.ink },
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  day: { minWidth: 44, minHeight: 44, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: palette.green, borderColor: palette.green },
  dayText: { fontSize: 12, color: palette.ink, textAlign: 'center' },
  dayTextOn: { color: '#fff', fontWeight: '800' },
  row: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
});
