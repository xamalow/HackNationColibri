import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { initLlama, type LlamaContext } from 'llama.rn';
import { bytesToHex, newSha256 } from '../crypto/hash';

/**
 * Gemma 4 E4B (Carter #47612): Apache-2.0, ggml-org/gemma-4-E4B-it-GGUF @ b809346922.
 * Side-loaded over USB into the app container (Documents/models/gemma/) with `xcrun devicectl device copy to`,
 * so the 4.6 GB file is never stored twice. Full SHA-256 values are from the desktop download; on the phone we
 * check the exact byte size plus a SAMPLED hash (64 x 1 MiB evenly spaced, first and last block included),
 * because a full SHA-256 of 4.6 GB in JS takes ~35 min on an iPhone 15 Pro. Stated as a limit in the evidence.
 */
type Variant = {
  id: string;
  label: string;
  license: string;
  source: string;
  revision: string;
  model: { fileName: string; bytes: number; sha256: string; sampledSha256: string };
  mmproj?: { fileName: string; bytes: number; sha256: string; sampledSha256: string };
};

/**
 * On-device variants, best first by what fits. The demo iPhone has ~3.7 GB usable, so it runs E2B
 * (Google's QAT mobile weights, quantized to UD-Q2_K_XL by unsloth, a THIRD-PARTY quant); E4B (Carter's choice)
 * runs on the hub GPU and on any phone with room. Full SHA-256 values match the Hugging Face API and the desktop
 * download (checked on the Mac before the USB side-load); on the phone: exact size + sampled hash only (a full
 * hash of GBs in JS takes 15-35 min). Known compromise, stated in docs/mobile/DEVICE_EVIDENCE.md.
 */
export const VARIANTS: readonly Variant[] = [
  {
    id: 'gemma4-e2b-qat-ud-q2_k_xl',
    label: 'Gemma 4 E2B (QAT mobile, UD-Q2_K_XL)',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/unsloth/gemma-4-E2B-it-qat-mobile-GGUF',
    revision: '46af839dc23aceb4b965ab640dae7fc1bea39bba',
    model: {
      fileName: 'gemma-4-E2B-it-qat-UD-Q2_K_XL.gguf',
      bytes: 2_186_186_784,
      sha256: '0a5bbc20f91f92da96ab4870fa71b356c45b8500a7b8b9c3e0eb48359b72da28',
      sampledSha256: '13779affefae482d5a2c286a4ef13433173a76d23b955d323c6ef5b104983bea',
    },
  },
  {
    id: 'gemma4-e4b-q4_0',
    label: 'Gemma 4 E4B (Q4_0)',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF',
    revision: 'b809346922',
    model: {
      fileName: 'gemma-4-E4B-it-Q4_0.gguf',
      bytes: 4_590_807_392,
      sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
      sampledSha256: '85b8fed169c9d6f77da5cad47bc893274976412bc47e2e69dfbbeb5242ceed6a',
    },
    mmproj: {
      fileName: 'mmproj-gemma-4-E4B-it-Q8_0.gguf',
      bytes: 559_874_816,
      sha256: '197f49a93027f9843772bd24a6a9e0be2a32a788de5a3def330e9c585d86edd1',
      sampledSha256: '18cee1bcd299b30b143c1a5e328b9ef3ed2c4c411b25304f7a86b38e9c5b8d45',
    },
  },
];

/** The first variant whose model file is fully present (exact size). */
export function activeVariant(): Variant | null {
  for (const v of VARIANTS) {
    const f = new File(new Directory(Paths.document, 'models', 'gemma'), v.model.fileName);
    if (f.exists && f.size === v.model.bytes) return v;
  }
  return null;
}
export const GEMMA = VARIANTS[0];

const CHUNK = 1 << 20;
const SAMPLES = 64;

const gemmaDir = () => new Directory(Paths.document, 'models', 'gemma');
const fileOf = (name: string) => new File(gemmaDir(), name);

