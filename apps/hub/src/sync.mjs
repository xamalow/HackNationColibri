// Sync server for Noor's offline app (README requirement 4). node:http only, no framework.
//
//   GET  /v1/health                     public, no data beyond {ok:true}
//   GET  /v1/events?since=<seq>&limit=  paired device only -> { events, next, has_more } (max 200 per page)
//   POST /v1/owner-actions              paired device only -> 202 { request_id, state: "pending", applied: false }
//   voice agent routes (voice_api.mjs)  paired device only, when createSyncServer gets `voice`: /v1/availability,
//                                       /v1/farm, /v1/owner/match, /v1/proposals, /v1/feedback/summary,
//                                       /v1/owner-proposals (bodies 16 KB max)
//
// POST /v1/owner-actions NEVER applies an approval. It records the device's request as "pending" for the hub's
// approval path; the core's approveExact inside the owner's PIN session stays the only authority. A replayed
// request (same device, action, digest, decision) returns the same request_id.
//
// Auth: "Authorization: Bearer <token>". Tokens are issued once by pairDevice (printed once to the operator) and
// only their SHA-256 is stored, in kv "sync.tokens" with the device id. Comparison is constant-time over all
// stored hashes. No CORS headers at all (the app is native, not a browser origin). Bodies: JSON only, 64 KB max.
// Logs carry method, route, status and device id only: never tokens, bodies, query values, names or numbers.
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { VOICE_MAX_BODY_BYTES } from "./voice_api.mjs";

export const TOKENS_KV = "sync.tokens";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PAGE = 200;
const OWNER_ACTION_KINDS = new Set(["send_message", "book_slot", "record_payment", "publish_listing", "reply_to_review"]);
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/;

const OWNER_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_action_requests (
  request_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, action_id TEXT NOT NULL, kind TEXT NOT NULL,
  rendered_digest TEXT NOT NULL, decision TEXT NOT NULL, client_ref TEXT, state TEXT NOT NULL,
  received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (device_id, action_id, rendered_digest, decision));
