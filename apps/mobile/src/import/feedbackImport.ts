import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { utf8ToBytes } from '@noble/hashes/utils';
import type { FeedbackOriginKind, FeedbackSource } from '../domain/types';
import { sha256Text } from '../crypto/hash';
import { parseFeedbackFile } from './parseFeedback';
import { getSecureDatabase } from '../storage/secureDatabase';
import { addFeedbackSourceOrigin } from '../storage/feedbackOrigins';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

export async function pickAndImportFeedback(): Promise<{ imported: number; skipped: number }> {
  const selection = await DocumentPicker.getDocumentAsync({
    type: ['text/csv', 'application/json'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (selection.canceled) return { imported: 0, skipped: 0 };

  const asset = selection.assets[0];
  if (!asset) throw new Error('No file was selected.');
  const cacheRoot = Paths.cache.uri.endsWith('/') ? Paths.cache.uri : `${Paths.cache.uri}/`;
  const cacheCopy = asset.uri.startsWith(cacheRoot) ? new File(asset.uri) : null;
  try {
    if (typeof asset.size === 'number' && asset.size > MAX_IMPORT_BYTES) {
      throw new Error('Feedback imports are limited to 25 MB.');
    }
    const content = await new File(asset.uri).text();
    if (utf8ToBytes(content).length > MAX_IMPORT_BYTES) {
      throw new Error('Feedback imports are limited to 25 MB.');
    }
    return await importFeedbackContent(asset.name, content, 'imported');
  } finally {
    // DocumentPicker created this copy because copyToCacheDirectory is true. Delete
    // only that path; never delete an original document selected from elsewhere.
    if (cacheCopy?.exists) cacheCopy.delete();
  }
}

/** Parse + store one CSV/JSON file's content. Re-importing the same rows is a no-op (INSERT OR IGNORE). */
export async function importFeedbackContent(
  fileName: string,
  content: string,
  originKind: Exclude<FeedbackOriginKind, 'legacy_unknown'>,
): Promise<{ imported: number; skipped: number }> {
  const parsed = parseFeedbackFile(fileName, content);
  const importedAt = new Date().toISOString();
  const originKey = sha256Text(content);
  const db = await getSecureDatabase();
  let imported = 0;
  await db.transaction(async (tx) => {
    for (const row of parsed) {
      const result = await tx.execute(
        `INSERT OR IGNORE INTO feedback_sources
           (source_id, file_name, row_number, content_hash, source_text, language, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?);`,
        [row.sourceId, fileName, row.rowNumber, row.contentHash, row.text, row.language, importedAt],
      );
      imported += result.rowsAffected;
      await addFeedbackSourceOrigin(tx, row.sourceId, originKind, originKey, importedAt);
    }
  });
  return { imported, skipped: parsed.length - imported };
}

/** The bundled SYNTHETIC demo reviews (src/demo/demoFeedback.ts). */
export async function loadDemoFeedback(): Promise<{ imported: number; skipped: number }> {
  const { DEMO_FEEDBACK_CSV, DEMO_FEEDBACK_FILE } = await import('../demo/demoFeedback');
  return importFeedbackContent(DEMO_FEEDBACK_FILE, DEMO_FEEDBACK_CSV, 'synthetic_demo');
}

export async function listFeedbackSources(limit = 100): Promise<FeedbackSource[]> {
  const db = await getSecureDatabase();
  const rows = db.executeSync(
    `SELECT source_id, file_name, row_number, content_hash, source_text, language, imported_at
     FROM feedback_sources ORDER BY imported_at DESC, row_number DESC, source_id DESC LIMIT ?;`,
    [limit],
  ).rows;
  const origins = rows.length === 0 ? [] : db.executeSync(
    `SELECT source_id, origin_kind FROM feedback_source_origins
     WHERE source_id IN (
       SELECT source_id FROM feedback_sources ORDER BY imported_at DESC, row_number DESC, source_id DESC LIMIT ?
     );`,
    [limit],
  ).rows;
  const originsBySource = new Map<string, FeedbackSource['origins']>();
  for (const origin of origins) {
    if (
      typeof origin.source_id !== 'string' ||
      !['imported', 'synthetic_demo', 'legacy_unknown'].includes(String(origin.origin_kind))
    ) continue;
    const entries = originsBySource.get(origin.source_id) ?? [];
    const kind = origin.origin_kind as FeedbackSource['origins'][number];
    if (!entries.includes(kind)) entries.push(kind);
    originsBySource.set(origin.source_id, entries);
  }
  return rows.flatMap((row) => {
    if (
      typeof row.source_id !== 'string' || typeof row.file_name !== 'string' ||
      typeof row.row_number !== 'number' || typeof row.content_hash !== 'string' ||
      typeof row.source_text !== 'string' || typeof row.language !== 'string' || typeof row.imported_at !== 'string'
    ) return [];
    return [{
      sourceId: row.source_id,
      fileName: row.file_name,
      rowNumber: row.row_number,
      contentHash: row.content_hash,
      text: row.source_text,
      language: row.language,
      importedAt: row.imported_at,
      origins: originsBySource.get(row.source_id) ?? ['legacy_unknown'],
    }];
  });
}

export async function setFeedbackLanguage(sourceId: string, language: 'sw' | 'en' | 'de' | 'fr' | 'und'): Promise<void> {
  const db = await getSecureDatabase();
  await db.transaction(async (tx) => {
    const result = await tx.execute('UPDATE feedback_sources SET language = ? WHERE source_id = ?;', [language, sourceId]);
    if (result.rowsAffected !== 1) throw new Error('The source record was not found; its language was not changed.');
  });
}

export async function countFeedbackSources(): Promise<number> {
  const db = await getSecureDatabase();
  const row = db.executeSync('SELECT COUNT(*) AS count FROM feedback_sources;').rows[0];
  return typeof row?.count === 'number' ? row.count : 0;
}
