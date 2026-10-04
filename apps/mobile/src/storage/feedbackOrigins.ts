import type { FeedbackOriginKind } from '../domain/types';

type OriginSqlExecutor = {
  execute(
    query: string,
    params?: (string | number | null)[],
  ): Promise<{ rowsAffected: number; rows: unknown[] }>;
};

const LEGACY_ORIGIN_KEY = 'legacy-pre-origin-v1';

/** Create the origin ledger and conservatively mark every pre-ledger row as unknown. */
export async function ensureFeedbackOriginSchema(tx: OriginSqlExecutor): Promise<void> {
  await tx.execute(`
    CREATE TABLE IF NOT EXISTS feedback_source_origins (
      source_id TEXT NOT NULL REFERENCES feedback_sources(source_id) ON DELETE CASCADE,
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('imported', 'synthetic_demo', 'legacy_unknown')),
      origin_key TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY(source_id, origin_kind, origin_key)
    );
  `);
  await tx.execute(`
    INSERT OR IGNORE INTO feedback_source_origins (source_id, origin_kind, origin_key, added_at)
    SELECT source_id, 'legacy_unknown', ?, imported_at
    FROM feedback_sources
    WHERE NOT EXISTS (
      SELECT 1 FROM feedback_source_origins origins WHERE origins.source_id = feedback_sources.source_id
    );
  `, [LEGACY_ORIGIN_KEY]);
}

/** Add an origin even when the content-addressed feedback source already exists. */
export async function addFeedbackSourceOrigin(
  tx: OriginSqlExecutor,
  sourceId: string,
  originKind: Exclude<FeedbackOriginKind, 'legacy_unknown'>,
  originKey: string,
  addedAt: string,
): Promise<void> {
  await tx.execute(
    `INSERT OR IGNORE INTO feedback_source_origins (source_id, origin_kind, origin_key, added_at)
     VALUES (?, ?, ?, ?);`,
    [sourceId, originKind, originKey, addedAt],
  );
}

/** A demo label is safe only when no import or unknown legacy origin shares these rows. */
export function isSyntheticDemoOnly(origins: readonly FeedbackOriginKind[]): boolean {
  return origins.length === 1 && origins[0] === 'synthetic_demo';
}
