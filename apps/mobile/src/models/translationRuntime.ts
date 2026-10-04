import { File } from 'expo-file-system';
import { AppState, Platform } from 'react-native';
import { createSentencePieceTokenizer } from './sentencePiece';
import { numberGuard } from './numberGuard';
import {
  getInstalledTranslationBundle,
  getTranslationArtifactUri,
  readTranslationArtifact,
  verifyTranslationBundle,
  type InstalledTranslationBundle,
} from './translationBundle';
import { TRANSLATION_MODEL, TRANSLATION_MODEL_BYTES } from './translationManifest';

type OrtModule = typeof import('onnxruntime-react-native');
type OrtSession = import('onnxruntime-react-native').InferenceSession;
type OrtTensor = import('onnxruntime-react-native').Tensor;

export type TranslationMeasurement = {
  translation: string | null;
  reason: 'ok' | 'number_guard' | 'empty_output' | 'unknown_token' | 'model_missing' | 'source_too_long';
  modelId: string;
  modelBytes: number;
  runtimeVersion: string;
  platform: string;
  loadMs: number;
  inferenceElapsedMs: number;
  sourceTokens: number;
  outputTokens: number;
  cpuThreads: number;
};

type LoadedRuntime = {
  bundleUri: string;
  ort: OrtModule;
  encoder: OrtSession;
  decoder: OrtSession;
  tokenizer: ReturnType<typeof createSentencePieceTokenizer>;
  pieceById: Map<number, string>;
  loadMs: number;
};

const CPU_THREADS = 4;
const SESSION_OPTIONS = {
  executionProviders: ['cpu'] as const,
  intraOpNumThreads: CPU_THREADS,
  interOpNumThreads: 1,
  executionMode: 'sequential' as const,
  graphOptimizationLevel: 'all' as const,
};

let loadedRuntime: LoadedRuntime | null = null;
let loadingRuntime: Promise<LoadedRuntime> | null = null;
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let appIsActive = AppState.currentState !== 'background';
let activeTranslations = 0;
let releaseWhenIdle = false;
let lifecycleSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

function ensureLifecycleListener(): void {
  if (lifecycleSubscription) return;
  lifecycleSubscription = AppState.addEventListener('change', (state) => {
    appIsActive = state === 'active';
    if (!appIsActive && activeTranslations === 0) void releaseTranslationRuntime();
  });
}

function scheduleRuntimeRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (activeTranslations > 0) return;
  if (!appIsActive || releaseWhenIdle) {
    void releaseTranslationRuntime();
    return;
  }
  releaseTimer = setTimeout(() => void releaseTranslationRuntime(), 60_000);
}

function createInt64Tensor(ort: OrtModule, numbers: readonly number[], dims: readonly number[]): OrtTensor {
  const data = new BigInt64Array(numbers.length);
  for (let index = 0; index < numbers.length; index++) data[index] = BigInt(numbers[index]);
  return new ort.Tensor('int64', data, dims);
}

function createFloatTensor(ort: OrtModule, data: Float32Array, dims: readonly number[]): OrtTensor {
  return new ort.Tensor('float32', data, dims);
}

function createBoolTensor(ort: OrtModule, value: boolean): OrtTensor {
  return new ort.Tensor('bool', [value], [1]);
}

function asTensor(value: unknown, name: string): OrtTensor {
  if (typeof value !== 'object' || value === null || !('data' in value) || !('dims' in value)) {
    throw new Error(`ONNX model output ${name} is not a tensor.`);
  }
  return value as OrtTensor;
}

