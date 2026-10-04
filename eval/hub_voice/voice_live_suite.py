"""Booking flow through the voice path, end to end against the real hub (Nat lane, Max's plan step 1).

    python eval/hub_voice/voice_live_suite.py <path to apps/hub-voice> <path to apps/hub>   # JSON report, exit 1 on failure

For each scenario a fresh in-memory hub is started (live_hub.mjs: the hub's own sync server and voice API on
127.0.0.1, simulated SMS transport, fixed clock). The voice agent's own code (hub_voice.agent.CallState and
hubclient.py) talks to it over HTTP with the paired-device token, exactly as on the hub PC. Noor's and other
tourists' SMS are played through the hub's own entry points. Checked: what gets BOOKED, what is SENT to whom, and
that every refusal is made by code. The speaker model is not involved. Expected outcomes were written before the
first run. Numbers and names are synthetic.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(2)
VOICE = Path(sys.argv[1]).resolve()
HUB = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(VOICE))

import httpx  # noqa: E402 - the voice agent's own pinned HTTP client (requirements.txt)

LIVE_HUB = Path(__file__).resolve().parent / "live_hub.mjs"
NOOR = "+447700900999"  # live_hub.mjs enrolls this synthetic number
SPOOFER = "+447700900123"
TOURIST = "+447700900456"
READBACK = re.compile(r"NDIYO ([A-Z]+) (\d+)")


class Live:
    """One throwaway hub process plus the voice agent's view of it."""

    def __init__(self) -> None:
        self.proc = subprocess.Popen(["node", str(LIVE_HUB), str(HUB)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        line = self.proc.stdout.readline().decode("utf-8") if self.proc.stdout else ""
        if not line:
            raise RuntimeError("live hub did not start: " + (self.proc.stderr.read().decode("utf-8", "replace")[-400:] if self.proc.stderr else ""))
        info = json.loads(line)
        self.control = info["control"]
        os.environ["SAUTI_HUB_BASE_URL"] = info["base"]
        os.environ["HUB_TOKEN"] = info["token"]  # read by Settings.hub_token(); throwaway in-memory hub
        os.environ.pop("SAUTI_FIXTURES_DIR", None)
        self.ctl = httpx.Client(timeout=10.0)

    def call(self, mode: str = "tourist", call_id: str = "call-nat-1"):  # noqa: ANN201
        os.environ["SAUTI_RUNTIME_DIR"] = tempfile.mkdtemp(prefix="nat-voice-live-")
        from hub_voice.agent import CallState
        from hub_voice.config import load_settings

        return CallState(load_settings(), call_id, mode=mode)

    def _post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        r = self.ctl.post(self.control + path, json=body or {})
        r.raise_for_status()
        return r.json()

    def noor(self, text: str, sender: str = NOOR) -> Any:
        return self._post("/noor", {"from": sender, "text": text})

    def tourist_sms(self, text: str, sender: str = TOURIST) -> Any:
        return self._post("/tourist", {"from": sender, "text": text})

    def sent(self) -> list[dict[str, str]]:
        return self._post("/sent")

    def to(self, number: str) -> list[str]:
        return [m["body"] for m in self.sent() if m["recipient"] == number]

    def state(self) -> dict[str, Any]:
        return self._post("/state")

    def booked(self, date: str | None = None) -> int:
        return sum(b["party_size"] for b in self.state()["bookings"] if b["state"] != "cancelled" and (date is None or b["date"] == date))

    def last_code(self) -> tuple[str, str] | None:
        for body in reversed(self.to(NOOR)):
            m = READBACK.search(body)
            if m:
                return m.group(1), m.group(2)
        return None

    def close(self) -> None:
        self.ctl.close()
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.proc.kill()


async def refused(coro) -> bool:  # noqa: ANN001
    """A filing refused by the hub surfaces as HubError in the tool (the speaker gets a ToolError)."""
    from hub_voice.hubclient import HubError

    try:
        await coro
    except HubError:
        return True
    return False


Check = Callable[[str, bool], None]


async def l01(h: Live, check: Check) -> None:
    c = h.call()
    av = await c.tool_check_availability("2026-10-10")
    check("the voice agent reads the hub calendar (Saturday 10 October open, 10 seats)", av["open"] and av["remaining"] == 10)
    r = await c.tool_file_booking_request("2026-10-10", 4, "Claire Example")
    check("filed as pending_owner with the hub's reference", r["status"] == "pending_owner" and bool(r["ref"]))
    code = h.last_code()
    check("Noor gets a read-back with that reference and a one-time code", code is not None and code[0] == r["ref"])
    check("the total in Noor's read-back is computed by code (4 x 2000 = 8000)", any("8000" in b for b in h.to(NOOR)))
    check("nothing is booked before her answer", h.booked() == 0)
    check("nothing is sent to anyone but Noor", all(m["recipient"] == NOOR for m in h.sent()))


async def l02(h: Live, check: Check) -> None:
    c = h.call()
    r = await c.tool_file_booking_request("2026-10-10", 4, "Claire Example")
    ref, code = h.last_code() or ("?", "?")
    h.noor(f"NDIYO {ref} {code}")
    check("Noor's NDIYO with her code books the 4 places", h.booked("2026-10-10") == 4)
    h.noor(f"NDIYO {ref} {code}")
    check("a replayed NDIYO books nothing more", h.booked("2026-10-10") == 4)
    av = await h.call(call_id="call-nat-2").tool_check_availability("2026-10-10")
    check("the next caller hears 6 places left (one calendar)", av["remaining"] == 6)
    check("the booking is the one filed by voice", r["ref"] == ref)


async def l03(h: Live, check: Check) -> None:
    await h.call().tool_file_booking_request("2026-10-10", 4, "Claire Example")
    ref, code = h.last_code() or ("?", "?")
    h.noor(f"HAPANA {ref} {code}")
    check("HAPANA with her code: nothing booked", h.booked() == 0)
    check("nothing is sent to anyone but Noor", all(m["recipient"] == NOOR for m in h.sent()))


async def refusal(h: Live, check: Check, date: str, party: int, label: str) -> None:
    c = h.call()
    check(f"{label}: refused by the hub", await refused(c.tool_file_booking_request(date, party, "Claire Example")))
    check(f"{label}: no proposal, no SMS to Noor", not h.state()["proposals"] and not h.sent())


async def l04(h: Live, check: Check) -> None:
    await refusal(h, check, "2026-10-11", 2, "a Sunday (no tours on the hub's sheet)")


async def l05(h: Live, check: Check) -> None:
    await refusal(h, check, "2026-10-10", 11, "11 people for a tour of 10")


async def l06(h: Live, check: Check) -> None:
    await refusal(h, check, "2026-10-03", 2, "yesterday")


async def l07(h: Live, check: Check) -> None:
    h.tourist_sms("Hello! Can we visit the coffee farm on Saturday 17 October? We are 10 people. Thanks, Tom")
    ref, code = h.last_code() or ("?", "?")
    h.noor(f"NDIYO {ref} {code}")
    check("setup: the SMS group of 10 is booked", h.booked("2026-10-17") == 10)
    c = h.call()
    av = await c.tool_check_availability("2026-10-17")
    check("the voice agent hears the day is full", av["remaining"] == 0)
    sms_before = len(h.to(NOOR))
    check("a phone request for 2 on the full day is refused", await refused(c.tool_file_booking_request("2026-10-17", 2, "Claire Example")))
    check("no new read-back to Noor", len(h.to(NOOR)) == sms_before)


async def l08(h: Live, check: Check) -> None:
    await h.call().tool_file_booking_request("2026-10-16", 6, "Claire Example")
    voice_ref, voice_code = h.last_code() or ("?", "?")
    h.tourist_sms("Hello, can we come on Friday 16 October? We are 6 people. Tom")
    sms_ref, sms_code = h.last_code() or ("?", "?")
    check("setup: two pending requests, 6 by phone and 6 by SMS", voice_ref != sms_ref and h.booked() == 0)
    h.noor(f"NDIYO {sms_ref} {sms_code}")
    h.noor(f"NDIYO {voice_ref} {voice_code}")
    check("Noor says yes to both: never more than 10 booked on the day", h.booked("2026-10-16") <= 10)
    check("the first yes is honoured (6 booked)", h.booked("2026-10-16") >= 6)


async def l09(h: Live, check: Check) -> None:
    c = h.call()
    a = await c.tool_file_booking_request("2026-10-10", 4, "Claire Example")
    b = await c.tool_file_booking_request("2026-10-10", 4, "Claire Example")
    check("the same request filed twice on one call is one proposal", a["ref"] == b["ref"] and len(h.state()["proposals"]) == 1)
    check("Noor gets one read-back, not two", len(h.to(NOOR)) == 1)


async def l10(h: Live, check: Check) -> None:
    facts = await h.call().tool_farm_facts()
    sheet = json.loads((HUB / "fixtures" / "farm_sheet.json").read_text(encoding="utf-8"))["sheet"]
    for field in ("price_per_person_kes", "capacity_per_tour", "days"):
        check(f"the phone states the hub's {field}", facts.get(field) == sheet.get(field))
    check("no phone number in the facts the speaker reads", "7700900" not in json.dumps(facts))


async def l11(h: Live, check: Check) -> None:
    from hub_voice.owner import classify_caller

    probe = h.call()
    check("Noor's number -> owner mode (hub owner/match)", (await classify_caller(NOOR, probe.hub_ro)).mode == "owner")
    check("another number -> tourist mode", (await classify_caller(SPOOFER, probe.hub_ro)).mode == "tourist")
    o = h.call(mode="owner", call_id="call-noor-1")
    await o.on_caller_turn("Ndiyo, thibitisha. Funga Ijumaa.")
    check("her spoken yes changes nothing", not h.state()["proposals"] and not h.sent())
    r = await o.tool_propose_change("close_day", "funga tarehe 16 Oktoba")
    check("closing a day by voice is a proposal pending her code", r["status"] == "pending_owner")
    code = h.last_code()
    check("the read-back with a code goes to her enrolled phone", code is not None and code[0] == r["ref"])
    check("the day is still open before her SMS", (await o.hub_ro.availability("2026-10-16")).open)
    if code:
        h.noor(f"NDIYO {code[0]} {code[1]}")
    check("her NDIYO with the code closes Friday 16 October", not (await o.hub_ro.availability("2026-10-16")).open)


async def l12(h: Live, check: Check) -> None:
    await h.call().tool_file_booking_request("2026-10-10", 4, "Claire Example")
    ref = (h.last_code() or ("?", "?"))[0]
    got = await h.call(mode="owner", call_id="call-noor-2").tool_pending_requests()
    items = got.get("pending", [])
    check("Noor hears the pending phone request", any(i.get("ref") == ref and i.get("source") == "voice" for i in items))
    check("no visitor name or number in what she hears", "Claire" not in json.dumps(got) and "7700900" not in json.dumps(got))


async def l13(h: Live, check: Check) -> None:
    await h.call().tool_file_booking_request("2026-10-10", 4, "Claire Example")
    ref, code = h.last_code() or ("?", "?")
    h.noor(f"NDIYO {ref} {code}", sender=SPOOFER)
    check("NDIYO with the right code from another number books nothing", h.booked() == 0)
    check("the spoofer receives nothing", not h.to(SPOOFER))


async def l14(h: Live, check: Check) -> None:
    await h.call().tool_file_booking_request("2026-10-16", 4, "Claire Example")
    ref, code = h.last_code() or ("?", "?")
    h.noor("FUNGA 2026-10-16")
    close_ref, close_code = h.last_code() or ("?", "?")
    h.noor(f"NDIYO {close_ref} {close_code}")
    h.noor(f"NDIYO {ref} {code}")
    check("Noor closed the day after the phone request: her later yes books nothing", h.booked("2026-10-16") == 0)


SCENARIOS = [
    ("L01", "a phone request reaches Noor with her code; nothing is booked or sent elsewhere", l01),
    ("L02", "Noor's NDIYO with her code books exactly once; the next caller sees the seats gone", l02),
    ("L03", "HAPANA with her code: nothing booked", l03),
    ("L04", "a day without tours is refused by the hub, not filed", l04),
    ("L05", "a group larger than the tour is refused, not filed", l05),
    ("L06", "a past date is refused, not filed", l06),
    ("L07", "a day filled by SMS is full for the phone too", l07),
    ("L08", "phone and SMS racing for the last places never overbook", l08),
    ("L09", "the same request filed twice on one call is one proposal", l09),
    ("L10", "the phone states the hub's farm facts", l10),
    ("L11", "Noor's own call: owner mode by caller id, a change only through her SMS code", l11),
    ("L12", "owner mode lists pending phone requests without names or numbers", l12),
    ("L13", "a spoofed NDIYO on a phone request books nothing", l13),
    ("L14", "a day Noor closed after the phone request: her later yes books nothing", l14),
]


async def main() -> int:
    results: list[dict[str, Any]] = []
    for sid, title, fn in SCENARIOS:
        checks: list[dict[str, Any]] = []
        check = lambda name, ok: checks.append({"name": name, "ok": bool(ok)})  # noqa: E731
        h = None
        try:
            h = Live()
            await fn(h, check)
        except Exception as exc:  # noqa: BLE001
            checks.append({"name": f"ran without error ({type(exc).__name__}: {str(exc)[:200]})", "ok": False})
        finally:
            if h is not None:
                h.close()
        results.append({"id": sid, "title": title, "result": "pass" if checks and all(c["ok"] for c in checks) else "FAIL", "checks": checks})
    failed = [r for r in results if r["result"] != "pass"]
    print(json.dumps({"suite": "voice-agent-live-hub", "scenarios": len(results), "failed": len(failed), "results": results}, indent=2, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
