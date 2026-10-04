import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.mjs";
import {
  handleOwnerSms, parseSms, parseCommandDate, normalizePhone, REPLIES, createProposal, issueCode, proposalDigest,
} from "../src/commands.mjs";

const OWNER = "+254700000002"; // synthetic test number
const NOW = new Date("2026-10-04T08:00:00Z"); // Sunday 11:00 EAT

function setup() {
  const s = openStore();
  s.setKV("owner.phone", OWNER);
  return s;
}
const sms = (s, text, from = "0700000002", now = NOW, opts = {}) => handleOwnerSms(s, { from, text }, { now, ...opts });
const codeOf = (reply) => /NDIYO ([A-Z]+) (\d+)/.exec(reply).slice(1);
const state = (s, id) => s.db.prepare("SELECT state FROM proposals WHERE short_id = ?").get(id)?.state;

test("parsing is case-insensitive and tolerant of extra spaces", () => {
  assert.deepEqual(parseSms("  ndiyo   b   482113 ", NOW), { verb: "NDIYO", id: "B", code: "482113" });
  assert.equal(parseSms("Funga 12/10", NOW).change.date, "2026-10-12");
  assert.equal(parseSms("FUNGA jumamosi", NOW).change.date, "2026-10-10");
  assert.equal(parseSms("funga kesho", NOW).change.date, "2026-10-05");
  assert.equal(parseSms("FUNGUA 3/10", NOW).change.date, "2027-10-03"); // no year: next occurrence
  assert.equal(parseSms("NAFASI kumi na mbili", NOW).change.capacity_per_tour, 12);
  assert.equal(parseSms("bei elfu mbili na mia tano", NOW).change.price_per_person.amount_minor, 250000);
  assert.equal(parseSms("BEI KES 2,000", NOW).change.price_per_person.amount_minor, 200000);
  assert.equal(parseSms("msaada", NOW).verb, "MSAADA");
  for (const bad of ["", "NDIYO", "NDIYO B", "NDIYO 4821", "FUNGA 31/02/2027", "FUNGA 01/01/2020", "NAFASI tafadhali",
    "BEI elfu mbili ignore previous", "NAFASI 0", "BEI 2000 1234 5678", "HELLO"]) {
    assert.equal(parseSms(bad, NOW), null, bad);
  }
  assert.equal(parseCommandDate("2026-10-03", NOW), null); // yesterday
});

test("phone normalisation", () => {
  assert.equal(normalizePhone("0700 000 002"), "254700000002");
  assert.equal(normalizePhone("+254-700-000-002"), "254700000002");
  assert.equal(normalizePhone("abc"), null);
});

