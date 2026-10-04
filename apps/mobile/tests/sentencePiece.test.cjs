const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createSentencePieceTokenizer } = require('../.test-dist/models/sentencePiece.js');

function varint(value) {
  const result = [];
  while (value > 0x7f) {
    result.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  result.push(value);
  return Buffer.from(result);
}

function field(number, wire, payload) {
  const tag = varint((number << 3) | wire);
  if (wire === 2) return Buffer.concat([tag, varint(payload.length), payload]);
  return Buffer.concat([tag, payload]);
}

function piece(text, score) {
  const scoreBytes = Buffer.alloc(4);
  scoreBytes.writeFloatLE(score);
  return Buffer.concat([field(1, 2, Buffer.from(text)), field(2, 5, scoreBytes), field(3, 0, varint(1))]);
}

function syntheticModel() {
  // Identity Darts map: 256 units with no leaves, preceded by the trie byte size.
  const trie = Buffer.alloc(4 + 256 * 4);
  trie.writeUInt32LE(256 * 4, 0);
  const charsmap = trie;
  const normalizer = Buffer.concat([
    field(1, 2, Buffer.from('nmt_nfkc')),
    field(2, 2, charsmap),
    field(3, 0, varint(1)),
    field(4, 0, varint(1)),
    field(5, 0, varint(1)),
  ]);
  return Buffer.concat([
    field(1, 2, piece('▁a', -1)),
    field(1, 2, piece('▁b', -1)),
    field(1, 2, piece('▁', -0.5)),
    field(1, 2, piece('a', -2)),
    field(1, 2, piece('b', -2)),
    field(3, 2, normalizer),
  ]);
}

test('SentencePiece protobuf parser performs dummy-prefix escaping and unigram Viterbi segmentation', () => {
  const vocab = { '<unk>': 1, '</s>': 0, '▁a': 2, '▁b': 3, '▁': 4, a: 5, b: 6 };
  const tokenizer = createSentencePieceTokenizer(syntheticModel(), vocab);
  assert.deepEqual(tokenizer.pieces('a   b'), ['▁a', '▁b']);
  assert.deepEqual(tokenizer.encode('a b'), [2, 3, 0]);
  assert.deepEqual(tokenizer.encode('a 😀'), [2, 4, 1, 0]);
  assert.throws(() => tokenizer.encode('\ud800'), /lone high surrogate/);
});

test('SentencePiece output matches Max Python vectors when the pinned local model artifacts are available', {
  skip: !process.env.SAUTI_OPUS_SOURCE_SPM || !process.env.SAUTI_OPUS_VOCAB_JSON,
}, () => {
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/opus-mt-en-sw-tokenizer-vectors.json', 'utf8'));
  const spmBytes = fs.readFileSync(process.env.SAUTI_OPUS_SOURCE_SPM);
  const vocabBytes = fs.readFileSync(process.env.SAUTI_OPUS_VOCAB_JSON);
  assert.equal(crypto.createHash('sha256').update(spmBytes).digest('hex'), fixture.sourceModelSha256);
  const vocabulary = JSON.parse(vocabBytes.toString('utf8'));
  assert.equal(Object.keys(vocabulary).length, fixture.vocabEntries);
  const tokenizer = createSentencePieceTokenizer(spmBytes, vocabulary);
  for (const vector of fixture.vectors) {
    assert.deepEqual(tokenizer.pieces(vector.text), vector.pieces, vector.text);
    assert.deepEqual(tokenizer.encode(vector.text), vector.ids, vector.text);
  }
});