async function loadRuntime(bundle: InstalledTranslationBundle): Promise<LoadedRuntime> {
  const loadStart = Date.now();
  await verifyTranslationBundle(bundle);
  const [spmBytes, vocabText, generationText] = await Promise.all([
    readTranslationArtifact(bundle, 'source.spm'),
    new File(getTranslationArtifactUri(bundle, 'vocab.json')).text(),
    new File(getTranslationArtifactUri(bundle, 'generation_config.json')).text(),
  ]);
  const vocabularyValue: unknown = JSON.parse(vocabText);
  const generationValue: unknown = JSON.parse(generationText);
  if (typeof vocabularyValue !== 'object' || vocabularyValue === null || Array.isArray(vocabularyValue)) {
    throw new Error('The pinned translation vocabulary is not a JSON object.');
  }
  const vocabulary = vocabularyValue as Record<string, number>;
  if (
    typeof generationValue !== 'object' || generationValue === null || Array.isArray(generationValue) ||
    !('decoder_start_token_id' in generationValue) || generationValue.decoder_start_token_id !== TRANSLATION_MODEL.decoderStartTokenId ||
    !('eos_token_id' in generationValue) || generationValue.eos_token_id !== TRANSLATION_MODEL.endTokenId ||
    !('pad_token_id' in generationValue) || generationValue.pad_token_id !== TRANSLATION_MODEL.padTokenId
  ) throw new Error('The generation configuration token IDs do not match the pinned model.');

  const tokenizer = createSentencePieceTokenizer(spmBytes, vocabulary);
  const pieceById = new Map<number, string>();
  for (const [piece, id] of Object.entries(vocabulary)) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('The translation vocabulary contains an invalid token ID.');
    pieceById.set(id, piece);
  }

  const ort = await import('onnxruntime-react-native');
  const encoder = await ort.InferenceSession.create(getTranslationArtifactUri(bundle, 'encoder_model.onnx'), SESSION_OPTIONS);
  try {
    const decoder = await ort.InferenceSession.create(getTranslationArtifactUri(bundle, 'decoder_model_merged.onnx'), SESSION_OPTIONS);
    return {
      bundleUri: bundle.directoryUri,
      ort,
      encoder,
      decoder,
      tokenizer,
      pieceById,
      loadMs: Date.now() - loadStart,
    };
  } catch (error) {
    await encoder.release();
    throw error;
  }
}

async function getRuntime(bundle: InstalledTranslationBundle): Promise<LoadedRuntime> {
  if (loadedRuntime?.bundleUri === bundle.directoryUri) return loadedRuntime;
  if (loadingRuntime) return loadingRuntime;
  loadingRuntime = (async () => {
    if (loadedRuntime) {
      await Promise.all([loadedRuntime.encoder.release(), loadedRuntime.decoder.release()]);
      loadedRuntime = null;
    }
    const loaded = await loadRuntime(bundle);
    loadedRuntime = loaded;
    return loaded;
  })();
  try {
    return await loadingRuntime;
  } finally {
    loadingRuntime = null;
  }
}

function tensorValue(outputs: Record<string, unknown>, name: string): OrtTensor {
  const value = outputs[name];
  if (value === undefined) throw new Error(`ONNX model did not return ${name}.`);
  return asTensor(value, name);
}

function tensorData(tensor: OrtTensor): ArrayLike<number | bigint> {
  return tensor.data as ArrayLike<number | bigint>;
}

async function translate(runtime: LoadedRuntime, source: string): Promise<{ text: string; sourceTokens: number; outputTokens: number; containsUnknownToken: boolean }> {
  const inputIds = runtime.tokenizer.encode(source);
  if (inputIds.length > TRANSLATION_MODEL.maxSourceTokens) throw new RangeError('SOURCE_TOKEN_LIMIT');
  const mask = inputIds.map(() => 1);
  const encoderOutputs = await runtime.encoder.run({
    input_ids: createInt64Tensor(runtime.ort, inputIds, [1, inputIds.length]),
    attention_mask: createInt64Tensor(runtime.ort, mask, [1, mask.length]),
  });
  const hidden = tensorValue(encoderOutputs as Record<string, unknown>, 'last_hidden_state');
  const pastInputs = runtime.decoder.inputNames.filter((name) => name.startsWith('past_key_values.'));
  const past = new Map<string, OrtTensor>();
  for (const name of pastInputs) past.set(name, createFloatTensor(runtime.ort, new Float32Array(0), [1, 8, 0, 64]));
  const encoderMask = createInt64Tensor(runtime.ort, mask, [1, mask.length]);
  let token: number = TRANSLATION_MODEL.decoderStartTokenId;
  const generated: number[] = [];

  for (let step = 0; step < TRANSLATION_MODEL.maxOutputTokens; step++) {
    const feeds: Record<string, OrtTensor> = {
      input_ids: createInt64Tensor(runtime.ort, [token], [1, 1]),
      encoder_hidden_states: hidden,
      encoder_attention_mask: encoderMask,
      use_cache_branch: createBoolTensor(runtime.ort, step > 0),
    };
    for (const [name, value] of past) feeds[name] = value;

    const decoderOutputs = await runtime.decoder.run(feeds);
    const logits = tensorValue(decoderOutputs as Record<string, unknown>, 'logits');
    const scores = tensorData(logits) as ArrayLike<number>;
    if (scores.length < 58_950) throw new Error('ONNX decoder logits have an unexpected vocabulary dimension.');
    let bestId = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let id = 0; id < scores.length; id++) {
      if (id === TRANSLATION_MODEL.padTokenId) continue;
      const score = Number(scores[id]);
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    }
    if (bestId < 0 || !Number.isFinite(bestScore)) throw new Error('ONNX decoder returned no usable token.');
    if (bestId === TRANSLATION_MODEL.endTokenId) break;
    generated.push(bestId);
    token = bestId;

    for (const name of pastInputs) {
      if (step > 0 && !name.includes('.decoder.')) continue;
      const presentName = name.replace('past_key_values.', 'present.');
      past.set(name, tensorValue(decoderOutputs as Record<string, unknown>, presentName));
    }
  }

  const outputPieces = generated.map((id) => runtime.pieceById.get(id) ?? '<unk>');
  return {
    text: outputPieces.join('').replace(/▁/g, ' ').trim(),
    containsUnknownToken: generated.includes(TRANSLATION_MODEL.unknownTokenId),
    sourceTokens: inputIds.length,
    outputTokens: generated.length,
  };
}

