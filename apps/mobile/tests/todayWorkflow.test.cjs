const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { runExclusive } = require('../.test-dist/domain/actionGate.js');
const { AsyncMutex } = require('../.test-dist/domain/asyncMutex.js');
const { isApprovalConflict } = require('../.test-dist/domain/approvalErrors.js');
const { buildMissingInfoQuestions } = require('../.test-dist/domain/missingInfo.js');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function analysisFixture() {
  return {
    themes: [
      {
        theme: 'directions', verdict: 'insufficient', comment_count: 2,
        evidence: [{ source_id: 'source-1', content_hash: 'a'.repeat(64), span: { start: 0, end: 5 }, quote: 'njia.' }],
        rejected: [],
      },
      {
        theme: 'food', verdict: 'conflicting', comment_count: 5,
        evidence: [{ source_id: 'source-2', content_hash: 'b'.repeat(64), span: { start: 0, end: 4 }, quote: 'tamu' }],
        rejected: [],
      },
      {
        theme: 'coffee', verdict: 'supported', comment_count: 3,
        evidence: [{ source_id: 'source-3', content_hash: 'c'.repeat(64), span: { start: 0, end: 4 }, quote: 'good' }],
        rejected: [],
      },
    ],
    rejected_tags: [],
    ask_a_person: [
      { reason: 'contradictory_reviews', detail: 'visitors disagree about food', about: ['food'] },
      { reason: 'unsupported_language', detail: '1 comment needs review', about: ['source-4'] },
    ],
  };
}

test('Today exposes evidence-bound questions for insufficient, conflicting, and unsupported evidence only', async () => {
  const analysis = analysisFixture();
  const { digest } = await import('@sauti/core');
  const questions = buildMissingInfoQuestions(analysis, (domain, value) => digest(domain, value, sha256));
  assert.deepEqual(questions.map(({ reason, theme }) => [reason, theme]), [
    ['insufficient_feedback', 'directions'],
    ['contradictory_reviews', 'food'],
    ['unsupported_language', null],
  ]);
  assert.equal(questions.some((question) => question.theme === 'coffee'), false, 'supported evidence does not ask for help');
});

test('a missing-info request is stable for the same evidence and changes with the evidence digest', async () => {
  const analysis = analysisFixture();
  const { digest } = await import('@sauti/core');
  const identity = (domain, value) => digest(domain, value, sha256);
  const first = buildMissingInfoQuestions(analysis, identity);
  const repeated = buildMissingInfoQuestions(analysis, identity);
  assert.deepEqual(first, repeated);

  const changed = analysisFixture();
  changed.themes[0].evidence[0].content_hash = 'd'.repeat(64);
  const refreshed = buildMissingInfoQuestions(changed, identity);
  assert.notEqual(refreshed[0].id, first[0].id);
});

test('same Today action cannot run twice while its first tap is still pending', async () => {
  const active = new Set();
  let finish;
  let calls = 0;
  const changes = [];
  const first = runExclusive(active, 'ask-missing:q1', () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  }, (keys) => changes.push(keys));
  const second = await runExclusive(active, 'ask-missing:q1', async () => { calls += 1; }, (keys) => changes.push(keys));

  assert.deepEqual(second, { accepted: false });
  assert.equal(calls, 1);
  assert.equal(changes[0].has('ask-missing:q1'), true);
  finish('recorded');
  assert.deepEqual(await first, { accepted: true, value: 'recorded' });
  assert.equal(active.has('ask-missing:q1'), false);
  assert.equal(changes.at(-1).has('ask-missing:q1'), false);
});

test('failed Today action releases its tap guard so the owner can try again', async () => {
  const active = new Set();
  await assert.rejects(runExclusive(active, 'import-feedback', async () => { throw new Error('storage unavailable'); }), /storage unavailable/);
  assert.equal(active.has('import-feedback'), false);
  assert.deepEqual(await runExclusive(active, 'import-feedback', async () => 'retried'), { accepted: true, value: 'retried' });
});

test('approval transactions serialize on the process mutex and release in order', async () => {
  const mutex = new AsyncMutex();
  const order = [];
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  const first = mutex.run(async () => {
    order.push('first:start');
    enterFirst();
    await firstBlocked;
    order.push('first:commit');
    return 'first';
  });
  await firstEntered;
  const second = mutex.run(async () => { order.push('second:start'); return 'second'; });
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first:start', 'first:commit', 'second:start']);
});

test('approval adapter conflicts become explicit refusals and unrelated failures stay visible', () => {
  assert.equal(isApprovalConflict({ code: 'SQLITE_BUSY' }), true);
  assert.equal(isApprovalConflict(new Error('UNIQUE constraint failed: sauti_approvals.action_id')), true);
  assert.equal(isApprovalConflict(new Error('network unavailable')), false);
});
