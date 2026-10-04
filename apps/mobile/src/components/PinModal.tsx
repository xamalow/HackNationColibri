import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette, spacing } from '../theme';

type Props = {
  visible: boolean;
  title: string;
  /** The exact text Noor approves, shown again before the PIN (Experience approval flow). */
  preview?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
};

/** Sauti PIN entry: 4 digits, secure field, never read back or stored by the UI. */
export function PinModal({ visible, title, preview, busy, error, onSubmit, onCancel }: Props) {
  const [pin, setPin] = useState('');
  const submit = () => {
    if (pin.length !== 4 || busy) return;
    const value = pin;
    setPin('');
    onSubmit(value);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text style={styles.title}>{title}</Text>
          {preview ? <Text style={styles.preview}>{preview}</Text> : null}
          <Text style={styles.label}>PIN yako ya Sauti (si nambari ya simu)</Text>
          <TextInput
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            autoFocus
            style={styles.input}
            accessibilityLabel="PIN yako ya Sauti"
            onSubmitEditing={submit}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.secondary]} onPress={() => { setPin(''); onCancel(); }} accessibilityRole="button">
              <Text style={styles.secondaryText}>Acha</Text>
            </Pressable>
            <Pressable style={[styles.button, pin.length !== 4 && styles.disabled]} onPress={submit} accessibilityRole="button" disabled={pin.length !== 4 || busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Ndiyo, idhinisha</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: palette.surface, padding: spacing.lg, borderTopLeftRadius: 20, borderTopRightRadius: 20, gap: spacing.sm },
  title: { fontSize: 20, fontWeight: '800', color: palette.ink },
  preview: { fontSize: 16, color: palette.ink, backgroundColor: palette.background, padding: spacing.md, borderRadius: 12 },
  label: { fontSize: 14, color: palette.muted, marginTop: spacing.sm },
  input: { fontSize: 32, letterSpacing: 16, textAlign: 'center', borderWidth: 1, borderColor: palette.line, borderRadius: 12, paddingVertical: spacing.md, color: palette.ink },
  error: { color: '#9a3412', fontSize: 15 },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  button: { flex: 1, minHeight: 48, borderRadius: 14, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: palette.background, borderWidth: 1, borderColor: palette.line },
  disabled: { opacity: 0.5 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  secondaryText: { color: palette.ink, fontWeight: '700', fontSize: 16 },
});
