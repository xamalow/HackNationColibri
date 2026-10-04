const test = require('node:test');
const assert = require('node:assert/strict');
const { runExclusive } = require('../.test-dist/domain/actionGate.js');
const { arrivalBusyKey, runArrivalUpdate, runBookingRequest, ZIARA_WRITE_GUARD } = require('../.test-dist/domain/ziaraWorkflow.js');

test('booking request turns success into a proposal and shows refusals or thrown failures', async () => {
  const input = { visitorName: 'Claire', date: '2026-10-17', partySize: 4, phone: '' };
  assert.deepEqual(await runBookingRequest(input, async (received) => {
    assert.deepEqual(received, input);
    return { ok: true };
  }), { status: 'proposed' });
  assert.deepEqual(await runBookingRequest(input, async () => ({ ok: false, message: 'no_capacity' })), {
    status: 'refused', message: 'no_capacity',
  });
  assert.deepEqual(await runBookingRequest(input, async () => { throw new Error('database unavailable'); }), {
    status: 'failed', message: 'database unavailable',
  });
});

test('arrival action reports recorded, refused, and storage failure outcomes', async () => {
  const booking = { booking_id: 'booking-1' };
  assert.deepEqual(await runArrivalUpdate(booking, 'arrived', async (received, status) => {
    assert.equal(received, booking);
    assert.equal(status, 'arrived');
    return { ok: true };
  }), { status: 'recorded' });
  assert.deepEqual(await runArrivalUpdate(booking, 'no_show', async () => ({ ok: false, reason: 'already_recorded' })), {
    status: 'refused', message: 'already_recorded',
  });
  assert.deepEqual(await runArrivalUpdate(booking, 'arrived', async () => { throw new Error('write failed'); }), {
    status: 'failed', message: 'write failed',
  });
});

test('Ziara uses one write guard and separate per-booking arrival indicators', () => {
  assert.equal(ZIARA_WRITE_GUARD, 'ziara-write');
  assert.equal(arrivalBusyKey('booking-1', 'arrived'), 'arrival:booking-1:arrived');
  assert.equal(arrivalBusyKey('booking-1', 'no_show'), 'arrival:booking-1:no_show');
});

test('Ziara write guard blocks overlapping booking and arrival writes until storage finishes', async () => {
  const active = new Set();
  let finish;
  let calls = 0;
  const first = runExclusive(active, ZIARA_WRITE_GUARD, () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.deepEqual(await runExclusive(active, ZIARA_WRITE_GUARD, async () => { calls += 1; }), { accepted: false });
  assert.equal(calls, 1);
  finish('recorded');
  assert.deepEqual(await first, { accepted: true, value: 'recorded' });
  assert.equal(active.has(ZIARA_WRITE_GUARD), false);
});
