import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { File, FileMode, Paths } from 'expo-file-system';

/**
 * Read a Swahili translation aloud with Chatterbox, then check the audio with Whisper. Both run on the hub PC
 * (apps/hub-voice expects the same OpenAI-compatible endpoints: Chatterbox at /v1/audio/speech as model "tts-1",
 * faster-whisper at /v1/audio/transcriptions). The phone reaches the hub over local Wi-Fi only: addresses that
 * are not private LAN hosts are refused, so no audio or text can go to a cloud service.
 * The check is a guard, not a score: Whisper must hear (almost) the same words, otherwise the audio is labelled
 * unreliable. Audio is display/listen only; never stored as evidence, never sent to anyone.
 */
export type HubConfig = { tts: string; stt: string };

const CONFIG_FILE = () => new File(Paths.document, 'voice-hub.json');
const TIMEOUT_MS = 60_000;
export const MATCH_THRESHOLD = 0.75;

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** "192.168.1.20:8001" or "http://192.168.1.20:8001/v1" -> "http://192.168.1.20:8001/v1"; null if not a LAN host. */
export function normalizeBase(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const m = withScheme.match(/^(https?):\/\/([^/:]+)(:\d{1,5})?(\/.*)?$/i);
  if (!m || !isPrivateHost(m[2].toLowerCase())) return null;
  const path = (m[4] ?? '').replace(/\/+$/, '');
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ?? ''}${path.endsWith('/v1') ? path : `${path}/v1`}`;
}

export function readHubConfig(): HubConfig | null {
  try {
    const f = CONFIG_FILE();
    if (!f.exists || f.size === 0) return null;
    const h = f.open(FileMode.ReadOnly);
    const text = new TextDecoder().decode(h.readBytes(f.size));
    h.close();
    const parsed = JSON.parse(text) as Partial<HubConfig>;
    const tts = normalizeBase(String(parsed.tts ?? ''));
    const stt = normalizeBase(String(parsed.stt ?? ''));
    return tts && stt ? { tts, stt } : null;
  } catch {
    return null;
  }
}

export function saveHubConfig(ttsInput: string, sttInput: string): HubConfig | null {
  const tts = normalizeBase(ttsInput);
  const stt = normalizeBase(sttInput || ttsInput);
  if (!tts || !stt) return null;
  const f = CONFIG_FILE();
  if (f.exists) f.delete();
  f.create();
  const h = f.open(FileMode.ReadWrite);
  h.writeBytes(new TextEncoder().encode(JSON.stringify({ tts, stt })));
  h.close();
  return { tts, stt };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const words = (s: string): string[] =>
  s.toLowerCase().normalize('NFC').replace(/[.,!?;:"'“”‘’«»()[\]…\-–—]/g, ' ').split(/\s+/).filter(Boolean);

/** 1 - word-level edit distance / longer length. */
export function wordMatch(expected: string, heard: string): number {
  const a = words(expected);
  const b = words(heard);
  if (!a.length && !b.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

export type SpokenCheck = {
  ttsMs: number;
  sttMs: number;
  heard: string;
  match: number;
  ok: boolean;
};

let player: AudioPlayer | null = null;

/** Chatterbox -> play -> Whisper check. Throws a short message on any failure (shown to the user). */
export async function speakAndCheck(text: string, onPlaying?: () => void): Promise<SpokenCheck> {
  const cfg = readHubConfig();
  if (!cfg) throw new Error('hub_not_configured');

  const t0 = Date.now();
  const speech = await fetchWithTimeout(`${cfg.tts}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tts-1', voice: 'sauti', input: text, response_format: 'wav', language: 'sw' }),
  });
  if (!speech.ok) throw new Error(`Chatterbox HTTP ${speech.status}`);
  const audio = new Uint8Array(await speech.arrayBuffer());
  if (audio.length < 44) throw new Error('Chatterbox returned no audio');
  const ttsMs = Date.now() - t0;

  const file = new File(Paths.cache, `sauti-tts-${Date.now()}.wav`);
  file.create();
  const h = file.open(FileMode.ReadWrite);
  h.writeBytes(audio);
  h.close();

  await setAudioModeAsync({ playsInSilentMode: true });
  player?.remove();
  player = createAudioPlayer({ uri: file.uri });
  player.play();
  onPlaying?.();

  try {
    const t1 = Date.now();
    const form = new FormData();
    form.append('file', { uri: file.uri, name: 'speech.wav', type: 'audio/wav' } as unknown as Blob);
    form.append('model', 'whisper-1');
    form.append('language', 'sw');
    form.append('response_format', 'json');
    const res = await fetchWithTimeout(`${cfg.stt}/audio/transcriptions`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Whisper HTTP ${res.status}`);
    const heard = String(((await res.json()) as { text?: unknown }).text ?? '').trim();
    const match = wordMatch(text, heard);
    return { ttsMs, sttMs: Date.now() - t1, heard, match, ok: match >= MATCH_THRESHOLD };
  } finally {
    // Give playback time to finish, then remove the temporary audio file.
    setTimeout(() => { if (file.exists) file.delete(); }, 120_000);
  }
}