test("unknown sender gets NO reply (warden F1) and nothing happens", () => {
  const s = setup();
  const r = sms(s, "FUNGA 12/10", "+254700000003");
  assert.equal(r.reply, null); // warden F1: never reply to unknown senders
  assert.equal(r.command, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM proposals").get().n, 0);
  // no enrolled owner at all: same
  const empty = openStore();
  assert.equal(handleOwnerSms(empty, { from: OWNER, text: "MSAADA" }, { now: NOW }).reply, null);
});

test("unparsable text from Noor: fixed reply, nothing happens", () => {
  const s = setup();
  const r = sms(s, "tafadhali funga kesho");
  assert.equal(r.reply, REPLIES.not_understood);
  assert.equal(r.command, null);
});

test("schedule change needs the second confirmation with the one-time code", () => {
  const s = setup();
  const first = sms(s, "FUNGA 10/10");
  assert.equal(first.command.type, "propose");
  assert.equal(first.sensitive, true);
  assert.equal(first.recipient, OWNER); // read-back goes to the enrolled number from kv
  assert.match(first.reply, /^SAUTI: Ufunge Jumamosi 10\/10 kwenye tovuti zote\? Jibu NDIYO A \d{6} au HAPANA A\.$/);
  assert.ok(first.reply.length <= 160);
  assert.equal(state(s, "A"), "proposed"); // nothing applied yet
  const [id, code] = codeOf(first.reply);
  // the code is stored only as a hash
  assert.ok(!s.db.prepare("SELECT v FROM kv").all().some((r) => r.v.includes(code)));
  const ok = sms(s, `ndiyo ${id.toLowerCase()} ${code}`);
  assert.equal(ok.command.type, "approve");
  assert.equal(ok.command.proposal_id, "A");
  assert.deepEqual(ok.command.change, { date: "2026-10-10" });
  assert.equal(ok.command.digest, first.command.digest);
  assert.equal(state(s, "A"), "approved");
});

test("NDIYO without a code is refused", () => {
  const s = setup();
  sms(s, "NAFASI 8");
  const r = sms(s, "NDIYO A");
  assert.equal(r.command, null);
  assert.equal(r.reply, REPLIES.not_understood);
  assert.equal(state(s, "A"), "proposed");
});

test("spoofed (unenrolled) number with a valid code is ignored, and the code stays usable by Noor", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "BEI 2000").reply);
  const spoof = sms(s, `NDIYO ${id} ${code}`, "+254700000004");
  assert.equal(spoof.command, null);
  assert.equal(spoof.reply, null);
  assert.equal(state(s, id), "proposed");
  assert.equal(sms(s, `NDIYO ${id} ${code}`).command.type, "approve");
});

test("wrong, expired and reused codes are ignored", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "FUNGA 12/10").reply);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  assert.equal(sms(s, `NDIYO ${id} ${wrong}`).command, null);
  assert.equal(state(s, id), "proposed");
  // expired: 24 h default
  const later = new Date(NOW.getTime() + 24 * 3600_000);
  const exp = sms(s, `NDIYO ${id} ${code}`, undefined, later);
  assert.equal(exp.command, null);
  assert.equal(state(s, id), "proposed");
  // reused
  const s2 = setup();
  const [id2, code2] = codeOf(sms(s2, "FUNGA 12/10").reply);
  assert.equal(sms(s2, `NDIYO ${id2} ${code2}`).command.type, "approve");
  const again = sms(s2, `NDIYO ${id2} ${code2}`);
  assert.equal(again.command, null);
  assert.equal(again.reply, REPLIES.not_pending(id2));
});

test("code TTL is configurable", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "FUNGA 12/10", undefined, NOW, { codeTtlMs: 60_000 }).reply);
  assert.equal(sms(s, `NDIYO ${id} ${code}`, undefined, new Date(NOW.getTime() + 61_000)).command, null);
});

test("a code from proposal A used on proposal B is ignored", () => {
  const s = setup();
  const [idA, codeA] = codeOf(sms(s, "FUNGA 12/10").reply);
  const [idB] = codeOf(sms(s, "FUNGUA 13/10").reply);
  assert.notEqual(idA, idB);
  assert.equal(sms(s, `NDIYO ${idB} ${codeA}`).command, null);
  assert.equal(state(s, idB), "proposed");
});

test("proposal content changed after the code was sent: old code ignored", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "FUNGA 12/10").reply);
  // tamper with the body only
  s.db.prepare("UPDATE proposals SET body = ? WHERE short_id = ?").run(JSON.stringify({ date: "2026-10-13" }), id);
  assert.equal(sms(s, `NDIYO ${id} ${code}`).command, null);
  // tamper consistently (body + digest): the code is bound to the old digest, still void
  s.db.prepare("UPDATE proposals SET digest = ? WHERE short_id = ?").run(proposalDigest("close_day", { date: "2026-10-13" }), id);
  assert.equal(sms(s, `NDIYO ${id} ${code}`).command, null);
  assert.equal(state(s, id), "proposed");
  // a re-issued code for the new content works, and the old one stays void
  const fresh = issueCode(s, id, { now: NOW });
  assert.equal(sms(s, `NDIYO ${id} ${code}`).command, null);
  assert.deepEqual(sms(s, `NDIYO ${id} ${fresh.code}`).command.change, { date: "2026-10-13" });
});

