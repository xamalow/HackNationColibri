type TrieNode = { children: Map<number, TrieNode>; piece?: string };

export type SentencePieceTokenizer = {
  pieces(text: string): string[];
  encode(text: string): number[];
};

type Piece = { piece: string; score: number; type: number };
type Normalizer = {
  name: string;
  charsmap: { bytes: Uint8Array; units: Uint32Array; poolStart: number };
  addDummyPrefix: boolean;
  removeExtraWhitespaces: boolean;
  escapeWhitespaces: boolean;
};

function readVarint(bytes: Uint8Array, start: number, limit = bytes.length): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let index = start;
  while (index < limit && shift < 35) {
    const byte = bytes[index++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: index };
    shift += 7;
  }
  throw new Error('The SentencePiece protobuf contains a malformed varint.');
}

function* protobufFields(bytes: Uint8Array): Generator<{ field: number; wire: number; value: number | Uint8Array }> {
  let index = 0;
  while (index < bytes.length) {
    const tag = readVarint(bytes, index);
    index = tag.next;
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    if (field === 0) throw new Error('The SentencePiece protobuf contains field zero.');
    if (wire === 0) {
      const value = readVarint(bytes, index);
      index = value.next;
      yield { field, wire, value: value.value };
    } else if (wire === 2) {
      const length = readVarint(bytes, index);
      index = length.next;
      if (length.value > bytes.length - index) throw new Error('The SentencePiece protobuf has a truncated field.');
      yield { field, wire, value: bytes.subarray(index, index + length.value) };
      index += length.value;
    } else if (wire === 5) {
      if (index + 4 > bytes.length) throw new Error('The SentencePiece protobuf has a truncated float.');
      yield { field, wire, value: bytes.subarray(index, index + 4) };
      index += 4;
    } else if (wire === 1) {
      if (index + 8 > bytes.length) throw new Error('The SentencePiece protobuf has a truncated fixed-width value.');
      yield { field, wire, value: bytes.subarray(index, index + 8) };
      index += 8;
    } else {
      throw new Error(`The SentencePiece protobuf uses unsupported wire type ${wire}.`);
    }
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++];
    let codePoint: number;
    if (first < 0x80) codePoint = first;
    else if ((first & 0xe0) === 0xc0 && index < bytes.length) {
      codePoint = ((first & 0x1f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf0) === 0xe0 && index + 1 < bytes.length) {
      codePoint = ((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else if ((first & 0xf8) === 0xf0 && index + 2 < bytes.length) {
      codePoint = ((first & 7) << 18) | ((bytes[index++] & 0x3f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
    } else {
      throw new Error('The SentencePiece model contains invalid UTF-8.');
    }
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error('The SentencePiece model contains an invalid Unicode scalar.');
    }
    result += String.fromCodePoint(codePoint);
  }
  return result;
}

function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const first = text.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = text.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new Error('The source text contains a lone high surrogate.');
      codePoint = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
      index++;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error('The source text contains a lone low surrogate.');
    }
    if (codePoint < 0x80) bytes.push(codePoint);
    else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint < 0x10000) bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    else bytes.push(0xf0 | (codePoint >>> 18), 0x80 | ((codePoint >>> 12) & 0x3f), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  }
  return Uint8Array.from(bytes);
}

function readString(bytes: Uint8Array): string {
  return decodeUtf8(bytes);
}

function parsePiece(bytes: Uint8Array): Piece {
  let piece = '';
  let score = 0;
  let type = 1;
  for (const field of protobufFields(bytes)) {
    if (field.field === 1 && field.wire === 2 && field.value instanceof Uint8Array) piece = readString(field.value);
    else if (field.field === 2 && field.wire === 5 && field.value instanceof Uint8Array) {
      score = new DataView(field.value.buffer, field.value.byteOffset, field.value.byteLength).getFloat32(0, true);
    } else if (field.field === 3 && field.wire === 0 && typeof field.value === 'number') type = field.value;
  }
  if (!piece || !Number.isFinite(score)) throw new Error('The SentencePiece model contains an invalid piece.');
  return { piece, score, type };
}

function parseNormalizer(bytes: Uint8Array): Normalizer {
  let name = '';
  let charsmap: Uint8Array | null = null;
  let addDummyPrefix = false;
  let removeExtraWhitespaces = false;
  // The protobuf default for NormalizerSpec.escape_whitespaces is true; this
  // model omits that field because the serialized value equals its default.
  let escapeWhitespaces = true;
  for (const field of protobufFields(bytes)) {
    if (field.field === 1 && field.wire === 2 && field.value instanceof Uint8Array) name = readString(field.value);
    else if (field.field === 2 && field.wire === 2 && field.value instanceof Uint8Array) charsmap = field.value;
    else if (field.field === 3 && field.wire === 0 && typeof field.value === 'number') addDummyPrefix = field.value !== 0;
    else if (field.field === 4 && field.wire === 0 && typeof field.value === 'number') removeExtraWhitespaces = field.value !== 0;
    else if (field.field === 5 && field.wire === 0 && typeof field.value === 'number') escapeWhitespaces = field.value !== 0;
  }
  if (name !== 'nmt_nfkc' || !charsmap || !addDummyPrefix || !removeExtraWhitespaces || !escapeWhitespaces) {
    throw new Error('The source model does not contain the expected nmt_nfkc SentencePiece normalizer.');
  }
  if (charsmap.length < 4) throw new Error('The SentencePiece normalizer map is truncated.');
  const trieBytes = new DataView(charsmap.buffer, charsmap.byteOffset, charsmap.byteLength).getUint32(0, true);
  if (trieBytes % 4 !== 0) throw new Error('The SentencePiece normalizer map has an invalid trie size.');
  const unitCount = trieBytes / 4;
  const poolStart = 4 + trieBytes;
  if (unitCount === 0 || poolStart > charsmap.length) throw new Error('The SentencePiece normalizer map has invalid trie metadata.');
  const units = new Uint32Array(unitCount);
  const view = new DataView(charsmap.buffer, charsmap.byteOffset, charsmap.byteLength);
  for (let index = 0; index < unitCount; index++) units[index] = view.getUint32(4 + index * 4, true);
  return { name, charsmap: { bytes: charsmap, units, poolStart }, addDummyPrefix, removeExtraWhitespaces, escapeWhitespaces };
}

function splitUtf8CodePointLength(firstByte: number): number {
  if (firstByte < 0x80) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  throw new Error('The source text is not valid UTF-8.');
}

function mapWithCharsmap(input: Uint8Array, charsmap: Normalizer['charsmap']): Uint8Array {
  const { bytes, units, poolStart } = charsmap;
  const unitOffset = (unit: number) => (unit >>> 10) << ((unit & 0x200) >>> 6);
  const output: number[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const root = units[0];
    let node = unitOffset(root);
    let scan = cursor;
    let matchedLength = 0;
    let replacementOffset = -1;
    while (scan < input.length) {
      node ^= input[scan];
      if (node < 0 || node >= units.length) break;
      const unit = units[node];
      if ((unit & 0xff) !== input[scan]) break;
      node ^= unitOffset(unit);
      scan++;
      if ((unit & 0x100) !== 0) {
        if (node < 0 || node >= units.length) throw new Error('The SentencePiece normalizer has an invalid leaf.');
        matchedLength = scan - cursor;
        replacementOffset = units[node] & 0x7fffffff;
      }
    }
    if (matchedLength > 0) {
      let poolIndex = poolStart + replacementOffset;
      if (poolIndex < poolStart || poolIndex >= bytes.length) throw new Error('The SentencePiece normalizer has an invalid replacement offset.');
      while (poolIndex < bytes.length && bytes[poolIndex] !== 0) output.push(bytes[poolIndex++]);
      if (poolIndex >= bytes.length) throw new Error('The SentencePiece normalizer has an unterminated replacement.');
      cursor += matchedLength;
    } else {
      const length = splitUtf8CodePointLength(input[cursor]);
      if (cursor + length > input.length) throw new Error('The source text ends in a truncated UTF-8 sequence.');
      for (let index = cursor; index < cursor + length; index++) output.push(input[index]);
      cursor += length;
    }
  }
  return Uint8Array.from(output);
}

function normalizeWhitespace(text: string): string {
  // SentencePiece's nmt_nfkc map first turns compatibility spaces into U+0020. This
  // pass mirrors RemoveExtraWhitespaces: collapse and trim whitespace, then the model
  // adds its dummy prefix and escapes spaces to U+2581.
  return text.replace(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g, ' ').replace(/^ | $/g, '');
}

function normalize(text: string, spec: Normalizer): Uint8Array {
  const mapped = mapWithCharsmap(encodeUtf8(text), spec.charsmap);
  let normalized = decodeUtf8(mapped);
  if (spec.removeExtraWhitespaces) normalized = normalizeWhitespace(normalized);
  if (spec.addDummyPrefix && normalized.length > 0) normalized = ` ${normalized}`;
  if (spec.escapeWhitespaces) normalized = normalized.replace(/ /g, '▁');
  return encodeUtf8(normalized);
}

function nextRuneLength(bytes: Uint8Array, start: number): number {
  return splitUtf8CodePointLength(bytes[start]);
}

function buildTrie(pieces: Piece[]): { root: TrieNode; minimumScore: number } {
  const root: TrieNode = { children: new Map() };
  let minimumScore = Number.POSITIVE_INFINITY;
  for (const entry of pieces) {
    if (entry.type !== 1) continue;
    const bytes = encodeUtf8(entry.piece);
    let node = root;
    for (const byte of bytes) {
      let child = node.children.get(byte);
      if (!child) {
        child = { children: new Map() };
        node.children.set(byte, child);
      }
      node = child;
    }
    node.piece = entry.piece;
    minimumScore = Math.min(minimumScore, entry.score);
  }
  if (!Number.isFinite(minimumScore)) throw new Error('The SentencePiece model has no normal pieces.');
  return { root, minimumScore };
}

/**
 * Builds the exact unigram tokenizer used by Helsinki-NLP/opus-mt-en-sw. The source
 * model itself supplies both the nmt_nfkc char map and all normal-piece scores.
 */
export function createSentencePieceTokenizer(modelBytes: Uint8Array, vocab: Record<string, number>): SentencePieceTokenizer {
  const pieces: Piece[] = [];
  let normalizer: Normalizer | null = null;
  for (const field of protobufFields(modelBytes)) {
    if (field.field === 1 && field.wire === 2 && field.value instanceof Uint8Array) pieces.push(parsePiece(field.value));
    else if (field.field === 3 && field.wire === 2 && field.value instanceof Uint8Array) normalizer = parseNormalizer(field.value);
  }
  if (!normalizer) throw new Error('The SentencePiece model has no normalizer specification.');
  const { root, minimumScore } = buildTrie(pieces);
  const scores = new Map<string, number>();
  for (const entry of pieces) if (entry.type === 1) scores.set(entry.piece, entry.score);
  const unknownId = vocab['<unk>'];
  if (unknownId !== 1 || vocab['</s>'] !== 0) throw new Error('The vocabulary special-token IDs do not match the pinned Opus-MT model.');

  function segment(text: string): string[] {
    const normalized = normalize(text, normalizer as Normalizer);
    if (normalized.length === 0) return [];
    const best = new Array<number>(normalized.length + 1).fill(Number.NEGATIVE_INFINITY);
    const previous = new Array<{ start: number; piece: string; unknown: boolean } | null>(normalized.length + 1).fill(null);
    best[0] = 0;
    for (let start = 0; start < normalized.length; start++) {
      if (!Number.isFinite(best[start])) continue;
      let node = root;
      let cursor = start;
      let hasCharacterPiece = false;
      while (cursor < normalized.length) {
        const child = node.children.get(normalized[cursor]);
        if (!child) break;
        node = child;
        cursor++;
        if (node.piece !== undefined) {
          const score = scores.get(node.piece);
          if (score === undefined) throw new Error('The SentencePiece score table is incomplete.');
          const candidate = best[start] + score;
          if (candidate > best[cursor]) {
            best[cursor] = candidate;
            previous[cursor] = { start, piece: node.piece, unknown: false };
          }
          if (cursor === start + nextRuneLength(normalized, start)) hasCharacterPiece = true;
        }
      }
      if (!hasCharacterPiece) {
        const next = start + nextRuneLength(normalized, start);
        const candidate = best[start] + minimumScore - 10;
        if (candidate > best[next]) {
          best[next] = candidate;
          previous[next] = { start, piece: decodeUtf8(normalized.subarray(start, next)), unknown: true };
        }
      }
    }
    const reversed: { piece: string; unknown: boolean }[] = [];
    for (let cursor = normalized.length; cursor > 0;) {
      const step = previous[cursor];
      if (!step || step.start >= cursor) throw new Error('SentencePiece could not segment this source safely.');
      reversed.push({ piece: step.piece, unknown: step.unknown });
      cursor = step.start;
    }
    reversed.reverse();
    const result: { piece: string; unknown: boolean }[] = [];
    for (const current of reversed) {
      const last = result[result.length - 1];
      if (current.unknown && last?.unknown) last.piece += current.piece;
      else result.push({ ...current });
    }
    return result.map(({ piece }) => piece);
  }

  return {
    pieces: segment,
    encode(text) {
      return [...segment(text).map((piece) => vocab[piece] ?? unknownId), 0];
    },
  };
}
