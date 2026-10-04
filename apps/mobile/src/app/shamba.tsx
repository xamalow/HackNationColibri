import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Weekday } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, Notice, PageTitle, Screen, SectionTitle, splitBi } from '../components/Screen';
import { runExclusive } from '../domain/actionGate';
import { formFromSheet, loadDemoFarm, readFacts, saveFarmSheet, type FarmForm } from '../domain/farm';
import { enrollPin, isEnrolled } from '../domain/pin';
import { runDemoFarmLoad, runFarmSave, runPinEnrollment, toggleWeekday } from '../domain/shambaWorkflow';
import { bi, getUiLang, t } from '../domain/w3';
import { useLang } from '../components/Lang';
import { palette, radius, spacing } from '../theme';

const DAYS: [Weekday, string, string][] = [
  ['mon', 'Jtatu', 'Mon'], ['tue', 'Jnne', 'Tue'], ['wed', 'Jtano', 'Wed'], ['thu', 'Alh', 'Thu'],
  ['fri', 'Ijm', 'Fri'], ['sat', 'Jmos', 'Sat'], ['sun', 'Jpili', 'Sun'],
];

function Field({ label, value, onChange, numeric, placeholder, multiline, disabled = false }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string; multiline?: boolean; disabled?: boolean }) {
  const [sw, en] = splitBi(label);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{sw}{en ? <Text style={styles.labelEn}>  {en}</Text> : null}</Text>
      <TextInput value={value} onChangeText={onChange} editable={!disabled} keyboardType={numeric ? 'number-pad' : 'default'} placeholder={placeholder} placeholderTextColor={palette.faint} multiline={multiline} style={[styles.input, multiline && styles.multiline]} accessibilityLabel={label} />
    </View>
  );
}