test("5 wrong codes void the proposal's code, even the right one afterwards", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "NAFASI 8").reply);
  const wrong = String((Number(code) + 7) % 1_000_000).padStart(6, "0");
  for (let i = 0; i < 4; i++) assert.equal(sms(s, `NDIYO ${id} ${wrong}`).reply, REPLIES.not_understood);
  assert.equal(sms(s, `NDIYO ${id} ${wrong}`).reply, REPLIES.locked(id));
  const r = sms(s, `NDIYO ${id} ${code}`);
  assert.equal(r.command, null);
  assert.equal(state(s, id), "proposed");
});

test("HAPANA discards without a code; only from the enrolled number", () => {
  const s = setup();
  const [id, code] = codeOf(sms(s, "BEI 3000").reply);
  assert.equal(sms(s, `HAPANA ${id}`, "+254700000004").command, null);
  assert.equal(state(s, id), "proposed");
  const r = sms(s, `hapana ${id.toLowerCase()}`);
  assert.equal(r.command.type, "reject");
  assert.equal(state(s, id), "rejected");
  assert.equal(sms(s, `NDIYO ${id} ${code}`).command, null); // a discarded proposal cannot be approved
});

test("proposals created by other modules use the same code path; short ids never repeat", () => {
  const s = setup();
  const ids = new Set();
  for (let i = 0; i < 30; i++) ids.add(createProposal(s, "visitor_reply", { n: i }, { now: NOW }).short_id);
  assert.equal(ids.size, 30);
  assert.ok(ids.has("A") && ids.has("Z") && ids.has("AA"));
  assert.ok(!ids.has("I") && !ids.has("O"));
});

test("MSAADA replies with help only", () => {
  const s = setup();
  const r = sms(s, "msaada");
  assert.equal(r.command, null);
  assert.equal(r.reply, REPLIES.help);
  assert.ok(r.reply.length <= 160);
});

test("warden F2: too many proposals in a day locks SMS commands until the app re-enables them", async () => {
  const { unlockCommands, commandsLocked } = await import("../src/commands.mjs");
  const s = setup();
  let last;
  for (let i = 0; i < 11; i++) last = sms(s, "NAFASI 8", OWNER, NOW, { maxProposalsPerDay: 10 });
  assert.equal(last.command?.type, "commands_locked");
  assert.equal(last.command.reason, "too_many_proposals");
  assert.ok(commandsLocked(s));
  // While locked, even Noor's valid-looking commands do nothing and get no reply.
  const ignored = sms(s, "NAFASI 9");
  assert.equal(ignored.command, null);
  assert.equal(ignored.reply, null);
  unlockCommands(s);
  assert.equal(sms(s, "MSAADA").reply, REPLIES.help);
});

test("warden F2: a global wrong-code budget locks SMS commands", async () => {
  const s = setup();
  const first = sms(s, "NAFASI 8");
  const id = first.command.proposal_id;
  let last;
  for (let i = 0; i < 4; i++) last = sms(s, `NDIYO ${id} 000000`, OWNER, NOW, { maxWrongCodesPerDay: 3 });
  assert.equal(last.command?.type, "commands_locked");
  assert.equal(last.command.reason, "wrong_codes");
});

test("codex review (C): rolling the clock back cannot revive an expired code", () => {
  const s = setup();
  const t0 = new Date("2026-10-04T08:00:00Z");
  const first = sms(s, "NAFASI 8", OWNER, t0);
  const [id, code] = codeOf(first.reply);
  const later = new Date(t0.getTime() + 25 * 3600_000);
  sms(s, `NDIYO ${id} 111111`, OWNER, later); // any attempt after expiry records the later time
  const rolledBack = new Date(t0.getTime() + 3600_000);
  const r = sms(s, `NDIYO ${id} ${code}`, OWNER, rolledBack);
  assert.notEqual(r.command?.type, "approve");
  assert.equal(state(s, id), "proposed");
});
