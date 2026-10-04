import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { ensureFeedbackOriginSchema } from './feedbackOrigins';

const KEY_ALIAS = 'sauti-host.sqlcipher.key.v1';
const DATABASE_NAME = 'sauti-host.sqlite';

type NativeDb = import('@op-engineering/op-sqlite').DB;
let databasePromise: Promise<NativeDb> | null = null;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateDatabaseKey(): Promise<string> {
  if (!(await SecureStore.isAvailableAsync())) {
    throw new Error('Secure device storage is unavailable; encrypted storage was not opened.');
  }

  const storedKey = await SecureStore.getItemAsync(KEY_ALIAS);
  if (storedKey) return storedKey;

  const generatedKey = toHex(await Crypto.getRandomBytesAsync(32));
  await SecureStore.setItemAsync(KEY_ALIAS, generatedKey, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return generatedKey;
}

async function createSecureDatabase(): Promise<NativeDb> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new Error('Sauti Host local storage requires an iOS or Android native build.');
  }

  const { open } = await import('@op-engineering/op-sqlite');
  const encryptionKey = await getOrCreateDatabaseKey();
  const db = open({ name: DATABASE_NAME, encryptionKey });

  try {
    const cipherVersion = db.executeSync('PRAGMA cipher_version;').rows[0]?.cipher_version;
    if (typeof cipherVersion !== 'string' || cipherVersion.length === 0) {
      throw new Error('SQLCipher is not active; refusing to use an unencrypted database.');
    }

    db.executeSync('PRAGMA foreign_keys = ON;');
    db.executeSync('PRAGMA journal_mode = WAL;');
    await db.transaction(async (tx) => {
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS feedback_sources (
          source_id TEXT PRIMARY KEY NOT NULL,
          file_name TEXT NOT NULL,
          row_number INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          source_text TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'und',
          imported_at TEXT NOT NULL
        );
      `);
      // integrity_ms is NULL when the model file was already verified earlier in this session
      // (e.g. at import). Older installs created it NOT NULL, which made every run fail to record.
      const runColumns = await tx.execute('PRAGMA table_info(model_runs);');
      const integrityColumn = runColumns.rows.find((column) => column.name === 'integrity_ms');
      if (integrityColumn && Number(integrityColumn.notnull) === 1) {
        await tx.execute('ALTER TABLE model_runs RENAME TO model_runs_v1;');
        await tx.execute(`
          CREATE TABLE model_runs (
            run_id TEXT PRIMARY KEY NOT NULL,
            model_id TEXT NOT NULL,
            prompt_hash TEXT NOT NULL,
            response_text TEXT NOT NULL,
            model_bytes INTEGER NOT NULL,
            runtime_version TEXT NOT NULL,
            load_ms REAL,
            integrity_ms REAL,
            elapsed_ms REAL NOT NULL,
            prompt_ms REAL NOT NULL,
            generation_ms REAL NOT NULL,
            tokens_per_second REAL NOT NULL,
            platform TEXT NOT NULL,
            n_ctx INTEGER NOT NULL,
            n_threads INTEGER NOT NULL,
            n_gpu_layers INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
        await tx.execute('INSERT INTO model_runs SELECT * FROM model_runs_v1;');
        await tx.execute('DROP TABLE model_runs_v1;');
      }
      const feedbackColumns = await tx.execute('PRAGMA table_info(feedback_sources);');
      if (!feedbackColumns.rows.some((column) => column.name === 'language')) {
        await tx.execute("ALTER TABLE feedback_sources ADD COLUMN language TEXT NOT NULL DEFAULT 'und';");
      }
      // A filename cannot establish origin. Legacy rows are unknown; new imports append origin records.
      await ensureFeedbackOriginSchema(tx);
      await tx.execute('CREATE INDEX IF NOT EXISTS feedback_imported_at ON feedback_sources(imported_at);');
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS app_meta (
          meta_key TEXT PRIMARY KEY NOT NULL,
          meta_value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS installed_models (
          model_id TEXT PRIMARY KEY NOT NULL,
          file_uri TEXT NOT NULL,
          file_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          installed_at TEXT NOT NULL
        );
      `);
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS model_runs (
          run_id TEXT PRIMARY KEY NOT NULL,
          model_id TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          response_text TEXT NOT NULL,
          model_bytes INTEGER NOT NULL,
          runtime_version TEXT NOT NULL,
          load_ms REAL,
          integrity_ms REAL,
          elapsed_ms REAL NOT NULL,
          prompt_ms REAL NOT NULL,
          generation_ms REAL NOT NULL,
          tokens_per_second REAL NOT NULL,
          platform TEXT NOT NULL,
          n_ctx INTEGER NOT NULL,
          n_threads INTEGER NOT NULL,
          n_gpu_layers INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function getSecureDatabase(): Promise<NativeDb> {
  if (!databasePromise) {
    databasePromise = createSecureDatabase();
    void databasePromise.catch(() => {
      databasePromise = null;
    });
  }
  return databasePromise;
}

export async function getSqlCipherVersion(): Promise<string> {
  const db = await getSecureDatabase();
  const version = db.executeSync('PRAGMA cipher_version;').rows[0]?.cipher_version;
  if (typeof version !== 'string' || !version) {
    throw new Error('SQLCipher verification failed.');
  }
  return version;
}

export async function recordRestartProbe(bootId: string): Promise<string> {
  const db = await getSecureDatabase();
  const marker = Crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO app_meta(meta_key, meta_value, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value, updated_at = excluded.updated_at;`,
      ['restart_probe', JSON.stringify({ marker, bootId }), new Date().toISOString()],
    );
  });
  return marker;
}

export async function readRestartProbe(): Promise<{ marker: string; bootId: string } | null> {
  const db = await getSecureDatabase();
  const row = db.executeSync('SELECT meta_value FROM app_meta WHERE meta_key = ?;', ['restart_probe']).rows[0];
  if (typeof row?.meta_value !== 'string') return null;
  try {
    const value: unknown = JSON.parse(row.meta_value);
    if (
      typeof value === 'object' && value !== null &&
      'marker' in value && typeof value.marker === 'string' &&
      'bootId' in value && typeof value.bootId === 'string'
    ) return { marker: value.marker, bootId: value.bootId };
  } catch {
    return null;
  }
  return null;
}
