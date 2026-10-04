import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { enrollPin, isEnrolled, isValidPin } from '../domain/pin';
import { t } from '../domain/w3';
import { palette, spacing } from '../theme';

/** Shamba langu: first-launch Sauti PIN enrollment. Farm sheet fields come next (validateFarmSheet in core). */
export default function ShambaScreen() {
  const [enrolled, setEnrolled] = useState(false);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setEnrolled(await isEnrolled()), []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const enroll = async () => {
    if (!isValidPin(first) || first !== second) {
      Alert.alert('PIN', 'Weka tarakimu nne, mara mbili, zinazofanana.');
      return;
    }
    setBusy(true);
    const out = await enrollPin(first);
    setBusy(false);
    setFirst('');
    setSecond('');
    if (out.ok) {
      Alert.alert('PIN', `PIN imehifadhiwa (${out.ms} ms).`);
      await refresh();
    } else Alert.alert('PIN', out.error);
  };

  return (
    <Screen>
      <PageTitle eyebrow="Sauti" title={t('screen.farm.title')} subtitle={t('approval.pin_setup')} />
      <SectionTitle title="PIN ya Sauti" />
      {enrolled ? (
        <Notice tone="success">PIN ya Sauti imewekwa kwenye simu hii. Noor pekee anaweza kuidhinisha.</Notice>
      ) : (
        <Card style={styles.card}>
          <Text style={styles.body}>{t('approval.pin_setup')}</Text>
          <TextInput value={first} onChangeText={(v) => setFirst(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} style={styles.input} accessibilityLabel="PIN mpya" />
          <TextInput value={second} onChangeText={(v) => setSecond(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" secureTextEntry maxLength={4} style={styles.input} accessibilityLabel="Rudia PIN" />
          <ActionButton label="Hifadhi PIN" onPress={() => void enroll()} busy={busy} />
        </Card>
      )}
      <Notice>{t('approval.pin_forgotten')}</Notice>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { fontSize: 17, color: palette.ink, lineHeight: 24 },
  input: { fontSize: 28, letterSpacing: 14, textAlign: 'center', borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingVertical: spacing.sm, color: palette.ink },
});
