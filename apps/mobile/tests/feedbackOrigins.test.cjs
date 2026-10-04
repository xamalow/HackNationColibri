const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  addFeedbackSourceOrigin,
  ensureFeedbackOriginSchema,
  isSyntheticDemoOnly,
} = require('../.test-dist/storage/feedbackOrigins.js');

function makeExecutor(db) {
  return {
    async execute(query, params = []) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)\b/i.test(query)) {
        return { rows: statement.all(...params), rowsAffected: 0 };
      }
      const result = statement.run(...params);
      return { rows: [], rowsAffected: Number(result.changes) };
    },
  };
}

function makeLegacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE feedback_sources (
      source_id TEXT PRIMARY KEY NOT NULL,
      file_name TEXT NOT NULL,
      row_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      source_text TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'und',
      imported_at TEXT NOT NULL
    );
    INSERT INTO feedback_sources VALUES
      ('legacy-demo-name', 'sauti-demo-feedback.csv', 1, 'hash-1', 'owner selected this filename', 'sw', '2026-10-04T00:00:00Z');
  `);
  return db;
}

test('legacy filenames never prove demo origin and migration is idempotent', async () => {
  const db = makeLegacyDb();
  const tx = makeExecutor(db);
  await ensureFeedbackOriginSchema(tx);
  await ensureFeedbackOriginSchema(tx);
  const rows = db.prepare('SELECT origin_kind, origin_key FROM feedback_source_origins WHERE source_id = ?;').all('legacy-demo-name');
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ origin_kind: 'legacy_unknown', origin_key: 'legacy-pre-origin-v1' }]);
  assert.equal(isSyntheticDemoOnly(rows.map((row) => row.origin_kind)), false);
  db.close();
});

test('duplicate demo and picked-file imports retain both origins in either order', async () => {
  for (const order of [
    ['synthetic_demo', 'imported'],
    ['imported', 'synthetic_demo'],
  ]) {
    const db = makeLegacyDb();
    const tx = makeExecutor(db);
    await ensureFeedbackOriginSchema(tx);
    db.prepare('DELETE FROM feedback_sources WHERE source_id = ?;').run('legacy-demo-name');
    db.prepare(`INSERT INTO feedback_sources VALUES (?, ?, ?, ?, ?, ?, ?);`)
      .run('shared-row', 'sauti-demo-feedback.csv', 1, 'hash-2', 'shared feedback', 'sw', '2026-10-04T00:00:00Z');
    for (const kind of order) {
      await addFeedbackSourceOrigin(tx, 'shared-row', kind, 'same-dataset-hash', '2026-10-04T00:01:00Z');
    }
    await addFeedbackSourceOrigin(tx, 'shared-row', order[0], 'same-dataset-hash', '2026-10-04T00:02:00Z');
    const origins = db.prepare('SELECT origin_kind FROM feedback_source_origins WHERE source_id = ? ORDER BY origin_kind;').all('shared-row');
    assert.deepEqual(origins.map((row) => row.origin_kind), ['imported', 'synthetic_demo']);
    assert.equal(isSyntheticDemoOnly(origins.map((row) => row.origin_kind)), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM feedback_sources WHERE source_id = ?;').get('shared-row').count, 1);
    db.close();
  }
});

test('only a synthetic-demo-only source receives the synthetic label', () => {
  assert.equal(isSyntheticDemoOnly(['synthetic_demo']), true);
  assert.equal(isSyntheticDemoOnly(['synthetic_demo', 'imported']), false);
  assert.equal(isSyntheticDemoOnly(['legacy_unknown']), false);
  assert.equal(isSyntheticDemoOnly([]), false);
});
