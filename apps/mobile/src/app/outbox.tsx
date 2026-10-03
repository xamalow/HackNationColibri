import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ActionButton, Card, Notice, PageTitle, Screen, SectionTitle } from '../components/Screen';
import { getApprovalAvailability, readApprovedOutbox } from '../domain/approvalPort';
import type { OutboxItem, OutboxStatus } from '../domain/types';
import { OUTBOX_STATUSES } from '../domain/types';
import { palette } from '../theme';

const STATUS_LABELS: Record<OutboxStatus, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  send_unknown: 'Send unknown',
  delivered: 'Delivered',
  failed: 'Failed',
};

export default function OutboxScreen() {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [ready, setReady] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const availability = getApprovalAvailability();
    setReady(availability.ready);
    setReason(availability.reason);
    if (availability.ready) setItems(await readApprovedOutbox());
  }, []);
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  return (
    <Screen>
      <PageTitle eyebrow="Owner-approved actions" title="Outbox" subtitle="Only an exact message approved by its owner can enter the durable queue." />
      {!ready ? <Notice tone="warning">{reason} Queue creation and sending are unavailable until Mobile binds the frozen approval API.</Notice> : null}
      <SectionTitle title="Transport state" />
      <Card style={styles.legendCard}>
        {OUTBOX_STATUSES.map((status) => (
          <View key={status} style={styles.legendRow}>
            <View style={[styles.statusDot, status === 'delivered' ? styles.successDot : status === 'send_unknown' ? styles.warningDot : null]} />
            <Text style={styles.statusName}>{STATUS_LABELS[status]}</Text>
            <Text style={styles.statusHelp}>{status === 'send_unknown' ? 'Acceptance is ambiguous; never blindly retry.' : status === 'queued' ? 'Durable, approved, waiting to send.' : status === 'delivered' ? 'Recipient delivery confirmed.' : status === 'sent' ? 'Transport accepted the message.' : status === 'sending' ? 'A send attempt is active.' : 'The attempt failed with a known result.'}</Text>
          </View>
        ))}
      </Card>
      <SectionTitle title={`Approved messages · ${items.length}`} />
      {items.length === 0 ? (
        <Card>
          <Text style={styles.emptyTitle}>Nothing in the queue</Text>
          <Text style={styles.body}>Queued, sent, delivered, and send unknown remain separate states. A model suggestion never creates a queue item.</Text>
        </Card>
      ) : items.map((item) => (
        <Card key={item.actionId}>
          <View style={styles.itemHeader}>
            <Text style={styles.statusName}>{STATUS_LABELS[item.status]}</Text>
            <Text style={styles.recipient}>{item.recipientLabel}</Text>
          </View>
          <Text selectable style={styles.message}>{item.exactMessage}</Text>
          <Text style={styles.digest}>Rendered digest · {item.renderedDigest}</Text>
        </Card>
      ))}
      <ActionButton label="Refresh queue" onPress={() => void refresh()} secondary />
    </Screen>
  );
}

const styles = StyleSheet.create({
  legendCard: { gap: 13 },
  legendRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  statusDot: { width: 8, height: 8, marginTop: 5, borderRadius: 4, backgroundColor: '#748078' },
  successDot: { backgroundColor: palette.green },
  warningDot: { backgroundColor: palette.amber },
  statusName: { color: palette.ink, fontSize: 13, fontWeight: '800', minWidth: 88 },
  statusHelp: { flex: 1, color: palette.muted, fontSize: 12, lineHeight: 17 },
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  body: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  recipient: { color: palette.muted, fontSize: 12 },
  message: { color: palette.ink, fontSize: 15, lineHeight: 23 },
  digest: { color: palette.muted, fontSize: 10, lineHeight: 15 },
});
