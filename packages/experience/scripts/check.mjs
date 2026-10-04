// Consistency gate for packages/experience. Zero dependencies.
//   node packages/experience/scripts/check.mjs
// Fails (exit 1) if the UI spec drifts from contracts/states.json, a copy key
// or icon is missing, or Swahili copy claims a review that the sheet does not record.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const contract = readJson(join(root, "contracts", "states.json"));
const ui = readJson(join(pkg, "interaction", "states.json"));
const screens = readJson(join(pkg, "interaction", "screens.json"));
const en = readJson(join(pkg, "copy", "en.json")).keys;
const sw = readJson(join(pkg, "copy", "sw.json")).keys;
const sheet = readFileSync(join(pkg, "review", "swahili-review-sheet.csv"), "utf8");

const errors = [];
const sameSet = (name, a, b) => {
  const missing = a.filter((x) => !b.includes(x));
  const extra = b.filter((x) => !a.includes(x));
  if (missing.length) errors.push(`${name}: no UI mapping for ${missing.join(", ")}`);
  if (extra.length) errors.push(`${name}: UI maps states the contract does not have: ${extra.join(", ")}`);
};

// 1. Every contract state is mapped, and nothing else.
sameSet("business", contract.business_states, Object.keys(ui.business));
sameSet("transport", contract.transport_states, Object.keys(ui.transport));

// 2. Every referenced copy key exists in both locales; 3. every icon exists.
const keys = new Set();
const icons = new Set();
const visit = (entry) => {
  for (const field of ["label", "note_key", "revoke_note_key"]) if (entry[field]) keys.add(entry[field]);
  if (entry.icon) icons.add(entry.icon);
  for (const action of [...(entry.actions ?? []), ...(entry.extra_actions ?? [])]) keys.add(`action.${action}`);
};
for (const group of ["business", "transport", "special", "screen_states"]) Object.values(ui[group]).forEach(visit);
for (const screen of Object.values(screens.screens)) keys.add(screen.title);
screens.screens.today.card.sections.forEach((s) => keys.add(s.key));
for (const name of ["farm", "visits"]) {
  const sc = screens.screens[name];
  if (!sc) continue;
  keys.add(sc.title);
  (sc.fields ?? []).forEach((f) => keys.add(f.key));
  for (const card of [sc.request_card, sc.booked_card].filter(Boolean)) {
    card.sections.forEach((x) => keys.add(x.key));
    [...(card.actions_order ?? []), ...(card.on_the_day?.actions ?? [])].forEach((a) => keys.add(`action.${a}`));
  }
}
for (const variant of Object.values(screens.screens.today.card_variants_phase2 ?? {})) {
  variant.sections.forEach((s) => keys.add(s.key));
  keys.add(variant.fail_safe.show);
  [...variant.fail_safe.actions, ...variant.actions_order].forEach((a) => keys.add(`action.${a}`));
}
screens.preview.fields.forEach((k) => keys.add(k));
// iOS VoiceOver: every action (except cancel) has a spoken hint, and the state lines have a label.
keys.add("a11y.state_lines");
keys.add("finding.model_label_unverified");
for (const key of [...keys]) {
  if (key.startsWith("action.") && key.split(".").length === 2 && key !== "action.cancel") keys.add(`a11y.hint.${key.slice("action.".length)}`);
}
for (const key of keys) {
  if (!en[key]) errors.push(`copy key missing in en.json: ${key}`);
  if (!sw[key]) errors.push(`copy key missing in sw.json: ${key}`);
}
for (const icon of icons) {
  if (!existsSync(join(pkg, "assets", "icons", `${icon}.svg`))) errors.push(`icon missing: ${icon}.svg`);
}

// 4. Locales have the same keys and the same {placeholders}.
const placeholders = (t) => (t.match(/\{[a-z_]+\}/g) ?? []).sort().join(",");
for (const key of Object.keys(en)) {
  if (!sw[key]) { errors.push(`sw.json lacks ${key}`); continue; }
  if (placeholders(en[key].text) !== placeholders(sw[key].text)) errors.push(`placeholders differ for ${key}`);
}
for (const key of Object.keys(sw)) if (!en[key]) errors.push(`en.json lacks ${key}`);

// 5. Swahili never carries digits: TTS reads letters only, code renders numbers as words.
for (const [key, value] of Object.entries(sw)) {
  if (/\d/.test(value.text.replace(/\{[a-z_]+\}/g, ""))) errors.push(`digit in Swahili copy: ${key}`);
}

// 6. A Swahili string may only leave UNREVIEWED if the sheet records reviewer and date.
const approved = new Set(
  sheet.trim().split("\n").slice(1)
    .map((line) => line.split(","))
    .filter((cols) => cols.at(-1) === "APPROVED" && cols.at(-3) && cols.at(-2))
    .map((cols) => cols[0]),
);
for (const [key, value] of Object.entries(sw)) {
  if (value.review_status !== "UNREVIEWED" && !approved.has(key)) {
    errors.push(`sw ${key} claims '${value.review_status}' without a signed review row`);
  }
}

