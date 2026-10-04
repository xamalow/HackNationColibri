import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { bytesToHex, newSha256, sha256Text } from '../crypto/hash';
import { getSecureDatabase } from '../storage/secureDatabase';
import { TRANSLATION_BUNDLE_SHA256, TRANSLATION_MODEL, TRANSLATION_MODEL_BYTES } from './translationManifest';

export type InstalledTranslationBundle = {
  modelId: string;
  directoryUri: string;
  bytes: number;
  sha256: string;
  installedAt: string;
};

const BUNDLE_SHA256 = sha256Text(TRANSLATION_BUNDLE_SHA256);
const verifiedDirectories = new Set<string>();

function formatMiB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function fileFor(directory: Directory, fileName: string): File {
  return new File(directory, fileName);
}

export async function getInstalledTranslationBundle(): Promise<InstalledTranslationBundle | null> {
  const db = await getSecureDatabase();
  const row = db.executeSync(
    'SELECT model_id, file_uri, file_bytes, sha256, installed_at FROM installed_models WHERE model_id = ?;',
    [TRANSLATION_MODEL.id],
  ).rows[0];
  if (
    row?.model_id !== TRANSLATION_MODEL.id || typeof row.file_uri !== 'string' ||
    typeof row.file_bytes !== 'number' || typeof row.sha256 !== 'string' || typeof row.installed_at !== 'string' ||
    row.file_bytes !== TRANSLATION_MODEL_BYTES || row.sha256 !== BUNDLE_SHA256
  ) return null;

  const directory = new Directory(row.file_uri);
  if (!directory.exists) return null;
  for (const artifact of TRANSLATION_MODEL.artifacts) {
    const file = fileFor(directory, artifact.fileName);
    if (!file.exists || file.size !== artifact.bytes) return null;
  }
  return {
    modelId: row.model_id,
    directoryUri: directory.uri,
    bytes: row.file_bytes,
    sha256: row.sha256,
    installedAt: row.installed_at,
  };
}

