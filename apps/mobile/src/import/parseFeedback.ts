import Papa from 'papaparse';
import { utf8ToBytes } from '@noble/hashes/utils';
import { sha256Text, sourceTextHash } from '../crypto/hash';

export type ParsedFeedback = {
  sourceId: string;
  rowNumber: number;
  contentHash: string;
  text: string;
  language: string;
};

const TEXT_FIELDS = ['feedback', 'text', 'comment', 'review', 'message', 'notes'];
const LANGUAGE_FIELDS = ['lang', 'language', 'locale'];
const MAX_SOURCE_BYTES = 16 * 1024;

function readTextField(row: Record<string, unknown>): string | null {
  const fieldsByLowerName = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().trim(), value]));
  for (const field of TEXT_FIELDS) {
    const value = fieldsByLowerName.get(field);
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function readDeclaredLanguage(row: Record<string, unknown>): string {
  const fieldsByLowerName = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().trim(), value]));
  for (const field of LANGUAGE_FIELDS) {
    const value = fieldsByLowerName.get(field);
    if (typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40) return value.trim();
  }
  return 'und';
}

function parseJsonRecords(content: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(content);
  const records = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && 'records' in parsed && Array.isArray(parsed.records)
      ? parsed.records
      : typeof parsed === 'object' && parsed !== null && 'feedback' in parsed && Array.isArray(parsed.feedback)
        ? parsed.feedback
        : null;
  if (!records || records.some((row) => typeof row !== 'object' || row === null || Array.isArray(row))) {
    throw new Error('JSON feedback must be an array of objects, or contain a records/feedback array.');
  }
  return records as Record<string, unknown>[];
}

export function parseFeedbackFile(fileName: string, content: string): ParsedFeedback[] {
  const extension = fileName.toLowerCase().split('.').pop();
  let rows: Record<string, unknown>[];

  if (extension === 'json') {
    rows = parseJsonRecords(content);
  } else if (extension === 'csv') {
    const parsed = Papa.parse<Record<string, unknown>>(content, {
      header: true,
      delimiter: ',',
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
    });
    if (parsed.errors.length > 0) {
      throw new Error(`CSV could not be read: ${parsed.errors[0]?.message ?? 'invalid row'}`);
    }
    rows = parsed.data;
  } else {
    throw new Error('Choose a .csv or .json feedback file.');
  }

  // Row position distinguishes identical comments in one export; the dataset hash
  // keeps IDs stable if the same export is renamed before it is imported again.
  const batchHash = sha256Text(content);
  const result = rows.flatMap((row, index) => {
    const text = readTextField(row);
    if (text === null) return [];
    const contentHash = sourceTextHash(text);
    if (utf8ToBytes(text).length > MAX_SOURCE_BYTES) {
      throw new Error(`Feedback row ${index + 1} exceeds the ${MAX_SOURCE_BYTES}-byte source limit.`);
    }
    return [{
      sourceId: `feedback:${sha256Text(`${batchHash}:${index + 1}`)}`,
      rowNumber: index + 1,
      contentHash,
      text,
      language: readDeclaredLanguage(row),
    }];
  });

  if (result.length === 0) {
    throw new Error('No non-empty feedback text was found. Use a feedback, text, comment, review, message, or notes column.');
  }
  return result;
}
