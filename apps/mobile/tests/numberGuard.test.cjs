const test = require('node:test');
const assert = require('node:assert/strict');
const { sameNumbers } = require('../.test-dist/models/numberGuard.js');

test('translation keeps every number the same number of times', () => {
  assert.equal(sameNumbers('Tulikuwa watu 4, tulilipa 2000.', 'We were 4 people and paid 2,000.'), true);
  assert.equal(sameNumbers('at 9:30', 'saa 9:30'), true);
  assert.equal(sameNumbers('no numbers here', 'hakuna namba'), true);
});

test('a dropped, duplicated, added or changed number is caught (codex-mobile #48)', () => {
  assert.equal(sameNumbers('5 and 5', '5'), false, 'dropped occurrence');
  assert.equal(sameNumbers('5', '5 5'), false, 'duplicated occurrence');
  assert.equal(sameNumbers('Lovely tour', 'Ziara nzuri 3'), false, 'added number');
  assert.equal(sameNumbers('4 people', 'watu 5'), false, 'changed number');
  assert.equal(sameNumbers('at 9:30', 'saa 9'), false, 'truncated time');
});