async function copyAndVerify(sourceUri: string, destination: File, expectedBytes: number, expectedHash: string): Promise<void> {
  const source = new File(sourceUri);
  if (source.size !== expectedBytes) throw new Error(`${destination.name} must be ${expectedBytes.toLocaleString()} bytes.`);
  const input = source.open(FileMode.ReadOnly);
  const output = destination.open(FileMode.WriteOnly);
  const digest = newSha256();
  let bytes = 0;
  try {
    while (true) {
      const chunk = input.readBytes(1024 * 1024);
      if (chunk.length === 0) break;
      digest.update(chunk);
      output.writeBytes(chunk);
      bytes += chunk.length;
      if (bytes % (16 * 1024 * 1024) < chunk.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    input.close();
    output.close();
  }
  const actualHash = bytesToHex(digest.digest());
  if (bytes !== expectedBytes || actualHash !== expectedHash) {
    throw new Error(`${destination.name} failed SHA-256 verification; the existing translation bundle was left unchanged.`);
  }
}

export async function importTranslationBundle(assets: readonly DocumentPicker.DocumentPickerAsset[]): Promise<InstalledTranslationBundle> {
  const byName = new Map<string, DocumentPicker.DocumentPickerAsset>();
  for (const asset of assets) {
    const fileName = asset.name.split(/[\\/]/).at(-1) ?? '';
    if (!TRANSLATION_MODEL.artifacts.some((artifact) => artifact.fileName === fileName)) continue;
    if (byName.has(fileName)) throw new Error(`Select only one ${fileName} file.`);
    byName.set(fileName, asset);
  }
  const missing = TRANSLATION_MODEL.artifacts.filter((artifact) => !byName.has(artifact.fileName));
  if (missing.length > 0) throw new Error(`Select all five files together, including: ${missing.map((item) => item.fileName).join(', ')}.`);
  for (const artifact of TRANSLATION_MODEL.artifacts) {
    const asset = byName.get(artifact.fileName);
    if (asset && typeof asset.size === 'number' && asset.size !== artifact.bytes) {
      throw new Error(`${artifact.fileName} has the wrong size (${asset.size.toLocaleString()} bytes).`);
    }
  }

  const copyAndInstallBytes = TRANSLATION_MODEL_BYTES * 2 + 32 * 1024 * 1024;
  if (Paths.availableDiskSpace < copyAndInstallBytes) {
    throw new Error(`Free at least ${formatMiB(copyAndInstallBytes)} MiB to stage and install this ${formatMiB(TRANSLATION_MODEL_BYTES)} MiB model bundle.`);
  }

  const modelsDirectory = new Directory(Paths.document, 'models');
  if (!modelsDirectory.exists) modelsDirectory.create({ intermediates: true, idempotent: true });
  const nonce = Crypto.randomUUID();
  const stagingDirectory = new Directory(modelsDirectory, `${TRANSLATION_MODEL.id}-${nonce}.staging`);
  const finalDirectory = new Directory(modelsDirectory, `${TRANSLATION_MODEL.id}-${nonce}`);
  stagingDirectory.create({ intermediates: true });
  let finalMoved = false;

  try {
    for (const artifact of TRANSLATION_MODEL.artifacts) {
      const asset = byName.get(artifact.fileName);
      if (!asset) throw new Error(`The selected ${artifact.fileName} file disappeared.`);
      const destination = fileFor(stagingDirectory, artifact.fileName);
      destination.create({ intermediates: true });
      await copyAndVerify(asset.uri, destination, artifact.bytes, artifact.sha256);
    }

    await stagingDirectory.move(finalDirectory);
    finalMoved = true;
    const installedAt = new Date().toISOString();
    const db = await getSecureDatabase();
    await db.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO installed_models(model_id, file_uri, file_bytes, sha256, installed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET file_uri = excluded.file_uri, file_bytes = excluded.file_bytes,
           sha256 = excluded.sha256, installed_at = excluded.installed_at;`,
        [TRANSLATION_MODEL.id, finalDirectory.uri, TRANSLATION_MODEL_BYTES, BUNDLE_SHA256, installedAt],
      );
    });
    finalMoved = false;
    const bundle = { modelId: TRANSLATION_MODEL.id, directoryUri: finalDirectory.uri, bytes: TRANSLATION_MODEL_BYTES, sha256: BUNDLE_SHA256, installedAt };
    verifiedDirectories.add(bundle.directoryUri);
    return bundle;
  } finally {
    if (stagingDirectory.exists) stagingDirectory.delete();
    if (finalMoved && finalDirectory.exists) finalDirectory.delete();
  }
}

export async function pickAndImportTranslationBundle(): Promise<InstalledTranslationBundle | null> {
  const installed = await getInstalledTranslationBundle();
  if (installed) {
    try {
      await verifyTranslationBundle(installed);
      return installed;
    } catch {
      // A damaged installation remains active until a complete replacement is verified
      // and its database pointer commits successfully.
    }
  }
  const pickerAndInstallBytes = TRANSLATION_MODEL_BYTES * 2 + 32 * 1024 * 1024;
  if (Paths.availableDiskSpace < pickerAndInstallBytes) {
    throw new Error(`Free at least ${formatMiB(pickerAndInstallBytes)} MiB before choosing the five model files.`);
  }
  const selection = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: true,
  });
  if (selection.canceled) return null;
  const cacheRoot = Paths.cache.uri.endsWith('/') ? Paths.cache.uri : `${Paths.cache.uri}/`;
  const pickerCopies = selection.assets.flatMap((asset) => asset.uri.startsWith(cacheRoot) ? [new File(asset.uri)] : []);
  try {
    return await importTranslationBundle(selection.assets);
  } finally {
    for (const copy of pickerCopies) if (copy.exists) copy.delete();
  }
}

export async function readTranslationArtifact(bundle: InstalledTranslationBundle, fileName: string): Promise<Uint8Array> {
  const artifact = TRANSLATION_MODEL.artifacts.find((item) => item.fileName === fileName);
  if (!artifact) throw new Error('The requested translation artifact is not part of the pinned bundle.');
  const file = fileFor(new Directory(bundle.directoryUri), artifact.fileName);
  if (!file.exists || file.size !== artifact.bytes) throw new Error(`${artifact.fileName} is missing or has the wrong size.`);
  const input = file.open(FileMode.ReadOnly);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = input.readBytes(1024 * 1024);
      if (chunk.length === 0) break;
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    input.close();
  }
  if (total !== artifact.bytes) throw new Error(`${artifact.fileName} changed while it was being read.`);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function verifyTranslationBundle(bundle: InstalledTranslationBundle): Promise<void> {
  if (verifiedDirectories.has(bundle.directoryUri)) return;
  const directory = new Directory(bundle.directoryUri);
  for (const artifact of TRANSLATION_MODEL.artifacts) {
    const file = fileFor(directory, artifact.fileName);
    if (!file.exists || file.size !== artifact.bytes) throw new Error(`${artifact.fileName} is missing or has the wrong size.`);
    const input = file.open(FileMode.ReadOnly);
    const digest = newSha256();
    let bytes = 0;
    try {
      while (true) {
        const chunk = input.readBytes(1024 * 1024);
        if (chunk.length === 0) break;
        digest.update(chunk);
        bytes += chunk.length;
        if (bytes % (32 * 1024 * 1024) < chunk.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      input.close();
    }
    if (bytes !== artifact.bytes || bytesToHex(digest.digest()) !== artifact.sha256) {
      throw new Error(`${artifact.fileName} failed its pinned SHA-256 check; re-import the translation bundle.`);
    }
  }
  verifiedDirectories.add(bundle.directoryUri);
}

export function getTranslationArtifactUri(bundle: InstalledTranslationBundle, fileName: string): string {
  if (!TRANSLATION_MODEL.artifacts.some((item) => item.fileName === fileName)) throw new Error('Unknown translation artifact.');
  return fileFor(new Directory(bundle.directoryUri), fileName).uri;
}
