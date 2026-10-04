// Default transport: inbound items from a fixtures folder, outbound items to JSONL logs. Works in airplane mode.
// Every simulated item must carry "synthetic": true; real adapters implement the same three functions.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function simulatedInbound(folder) {
  return {
    name: "simulated_inbound",
    fetch() {
      if (!existsSync(folder)) return [];
      const items = [];
      for (const f of readdirSync(folder).filter((x) => x.endsWith(".json")).sort()) {
        const data = JSON.parse(readFileSync(join(folder, f), "utf8"));
        for (const it of Array.isArray(data) ? data : [data]) {
          if (it.synthetic !== true) throw new Error(`simulated item without synthetic:true in ${f}`);
          items.push(it);
        }
      }
      return items;
    },
  };
}

export function simulatedOutbound(logPath) {
  const sent = () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    name: "simulated_outbound",
    /** Not idempotent on purpose, like a real SMS gateway: the hub's outbox prevents duplicates. */
    send(item) {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ ...item, simulated: true, at: new Date().toISOString() }) + "\n");
      return { ref: `sim-${item.idempotency_key.slice(0, 12)}` };
    },
    wasSent(key) { return sent().some((s) => s.idempotency_key === key); },
    log: sent,
  };
}
