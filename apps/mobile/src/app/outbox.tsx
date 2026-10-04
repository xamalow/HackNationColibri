import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text } from 'react-native';
import type { StoredAction } from '@sauti/core';
import { ActionButton, Card, Notice, PageTitle, Screen } from '../components/Screen';
import { PinModal } from '../components/PinModal';
import { dispatch, recoverInterruptedSends, revokeWithPin } from '../domain/actions';
import { listActions } from '../domain/coreDb';
import { t } from '../domain/w3';
import { palette, spacing } from '../theme';

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
      <PageTitle eyebrow="Sauti" title={t('screen.outbox.title')} subtitle={t('preview.waits_for_signal')} />
      {items.length === 0 ? <Notice>{t('screen.empty')}</Notice> : null}
      {items.map((a) => {
        const body = (a.envelope.payload as { body?: string }).body ?? '';
        const line = transportLine(a);
        const canSend = a.business === 'approved' && (a.transport === 'queued' || a.transport === 'failed');
        const canRevoke = a.business === 'approved' && ['queued', 'failed', 'sending', 'send_unknown'].includes(a.transport);
        return (
          <Card key={a.envelope.action_id} style={styles.card}>
            {a.envelope.recipient.channel === 'simulated' ? <Text style={styles.simulated}>{t('preview.simulated')}</Text> : null}
            <Text style={styles.meta}>{t('preview.to', { recipient: a.envelope.recipient.address })}</Text>
            <Text style={styles.body}>{body}</Text>
            <Text style={styles.state}>{t(BUSINESS_KEY[a.business])}</Text>
            {line ? <Text style={styles.transport}>{line}</Text> : null}
            {a.provider_ref ? <Text style={styles.meta}>{a.provider_ref}</Text> : null}
            {canSend ? (
              <ActionButton
                label={a.envelope.recipient.channel === 'sms' ? t('action.open_messages') : 'Tuma (majaribio)'}
                onPress={() => void send(a)}
              />
            ) : null}
            {canRevoke ? (
              <>
                {a.transport === 'sending' || a.transport === 'send_unknown' ? <Text style={styles.meta}>{t('action.revoke.may_be_sent')}</Text> : null}
                <ActionButton label={t('action.revoke')} secondary onPress={() => { setPinError(null); setRevoking(a); }} />
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

const styles = StyleSheet.create({
  card: { gap: spacing.xs },
  simulated: { fontSize: 13, fontWeight: '800', color: palette.red },
  meta: { fontSize: 14, color: palette.muted },
  body: { fontSize: 17, color: palette.ink, lineHeight: 24 },
  state: { fontSize: 16, fontWeight: '800', color: palette.ink, marginTop: spacing.xs },
  transport: { fontSize: 16, fontWeight: '600', color: palette.green },
});
