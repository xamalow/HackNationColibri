#!/usr/bin/env node
// Independent SMS-approval spoofing suite for the hub (Nat lane, gate for Carter's guardrail 3).
//
//   node eval/hub/sms_approval_suite.mjs <path to apps/hub>     # prints a JSON report, exit 1 on any failure
//
// Black-box against apps/hub/src/commands.mjs handleOwnerSms + store.mjs openStore. The rule under test:
// an SMS approval counts ONLY from Noor's enrolled number AND with the one-time code of THAT proposal,
// unchanged since the code was sent, unexpired, unused; anything else approves nothing and leaks nothing.
// Expected outcomes were written before running. Phone numbers are synthetic zero-pattern placeholders.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hubDir = process.argv[2];
if (!hubDir) {
  console.error("usage: sms_approval_suite.mjs <path to apps/hub>");
  process.exit(2);
}
const load = (p) => import(pathToFileURL(resolve(hubDir, p)).href);
const { openStore } = await load("src/store.mjs");
const { handleOwnerSms } = await load("src/commands.mjs");

const OWNER = "+254700000002";
const OWNER_LOCAL_FORMAT = "0700000002";
const SPOOFER = "+254700000009";
const T0 = new Date("2026-10-04T08:00:00Z");
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);

function fresh() {
  const store = openStore();
  store.setKV("owner.phone", OWNER);
  return store;
}
const send = (store, from, text, now = T0, opts = {}) => handleOwnerSms(store, { from, text }, { now, ...opts });
const stateOf = (store, id) => store.db.prepare("SELECT state FROM proposals WHERE short_id = ?").get(id)?.state ?? null;
const proposalCount = (store) => store.db.prepare("SELECT COUNT(*) AS n FROM proposals").get().n;
const approved = (r) => r?.command?.type === "approve";

/** Noor asks to close a day; returns the proposal id and the one-time code from the read-back she receives. */
function propose(store, text = "FUNGA 2026-10-16", now = T0) {
  const r = send(store, OWNER, text, now);
  const m = /NDIYO ([A-Z]+) (\d+)/.exec(r.reply ?? "");
  if (r?.command?.type !== "propose" || !m) throw new Error(`setup: no proposal/code in read-back: ${r?.reply}`);
  return { id: m[1], code: m[2], reply: r.reply, result: r };
}
const otherCode = (code) => String((Number(code) + 1) % 10 ** code.length).padStart(code.length, "0");

