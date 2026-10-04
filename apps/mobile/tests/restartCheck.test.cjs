const test = require('node:test');
const assert = require('node:assert/strict');
const { restartCheck } = require('../.test-dist/domain/restartCheck.js');

const D = 'a'.repeat(64);
const START = Date.parse('2026-10-04T08:00:00Z');
const base = {
  envelopeDigest: D,
  approvalDigest: D,
  outboxDigest: D,
  approvedAt: '2026-10-04T07:59:00Z',
  transport: 'queued',
  processStartedAtMs: START,
};

test('approved before this launch, same digest everywhere, still queued: the restart proof holds', () => {
  assert.deepEqual(restartCheck(base), { kind: 'survived', digestOk: true, waiting: true });
});

test('approved during this launch: no restart proof yet', () => {
  assert.equal(restartCheck({ ...base, approvedAt: '2026-10-04T08:00:01Z' }).kind, 'same_session');
});

test('a changed envelope, approval or outbox digest fails the check', () => {
  assert.equal(restartCheck({ ...base, envelopeDigest: 'b'.repeat(64) }).digestOk, false, 'envelope edited after approval');
  assert.equal(restartCheck({ ...base, approvalDigest: 'b'.repeat(64) }).digestOk, false, 'approval for other content');
  assert.equal(restartCheck({ ...base, outboxDigest: 'b'.repeat(64) }).digestOk, false, 'outbox pinned other bytes');
  assert.equal(restartCheck({ ...base, outboxDigest: null }).digestOk, false, 'outbox row missing');
});

test('sent, failed or unknown is not "still waiting"', () => {
  for (const transport of ['sending', 'sent', 'delivered', 'failed', 'send_unknown']) {
    assert.equal(restartCheck({ ...base, transport }).waiting, false, transport);
  }
});

test('no approval record, or an unreadable time, never claims survival', () => {
  assert.deepEqual(restartCheck({ ...base, approvalDigest: null }), { kind: 'not_approved' });
  assert.equal(restartCheck({ ...base, approvedAt: 'not a date' }).kind, 'same_session');
});