// 7. Audio clips: every copy clip's text hash must match the current Swahili copy (a stale clip must never play).
const audioPath = join(pkg, "audio", "manifest.json");
if (existsSync(audioPath)) {
  const { createHash } = await import("node:crypto");
  const audio = readJson(audioPath);
  for (const c of audio.copy_clips) {
    const current = sw[c.key];
    if (!current) { errors.push(`audio clip for unknown copy key: ${c.key}`); continue; }
    const hash = createHash("sha256").update(current.text, "utf8").digest("hex");
    if (hash !== c.text_sha256) errors.push(`stale audio clip (text changed): ${c.key}`);
  }
}

// 9. Pending clips (audio/pending_clips.json): needed by the hub's alert calls, not rendered yet. A pending key is
// never in a manifest group (apps/hub and apps/hub-voice count every key there as available), carries no file or
// audio hash (nothing faked), and its text is UNREVIEWED, digit-free and hash-consistent. A rendered clip that moved
// into manifest.alert_clips must be RECORDED with its file and keep the text it was rendered from.
const pendingPath = join(pkg, "audio", "pending_clips.json");
let pendingCount = 0;
if (existsSync(pendingPath) || existsSync(audioPath)) {
  const { createHash } = await import("node:crypto");
  const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
  const audio = existsSync(audioPath) ? readJson(audioPath) : {};
  const available = new Set(["copy_clips", "word_clips", "alert_clips", "clips"].flatMap((g) => audio[g] ?? []).map((c) => c?.key));
  const clipKey = /^[a-z0-9][a-z0-9._-]{0,63}$/; // apps/hub-voice outbound.py CLIP_KEY
  const pending = existsSync(pendingPath) ? readJson(pendingPath).clips ?? [] : [];
  const seen = new Set();
  for (const c of pending) {
    const k = c.key;
    pendingCount += 1;
    if (typeof k !== "string" || !clipKey.test(k)) { errors.push(`pending clip with an invalid key: ${k}`); continue; }
    if (seen.has(k)) errors.push(`pending clip listed twice: ${k}`);
    seen.add(k);
    if (available.has(k)) errors.push(`pending clip ${k} is also in the manifest (it would count as available)`);
    const group = k.startsWith("word.") ? "word_clips" : "alert_clips";
    if (c.group !== group) errors.push(`pending clip ${k} must target ${group}, not ${c.group}`);
    if (typeof c.text !== "string" || !c.text.trim()) { errors.push(`pending clip ${k} has no text`); continue; }
    if (/\d/.test(c.text)) errors.push(`digit in pending clip text: ${k}`);
    if (group === "word_clips" && c.text !== k.slice("word.".length)) errors.push(`word clip ${k} must say '${k.slice(5)}'`);
    if (sha(c.text) !== c.text_sha256) errors.push(`pending clip ${k}: text_sha256 does not match its text`);
    if (c.review_status !== "UNREVIEWED" || c.needs_native_review !== true) errors.push(`pending clip ${k} must stay UNREVIEWED with needs_native_review`);
    if (!["PENDING_RENDER", "SUSPECT"].includes(c.status)) errors.push(`pending clip ${k} has status '${c.status}' (PENDING_RENDER or SUSPECT)`);
    if ("file" in c) errors.push(`pending clip ${k} has a file field (only rendered manifest clips have one)`);
    if (c.status === "PENDING_RENDER" && ("wav_sha256" in c || "duration_s" in c)) errors.push(`pending clip ${k} has audio measurements but no render`);
  }
  for (const c of audio.alert_clips ?? []) {
    const k = c.key;
    if (seen.has(k)) continue; // already reported above
    if (c.status !== "RECORDED" || typeof c.wav_sha256 !== "string" || c.file !== `audio/sw/${k}.wav`) {
      errors.push(`alert clip ${k} must be RECORDED with wav_sha256 and file audio/sw/${k}.wav`);
    }
    if (typeof c.text !== "string" || sha(c.text) !== c.text_sha256) errors.push(`stale alert clip (text changed): ${k}`);
    if (c.review_status !== "UNREVIEWED" && !approved.has(k)) errors.push(`alert clip ${k} claims '${c.review_status}' without a signed review row`);
  }
}

if (errors.length) {
  console.error(`experience check FAILED (${errors.length})`);
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}
const unreviewed = Object.values(sw).filter((v) => v.review_status === "UNREVIEWED").length;
console.log(`experience check OK: ${keys.size} copy keys referenced, ${icons.size} icons, ` +
  `${contract.business_states.length}+${contract.transport_states.length} contract states mapped, ` +
  `${unreviewed}/${Object.keys(sw).length} Swahili strings UNREVIEWED, ${pendingCount} clips pending render`);
