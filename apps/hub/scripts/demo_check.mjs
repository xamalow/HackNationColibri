#!/usr/bin/env node
/* global fetch */
// One command that proves the hub demo works: `npm run demo:check` (root) or `node apps/hub/scripts/demo_check.mjs`.
//
// It starts the two-phone demo server in-process (createDemoServer from src/demo_web.mjs, port 0, a fresh var dir),
// drives it ONLY through the HTTP API the page itself uses (POST /api/tourist, /api/noor, /api/day, /api/inbox,
// /api/guided/next, /api/reset; GET /api/state), and checks every hub workflow with assertions. One line per
// workflow (PASS / FAIL + the first broken assertion), then a summary. Exit 0 only when everything passed; exit 2 when
// a prerequisite is missing (with the command that installs it).
//
//   --no-nat   skip Nat's independent suites (eval/hub/booking_flow_suite.mjs, eval/hub/sms_approval_suite.mjs)
//   --verbose  print the messages each workflow produced
//
// Expected prices and capacity come from the farm sheet fixture (apps/hub/fixtures/farm_sheet.json), never from the
// answers under test. Synthetic data only: fictional numbers, the page never sees one.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HUB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = resolve(HUB, "..", "..");
const SHEET = JSON.parse(readFileSync(join(HUB, "fixtures", "farm_sheet.json"), "utf8")).sheet;
const PRICE = SHEET.price_per_person_kes;
const CAPACITY = SHEET.capacity_per_tour;
const START = SHEET.hours.start.slice(0, 5);
const GUIDED_STEPS = 7;
const NAT_SUITES = ["eval/hub/booking_flow_suite.mjs", "eval/hub/sms_approval_suite.mjs"];

// ---------------------------------------------------------------------------------------------------------
// Prerequisites: a clear message instead of an import error deep in the hub.