/** Shamba langu: Sauti PIN enrollment + the farm sheet (W1 facts), validated by code in @sauti/core. */
export default function ShambaScreen() {
  useLang();
  const [enrolled, setEnrolled] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const activeActions = useRef(new Set<string>());
  const [form, setForm] = useState<FarmForm>(formFromSheet(null));
  const [revision, setRevision] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setEnrolled(await isEnrolled());
      const facts = await readFacts();
      setRevision(facts?.revision ?? null);
      setForm(formFromSheet(facts?.sheet ?? null));
    } catch (error) {
      Alert.alert(t('screen.farm.title'), error instanceof Error ? error.message : String(error));
    }
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const runAction = (key: string, operation: () => Promise<void>) => {
    void runExclusive(activeActions.current, 'shamba-write', async () => {
      setBusyAction(key);
      try {
        await operation();
      } catch (error) {
        Alert.alert(t('screen.farm.title'), error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction(null);
      }
    });
  };

  const enroll = () => runAction('pin-enroll', async () => {
    const out = await runPinEnrollment(first, second, enrollPin);
    setFirst('');
    setSecond('');
    if (out.status === 'invalid' || out.status === 'mismatch') {
      Alert.alert('PIN', bi('Weka tarakimu nne, mara mbili, zinazofanana.', 'Enter the same 4 digits twice.'));
    } else if (out.status === 'enrolled') {
      Alert.alert('PIN', bi(`PIN imehifadhiwa (${out.ms} ms).`, `PIN saved (${out.ms} ms).`));
      await refresh();
    } else {
      Alert.alert('PIN', out.message);
    }
  });

  const save = () => runAction('farm-save', async () => {
    const out = await runFarmSave(form, saveFarmSheet);
    if (out.status === 'invalid') {
      Alert.alert(t('finding.uncertain'), out.errors.join('\n'));
    } else if (out.status === 'failed') {
      Alert.alert(t('screen.farm.title'), out.message);
    } else {
      Alert.alert(t('screen.farm.title'), t('farm.revision', { revision: out.revision }));
      await refresh();
    }
  });

  const demoFarm = () => runAction('demo-farm', async () => {
    const out = await runDemoFarmLoad(loadDemoFarm);
    if (out.status === 'invalid') Alert.alert(t('finding.uncertain'), out.errors.join('\n'));
    else if (out.status === 'failed') Alert.alert(t('screen.farm.title'), out.message);
    else if (out.status === 'already_exists') Alert.alert(t('screen.farm.title'), bi('Taarifa za shamba tayari zimehifadhiwa.', 'Farm details are already saved.'));
    await refresh();
  });

  const set = (k: keyof FarmForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (d: Weekday) => setForm((f) => ({ ...f, days: toggleWeekday(f.days, d) }));

  const pinBusy = busyAction === 'pin-enroll';
  const demoBusy = busyAction === 'demo-farm';
  const saveBusy = busyAction === 'farm-save';

  return (
    <Screen>
      <PageTitle icon="home" eyebrow="Sauti Host" title={t('screen.farm.title')} subtitle={t('farm.save_confirm')} />

      <SectionTitle title={bi('PIN ya Sauti', 'Sauti PIN')} />
      {enrolled ? (
        <View style={styles.pinOk}>
          <View style={styles.pinIcon}><Feather name="lock" size={20} color={palette.white} /></View>
          <View style={styles.flex}>
            <Bi text={bi('PIN imewekwa', 'PIN is set')} style={styles.pinOkTitle} enStyle={styles.labelEn} />
            <Text style={styles.meta}>{bi('Noor pekee anaweza kuidhinisha.', 'Only Noor can approve.')}</Text>
          </View>
        </View>
      ) : (
        <Card accent={palette.amber}>
          <Bi text={t('approval.pin_setup')} style={styles.body} enStyle={styles.labelEn} />
          <View style={styles.row}>
            <TextInput value={first} onChangeText={(v) => setFirst(v.replace(/\D/g, '').slice(0, 4))} editable={busyAction === null} keyboardType="number-pad" secureTextEntry maxLength={4} placeholder="••••" placeholderTextColor={palette.line} style={[styles.pin, styles.flex]} accessibilityLabel={bi('PIN mpya', 'New PIN')} />
            <TextInput value={second} onChangeText={(v) => setSecond(v.replace(/\D/g, '').slice(0, 4))} editable={busyAction === null} keyboardType="number-pad" secureTextEntry maxLength={4} placeholder="••••" placeholderTextColor={palette.line} style={[styles.pin, styles.flex]} accessibilityLabel={bi('Rudia PIN', 'Repeat PIN')} />
          </View>
          <Text style={styles.meta}>{bi('Weka mara mbili', 'Enter twice')}</Text>
          <ActionButton icon="lock" label={bi('Hifadhi PIN', 'Save PIN')} onPress={enroll} busy={pinBusy} disabled={busyAction !== null && !pinBusy} />
        </Card>
      )}

      <SectionTitle title={bi('Taarifa za shamba', 'Farm details')} trailing={revision ? <Badge label={`REV ${revision}`} tone="success" icon="check" /> : null} />
      {revision === null ? (
        <ActionButton secondary icon="download" label={bi('Pakia shamba la majaribio (SYNTHETIC)', 'Load demo farm (SYNTHETIC)')} onPress={demoFarm} busy={demoBusy} disabled={busyAction !== null && !demoBusy} />
      ) : null}
      <Card>
        <View style={styles.row}>
          <View style={styles.flex}><Field label={t('farm.price')} value={form.price} onChange={set('price')} numeric placeholder="2000" disabled={busyAction !== null} /></View>
          <View style={styles.flex}><Field label={t('farm.capacity')} value={form.capacity} onChange={set('capacity')} numeric placeholder="10" disabled={busyAction !== null} /></View>
        </View>
        <Text style={styles.label}>{splitBi(t('farm.days'))[0]}{splitBi(t('farm.days'))[1] ? <Text style={styles.labelEn}>  {splitBi(t('farm.days'))[1]}</Text> : null}</Text>
        <View style={styles.days}>
          {DAYS.map(([code, swName, enName]) => {
            const on = form.days.includes(code);
            return (
              <Pressable key={code} onPress={() => toggleDay(code)} disabled={busyAction !== null} style={[styles.day, on && styles.dayOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: busyAction !== null }}>
                <Text style={[styles.dayText, on && styles.dayTextOn]}>{getUiLang() === 'en' ? enName : swName}</Text>
                {getUiLang() === 'both' ? <Text style={[styles.dayEn, on && styles.dayTextOn]}>{enName}</Text> : null}
              </Pressable>
            );
          })}
        </View>
        <View style={styles.row}>
          <View style={styles.flex}><Field label={bi('Kuanzia', 'From')} value={form.start} onChange={set('start')} placeholder="09:00" disabled={busyAction !== null} /></View>
          <View style={styles.flex}><Field label={bi('Hadi', 'To')} value={form.end} onChange={set('end')} placeholder="15:00" disabled={busyAction !== null} /></View>
        </View>
        <Field label={t('farm.directions')} value={form.directions} onChange={set('directions')} multiline disabled={busyAction !== null} />
        <Field label={t('farm.inclusions')} value={form.inclusions} onChange={set('inclusions')} placeholder={bi('tenganisha kwa koma', 'separate with commas')} disabled={busyAction !== null} />
        <View style={styles.warn}>
          <Feather name="info" size={14} color={palette.amber} />
          <Text style={[styles.meta, styles.flex]}>{t('farm.changed_voids')}</Text>
        </View>
        <ActionButton icon="save" label={bi('Hifadhi taarifa za shamba', 'Save farm details')} onPress={save} busy={saveBusy} disabled={busyAction !== null && !saveBusy} />
      </Card>

      <Notice>{t('approval.pin_forgotten')}</Notice>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { fontSize: 16, color: palette.ink, lineHeight: 23, fontWeight: '600' },
  meta: { fontSize: 13, color: palette.muted, lineHeight: 18 },
  label: { fontSize: 14, fontWeight: '700', color: palette.ink },
  labelEn: { fontSize: 12, fontWeight: '500', color: palette.faint },
  field: { gap: 6 },
  input: { fontSize: 17, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 13, color: palette.ink, backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.line },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  pin: { fontSize: 28, letterSpacing: 12, textAlign: 'center', borderRadius: radius.md, paddingVertical: spacing.md, color: palette.ink, backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.line },
  pinOk: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: palette.greenSoft, borderRadius: radius.lg, padding: spacing.md },
  pinIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  pinOkTitle: { fontSize: 17, fontWeight: '800', color: palette.greenDeep },
  days: { flexDirection: 'row', gap: 5 },
  day: { flex: 1, minHeight: 54, borderRadius: radius.sm, backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: palette.green, borderColor: palette.green },
  dayText: { fontSize: 12, fontWeight: '800', color: palette.ink },
  dayEn: { fontSize: 10, color: palette.muted },
  dayTextOn: { color: palette.white },
  row: { flexDirection: 'row', gap: spacing.sm },
  warn: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: palette.amberSoft, padding: spacing.sm, borderRadius: radius.sm },
});
