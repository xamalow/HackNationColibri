// End-to-end demo of Noor's app syncing with the hub (requirement 4). Runs offline on localhost.
//
//   node apps/hub/src/demo-sync-client.mjs
//       starts an in-memory hub on an ephemeral localhost port, seeds synthetic events, pairs a device,
//       pulls every page of events, posts an owner action, and shows it waiting as "pending".
//   SAUTI_HUB_URL=http://127.0.0.1:8787 SAUTI_SYNC_TOKEN=... node apps/hub/src/demo-sync-client.mjs
//       acts as a pure client against a running hub (token from `sync.mjs pair <device>`).
//
// The posted action does NOT approve anything: the hub records it as pending; approval happens only through the
// core's approveExact in Noor's PIN session.
import { createHash, randomUUID } from "node:crypto";

async function pullAll(base, token) {
  const events = [];
  let since = 0;
  for (;;) {
    const r = await fetch(`${base}/v1/events?since=${since}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status !== 200) throw new Error(`events: HTTP ${r.status} ${(await r.json()).error?.code}`);
    const page = await r.json();
    events.push(...page.events);
    console.log(`  pulled ${page.events.length} event(s), cursor ${since} -> ${page.next}`);
    since = page.next;
    if (!page.has_more) return { events, cursor: since };
  }
}

async function postOwnerAction(base, token, action) {
  const r = await fetch(`${base}/v1/owner-actions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(action),
  });
  return { status: r.status, body: await r.json() };
}

async function main() {
  let base = process.env.SAUTI_HUB_URL;
  let token = process.env.SAUTI_SYNC_TOKEN;
  let local = null;

  if (!base || !token) {
    const { openStore } = await import("./store.mjs");
    const { createSyncServer, pairDevice, pendingOwnerActions } = await import("./sync.mjs");
    const store = openStore(":memory:");
    for (let i = 1; i <= 3; i++) {
      store.addEvent({ id: `demo-${i}`, kind: "booking", channel: "email_gyg", received_at: `2026-10-0${i}T08:00:00Z`, synthetic: true,
        booking: { platform: "getyourguide", ref: `SIM-${i}`, date: `2026-10-1${i}`, party_size: i + 1, visitor_name: "Synthetic Visitor" } });
    }
    console.log("hub: in-memory store with 3 synthetic booking events");
    token = pairDevice(store, "demo-iphone");
    console.log("hub: paired device demo-iphone (token issued once, not shown in this demo)");
    const server = createSyncServer({ store, log: () => {} });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    local = { server, store, pendingOwnerActions };
  }

  console.log(`app: health -> ${(await fetch(`${base}/v1/health`)).status}`);
  const noAuth = await fetch(`${base}/v1/events?since=0`);
  console.log(`app: events without token -> ${noAuth.status}`);
  await noAuth.body?.cancel();

  console.log("app: syncing events");
  const { events, cursor } = await pullAll(base, token);
  for (const e of events) console.log(`  #${e.seq} ${e.kind} ${e.booking?.platform ?? ""} ${e.booking?.date ?? ""} party ${e.booking?.party_size ?? "?"}${e.synthetic ? " [synthetic]" : ""}`);
  console.log(`app: saved cursor ${cursor}`);

  // In the real app action_id and rendered_digest come from the proposal card Noor saw; here they are synthetic.
  const action = { action_id: randomUUID(), kind: "book_slot", rendered_digest: createHash("sha256").update("demo card").digest("hex"), decision: "approve" };
  const posted = await postOwnerAction(base, token, action);
  console.log(`app: owner action -> HTTP ${posted.status} state=${posted.body.state} applied=${posted.body.applied}`);

  if (local) {
    const pending = local.pendingOwnerActions(local.store);
    console.log(`hub: ${pending.length} owner action(s) pending for the approval path (PIN session), none applied`);
    local.server.closeAllConnections();
    local.server.close();
    local.store.close();
  }
}

main().catch((e) => { console.error(`demo failed: ${e.message}`); process.exitCode = 1; });