`;

const hashToken = (token) => createHash("sha256").update(token, "utf8").digest();

// ---------------------------------------------------------------- pairing (hub operator side)

/** Issue a new token for deviceId (re-pairing rotates it). Returns the token ONCE; only its hash is stored. */
export function pairDevice(store, deviceId, { now = () => new Date() } = {}) {
  if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) throw new Error("device id must match [A-Za-z0-9._-]{1,64}");
  const token = `sst_${randomBytes(32).toString("base64url")}`;
  const entry = { device_id: deviceId, token_sha256: hashToken(token).toString("hex"), created_at: now().toISOString() };
  store.transaction(() => {
    const list = store.getKV(TOKENS_KV, []).filter((t) => t.device_id !== deviceId);
    list.push(entry);
    store.setKV(TOKENS_KV, list);
  });
  return token;
}

/** Remove a device's token. Returns true if it existed. */
export function revokeDevice(store, deviceId) {
  return store.transaction(() => {
    const list = store.getKV(TOKENS_KV, []);
    const kept = list.filter((t) => t.device_id !== deviceId);
    store.setKV(TOKENS_KV, kept);
    return kept.length !== list.length;
  });
}

/** Constant-time lookup: hashes the presented token and compares against EVERY stored hash. */
export function authenticate(presented, entries) {
  if (typeof presented !== "string") return null;
  const got = hashToken(presented);
  let match = null;
  for (const e of entries) {
    const want = typeof e?.token_sha256 === "string" && HEX64_RE.test(e.token_sha256) ? Buffer.from(e.token_sha256, "hex") : null;
    // Compare against a dummy on malformed entries so the loop does the same work for every entry.
    const ok = timingSafeEqual(got, want ?? Buffer.alloc(32)) && want !== null;
    if (ok && match === null) match = e.device_id;
  }
  return match;
}

// ---------------------------------------------------------------- pending owner actions (hub approval path reads these)

export function ensureSyncSchema(store) { store.db.exec(OWNER_ACTIONS_SCHEMA); }

/** Requests from paired devices awaiting the hub's approval path (approveExact in the owner's PIN session). */
export function pendingOwnerActions(store) {
  ensureSyncSchema(store);
  return store.db.prepare(
    "SELECT request_id, device_id, action_id, kind, rendered_digest, decision, client_ref, state, received_at FROM owner_action_requests WHERE state = ? ORDER BY received_at, request_id",
  ).all("pending").map((r) => ({ ...r }));
}

/** Called by the approval path once it has acted (or refused): state = "applied" | "refused" | "superseded". */
export function markOwnerAction(store, requestId, state, { now = () => new Date() } = {}) {
  if (!["applied", "refused", "superseded"].includes(state)) throw new Error("invalid owner action state");
  ensureSyncSchema(store);
  return store.db.prepare("UPDATE owner_action_requests SET state = ?, updated_at = ? WHERE request_id = ? AND state = ?")
    .run(state, now().toISOString(), requestId, "pending").changes === 1;
}

// ---------------------------------------------------------------- HTTP

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function sendJson(res, status, obj, extra = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

const sendError = (res, status, code, message, extra) => sendJson(res, status, { error: { code, message } }, extra);

/** Read a JSON body with a hard byte cap. Resolves the parsed object or rejects with HttpError. */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const ctype = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (ctype !== "application/json") return reject(new HttpError(415, "unsupported_media_type", "Content-Type must be application/json"));
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) return reject(new HttpError(413, "payload_too_large", `body exceeds ${limit} bytes`));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(new HttpError(413, "payload_too_large", `body exceeds ${limit} bytes`)); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new HttpError(400, "invalid_json", "body is not valid JSON")); }
    });
    req.on("error", () => { if (!failed) { failed = true; reject(new HttpError(400, "bad_request", "request stream error")); } });
  });
}

function validateOwnerAction(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_body", "body must be a JSON object");
  const allowed = new Set(["action_id", "kind", "rendered_digest", "decision", "client_ref"]);
  for (const k of Object.keys(body)) if (!allowed.has(k)) throw new HttpError(400, "unknown_field", `unknown field: ${k.slice(0, 40)}`);
  const { action_id, kind, rendered_digest, decision, client_ref } = body;
  if (typeof action_id !== "string" || !UUID_RE.test(action_id)) throw new HttpError(400, "invalid_action_id", "action_id must be a lowercase UUID");
  if (typeof kind !== "string" || !OWNER_ACTION_KINDS.has(kind)) throw new HttpError(400, "invalid_kind", "kind is not an action envelope kind");
  if (typeof rendered_digest !== "string" || !HEX64_RE.test(rendered_digest)) throw new HttpError(400, "invalid_digest", "rendered_digest must be 64 lowercase hex chars");
  if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "invalid_decision", 'decision must be "approve" or "reject"');
  if (client_ref !== undefined && (typeof client_ref !== "string" || client_ref.length < 1 || client_ref.length > 128)) {
    throw new HttpError(400, "invalid_client_ref", "client_ref must be a string of 1..128 chars");
  }
  return { action_id, kind, rendered_digest, decision, client_ref: client_ref ?? null };
}

function parseNonNegInt(raw, name, fallback) {
  if (raw === null) return fallback;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `invalid_${name}`, `${name} must be a non-negative integer`);
  return Number(raw);
}

/**
 * @param {object} opts
 * @param {ReturnType<import("./store.mjs").openStore>} opts.store
 * @param {Array<{device_id:string, token_sha256:string}> | (() => Array) } [opts.tokens]
 *        Token hash entries. Default: read kv "sync.tokens" on every request, so newly paired devices work at once.
 * @param {(line: object) => void} [opts.log] structured access log; receives {method, route, status, device} only.
 * @param {() => Date} [opts.now]
 * @param {ReturnType<import("./voice_api.mjs").createVoiceApi>} [opts.voice] the voice agent's routes; absent -> 404.
 */
export function createSyncServer({ store, tokens, log = defaultLog, now = () => new Date(), maxBodyBytes = MAX_BODY_BYTES, voice = null } = {}) {
  if (!store) throw new Error("createSyncServer needs a store");
  ensureSyncSchema(store);
  const tokenEntries = typeof tokens === "function" ? tokens : Array.isArray(tokens) ? () => tokens : () => store.getKV(TOKENS_KV, []);
  const pageStmt = store.db.prepare("SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?");
  const insertReq = store.db.prepare(
    `INSERT INTO owner_action_requests (request_id, device_id, action_id, kind, rendered_digest, decision, client_ref, state, received_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (device_id, action_id, rendered_digest, decision) DO NOTHING`,
  );
  const findReq = store.db.prepare(
    "SELECT request_id, state FROM owner_action_requests WHERE device_id = ? AND action_id = ? AND rendered_digest = ? AND decision = ?",
  );

  async function handle(req, res, ctx) {
    const url = new URL(req.url, "http://hub.invalid");
    ctx.route = url.pathname.length <= 64 ? url.pathname : "(long)";

    if (url.pathname === "/v1/health") {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      return sendJson(res, 200, { ok: true });
    }
    if (!url.pathname.startsWith("/v1/")) throw new HttpError(404, "not_found", "no such route");

    const m = BEARER_RE.exec(String(req.headers.authorization || ""));
    const device = m ? authenticate(m[1], tokenEntries() || []) : null;
    if (!device) throw new HttpError(401, "unauthorized", "missing or invalid bearer token");
    ctx.device = device;

    if (url.pathname === "/v1/events") {
      if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      const since = parseNonNegInt(url.searchParams.get("since"), "since", 0);
      const limit = Math.min(Math.max(parseNonNegInt(url.searchParams.get("limit"), "limit", MAX_PAGE), 1), MAX_PAGE);
      const rows = pageStmt.all(since, limit + 1);
      const page = rows.slice(0, limit).map((r) => ({ ...JSON.parse(r.body), seq: r.seq }));
      const next = page.length ? page[page.length - 1].seq : since;
      return sendJson(res, 200, { events: page, next, has_more: rows.length > limit });
    }

    if (url.pathname === "/v1/owner-actions") {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const body = validateOwnerAction(await readJsonBody(req, maxBodyBytes));
      const at = now().toISOString();
      insertReq.run(randomUUID(), device, body.action_id, body.kind, body.rendered_digest, body.decision, body.client_ref, at, at);
      const row = findReq.get(device, body.action_id, body.rendered_digest, body.decision);
      return sendJson(res, 202, {
        request_id: row.request_id,
        state: row.state,
        applied: false,
        note: "recorded for the hub approval path; approval happens only in the owner's PIN session",
      });
    }

    if (voice) {
      const r = await voice.handle({ method: req.method, url, device, readBody: () => readJsonBody(req, Math.min(maxBodyBytes, VOICE_MAX_BODY_BYTES)) });
      if (r) return sendJson(res, r.status, r.body);
    }

    throw new HttpError(404, "not_found", "no such route");
  }

  const server = createServer((req, res) => {
    const ctx = { route: "?", device: null };
    res.on("finish", () => { try { log({ method: req.method, route: ctx.route, status: res.statusCode, device: ctx.device }); } catch { /* logging never breaks a request */ } });
    handle(req, res, ctx).catch((err) => {
      if (err instanceof HttpError) {
        const extra = err.status === 413 ? { Connection: "close" } : {};
        sendError(res, err.status, err.code, err.message, extra);
        if (err.status === 413) drainThenDrop(req);
      } else {
        sendError(res, 500, "internal", "internal error");
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.maxHeadersCount = 64;
  return server;
}

/** After a 413, swallow what the client is still sending (so it can read the response) but cap it. */
function drainThenDrop(req) {
  let drained = 0;
  req.on("data", (c) => { drained += c.length; if (drained > 4 * MAX_BODY_BYTES) req.socket.destroy(); });
  req.resume();
}

function defaultLog({ method, route, status, device }) {
  process.stderr.write(`[sync] ${new Date().toISOString()} ${method} ${route} ${status} device=${device ?? "-"}\n`);
}

// ---------------------------------------------------------------- CLI: pair a device / serve
//   node apps/hub/src/sync.mjs pair <device-id> [--db hub.db]   prints the token ONCE
//   node apps/hub/src/sync.mjs serve [--db hub.db] [--port 8787] [--host 127.0.0.1] [--sheet farm_sheet.json]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openStore } = await import("./store.mjs");
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
  const store = openStore(opt("db", process.env.SAUTI_HUB_DB || "hub.db"));
  if (args[0] === "pair" && args[1]) {
    const token = pairDevice(store, args[1]);
    process.stdout.write(`Paired device ${args[1]}. Enter this token in the app now; it is not stored and will not be shown again:\n${token}\n`);
    store.close();
  } else if (args[0] === "serve") {
    const host = opt("host", "127.0.0.1");
    const port = Number(opt("port", "8787"));
    // The voice agent's routes: the farm sheet, the outbox (simulated by default) and Max's tagger when installed.
    const { loadFarmSheet } = await import("./bookings.mjs");
    const { createOutbox } = await import("./outbox.mjs");
    const { createVoiceApi } = await import("./voice_api.mjs");
    const tagger = await import("../../../contrib/max/tagger/tag_feedback.mjs").then((m) => m.tagFeedback, () => null);
    const sheetPath = opt("sheet", null);
    const voice = createVoiceApi({ store, sheet: sheetPath ? loadFarmSheet(sheetPath) : loadFarmSheet(), outbox: createOutbox(store), tagger });
    createSyncServer({ store, voice }).listen(port, host, () => process.stderr.write(`[sync] listening on http://${host}:${port}\n`));
  } else {
    process.stderr.write("usage: sync.mjs pair <device-id> [--db path] | serve [--db path] [--port n] [--host h] [--sheet farm_sheet.json]\n");
    process.exitCode = 2;
  }
}