async function sampledSha256(file: File, size: number): Promise<string> {
  const handle = file.open(FileMode.ReadOnly);
  const digest = newSha256();
  try {
    for (let i = 0; i < SAMPLES; i += 1) {
      handle.offset = Math.floor((i * (size - CHUNK)) / (SAMPLES - 1));
      digest.update(handle.readBytes(CHUNK));
      if (i % 8 === 7) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    handle.close();
  }
  return bytesToHex(digest.digest());
}

export type GemmaCheck = { ok: true; ms: number; withAudio: boolean; label: string } | { ok: false; reason: string };

/** Exact size + sampled hash for the model (required) and the audio projector (optional). */
export async function verifyGemma(): Promise<GemmaCheck> {
  const started = Date.now();
  const v = activeVariant();
  if (!v) return { ok: false, reason: `no complete model in Documents/models/gemma (${VARIANTS.map((x) => x.model.fileName).join(' or ')})` };
  const model = fileOf(v.model.fileName);
  if ((await sampledSha256(model, v.model.bytes)) !== v.model.sampledSha256) return { ok: false, reason: `${v.label}: sampled hash mismatch` };
  let withAudio = false;
  if (v.mmproj) {
    const mmproj = fileOf(v.mmproj.fileName);
    if (mmproj.exists && mmproj.size === v.mmproj.bytes) {
      if ((await sampledSha256(mmproj, v.mmproj.bytes)) !== v.mmproj.sampledSha256) return { ok: false, reason: 'mmproj sampled hash mismatch' };
      withAudio = true;
    }
  }
  return { ok: true, ms: Date.now() - started, withAudio, label: v.label };
}

let ctx: LlamaContext | null = null;
let loadMs: number | null = null;

export async function loadGemma(): Promise<{ loadMs: number; reused: boolean }> {
  if (ctx) return { loadMs: loadMs ?? 0, reused: true };
  const started = Date.now();
  const v = activeVariant();
  if (!v) throw new Error('No Gemma model installed on this phone.');
  ctx = await initLlama({
    model: fileOf(v.model.fileName).uri,
    n_ctx: 2048,
    n_batch: 256,
    n_threads: 4,
    n_gpu_layers: 99,
  });
  loadMs = Date.now() - started;
  return { loadMs, reused: false };
}

export async function releaseGemma(): Promise<void> {
  if (ctx) await ctx.release();
  ctx = null;
  loadMs = null;
}

const digitsOf = (s: string): string[] => (s.match(/\d+(?:[.,:]\d+)*/g) ?? []).map((d) => d.replace(/[.,]/g, ''));

export type Translation =
  | { ok: true; text: string; ms: number; tokensPerSecond: number }
  | { ok: false; reason: 'empty' | 'number_changed' | 'too_long'; ms: number };

/**
 * Display-only machine translation of a visitor's ORIGINAL text into Swahili. Never stored as evidence, never
 * counted, never sent (the core only accepts exact slices of originals). Hidden when it adds or changes a number.
 */
export async function translateToSwahili(original: string): Promise<Translation> {
  await loadGemma();
  const started = Date.now();
  const result = await ctx!.completion({
    messages: [
      { role: 'system', content: 'You translate tourist reviews into Swahili (Kiswahili). Output only the translation. Keep every number exactly as written. Do not add anything.' },
      { role: 'user', content: original },
    ],
    n_predict: 256,
    temperature: 0,
    top_k: 1,
  });
  const ms = Date.now() - started;
  const text = result.text.replace(/<[^>]*>/g, '').trim();
  if (!text) return { ok: false, reason: 'empty', ms };
  if (text.length > original.length * 4 + 40) return { ok: false, reason: 'too_long', ms };
  const allowed = new Set(digitsOf(original));
  if (digitsOf(text).some((d) => !allowed.has(d))) return { ok: false, reason: 'number_changed', ms };
  return { ok: true, text, ms, tokensPerSecond: result.timings.predicted_per_second };
}