/**
 * Returns an ephemeral, display-only machine translation. It never writes to the
 * evidence database, Core, approvals, queues, or any outbound transport.
 */
export async function translateEnglishForDisplay(source: string): Promise<TranslationMeasurement> {
  ensureLifecycleListener();
  const installed = await getInstalledTranslationBundle();
  if (!installed) {
    return {
      translation: null,
      reason: 'model_missing',
      modelId: TRANSLATION_MODEL.id,
      modelBytes: TRANSLATION_MODEL_BYTES,
      runtimeVersion: TRANSLATION_MODEL.runtimeVersion,
      platform: Platform.OS,
      loadMs: 0,
      inferenceElapsedMs: 0,
      sourceTokens: 0,
      outputTokens: 0,
      cpuThreads: CPU_THREADS,
    };
  }

  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  activeTranslations++;
  releaseWhenIdle = false;
  try {
    const runtime = await getRuntime(installed);
    const loadMs = runtime.loadMs;
    const inferenceStart = Date.now();
    let result: { text: string; sourceTokens: number; outputTokens: number; containsUnknownToken: boolean };
    try {
      result = await translate(runtime, source);
    } catch (error) {
      if (error instanceof RangeError && error.message === 'SOURCE_TOKEN_LIMIT') {
        return {
          translation: null,
          reason: 'source_too_long',
          modelId: TRANSLATION_MODEL.id,
          modelBytes: TRANSLATION_MODEL_BYTES,
          runtimeVersion: TRANSLATION_MODEL.runtimeVersion,
          platform: Platform.OS,
          loadMs,
          inferenceElapsedMs: Date.now() - inferenceStart,
          sourceTokens: 0,
          outputTokens: 0,
          cpuThreads: CPU_THREADS,
        };
      }
      throw error;
    }

    let reason: TranslationMeasurement['reason'] = 'empty_output';
    let value: string | null = null;
    if (result.containsUnknownToken) reason = 'unknown_token';
    else if (result.text.length > 0 && !numberGuard(source, result.text)) reason = 'number_guard';
    else if (result.text.length > 0) {
      reason = 'ok';
      value = result.text;
    }
    return {
      translation: value,
      reason,
      modelId: TRANSLATION_MODEL.id,
      modelBytes: TRANSLATION_MODEL_BYTES,
      runtimeVersion: TRANSLATION_MODEL.runtimeVersion,
      platform: Platform.OS,
      loadMs,
      inferenceElapsedMs: Date.now() - inferenceStart,
      sourceTokens: result.sourceTokens,
      outputTokens: result.outputTokens,
      cpuThreads: CPU_THREADS,
    };
  } finally {
    activeTranslations--;
    if (activeTranslations === 0) scheduleRuntimeRelease();
  }
}

export async function releaseTranslationRuntime(): Promise<void> {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = null;
  if (activeTranslations > 0) {
    releaseWhenIdle = true;
    return;
  }
  releaseWhenIdle = false;
  if (!loadedRuntime) return;
  const current = loadedRuntime;
  loadedRuntime = null;
  await Promise.all([current.encoder.release(), current.decoder.release()]);
}
