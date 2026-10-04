const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDispatchAction, canDispatchAction } = require('../.test-dist/domain/dispatchPolicy.js');
const { withDispatchGuard, shouldRecoverInterruptedDispatch } = require('../.test-dist/domain/dispatchGate.js');

function action(overrides = {}) {
  return {
    tenant_id: 'tenant-1',
    envelope: {
      action_id: 'action-1',
      tenant_id: 'tenant-1',
      digest: 'a'.repeat(64),
      recipient: { channel: 'sms', address: '+254700000000' },
      payload: { body: 'Exact approved bytes' },
    },
    business: 'approved',
    transport: 'failed',
    attempts: 1,
    revoked_at: null,
    provider_ref: null,
    ...overrides,
  };
}

async function coreRetry() {
  return (await import('@sauti/core')).retry;
}

test('failed approved action uses Core retry without changing pinned action data', async () => {
  const { retry, idempotencyKey } = await import('@sauti/core');
  const failed = action();
  const sha256 = (bytes) => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const originalKey = idempotencyKey(failed.tenant_id, failed.envelope.action_id, failed.envelope.digest, sha256);
  const prepared = prepareDispatchAction(failed, retry);

  assert.equal(prepared.ok, true);
  assert.equal(prepared.retried, true);
  assert.equal(prepared.action.transport, 'queued');
  assert.equal(prepared.action.attempts, failed.attempts);
  assert.deepEqual(prepared.action.envelope, failed.envelope, 'retry keeps the same action ID, recipient, and approved body');
  assert.equal(idempotencyKey(prepared.action.tenant_id, prepared.action.envelope.action_id, prepared.action.envelope.digest, sha256), originalKey, 'retry input keeps the stable Core key material');
  assert.equal(failed.transport, 'failed', 'Core transition is pure; persisted row changes only on the dispatch path');
});

test('retry is available only below Core budget; send_unknown and local actions never show Send', async () => {
  const { retry, DEFAULT_RETRY_BUDGET } = await import('@sauti/core');
  const overBudget = action({ attempts: DEFAULT_RETRY_BUDGET });
  assert.deepEqual(prepareDispatchAction(overBudget, retry), { ok: false, reason: 'retry_limit' });
  assert.equal(canDispatchAction(overBudget, retry), false);

  const unknown = action({ transport: 'send_unknown' });
  assert.equal(canDispatchAction(unknown, retry), false);
  const unknownPrepared = prepareDispatchAction(unknown, retry);
  assert.equal(unknownPrepared.ok, true);
  assert.equal(unknownPrepared.action, unknown);
  assert.equal(unknownPrepared.retried, false);

  assert.equal(canDispatchAction(action({ transport: 'queued' }), retry), true);
  assert.equal(canDispatchAction(action({ transport: 'queued', envelope: { ...action().envelope, recipient: { channel: 'local' } } }), retry), false);
});

test('rapid taps dispatch one action at most once and release the guard afterward', async () => {
  const active = new Set();
  let finish;
  let providerCalls = 0;
  const inFlight = new Promise((resolve) => { finish = resolve; });
  const first = withDispatchGuard(active, 'action-1', async () => {
    providerCalls += 1;
    await inFlight;
    return 'completed';
  });
  const second = await withDispatchGuard(active, 'action-1', async () => { providerCalls += 1; });

  assert.deepEqual(second, { accepted: false });
  assert.equal(providerCalls, 1);
  finish();
  assert.deepEqual(await first, { accepted: true, value: 'completed' });
  assert.equal(active.has('action-1'), false);
});

test('a live same-process send is not recovered as send_unknown, but a crash-left send is', () => {
  const active = new Set(['action-live']);
  assert.equal(shouldRecoverInterruptedDispatch('action-live', 'sending', active), false);
  assert.equal(shouldRecoverInterruptedDispatch('action-after-crash', 'sending', active), true);
  assert.equal(shouldRecoverInterruptedDispatch('action-unknown', 'send_unknown', active), false);
});
