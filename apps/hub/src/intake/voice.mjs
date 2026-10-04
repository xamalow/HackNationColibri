// The hub answers the farm's phone number. A tourist hears a short greeting (Swahili, then English), leaves a
// voicemail of at most 60 s and hears a thank-you. Nothing is promised on the call: any answer is a proposal
// Noor approves later. The recording is transcribed ON THE HUB (local Whisper) through an injected transcriber;
// the transcript is untrusted data like an SMS.
//
// Call item (simulated transport; the telephony adapter maps its webhook to the same shape):
//   { synthetic: true, kind: "call", call_id, from, received_at, duration_s, recording?: "voicemail-001.wav" | null,
//     recording_s?: number }
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { normalizePhone, receivedAt, safeToken, sanitizeText, shortHash } from "./sms.mjs";

/** Recordings shorter than this carry no message (hang-up after the beep). */
export const MIN_VOICEMAIL_S = 3;
export const MAX_VOICEMAIL_S = 60;

/**
 * The IVR script, in order. Clip keys refer to packages/experience/audio/manifest.json (Experience records them;
 * "ivr.greeting" and "ivr.thanks" must exist there in sw and en). The telephony adapter renders this plan into
 * its own call-control format (e.g. Africa's Talking XML); the plan itself is provider neutral.
 */
export const IVR_PLAN = Object.freeze([
  Object.freeze({ step: "play", clip: "ivr.greeting", langs: Object.freeze(["sw", "en"]) }),
  Object.freeze({ step: "record", max_seconds: MAX_VOICEMAIL_S, beep: true, finish_on_key: "#", trim_silence: true }),
  Object.freeze({ step: "play", clip: "ivr.thanks", langs: Object.freeze(["sw", "en"]) }),
  Object.freeze({ step: "hangup" }),
]);

/**
 * @typedef {{ transcribe(audioPath: string): Promise<{ text: string, lang: string }> | { text: string, lang: string },
 *             source: "whisper" | "fixture" }} Transcriber
 */

/**
 * Simulated transcriber for the demo and tests: reads `<transcriptsDir>/<recording basename>.json`
 * ({ synthetic: true, text, lang }). Every event it produces is marked transcript_source "fixture".
 * @returns {Transcriber}
 */
export function fixtureTranscriber(transcriptsDir) {
  return {
    source: "fixture",
    transcribe(audioPath) {
      const name = basename(String(audioPath), extname(String(audioPath)));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("bad recording name");
      const t = JSON.parse(readFileSync(join(transcriptsDir, `${name}.json`), "utf8"));
      if (t.synthetic !== true) throw new Error(`fixture transcript ${name} without synthetic:true`);
      return { text: t.text, lang: t.lang };
    },
  };
}

/** Only the two known transcriber kinds are trusted labels; anything else is "unknown", never "whisper". */
const sourceOf = (t) => (t?.source === "whisper" || t?.source === "fixture" ? t.source : "unknown");
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

/**
 * A finished call -> HubEvent. No recording, or one shorter than MIN_VOICEMAIL_S, or an empty transcript ->
 * kind "missed_call" (Noor may want to call back). A transcriber failure is NOT dropped: it is a voicemail
 * event with reason "transcription_failed" so Noor can listen to the recording herself.
 * @param {object} call
 * @param {Transcriber} transcriber
 * @returns {Promise<import("./sms.mjs").HubEvent>}
 */
export async function callToEvent(call, transcriber, { now } = {}) {
  const cid = safeToken(call?.call_id);
  const id = `call:${cid ?? shortHash(call?.from, call?.received_at, call?.duration_s)}`;
  const from = normalizePhone(call?.from);
  const base = { id, channel: "voice", received_at: receivedAt(call?.received_at, now), from, synthetic: call?.synthetic === true };
  if (!from) base.reason = "no_reply_address";
  const recLen = Number.isFinite(call?.recording_s) ? call.recording_s : Number.isFinite(call?.duration_s) ? call.duration_s : 0;
  if (!call?.recording || recLen < MIN_VOICEMAIL_S) {
    return { ...base, kind: "missed_call", duration_s: Number.isFinite(call?.duration_s) ? call.duration_s : 0 };
  }
  const recording = String(call.recording);
  let result;
  try {
    result = await transcriber.transcribe(recording);
  } catch {
    return { ...base, kind: "voicemail", recording, text: "", reason: "transcription_failed", transcript_source: sourceOf(transcriber) };
  }
  const { text, truncated } = sanitizeText(result?.text);
  if (text.length === 0) return { ...base, kind: "missed_call", recording, duration_s: recLen, reason: "empty_voicemail" };
  const lang = typeof result?.lang === "string" && LANG.test(result.lang) ? result.lang : "und";
  const ev = { ...base, kind: "voicemail", recording, text, lang, transcript_source: sourceOf(transcriber) };
  if (truncated) ev.truncated = true;
  return ev;
}
