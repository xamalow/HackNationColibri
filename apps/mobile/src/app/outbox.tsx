import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import type { StoredAction } from '@sauti/core';
import { ActionButton, Badge, Bi, Card, PageTitle, Screen, splitBi } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { dispatch, recoverInterruptedSends, revokeWithPin } from '../domain/actions';
import { listActions } from '../domain/coreDb';
import { bi, t } from '../domain/w3';
import { localizeStored, recipientLabel } from '../domain/display';
import { useLang } from '../components/Lang';
import { palette, radius, spacing } from '../theme';

const BUSINESS_KEY = {
  proposed: 'state.business.proposed',
  approved: 'state.business.approved',
  rejected: 'state.business.rejected',
  expired: 'state.business.expired',
  revoked: 'state.business.revoked',
  cancelled: 'state.business.cancelled',
} as const;

/** Truthful transport line (Experience rules): approved is never 'sent', sent is never 'delivered'. */
function transportLine(a: StoredAction): string | null {
  const sms = a.envelope.recipient.channel === 'sms';
  if (a.envelope.recipient.channel === 'local') {
    return a.transport === 'sent' ? bi('Imehifadhiwa kwenye kalenda (hakuna ujumbe uliotumwa)', 'Saved in the calendar (no message sent)') : null;
  }
  switch (a.transport) {
    case 'none': return null;
    case 'queued': return t('state.transport.queued');
    case 'sending': return t('state.transport.sending');
    case 'sent': return sms ? t('state.transport.sent_sms') : `${t('state.transport.sent')} · ${t('preview.simulated')}`;
    case 'delivered': return t('state.transport.delivered');
    case 'failed': return sms ? t('state.transport.composer_cancelled') : t('state.transport.failed');
    case 'send_unknown': return `${t('state.transport.send_unknown')}. ${t('state.transport.send_unknown.note')}`;
  }
}

