const test = require('node:test');
const assert = require('node:assert/strict');
const { runExclusive } = require('../.test-dist/domain/actionGate.js');
const { runDemoFarmLoad, runFarmSave, runPinEnrollment, toggleWeekday } = require('../.test-dist/domain/shambaWorkflow.js');

const form = { price: '2000', capacity: '10', days: ['mon'], start: '09:00', end: '15:00', directions: '', inclusions: '' };

test('PIN enrollment rejects invalid or mismatched entries without calling the enrollment port', async () => {
  let calls = 0;
  const enroll = async () => { calls += 1; return { ok: true, ms: 4 }; };
  assert.deepEqual(await runPinEnrollment('12', '12', enroll), { status: 'invalid' });
  assert.deepEqual(await runPinEnrollment('1234', '4321', enroll), { status: 'mismatch' });
  assert.equal(calls, 0);
});

test('PIN enrollment reports saved and refused outcomes, and converts thrown storage errors to visible failures', async () => {
  assert.deepEqual(await runPinEnrollment('1234', '1234', async (pin) => {
    assert.equal(pin, '1234');
    return { ok: true, ms: 31 };
  }), { status: 'enrolled', ms: 31 });
  assert.deepEqual(await runPinEnrollment('1234', '1234', async () => ({ ok: false, error: 'already_enrolled' })), {
    status: 'refused', message: 'already_enrolled',
  });
  assert.deepEqual(await runPinEnrollment('1234', '1234', async () => { throw new Error('database locked'); }), {
    status: 'failed', message: 'database locked',
  });
});

test('farm save surfaces validation errors, confirms the saved revision, and reports persistence failures', async () => {
  assert.deepEqual(await runFarmSave(form, async () => ({ ok: false, errors: ['capacity_required'] })), {
    status: 'invalid', errors: ['capacity_required'],
  });
  assert.deepEqual(await runFarmSave(form, async (saved) => {
    assert.deepEqual(saved, form);
    return { ok: true, revision: { revision: 4 } };
  }), { status: 'saved', revision: 4 });
  assert.deepEqual(await runFarmSave(form, async () => { throw new Error('write failed'); }), {
    status: 'failed', message: 'write failed',
  });
});

test('synthetic farm load distinguishes loaded, already-saved, validation, and storage outcomes', async () => {
  assert.deepEqual(await runDemoFarmLoad(async () => ({ loaded: true })), { status: 'loaded' });
  assert.deepEqual(await runDemoFarmLoad(async () => ({ loaded: false })), { status: 'already_exists' });
  assert.deepEqual(await runDemoFarmLoad(async () => ({ loaded: false, errors: ['days_required'] })), {
    status: 'invalid', errors: ['days_required'],
  });
  assert.deepEqual(await runDemoFarmLoad(async () => { throw new Error('database unavailable'); }), {
    status: 'failed', message: 'database unavailable',
  });
});

test('weekday toggles add or remove one selection without mutating prior form state', () => {
  const days = ['mon', 'fri'];
  assert.deepEqual(toggleWeekday(days, 'tue'), ['mon', 'fri', 'tue']);
  assert.deepEqual(toggleWeekday(days, 'mon'), ['fri']);
  assert.deepEqual(days, ['mon', 'fri']);
});

test('Shamba writes share a guard to reject rapid taps and prevent save/demo/PIN overlap', async () => {
  const active = new Set();
  let finish;
  let calls = 0;
  const first = runExclusive(active, 'shamba-write', () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  });
  assert.deepEqual(await runExclusive(active, 'shamba-write', async () => { calls += 1; }), { accepted: false });
  assert.equal(calls, 1);
  finish('saved');
  assert.deepEqual(await first, { accepted: true, value: 'saved' });
  assert.equal(active.has('shamba-write'), false);

  await assert.rejects(runExclusive(active, 'shamba-write', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(active.has('shamba-write'), false);
});
