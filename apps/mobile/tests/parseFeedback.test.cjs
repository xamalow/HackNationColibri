const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { parseFeedbackFile } = require('../.test-dist/import/parseFeedback.js');

test('CSV import preserves the source text, including punctuation and line breaks', () => {
  const [row] = parseFeedbackFile('visitor.csv', '\uFEFFcomment,language\r\n"Chakula, baridi\nna kidogo",sw\r\n');
  assert.equal(row.text, 'Chakula, baridi\nna kidogo');
  assert.equal(row.rowNumber, 1);
  assert.equal(row.language, 'sw');
  assert.match(row.contentHash, /^[a-f0-9]{64}$/);
});

test('source identifiers remain stable for the same file contents', () => {
  const csv = 'text\n"Tulipotea njia."\n';
  assert.deepEqual(parseFeedbackFile('feedback.csv', csv), parseFeedbackFile('renamed.csv', csv));
});

test('identical comments at different row positions keep distinct source IDs', () => {
  const rows = parseFeedbackFile('feedback.csv', 'text\n"Great view."\n"Great view."\n');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].sourceId, rows[1].sourceId);
  assert.equal(rows[0].contentHash, rows[1].contentHash);
});

test('JSON records accept a feedback field and preserve its exact text', () => {
  const [row] = parseFeedbackFile('feedback.json', JSON.stringify({ records: [{ feedback: 'Hakuna choo safi.', language: 'sw' }] }));
  assert.equal(row.text, 'Hakuna choo safi.');
  assert.equal(row.language, 'sw');
  assert.equal(row.contentHash, createHash('sha256').update('sauti.source_text.v1\0Hakuna choo safi.', 'utf8').digest('hex'));
});

test('sources without declared language remain undetermined until a person selects one', () => {
  const [row] = parseFeedbackFile('feedback.json', '[{"text":"Njia ilikuwa rahisi."}]');
  assert.equal(row.language, 'und');
});

test('UTF-8 source byte limit is enforced, including multibyte text', () => {
  const oversized = 'é'.repeat(8193);
  assert.throws(() => parseFeedbackFile('feedback.json', JSON.stringify([{ text: oversized, lang: 'sw' }])), /16384-byte source limit/);
});

test('unsupported formats and files without feedback text fail closed', () => {
  assert.throws(() => parseFeedbackFile('notes.txt', 'hello'), /Choose a \.csv or \.json/);
  assert.throws(() => parseFeedbackFile('rows.json', '[{"name":"Amina"}]'), /No non-empty feedback text/);
});

test('malformed UTF-16 source strings are rejected instead of normalized', () => {
  assert.throws(() => parseFeedbackFile('rows.json', '[{"text":"\\ud800"}]'), /lone high surrogate/);
});