export default function UjumbeScreen() {
  useLang();
  const [items, setItems] = useState<StoredAction[]>([]);
  const [revoking, setRevoking] = useState<StoredAction | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    await recoverInterruptedSends();
    setItems((await listActions()).filter((a) => a.business !== 'proposed'));
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const send = async (a: StoredAction) => {
    const out = await dispatch(a);
    if (!out.ok) Alert.alert(t('finding.uncertain'), out.reason);
    await refresh();
  };

  const revoke = async (pin: string) => {
    if (!revoking) return;
    setBusy(true);
    const out = await revokeWithPin(revoking, pin);
    setBusy(false);
    if (out.ok) { setRevoking(null); await refresh(); } else setPinError(out.reason);
  };

  return (
    <Screen>
      <PageTitle icon="send" eyebrow="Sauti Host" title={t('screen.outbox.title')} subtitle={t('preview.waits_for_signal')} />
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="inbox" size={34} color={palette.faint} />
          <Bi text={bi('Hakuna ujumbe bado', 'No messages yet')} style={styles.emptyText} center />
        </View>
      ) : null}
      {items.map((a) => {
        const body = (a.envelope.payload as { body?: string }).body ?? localizeStored(a.envelope.preview.text);
        const line = transportLine(a);
        const tone = toneOf(a);
        const canSend = a.business === 'approved' && a.envelope.recipient.channel !== 'local' && (a.transport === 'queued' || a.transport === 'failed');
        const canRevoke = a.business === 'approved' && ['queued', 'failed', 'sending', 'send_unknown'].includes(a.transport);
        return (
          <Card key={a.envelope.action_id} accent={TONE_COLOR[tone]}>
            <View style={styles.head}>
              <Badge label={splitBi(t(BUSINESS_KEY[a.business]))[0]} tone={a.business === 'approved' ? 'success' : 'neutral'} icon={a.business === 'approved' ? 'check' : 'x'} />
              {a.envelope.recipient.channel === 'simulated' ? <Badge label={bi('MAJARIBIO TU', 'TEST ONLY')} tone="danger" icon="slash" /> : null}
              {a.envelope.recipient.channel === 'local' ? <Badge label={bi('KALENDA', 'CALENDAR')} tone="info" icon="calendar" /> : null}
            </View>
            <View style={styles.toRow}>
              <Text style={styles.toLabel}>{bi('Kwa', 'To')}</Text>
              <Bi text={recipientLabel(a)} style={styles.toValue} enStyle={styles.small} />
            </View>
            <View style={styles.bubble}><Text style={styles.body}>{body}</Text></View>
            {line ? (
              <View style={[styles.status, { backgroundColor: TONE_BG[tone] }]}>
                <Feather name={TONE_ICON[tone]} size={16} color={TONE_COLOR[tone]} />
                <View style={styles.flex}><Bi text={line} style={[styles.statusText, { color: TONE_COLOR[tone] }]} enStyle={styles.small} /></View>
              </View>
            ) : null}
            {a.provider_ref && a.envelope.recipient.channel !== 'local' ? <Text style={styles.ref}>{a.provider_ref}</Text> : null}
            {canSend ? (
              <ActionButton
                icon={a.envelope.recipient.channel === 'sms' ? 'message-square' : 'send'}
                label={a.envelope.recipient.channel === 'sms' ? t('action.open_messages') : bi('Tuma: majaribio', 'Send: test only')}
                onPress={() => void send(a)}
              />
            ) : null}
            {canRevoke ? (
              <>
                {a.transport === 'sending' || a.transport === 'send_unknown' ? <Text style={styles.small}>{t('action.revoke.may_be_sent')}</Text> : null}
                <ActionButton label={t('action.revoke')} secondary danger icon="rotate-ccw" onPress={() => { setPinError(null); setRevoking(a); }} />
              </>
            ) : null}
          </Card>
        );
      })}
      <PinModal
        visible={revoking !== null}
        title={t('action.revoke')}
        busy={busy}
        error={pinError}
        onSubmit={(pin) => void revoke(pin)}
        onCancel={() => setRevoking(null)}
      />
    </Screen>
  );
}

type Tone = 'ok' | 'wait' | 'bad' | 'off';
function toneOf(a: StoredAction): Tone {
  if (a.business !== 'approved') return 'off';
  if (a.transport === 'sent' || a.transport === 'delivered') return 'ok';
  if (a.transport === 'failed' || a.transport === 'send_unknown') return 'bad';
  return 'wait';
}
const TONE_COLOR: Record<Tone, string> = { ok: palette.green, wait: palette.amber, bad: palette.red, off: palette.faint };
const TONE_BG: Record<Tone, string> = { ok: palette.greenSoft, wait: palette.amberSoft, bad: palette.redSoft, off: palette.surfaceAlt };
const TONE_ICON: Record<Tone, 'check-circle' | 'clock' | 'alert-triangle' | 'minus-circle'> = { ok: 'check-circle', wait: 'clock', bad: 'alert-triangle', off: 'minus-circle' };

const styles = StyleSheet.create({
  flex: { flex: 1 },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 48 },
  emptyText: { fontSize: 16, fontWeight: '700', color: palette.muted },
  head: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  toRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  toLabel: { fontSize: 12, fontWeight: '800', color: palette.faint, marginTop: 2, letterSpacing: 0.5 },
  toValue: { fontSize: 15, fontWeight: '700', color: palette.ink },
  bubble: { backgroundColor: palette.surfaceAlt, borderRadius: radius.md, borderTopLeftRadius: 4, padding: spacing.md },
  body: { fontSize: 16, color: palette.ink, lineHeight: 23 },
  status: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', borderRadius: radius.sm, padding: spacing.sm },
  statusText: { fontSize: 14, fontWeight: '700' },
  small: { fontSize: 12, color: palette.muted, lineHeight: 17 },
  ref: { fontSize: 11, color: palette.faint, fontFamily: 'Menlo' },
});
