import { Feather } from '@expo/vector-icons';
import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { splitBi } from './Screen';
import { bi } from '../domain/w3';
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
  const inputRef = useRef<TextInput>(null);
  const submit = () => {
    if (pin.length !== 4 || busy) return;
    const value = pin;
    setPin('');
    onSubmit(value);
  };
  const [titleSw, titleEn] = splitBi(title);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <View style={styles.lock}><Feather name="lock" size={18} color={palette.white} /></View>
            <View style={styles.flex}>
              <Text style={styles.title}>{titleSw}</Text>
              {titleEn ? <Text style={styles.titleEn}>{titleEn}</Text> : null}
            </View>
          </View>
          {preview ? <View style={styles.preview}><Text style={styles.previewText}>{preview}</Text></View> : null}
          <Text style={styles.label}>{bi('PIN yako ya Sauti, si nambari ya simu', 'Your Sauti PIN, not the phone passcode')}</Text>
          <Pressable onPress={() => inputRef.current?.focus()} style={styles.dots} accessibilityLabel="PIN yako ya Sauti">
            {[0, 1, 2, 3].map((i) => <View key={i} style={[styles.dot, i < pin.length && styles.dotOn, error && styles.dotError]} />)}
          </Pressable>
          <TextInput
            ref={inputRef}
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            autoFocus
            style={styles.hidden}
            accessibilityLabel="PIN yako ya Sauti"
            onSubmitEditing={submit}
          />
          {error ? (
            <View style={styles.errorBox}>
              <Feather name="alert-circle" size={15} color={palette.red} />
              <Text style={styles.error}>{error}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Pressable style={[styles.button, styles.secondary]} onPress={() => { setPin(''); onCancel(); }} accessibilityRole="button">
              <Text style={styles.secondaryText}>{splitBi(bi('Acha', 'Cancel'))[0]}</Text>
              {splitBi(bi('Acha', 'Cancel'))[1] ? <Text style={styles.secondaryEn}>Cancel</Text> : null}
            </Pressable>
            <Pressable style={[styles.button, styles.primary, pin.length !== 4 && styles.disabled]} onPress={submit} accessibilityRole="button" disabled={pin.length !== 4 || busy}>
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Text style={styles.primaryText}>{splitBi(bi('Ndiyo, idhinisha', 'Yes, approve'))[0]}</Text>
                  {splitBi(bi('Ndiyo, idhinisha', 'Yes, approve'))[1] ? <Text style={styles.primaryEn}>Yes, approve</Text> : null}
                </>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(10,25,20,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: palette.surface, padding: spacing.lg, paddingTop: spacing.sm, paddingBottom: 34, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: spacing.md },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: palette.line, marginBottom: spacing.xs },
  head: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  lock: { width: 38, height: 38, borderRadius: 12, backgroundColor: palette.green, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: palette.ink, lineHeight: 23 },
  titleEn: { fontSize: 13, color: palette.muted, lineHeight: 18, marginTop: 2 },
  preview: { backgroundColor: palette.greenSoft, padding: spacing.md, borderRadius: 14, borderTopLeftRadius: 4 },
  previewText: { fontSize: 15, color: palette.greenDeep, lineHeight: 21 },
  label: { fontSize: 13, color: palette.muted, textAlign: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 18, paddingVertical: spacing.sm },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: palette.green },
  dotOn: { backgroundColor: palette.green },
  dotError: { borderColor: palette.red },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
  errorBox: { flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: palette.redSoft, padding: spacing.sm, borderRadius: 10 },
  error: { color: palette.red, fontSize: 14, flex: 1 },
  row: { flexDirection: 'row', gap: spacing.sm },
  button: { flex: 1, minHeight: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primary: { flex: 1.6, backgroundColor: palette.green },
  secondary: { backgroundColor: palette.surfaceAlt, borderWidth: 1, borderColor: palette.line },
  disabled: { opacity: 0.4 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  primaryEn: { color: '#fff', fontSize: 11, opacity: 0.8 },
  secondaryText: { color: palette.ink, fontWeight: '700', fontSize: 16 },
  secondaryEn: { color: palette.muted, fontSize: 11 },
});
