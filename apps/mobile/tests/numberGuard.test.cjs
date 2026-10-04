const test = require('node:test');
const assert = require('node:assert/strict');
const { sameNumbers } = require('../.test-dist/models/numberGuard.js');

test('translation keeps every number the same number of times', () => {
  assert.equal(sameNumbers('Tulikuwa watu 4, tulilipa 2000.', 'We were 4 people and paid 2000.'), true);
  assert.equal(sameNumbers('at 9:30', 'saa 9:30'), true);
  assert.equal(sameNumbers('no numbers here', 'hakuna namba'), true);
});

test('a dropped, duplicated, added or changed number is caught (codex-mobile #48)', () => {
  assert.equal(sameNumbers('5 and 5', '5'), false, 'dropped occurrence');
  assert.equal(sameNumbers('5', '5 5'), false, 'duplicated occurrence');
  assert.equal(sameNumbers('Lovely tour', 'Ziara nzuri 3'), false, 'added number');
  assert.equal(sameNumbers('4 people', 'watu 5'), false, 'changed number');
  assert.equal(sameNumbers('at 9:30', 'saa 9'), false, 'truncated time');
  assert.equal(sameNumbers('-5°C', '5°C'), false, 'negative sign cannot be dropped');
  assert.equal(sameNumbers('9007199254740992', '9007199254740993'), false, 'large integers cannot round together');
  assert.equal(sameNumbers('1 and 2', '2 and 1'), false, 'number order is preserved');
  assert.equal(sameNumbers('01/02/2026', '02/01/2026'), false, 'date components cannot be reordered');
});

test('decimals keep their value (codex-mobile #48)', () => {
  assert.equal(sameNumbers('1.5', '15'), false, '1.5 is not 15');
  assert.equal(sameNumbers('2.5 km', '25 km'), false);
  assert.equal(sameNumbers('2.5 km', 'kilomita 2,5'), true, 'decimal comma is the same value');
  assert.equal(sameNumbers('KES 2,000', 'shilingi 2000'), false, 'a lone three-digit separator is ambiguous');
  assert.equal(sameNumbers('KES 2,000', 'shilingi 2,000'), true, 'unchanged ambiguous token is preserved');
  assert.equal(sameNumbers('KES 1,234,567', 'shilingi 1234567'), true, 'repeated grouping is unambiguous');
  assert.equal(sameNumbers('1,234.5', '1234.5'), true);
  assert.equal(sameNumbers('1.234,5', '1234.5'), true);
  assert.equal(sameNumbers('1.500', '1,5'), false, 'ambiguous grouping fails closed');
  assert.equal(sameNumbers('1.500 euros', '1500 euros'), false, 'ambiguous decimal/grouping cannot become an integer');
});
