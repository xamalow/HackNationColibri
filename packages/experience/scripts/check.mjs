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
  for (const field of ["label", "note_key"]) if (entry[field]) keys.add(entry[field]);
  if (entry.icon) icons.add(entry.icon);
  for (const action of [...(entry.actions ?? []), ...(entry.extra_actions ?? [])]) keys.add(`action.${action}`);
};
for (const group of ["business", "transport", "special", "screen_states"]) Object.values(ui[group]).forEach(visit);
for (const screen of Object.values(screens.screens)) keys.add(screen.title);
screens.screens.today.card.sections.forEach((s) => keys.add(s.key));
for (const variant of Object.values(screens.screens.today.card_variants_phase2 ?? {})) {
  variant.sections.forEach((s) => keys.add(s.key));
  keys.add(variant.fail_safe.show);
  [...variant.fail_safe.actions, ...variant.actions_order].forEach((a) => keys.add(`action.${a}`));
}
screens.preview.fields.forEach((k) => keys.add(k));
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

if (errors.length) {
  console.error(`experience check FAILED (${errors.length})`);
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}
const unreviewed = Object.values(sw).filter((v) => v.review_status === "UNREVIEWED").length;
console.log(`experience check OK: ${keys.size} copy keys referenced, ${icons.size} icons, ` +
  `${contract.business_states.length}+${contract.transport_states.length} contract states mapped, ` +
  `${unreviewed}/${Object.keys(sw).length} Swahili strings UNREVIEWED`);
