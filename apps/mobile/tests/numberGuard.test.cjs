const test = require('node:test');
const assert = require('node:assert/strict');
const { numberGuard } = require('../.test-dist/models/numberGuard.js');

test('number guard preserves Python thousands-separator and multiset behavior', () => {
  assert.equal(numberGuard('Price 1,200 and 8.5', 'Bei 1200 na 8.5'), true);
  assert.equal(numberGuard('1,200', '1 200'), true);
  assert.equal(numberGuard('2 2', '2'), false);
  assert.equal(numberGuard('08:46', 'saa 2:46'), false);
  assert.equal(numberGuard('1,20 and 3', '1 20 and 3'), true);
});

test('number guard handles Unicode decimal digits and integers beyond JS safe range', () => {
  assert.equal(numberGuard('bei ١٬٢٠٠', 'bei 1200'), false);
  assert.equal(numberGuard('1,234,567,890,123,456,789,012', '1234567890123456789012'), true);
  assert.equal(numberGuard('No numbers here', 'Hakuna namba'), true);
});
