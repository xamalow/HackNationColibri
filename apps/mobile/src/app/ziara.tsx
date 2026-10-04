import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Booking } from '@sauti/core';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { listBookings, markArrival, requestBooking } from '../domain/visits';
import { bi, t } from '../domain/w3';
import { palette, spacing } from '../theme';

const STATE_TEXT: Record<Booking['state'], string> = {
  tentative: bi('Inasubiri idhini yako', 'Waiting for your approval'),
  confirmed: bi('Imethibitishwa', 'Confirmed'),
  declined: bi('Imekataliwa', 'Declined'),
  cancelled: bi('Imeghairiwa', 'Cancelled'),
};

function tomorrow(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Ziara: booking requests (simulated inbox in v1), capacity by code, approval on Leo, arrival records. */
export default function ZiaraScreen() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [name, setName] = useState('Anna');
  const [date, setDate] = useState(tomorrow());
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
      <PageTitle eyebrow="Sauti" title={t('screen.visits.title')} subtitle={bi('Nafasi zinahesabiwa na programu kutoka taarifa za shamba.', 'Places are counted by code from your farm details.')} />

      <SectionTitle title={t('visits.request')} />
      <Card style={styles.card}>
        <Text style={styles.simulated}>{t('preview.simulated')}</Text>
        <Text style={styles.label}>{bi('Jina la mgeni', 'Visitor name')}</Text>
        <TextInput value={name} onChangeText={setName} style={styles.input} accessibilityLabel={bi('Jina la mgeni', 'Visitor name')} />
        <View style={styles.row}>
          <View style={styles.half}>
            <Text style={styles.label}>{bi('Tarehe (YYYY-MM-DD)', 'Date (YYYY-MM-DD)')}</Text>
            <TextInput value={date} onChangeText={setDate} style={styles.input} accessibilityLabel={bi('Tarehe', 'Date')} />
          </View>
          <View style={styles.half}>
            <Text style={styles.label}>{bi('Wageni', 'Visitors')}</Text>
            <TextInput value={party} onChangeText={(v) => setParty(v.replace(/\D/g, ''))} keyboardType="number-pad" style={styles.input} accessibilityLabel={bi('Idadi ya wageni', 'Number of visitors')} />
          </View>
        </View>
        <Text style={styles.label}>{bi('Simu ya mgeni (hiari; tupu = majaribio)', 'Visitor phone (optional; empty = test channel)')}</Text>
        <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.input} accessibilityLabel={bi('Simu ya mgeni', 'Visitor phone')} />
        <ActionButton label={bi('Angalia nafasi na pendekeza', 'Check places and propose')} onPress={() => void submit()} busy={busy} />
      </Card>

      <SectionTitle title={bi('Ziara zilizohifadhiwa', 'Booked visits')} />
      {bookings.length === 0 ? <Notice>{bi('Bado hakuna ziara.', 'No visits yet.')}</Notice> : null}
      {bookings.map((b) => (
        <Card key={b.booking_id} style={styles.card}>
          <Text style={styles.title}>{b.request.visitor_name} · {b.request.date} · {b.slot_start}</Text>
          <Text style={styles.meta}>{bi(`Wageni ${b.request.party_size} · KES ${b.price.amount_minor / 10 ** b.price.exponent} kwa mgeni`, `${b.request.party_size} visitors · KES ${b.price.amount_minor / 10 ** b.price.exponent} per visitor`)}</Text>
          <Text style={styles.state}>{STATE_TEXT[b.state]}</Text>
          {b.arrival ? <Text style={styles.state}>{b.arrival === 'arrived' ? t('action.arrived') : t('action.no_show')}</Text> : null}
          {b.state === 'confirmed' && !b.arrival ? (
            <View style={styles.row}>
              <View style={styles.half}><ActionButton label={t('action.arrived')} onPress={() => void arrival(b, 'arrived')} /></View>
              <View style={styles.half}><ActionButton label={t('action.no_show')} secondary onPress={() => void arrival(b, 'no_show')} /></View>
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  title: { fontSize: 18, fontWeight: '800', color: palette.ink },
  meta: { fontSize: 15, color: palette.muted },
  state: { fontSize: 16, fontWeight: '700', color: palette.green },
  simulated: { fontSize: 13, fontWeight: '800', color: palette.red },
  label: { fontSize: 14, fontWeight: '700', color: palette.ink },
  input: { fontSize: 17, borderWidth: 1, borderColor: palette.line, borderRadius: 10, paddingHorizontal: spacing.sm, paddingVertical: 10, color: palette.ink, backgroundColor: palette.surface },
  row: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
});