/** @returns {string[]} what is missing, each with the command that fixes it */
export function missingPrerequisites() {
  const missing = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) missing.push(`Node >= 22.13 (node:sqlite); this is ${process.versions.node}`);
  if (!existsSync(join(ROOT, "packages", "core", "dist", "index.js"))) {
    missing.push("the @sauti/core build: npm ci --prefix packages/core && npm run build --prefix packages/core");
  }
  if (!existsSync(join(ROOT, "contrib", "max", "langid", "node_modules", "franc"))) {
    missing.push("the language-ID / feedback-tagger deps: npm ci --prefix contrib/max/langid");
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------------------
// A tiny client for the page's API, with per-thread "new messages since" marks.

const THREADS = ["noor", "tourist1", "tourist2", "tourist3", "other"];

function client(base) {
  const marks = Object.fromEntries(THREADS.map((t) => [t, 0]));
  const c = {
    transcript: [],
    async post(path, body = {}) {
      const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await r.json();
      assert.equal(r.status, 200, `${path} answered ${r.status} ${JSON.stringify(json)}`);
      return json.result;
    },
    async state() {
      const r = await fetch(`${base}/api/state`);
      assert.equal(r.status, 200);
      return r.json();
    },
    async reset() {
      await c.post("/api/reset");
      for (const t of THREADS) marks[t] = 0;
      c.transcript = [];
    },
    /** Messages the hub sent to `thread` since the previous call for that thread (marks it read). */
    async fresh(thread) {
      const s = await c.state();
      const all = s.threads[thread];
      const out = all.slice(marks[thread]).filter((m) => m.from === "hub");
      marks[thread] = all.length;
      for (const m of out) c.transcript.push(`  ${thread} <- ${m.kind === "call" ? `[call ${m.call}] ${m.clips.join(" ")}` : m.text}`);
      return out;
    },
    tourist: (n, text) => { c.transcript.push(`  tourist${n} -> ${text}`); return c.post("/api/tourist", { tourist: n, text }); },
    noor: (text) => { c.transcript.push(`  noor -> ${text.replace(/\b\d{6}\b/g, "######")}`); return c.post("/api/noor", { text }); },
    /** The one-time code in the latest read-back for proposal `id` (Noor's phone only). */
    async codeFor(id) {
      const s = await c.state();
      const re = new RegExp(`NDIYO ${id} (\\d{6})\\b`);
      const hit = s.threads.noor.filter((m) => m.from === "hub" && re.test(m.text ?? "")).at(-1);
      assert.ok(hit, `no read-back with a one-time code for ${id} on Noor's phone`);
      return re.exec(hit.text)[1];
    },
    /** Noor's read-only WAGENI answer for a day: { groups, people, left }. */
    async guests(ddmm) {
      await c.noor(`WAGENI ${ddmm}`);
      const [m] = (await c.fresh("noor")).slice(-1);
      assert.ok(m && /^SAUTI WAGENI /.test(m.text), `no WAGENI answer: ${m?.text}`);
      if (/Hakuna wageni/.test(m.text)) return { groups: 0, people: 0, left: Number(/Nafasi (\d+) kati/.exec(m.text)?.[1]) };
      const g = /Wageni (\d+), watu (\d+)\./.exec(m.text);
      assert.ok(g, `unreadable WAGENI answer: ${m.text}`);
      return { groups: Number(g[1]), people: Number(g[2]), left: Number(/Nafasi (\d+) kati/.exec(m.text)?.[1]) };
    },
  };
  return c;
}

const last = (msgs) => msgs.at(-1)?.text ?? "";
const sms = (msgs) => msgs.filter((m) => m.kind === "sms");
const readbackRe = (id, people, dayDdMm, total) =>
  new RegExp(`^SAUTI: Mgeni \\(\\S+\\) anaomba watu ${people}, \\S+ ${dayDdMm}, KES ${total}\\. Jibu NDIYO ${id} (\\d{6}), HAPANA ${id} \\1, au ${id} \\1 <ujumbe>$`);

// ---------------------------------------------------------------------------------------------------------
// The workflows. Each starts from a fresh hub (POST /api/reset): empty calendar, clock Sunday 4 October 2026.

export const WORKFLOWS = [
  {
    id: 1, name: "booking -> read-back with code + price -> NDIYO -> confirmed; replayed code books nothing",
    async run(c) {
      const r = await c.tourist(1, "Hello! Can we visit the coffee farm on Saturday 17 October? We are 4 people.");
      assert.equal(r.action, "request_proposed");
      const id = r.proposal_id;
      const rb = sms(await c.fresh("noor"));
      assert.equal(rb.length, 1, "exactly one SMS to Noor");
      const m = readbackRe(id, 4, "17/10", 4 * PRICE).exec(rb[0].text);
      assert.ok(m, `read-back: ${rb[0].text}`);
      const code = m[1];
      const ack = await c.fresh("tourist1");
      assert.match(last(ack), /^Thank you! We received your request for 4 people on Saturday 17 October 2026/);
      assert.ok(!ack.some((x) => /Confirmed/.test(x.text)), "no confirmation before Noor's yes");
      assert.equal((await c.guests("17/10")).people, 0, "nothing booked before NDIYO");

      const yes = await c.noor(`NDIYO ${id} ${code}`);
      assert.deepEqual([yes.command, yes.executed?.outcome], ["approve", "confirmed"]);
      assert.match(last(await c.fresh("noor")), new RegExp(`^Sawa\\. ${id} imeidhinishwa\\.`));
      assert.equal(last(await c.fresh("tourist1")),
        `Confirmed! Noor welcomes 4 people on Saturday 17 October 2026. The tour starts at ${START}. Total price: ${4 * PRICE} KES.`);

      const replay = await c.noor(`NDIYO ${id} ${code}`);
      assert.equal(replay.executed, null, "a replayed code executes nothing");
      assert.match(last(await c.fresh("noor")), new RegExp(`^Pendekezo ${id} halipo au limeshaamuliwa`));
      assert.equal((await c.fresh("tourist1")).length, 0, "no second confirmation");
      assert.deepEqual(await c.guests("17/10"), { groups: 1, people: 4, left: CAPACITY - 4 });
    },
  },
  {
    id: 2, name: "HAPANA <id> <code> -> polite decline, nothing booked",
    async run(c) {
      const r = await c.tourist(2, "Hi, we would like to come on Friday 16 October, 2 people please.");
      assert.equal(r.action, "request_proposed");
      const code = await c.codeFor(r.proposal_id);
      await c.fresh("noor");
      await c.fresh("tourist2");
      const no = await c.noor(`HAPANA ${r.proposal_id} ${code}`);
      assert.deepEqual([no.command, no.executed?.outcome], ["reject", "declined"]);
      assert.match(last(await c.fresh("noor")), new RegExp(`^Sawa\\. ${r.proposal_id} imekataliwa\\.`));
      const t = await c.fresh("tourist2");
      assert.equal(t.length, 1);
      assert.match(t[0].text, /^Sorry, Noor cannot welcome you on Friday 16 October 2026\. Would another day suit you\?/);
      assert.equal((await c.guests("16/10")).people, 0, "nothing booked");
      const again = await c.noor(`NDIYO ${r.proposal_id} ${code}`);
      assert.equal(again.executed, null, "a declined request cannot be approved with the spent code");
      assert.equal((await c.guests("16/10")).people, 0);
    },
  },
  {
    id: 3, name: "Noor's suggestion '<id> <code> <words>' relayed verbatim, request stays open, later NDIYO confirms",
    async run(c) {
      const r = await c.tourist(1, "Hello, can we visit on Wednesday 14 October? We are 3 people.");
      assert.equal(r.action, "request_proposed");
      const code = await c.codeFor(r.proposal_id);
      await c.fresh("noor");
      await c.fresh("tourist1");
      const words = "Karibu sana, njooni saa tatu asubuhi na viatu vya kutembea";
      const s = await c.noor(`${r.proposal_id} ${code} ${words}`);
      assert.equal(s.command, "suggest");
      assert.equal(s.executed, null, "a suggestion executes nothing");
      assert.match(last(await c.fresh("noor")), /Ombi bado linasubiri NDIYO au HAPANA\.$/);
      const relayed = last(await c.fresh("tourist1"));
      assert.ok(relayed.startsWith(`Noor replied (in Swahili): «${words}»`), `relay: ${relayed}`);
      assert.match(relayed, /still open/);
      assert.equal((await c.guests("14/10")).people, 0, "still open: nothing booked");
      const yes = await c.noor(`NDIYO ${r.proposal_id} ${code}`);
      assert.equal(yes.executed?.outcome, "confirmed", "the code was not spent by the suggestion");
      assert.match(last(await c.fresh("tourist1")), new RegExp(`^Confirmed! .*3 people on Wednesday 14 October 2026.*Total price: ${3 * PRICE} KES\\.$`));
      assert.equal((await c.guests("14/10")).people, 3);
    },
  },
  {
    id: 4, name: "closed day: FUNGA -> read-back -> NDIYO; a request for that day is refused by code and Noor is told",
    async run(c) {
      const f = await c.noor("FUNGA 15/10");
      assert.equal(f.command, "propose");
      const rb = last(await c.fresh("noor"));
      const m = /^SAUTI: Ufunge Alhamisi 15\/10 kwenye tovuti zote\? Jibu NDIYO ([A-Z]+) (\d{6}) au HAPANA \1\.$/.exec(rb);
      assert.ok(m, `FUNGA read-back: ${rb}`);
      const ok = await c.noor(`NDIYO ${m[1]} ${m[2]}`);
      assert.deepEqual([ok.executed?.kind, ok.executed?.ok], ["close_day", true]);
      await c.fresh("noor");
      const r = await c.tourist(2, "Hi, can we come on Thursday 15 October? We are 2.");
      assert.equal(r.action, "request_unavailable");
      assert.equal(r.proposal_id, null, "no proposal for a closed day");
      assert.match(last(await c.fresh("tourist2")), /^Sorry, there is no tour on Thursday 15 October 2026\./);
      const told = sms(await c.fresh("noor"));
      assert.equal(told.length, 1);
      assert.match(told[0].text, /^SAUTI: Mgeni aliomba watu 2, Alhamisi 15\/10: siku imefungwa\. Mgeni amejibiwa\.$/);
      assert.ok(!/NDIYO/.test(told[0].text), "Noor is informed, not asked");
    },
  },
  {
    id: 5, name: "capacity race: two requests that each fit alone; Noor approves both; seats never exceed capacity",
    async run(c) {
      const party = Math.floor(CAPACITY / 2) + 1; // each fits alone, both do not
      const a = await c.tourist(1, `Hello, we would like to visit on Tuesday 13 October, ${party} people.`);
      const b = await c.tourist(2, `Hi, can we visit on Tuesday 13 October? We are ${party} people.`);
      assert.deepEqual([a.action, b.action], ["request_proposed", "request_proposed"], "each fits alone");
      const [ca, cb] = [await c.codeFor(a.proposal_id), await c.codeFor(b.proposal_id)];
      for (const t of ["noor", "tourist1", "tourist2"]) await c.fresh(t);
      const ya = await c.noor(`NDIYO ${a.proposal_id} ${ca}`);
      assert.equal(ya.executed?.outcome, "confirmed");
      await c.fresh("noor");
      const yb = await c.noor(`NDIYO ${b.proposal_id} ${cb}`);
      assert.notEqual(yb.executed?.outcome, "confirmed", "the second approval must not overbook");
      const told = sms(await c.fresh("noor")).map((m) => m.text);
      assert.ok(told.some((t) => new RegExp(`^SAUTI: ${b.proposal_id} haikuthibitishwa: Jumanne 13/10 imejaa`).test(t)), `Noor is told why: ${told.join(" | ")}`);
      assert.ok(!told.some((t) => /atapata uthibitisho/.test(t)), "no 'the guest will get a confirmation' that contradicts it");
      const g = await c.guests("13/10");
      assert.ok(g.people <= CAPACITY, `seats ${g.people} > capacity ${CAPACITY}`);
      assert.deepEqual(g, { groups: 1, people: party, left: CAPACITY - party });
      assert.match(last(await c.fresh("tourist1")), /^Confirmed!/);
      const t2 = (await c.fresh("tourist2")).map((x) => x.text);
      assert.ok(!t2.some((x) => /Confirmed/.test(x)), "the second tourist is never confirmed");
      assert.ok(t2.some((x) => new RegExp(`^Sorry, on Tuesday 13 October 2026 we only have room for ${CAPACITY - party} (?:people|person), not enough for your group\\.`).test(x)),
        `second tourist: ${t2.join(" | ")}`);
    },
  },
  {
    id: 6, name: "feedback loop: visits -> day jump -> automatic question -> replies -> Swahili digest -> MAONI",
    async run(c) {
      const visits = [
        [1, "Hello, can we come on Saturday 17 October? We are 2 people.", "Great coffee tasting, but the road to the farm was hard to find."],
        [2, "Hi, we would like to visit on Saturday 17 October, 3 people.", "We loved the coffee. The directions were confusing, there is no sign."],
        [3, "Habari, tungependa kuja Jumamosi tarehe 17 Oktoba, sisi ni watu wawili.", "Kahawa ilikuwa nzuri sana, lakini maelekezo ya kufika yalikuwa magumu."],
      ];
      for (const [n, req] of visits) {
        const r = await c.tourist(n, req);
        assert.equal(r.action, "request_proposed");
        assert.equal((await c.noor(`NDIYO ${r.proposal_id} ${await c.codeFor(r.proposal_id)}`)).executed?.outcome, "confirmed");
      }
      for (const t of ["noor", "tourist1", "tourist2", "tourist3"]) await c.fresh(t);
      const day = await c.post("/api/day", { date: "2026-10-18" });
      assert.equal(day.sent.length, 3, "one question per visit, sent automatically");
      assert.equal(day.proposed.length, 0, "autoFeedback: Noor is not asked");
      assert.equal((await c.fresh("noor")).length, 0, "nothing to Noor at the day jump");
      assert.match(last(await c.fresh("tourist1")), /What did you like, and what could be better\?/);
      assert.match(last(await c.fresh("tourist2")), /What did you like, and what could be better\?/);
      assert.match(last(await c.fresh("tourist3")), /Ulipenda nini, na nini kingeweza kuwa bora\?/);
      assert.equal((await c.post("/api/day", { date: "2026-10-19" })).sent.length, 0, "once per visit");
      for (const [n, , reply] of visits) assert.equal((await c.tourist(n, reply)).action, "feedback_reply");
      const digest = sms(await c.fresh("noor")).map((m) => m.text).filter((t) => /^SAUTI: Maoni ya wageni/.test(t)).at(-1);
      assert.ok(digest, "a Swahili pain-point digest reached Noor");
      assert.match(digest, /^SAUTI: Maoni ya wageni \(3\)\. Shida: Maelekezo ya kufika, maoni 3/);
      assert.match(digest, /Wanapenda: Kahawa \(3\)/);
      for (const n of [1, 2, 3]) assert.equal((await c.fresh(`tourist${n}`)).length, 0, "a feedback reply gets no automatic answer");
      const q = await c.noor("MAONI");
      assert.equal(q.command, "query");
      assert.equal(last(await c.fresh("noor")), digest.replace(/^SAUTI: /, "SAUTI MAONI: "));
    },
  },
  {
    id: 7, name: "owner alert: platform overbooking + a visitor question -> Swahili SMS to Noor, call queued (held w/o clips)",
    async run(c, { missingClips }) {
      const r = await c.post("/api/inbox");
      assert.ok(r.items >= 5, `platform inbox items: ${r.items}`);
      const msgs = await c.fresh("noor");
      assert.ok(sms(msgs).some((m) => /^SAUTI HARAKA: Jumatano 14\/10 imezidi\. Mpya \(GYG\): watu 3, /.test(m.text)), "urgent overbooking SMS");
      const calls = msgs.filter((m) => m.kind === "call");
      assert.ok(calls.length >= 1, "a call is queued for every alert");
      const urgent = calls.find((m) => m.urgent && m.call_kind === "booking_conflict");
      assert.ok(urgent, "an urgent call for the conflict");
      const expect = (m) => (m.clips.some((k) => missingClips.has(k)) ? "held" : "queued");
      for (const m of calls) assert.equal(m.call, expect(m), `call state for ${m.clips.join(",")}`);
      assert.equal(urgent.call, expect(urgent));
      assert.ok(!(await c.state()).threads.noor.some((m) => m.from === "hub" && m.kind === "call" && m.to !== "noor"), "calls only to Noor");

      const q = await c.tourist(3, "Is lunch included in the tour?");
      assert.equal(q.action, "question");
      assert.equal((await c.fresh("tourist3")).length, 0, "no automatic answer to a question");
      const qa = await c.fresh("noor");
      assert.ok(sms(qa).some((m) => /^SAUTI: Ujumbe wa mgeni \(SMS\) unasubiri jibu lako\. Angalia Sauti\.$/.test(m.text)));
      const qc = qa.filter((m) => m.kind === "call");
      assert.equal(qc.length, 1, "one call for the question");
      assert.equal(qc[0].call, expect(qc[0]));
    },
  },
  {
    id: 8, name: `guided demo: ${GUIDED_STEPS} clicks on /api/guided/next end with the MAONI summary`,
    async run(c) {
      const s0 = (await c.state()).guided;
      assert.equal(s0.total, GUIDED_STEPS);
      assert.ok(!s0.titles.some((t) => /stranger|inject|spoof/i.test(t)), "no safety showcase in the guided demo");
      let r;
      for (let i = 1; i <= GUIDED_STEPS; i++) {
        r = await c.post("/api/guided/next");
        assert.equal(r.step, i);
        assert.equal(r.done, i === GUIDED_STEPS);
      }
      const s = await c.state();
      const noor = s.threads.noor.filter((m) => m.from === "hub");
      assert.match(noor.at(-1).text, /^SAUTI MAONI: Maoni ya wageni \(3\)\. Shida: Maelekezo ya kufika/);
      assert.equal(s.threads.tourist1.filter((m) => /^Confirmed!/.test(m.text ?? "")).length, 1);
      assert.ok(s.threads.noor.some((m) => /^SAUTI WAGENI Jumamosi 17\/10: Wageni 3, watu 8\./.test(m.text ?? "")));
      const extra = await c.post("/api/guided/next");
      assert.equal(extra.done, true);
      assert.equal((await c.state()).threads.noor.length, s.threads.noor.length, "after the end a click changes nothing");
    },
  },
];

/** Page and privacy: served locally with a CSP, no banner, and no phone number in anything the page sees. */
const PAGE_CHECK = {
  id: "page", name: "page served locally (CSP, no banner); the state the page sees holds no phone number",
  async run(c, { base }) {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await r.text();
    assert.ok(!/Offline demo/i.test(html), "no 'Offline demo' banner");
    const s = JSON.stringify(await c.state());
    assert.ok(!/\+?(?:44 ?)?7700 ?900 ?\d{3}/.test(s), "no phone number in /api/state");
  },
};

// ---------------------------------------------------------------------------------------------------------

function runNode(args) {
  return new Promise((ok) => {
    execFile(process.execPath, args, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      ok({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

async function natSuite(path) {
  if (!existsSync(join(ROOT, path))) return { ok: false, detail: `${path} not found` };
  const r = await runNode([path, "apps/hub"]);
  let rep = null;
  try { rep = JSON.parse(r.stdout); } catch { /* not JSON */ }
  if (!rep) return { ok: false, detail: `no JSON report (exit ${r.code}) ${r.stderr.split("\n")[0] ?? ""}` };
  const failed = rep.results?.filter((x) => x.result !== "pass").map((x) => x.id) ?? [];
  const passed = rep.scenarios - rep.failed;
  return { ok: r.code === 0 && rep.failed === 0, detail: `${rep.suite} ${passed}/${rep.scenarios}${failed.length ? ` failed: ${failed.join(", ")}` : ""}` };
}

/**
 * Run every check. Used by the CLI below and by test/demo_check.test.mjs.
 * @param {{ nat?: boolean, verbose?: boolean, out?: (line: string) => void }} [opts]
 * @returns {Promise<{ results: { id: string|number, name: string, ok: boolean, ms: number, error?: string }[], passed: number, failed: number }>}
 */
export async function runDemoCheck({ nat = true, verbose = false, out = (l) => console.log(l) } = {}) {
  const { createDemoServer } = await import(pathToFileURL(join(HUB, "src", "demo_web.mjs")).href);
  const { MISSING_CLIPS } = await import(pathToFileURL(join(HUB, "src", "notify.mjs")).href);
  const missingClips = new Set(MISSING_CLIPS.map((x) => x.key));
  const varDir = mkdtempSync(join(tmpdir(), "sauti-demo-check-"));
  const serverLog = [];
  const demo = createDemoServer({ varDir, log: (l) => serverLog.push(l) });
  const results = [];
  const record = (id, name, ok, ms, error, detail) => {
    results.push({ id, name, ok, ms, ...(error ? { error } : {}) });
    out(`${ok ? "PASS" : "FAIL"}  ${String(id).padEnd(4)} ${name}${detail ? ` [${detail}]` : ""} (${ms} ms)${error ? `\n        -> ${error}` : ""}`);
  };
  try {
    const port = await demo.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const c = client(base);
    const st = await c.state();
    if (!st.tagger) out("WARN  the feedback tagger did not load (npm ci --prefix contrib/max/langid): workflows 6 and 8 will fail");
    for (const w of [...WORKFLOWS, PAGE_CHECK]) {
      const t0 = Date.now();
      let error = null;
      try {
        await c.reset();
        await w.run(c, { base, missingClips });
        await c.fresh("other");
      } catch (e) {
        error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      }
      if (serverLog.length) { error ??= `server error: ${serverLog[0]}`; serverLog.length = 0; }
      record(w.id, w.name, !error, Date.now() - t0, error);
      if (verbose || error) for (const l of c.transcript) out(l);
    }
  } finally {
    await demo.close();
    rmSync(varDir, { recursive: true, force: true });
  }
  if (nat) {
    for (const [i, path] of NAT_SUITES.entries()) {
      const t0 = Date.now();
      const r = await natSuite(path);
      record(`nat${i + 1}`, `Nat's suite ${path}`, r.ok, Date.now() - t0, r.ok ? null : r.detail, r.ok ? r.detail : null);
    }
  }
  const passed = results.filter((r) => r.ok).length;
  return { results, passed, failed: results.length - passed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const missing = missingPrerequisites();
  if (missing.length) {
    console.error("demo:check cannot run, missing prerequisites (run from the repo root):");
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(2);
  }
  const args = process.argv.slice(2);
  console.log("Sauti Host hub demo check: the two-phone demo server, driven through its HTTP API (synthetic data, offline)");
  const { passed, failed, results } = await runDemoCheck({ nat: !args.includes("--no-nat"), verbose: args.includes("--verbose") });
  console.log(`\ndemo:check ${failed ? "FAILED" : "OK"}: ${passed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
}
