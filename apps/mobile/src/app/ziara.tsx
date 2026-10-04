import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Booking } from '@sauti/core';
import { ActionButton, Badge, Card, Notice, PageTitle, Screen, SectionTitle, splitBi } from '../components/Screen';
import { listBookings, markArrival, requestBooking } from '../domain/visits';
import { bi, getUiLang, t } from '../domain/w3';
import { useLang } from '../components/Lang';
import { palette, radius, spacing } from '../theme';

const stateText = (): Record<Booking['state'], string> => ({
  tentative: bi('Inasubiri idhini yako', 'Waiting for your approval'),
  confirmed: bi('Imethibitishwa', 'Confirmed'),
  declined: bi('Imekataliwa', 'Declined'),
  cancelled: bi('Imeghairiwa', 'Cancelled'),
});

const DEMO_DATE = '2026-10-17';

/** Ziara: booking requests (simulated inbox in v1), capacity by code, approval on Leo, arrival records. */
export default function ZiaraScreen() {
  useLang();
  const [bookings, setBookings] = useState<Booking[]>([]);
  // Same request as Max's demo chip "Claire: booking (EN)": Saturday 17 October, 4 people (KES 8000 at the demo price).
  const [name, setName] = useState('Claire');
  const [date, setDate] = useState(DEMO_DATE);
  const [party, setParty] = useState('4');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setBookings(await listBookings()), []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const submit = async () => {
    setBusy(true);
    const out = await requestBooking({ visitorName: name, date, partySize: Number(party), phone });
    setBusy(false);
    if (out.ok) Alert.alert(t('visits.fits'), bi('Pendekezo liko kwenye Leo. Liidhinishe kwa PIN yako.', 'The proposal is on Leo (Today). Approve it with your PIN.'));
    else Alert.alert(t('visits.check'), out.message);
    await refresh();
  };

  const arrival = async (b: Booking, status: 'arrived' | 'no_show') => {
    const out = await markArrival(b, status);
    if (!out.ok) Alert.alert(t('finding.uncertain'), out.reason ?? '');
    await refresh();
  };

  return (
    <Screen>
      <PageTitle icon="calendar" eyebrow="Sauti Host" title={t('screen.visits.title')} subtitle={bi('Nafasi zinahesabiwa na programu kutoka taarifa za shamba.', 'Places are counted by code from your farm details.')} />

      <SectionTitle title={bi('Ziara zilizohifadhiwa', 'Booked visits')} count={bookings.length} />
      {bookings.length === 0 ? <Notice>{bi('Bado hakuna ziara.', 'No visits yet.')}</Notice> : null}
      {bookings.map((b) => {
        const [y, m, d] = b.request.date.split('-');
        const tone = b.state === 'confirmed' ? palette.green : b.state === 'tentative' ? palette.amber : palette.faint;
        return (
          <Card key={b.booking_id} accent={tone}>
            <View style={styles.bookingRow}>
              <View style={[styles.dateBlock, { backgroundColor: b.state === 'confirmed' ? palette.greenSoft : palette.amberSoft }]}>
                <Text style={[styles.dateDay, { color: tone }]}>{d}</Text>
                <Text style={styles.dateMonth}>{(getUiLang() === 'en' ? MONTHS_EN : MONTHS)[Number(m) - 1] ?? m}</Text>
                <Text style={styles.dateYear}>{y}</Text>
              </View>
              <View style={styles.flex}>
                <Text style={styles.title}>{b.request.visitor_name}</Text>
                <View style={styles.metaRow}>
                  <Feather name="clock" size={13} color={palette.muted} /><Text style={styles.meta}>{b.slot_start}</Text>
                  <Feather name="users" size={13} color={palette.muted} /><Text style={styles.meta}>{b.request.party_size}</Text>
                  <Text style={styles.meta}>KES {(b.price.amount_minor / 10 ** b.price.exponent) * b.request.party_size} ({b.request.party_size} × {b.price.amount_minor / 10 ** b.price.exponent})</Text>
                </View>
                <View style={styles.badges}>
                  <Badge label={splitBi(stateText()[b.state])[0]} tone={b.state === 'confirmed' ? 'success' : b.state === 'tentative' ? 'warning' : 'neutral'} icon={b.state === 'confirmed' ? 'check' : 'clock'} />
                  {b.arrival ? <Badge label={splitBi(b.arrival === 'arrived' ? t('action.arrived') : t('action.no_show'))[0]} tone={b.arrival === 'arrived' ? 'success' : 'danger'} icon={b.arrival === 'arrived' ? 'user-check' : 'user-x'} /> : null}
                </View>
                {splitBi(stateText()[b.state])[1] ? <Text style={styles.small}>{splitBi(stateText()[b.state])[1]}</Text> : null}
              </View>
            </View>
            {b.state === 'confirmed' && !b.arrival ? (
              <View style={styles.row}>
                <View style={styles.flex}><ActionButton label={t('action.no_show')} secondary danger icon="user-x" onPress={() => void arrival(b, 'no_show')} /></View>
                <View style={styles.flex}><ActionButton label={t('action.arrived')} icon="user-check" onPress={() => void arrival(b, 'arrived')} /></View>
              </View>
            ) : null}
          </Card>
        );
      })}

      <SectionTitle title={t('visits.request')} />
      <Card>
        <Badge label={bi('MAJARIBIO TU', 'TEST ONLY')} tone="danger" icon="slash" />
        <Field label={bi('Jina la mgeni', 'Visitor name')} value={name} onChange={setName} />
        <View style={styles.row}>
          <View style={styles.flex}><Field label={bi('Tarehe', 'Date')} hint="YYYY-MM-DD" value={date} onChange={setDate} /></View>
          <View style={styles.third}><Field label={bi('Wageni', 'Visitors')} value={party} onChange={(v) => setParty(v.replace(/\D/g, ''))} numeric /></View>
        </View>
        <Field label={bi('Simu ya mgeni (hiari)', 'Visitor phone (optional)')} hint={bi('tupu = majaribio', 'empty = test channel')} value={phone} onChange={setPhone} phone />
        <ActionButton icon="check-square" label={bi('Angalia nafasi na pendekeza', 'Check places and propose')} onPress={() => void submit()} busy={busy} />
      </Card>
    </Screen>
  );
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGO', 'SEP', 'OKT', 'NOV', 'DES'];
const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function Field({ label, hint, value, onChange, numeric, phone }: { label: string; hint?: string; value: string; onChange: (v: string) => void; numeric?: boolean; phone?: boolean }) {
  const [sw, en] = splitBi(label);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{sw}{en ? <Text style={styles.labelEn}>  {en}</Text> : null}</Text>
      <TextInput value={value} onChangeText={onChange} keyboardType={numeric ? 'number-pad' : phone ? 'phone-pad' : 'default'} placeholder={hint ? splitBi(hint).join(' · ').replace(/ · $/, '') : undefined} placeholderTextColor={palette.faint} style={styles.input} accessibilityLabel={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  third: { width: 96 },
  bookingRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  dateBlock: { width: 62, borderRadius: radius.md, alignItems: 'center', paddingVertical: 8 },
  dateDay: { fontSize: 26, fontWeight: '800', letterSpacing: -1 },
  dateMonth: { fontSize: 11, fontWeight: '800', color: palette.ink, letterSpacing: 1 },
  dateYear: { fontSize: 10, color: palette.muted },
  title: { fontSize: 19, fontWeight: '800', color: palette.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginVertical: 4, flexWrap: 'wrap' },
  meta: { fontSize: 14, color: palette.muted, marginRight: 6 },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 2 },
  small: { fontSize: 12, color: palette.faint, marginTop: 2 },
  row: { flexDirection: 'row', gap: spacing.sm },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: '700', color: palette.ink },
  labelEn: { fontSize: 12, fontWeight: '500', color: palette.faint },
  input: { fontSize: 17, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 13, color: palette.ink, backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.line },
});
