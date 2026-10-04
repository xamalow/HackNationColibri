import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Weekday } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, Notice, PageTitle, Screen, SectionTitle, splitBi } from '../components/Screen';
import { readHubConfig, saveHubConfig } from '../models/voice';
import { formFromSheet, readFacts, saveFarmSheet, type FarmForm } from '../domain/farm';
import { enrollPin, isEnrolled, isValidPin } from '../domain/pin';
import { bi, getUiLang, t } from '../domain/w3';
import { useLang } from '../components/Lang';
import { palette, radius, spacing } from '../theme';

const DAYS: [Weekday, string, string][] = [
  ['mon', 'Jtatu', 'Mon'], ['tue', 'Jnne', 'Tue'], ['wed', 'Jtano', 'Wed'], ['thu', 'Alh', 'Thu'],
  ['fri', 'Ijm', 'Fri'], ['sat', 'Jmos', 'Sat'], ['sun', 'Jpili', 'Sun'],
];

function Field({ label, value, onChange, numeric, placeholder, multiline }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string; multiline?: boolean }) {
  const [sw, en] = splitBi(label);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{sw}{en ? <Text style={styles.labelEn}>  {en}</Text> : null}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={numeric ? 'number-pad' : 'default'} placeholder={placeholder} placeholderTextColor={palette.faint} multiline={multiline} style={[styles.input, multiline && styles.multiline]} accessibilityLabel={label} />
    </View>
  );
}

/** Shamba langu: Sauti PIN enrollment + the farm sheet (W1 facts), validated by code in @sauti/core. */
export default function ShambaScreen() {
  useLang();
  const [enrolled, setEnrolled] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FarmForm>(formFromSheet(null));
  const [revision, setRevision] = useState<number | null>(null);
  const [hubTts, setHubTts] = useState(readHubConfig()?.tts ?? '');
  const [hubStt, setHubStt] = useState(readHubConfig()?.stt ?? '');

  const saveHub = () => {
    const cfg = saveHubConfig(hubTts, hubStt);
    if (!cfg) {
      Alert.alert(bi('Sauti ya hub', 'Voice hub'), bi('Anwani lazima iwe ya mtandao wa ndani (192.168.x.x, 10.x.x.x).', 'The address must be on the local network (192.168.x.x, 10.x.x.x).'));
      return;
    }
    setHubTts(cfg.tts);
    setHubStt(cfg.stt);
    Alert.alert(bi('Sauti ya hub', 'Voice hub'), `${cfg.tts}\n${cfg.stt}`);
  };

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
            <TextInput value={first} onChangeText={(v) => setFirst(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} placeholder="••••" placeholderTextColor={palette.line} style={[styles.pin, styles.flex]} accessibilityLabel={bi('PIN mpya', 'New PIN')} />
            <TextInput value={second} onChangeText={(v) => setSecond(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} placeholder="••••" placeholderTextColor={palette.line} style={[styles.pin, styles.flex]} accessibilityLabel={bi('Rudia PIN', 'Repeat PIN')} />
          </View>
          <Text style={styles.meta}>{bi('Weka mara mbili', 'Enter twice')}</Text>
          <ActionButton icon="lock" label={bi('Hifadhi PIN', 'Save PIN')} onPress={() => void enroll()} busy={busy} />
        </Card>
      )}

      <SectionTitle title={bi('Taarifa za shamba', 'Farm details')} trailing={revision ? <Badge label={`REV ${revision}`} tone="success" icon="check" /> : null} />
      <Card>
        <View style={styles.row}>
          <View style={styles.flex}><Field label={t('farm.price')} value={form.price} onChange={set('price')} numeric placeholder="2000" /></View>
          <View style={styles.flex}><Field label={t('farm.capacity')} value={form.capacity} onChange={set('capacity')} numeric placeholder="10" /></View>
        </View>
        <Text style={styles.label}>{splitBi(t('farm.days'))[0]}{splitBi(t('farm.days'))[1] ? <Text style={styles.labelEn}>  {splitBi(t('farm.days'))[1]}</Text> : null}</Text>
        <View style={styles.days}>
          {DAYS.map(([code, swName, enName]) => {
            const on = form.days.includes(code);
            return (
              <Pressable key={code} onPress={() => toggleDay(code)} style={[styles.day, on && styles.dayOn]} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
                <Text style={[styles.dayText, on && styles.dayTextOn]}>{getUiLang() === 'en' ? enName : swName}</Text>
                {getUiLang() === 'both' ? <Text style={[styles.dayEn, on && styles.dayTextOn]}>{enName}</Text> : null}
              </Pressable>
            );
          })}
        </View>
        <View style={styles.row}>
          <View style={styles.flex}><Field label={bi('Kuanzia', 'From')} value={form.start} onChange={set('start')} placeholder="09:00" /></View>
          <View style={styles.flex}><Field label={bi('Hadi', 'To')} value={form.end} onChange={set('end')} placeholder="15:00" /></View>
        </View>
        <Field label={t('farm.directions')} value={form.directions} onChange={set('directions')} multiline />
        <Field label={t('farm.inclusions')} value={form.inclusions} onChange={set('inclusions')} placeholder={bi('tenganisha kwa koma', 'separate with commas')} />
        <View style={styles.warn}>
          <Feather name="info" size={14} color={palette.amber} />
          <Text style={[styles.meta, styles.flex]}>{t('farm.changed_voids')}</Text>
        </View>
        <ActionButton icon="save" label={bi('Hifadhi taarifa za shamba', 'Save farm details')} onPress={() => void save()} />
      </Card>

      <SectionTitle title={bi('Sauti ya hub (Chatterbox + Whisper)', 'Voice hub (Chatterbox + Whisper)')} trailing={readHubConfig() ? <Badge label="OK" tone="success" icon="check" /> : null} />
      <Card>
        <Text style={styles.meta}>{bi('Kompyuta ya hub kwenye Wi-Fi ya nyumbani tu (hakuna mtandao wa nje).', 'The hub PC on local Wi-Fi only (no internet, no cloud).')}</Text>
        <Field label={bi('Chatterbox (sauti)', 'Chatterbox (speech)')} value={hubTts} onChange={setHubTts} placeholder="192.168.1.20:8002" />
        <Field label={bi('Whisper (ukaguzi)', 'Whisper (check)')} value={hubStt} onChange={setHubStt} placeholder="192.168.1.20:8001" />
        <ActionButton icon="wifi" label={bi('Hifadhi anwani ya hub', 'Save hub address')} onPress={saveHub} />
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