const SCENARIOS = [
  ["S01", "a spoofed sender with the right id and code approves nothing and gets no reply", (check) => {
    const s = fresh(); const p = propose(s);
    const r = send(s, SPOOFER, `NDIYO ${p.id} ${p.code}`);
    check("no approval", !approved(r)); check("no reply to the spoofer", r.reply === null && r.recipient === null);
    check("proposal still pending", stateOf(s, p.id) === "proposed");
    const real = send(s, OWNER, `NDIYO ${p.id} ${p.code}`);
    check("the spoof did not burn Noor's code: her approval still works", approved(real));
  }],
  ["S02", "a used code cannot approve again (replayed SMS)", (check) => {
    const s = fresh(); const p = propose(s);
    check("first approval works", approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`)));
    check("replay approves nothing", !approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(2))));
  }],
  ["S03", "an expired code approves nothing", (check) => {
    const s = fresh(); const p = propose(s);
    check("25 h later: refused", !approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(25 * 60))));
  }],
  ["S04", "setting the clock back does not revive an expired code", (check) => {
    const s = fresh(); const p = propose(s);
    send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(25 * 60));
    check("clock back to +1 h: still refused", !approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(60))));
  }],
  ["S05", "the code of proposal A cannot approve proposal B", (check) => {
    const s = fresh(); const a = propose(s, "FUNGA 2026-10-16"); const b = propose(s, "FUNGA 2026-10-17", at(1));
    check("B with A's code: refused", !approved(send(s, OWNER, `NDIYO ${b.id} ${a.code}`, at(2))));
    check("B still pending", stateOf(s, b.id) === "proposed");
  }],
  ["S06", "a proposal changed after its code was sent cannot be approved with that code", (check) => {
    const s = fresh(); const p = propose(s);
    const row = s.db.prepare("SELECT body FROM proposals WHERE short_id = ?").get(p.id);
    const body = JSON.parse(row.body); body.date = "2026-10-17";
    s.db.prepare("UPDATE proposals SET body = ? WHERE short_id = ?").run(JSON.stringify(body), p.id);
    check("tampered content: refused", !approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(1))));
  }],
  ["S07", "a bare yes is not an approval", (check) => {
    const s = fresh(); const p = propose(s);
    for (const text of ["NDIYO", "ndiyo", "Ndiyo sawa", `NDIYO ${p.id}`, "YES", "1"]) {
      check(`"${text}" approves nothing`, !approved(send(s, OWNER, text, at(1))));
    }
    check("proposal still pending", stateOf(s, p.id) === "proposed");
  }],
  ["S08", "Noor's free-text suggestion is never read as yes", (check) => {
    const s = fresh(); const p = propose(s);
    for (const text of ["nitachelewa kidogo", "Ndiyo lakini nitachelewa kidogo", "sawa, kesho asubuhi"]) {
      check(`"${text}" approves nothing`, !approved(send(s, OWNER, text, at(1))));
    }
    check("proposal still pending", stateOf(s, p.id) === "proposed");
  }],
  ["S09", "five wrong codes lock the proposal; the right code is then refused", (check) => {
    const s = fresh(); const p = propose(s);
    const wrongs = [];
    for (let c = otherCode(p.code); wrongs.length < 5; c = otherCode(c)) if (c !== p.code) wrongs.push(c);
    wrongs.forEach((w, i) => send(s, OWNER, `NDIYO ${p.id} ${w}`, at(1 + i)));
    check("right code after lockout: refused", !approved(send(s, OWNER, `NDIYO ${p.id} ${p.code}`, at(10))));
  }],
  ["S10", "a spoofed HAPANA cannot cancel Noor's pending proposal", (check) => {
    const s = fresh(); const p = propose(s);
    send(s, SPOOFER, `HAPANA ${p.id}`, at(1));
    check("proposal still pending", stateOf(s, p.id) === "proposed");
  }],
  ["S11", "a spoofed command creates nothing and never receives a code", (check) => {
    const s = fresh();
    const r = send(s, SPOOFER, "FUNGA 2026-10-16");
    check("no proposal", proposalCount(s) === 0); check("no reply, so no code leaks", r.reply === null);
  }],
  ["S12", "the read-back goes to the enrolled number, whatever format the sender used", (check) => {
    const s = fresh();
    const r = send(s, OWNER_LOCAL_FORMAT, "FUNGA 2026-10-16");
    check("command accepted from the local number format", r?.command?.type === "propose");
    check("read-back addressed to the enrolled number", r.recipient === OWNER);
  }],
  ["S13", "a relative date is read back as an absolute date before any approval", (check) => {
    const s = fresh();
    const r = send(s, OWNER, "FUNGA jumamosi");
    const absolute = /(2026-10-10|10\/10|10\.10)/.test(r.reply ?? "");
    check("read-back names the exact date (Saturday 2026-10-10)", r?.command?.type === "propose" && absolute);
  }],
  ["S14", "an approval smuggled inside another command approves nothing", (check) => {
    const s = fresh(); const p = propose(s);
    const r = send(s, OWNER, `FUNGA 2026-10-18 NDIYO ${p.id} ${p.code}`, at(1));
    check("no approval", !approved(r)); check("original proposal still pending", stateOf(s, p.id) === "proposed");
  }],
  ["S15", "the happy path still works: Noor's own code, on time, approves exactly once", (check) => {
    const s = fresh(); const p = propose(s);
    const r = send(s, OWNER, `ndiyo ${p.id.toLowerCase()} ${p.code}`, at(5));
    check("approved", approved(r)); check("bound to that proposal", r?.command?.proposal_id === p.id);
  }],
];

const results = [];
for (const [id, title, run] of SCENARIOS) {
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  try { run(check); } catch (e) { checks.push({ name: `ran without error (${e?.message ?? e})`, ok: false }); }
  results.push({ id, title, result: checks.every((c) => c.ok) ? "pass" : "FAIL", checks });
}
const failed = results.filter((r) => r.result !== "pass");
process.stdout.write(JSON.stringify({ suite: "sms-approval-spoofing", scenarios: results.length, failed: failed.length,
  results }, null, 2) + "\n");
process.exit(failed.length ? 1 : 0);
