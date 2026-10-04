"""The hub (apps/hub) as seen from the voice agent.

Two deliberately separate objects:

- HubReadOnly: availability, approved farm facts, owner match, pending requests,
  feedback summary. Sidecars get this one.
- HubActions: files a booking REQUEST (a proposal that reaches Noor as a read-back
  SMS through the hub and @sauti/core) or an owner PROPOSAL. Only the speaker's
  tools hold this one.

Neither confirms a booking: confirmation is Noor's exact approval, by Sauti PIN in
the app or by "NDIYO <ref> <code>" from her enrolled phone. With no hub URL
configured both answer from local fixtures and write to a local JSONL outbox under
runtime/ (gitignored), so the whole flow runs offline for the demo.

The hub's routes (apps/hub/src/voice_api.mjs, merged #45; same bearer token as /v1/events):
  GET  /v1/availability?date=YYYY-MM-DD   -> {date, capacity, confirmed, remaining, open, reason}
  GET  /v1/farm                           -> approved farm sheet with overrides, private keys removed
  GET  /v1/owner/match?sha256=<hex>       -> {match: true|false}   (30/min per device; owner MODE only, grants nothing)
  GET  /v1/proposals?status=pending_owner -> {pending: [{ref, date, party_size, source, filed_at}]}  (no names, no numbers)
  GET  /v1/feedback/summary               -> {period, themes: [{theme, verdict, direction, unique_comments, summary_sw}], ask_a_person, status}
  POST /v1/proposals                      -> 201 {ref, action_id, status: "pending_owner", expires_at}; 200 same ref on a retry;
                                             409 {status: "unavailable", reason, facts}; 422 {status: "invalid", reason};
                                             429/503 {status: "needs_owner", reason}
  POST /v1/owner-proposals                -> 201 {ref, action_id, status: "pending_owner", kind, expires_at};
                                             422 {status: "invalid", reason}; 429 {status: "needs_owner", reason: "budget_exhausted"}
Outbound alert calls (warden #47770; the hub lists, hub-voice dials):
  GET  /v1/owner-alerts/pending           -> {pending: [{alert_id, device_id, clip_keys, urgent, created_at}]}  (never a number)
  POST /v1/owner-alerts/{alert_id}/result -> {status, played, missing, reason?}; poller facts refused|simulated|dispatched|dispatch_unknown
                                             (dispatch_unknown is non-final, reconcilable), worker facts answered|no_answer|failed (final)
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import require_loopback
from .redact import redact_text

try:  # httpx is only needed against a real hub
    import httpx
except Exception:  # pragma: no cover - optional at import time
    httpx = None  # type: ignore[assignment]

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_PARTY = 200


class HubError(RuntimeError):
    pass


@dataclass(frozen=True)
class Availability:
    date: str
    capacity: int
    confirmed: int
    open: bool
    """Why the day is not open: past / closed_by_owner / platform_blocked / not_a_tour_day / ask_a_person; None when open."""
    reason: str | None = None

    @property
    def remaining(self) -> int:
        return max(0, self.capacity - self.confirmed) if self.open else 0

    def as_dict(self) -> dict[str, Any]:
        return {"date": self.date, "capacity": self.capacity, "confirmed": self.confirmed, "remaining": self.remaining, "open": self.open, "reason": self.reason}


def _check_date(date: str) -> None:
    if not DATE.match(date):
        raise HubError("date must be YYYY-MM-DD")


def _reason(data: Any) -> str | None:
    if isinstance(data, dict) and isinstance(data.get("reason"), str) and data["reason"]:
        return data["reason"][:64]
    return None


class HubReadOnly:
    """Queries only. No method here changes anything anywhere."""

    def __init__(self, base_url: str, token: str, fixtures_dir: Path, timeout_s: float = 1.0) -> None:
        self._base = require_loopback("SAUTI_HUB_BASE_URL", base_url).rstrip("/")
        self._token = token
        self._fixtures = fixtures_dir
        self._timeout = timeout_s

    @property
    def simulated(self) -> bool:
        return not self._base

    async def availability(self, date: str) -> Availability:
        _check_date(date)
        if self.simulated:
            cal = json.loads((self._fixtures / "availability.json").read_text(encoding="utf-8"))
            day = cal.get("days", {}).get(date)
            if day is None:
                weekday = time.strftime("%a", time.strptime(date, "%Y-%m-%d")).lower()[:3]
                open_days = {d[:3].lower() for d in cal.get("open_weekdays", [])}
                is_open = weekday in open_days
                return Availability(date=date, capacity=int(cal.get("capacity_per_tour", 0)), confirmed=0, open=is_open, reason=None if is_open else "not_a_tour_day")
            is_open = bool(day.get("open", True))
            return Availability(date=date, capacity=int(day.get("capacity", cal.get("capacity_per_tour", 0))), confirmed=int(day.get("confirmed", 0)), open=is_open, reason=None if is_open else str(day.get("reason", "closed_by_owner")))
        data = await self._get("/v1/availability", {"date": date})
        return Availability(date=str(data["date"]), capacity=int(data["capacity"]), confirmed=int(data["confirmed"]), open=bool(data.get("open", True)), reason=_reason(data))

    async def farm_facts(self) -> dict[str, Any]:
        """The approved farm sheet (prices, hours, days, directions, inclusions). Facts the speaker may state."""
        if self.simulated:
            return json.loads((self._fixtures / "farm.json").read_text(encoding="utf-8"))
        return await self._get("/v1/farm", {})

    async def owner_match(self, caller_sha256: str) -> bool:
        """Does this caller-id hash belong to the tenant's enrolled owner phone? Selects owner MODE only; grants nothing."""
        if not re.fullmatch(r"[0-9a-f]{64}", caller_sha256):
            return False
        try:
            if self.simulated:
                owner = json.loads((self._fixtures / "owner.json").read_text(encoding="utf-8"))
                return owner.get("enrolled_number_sha256") == caller_sha256
            data = await self._get("/v1/owner/match", {"sha256": caller_sha256})
        except Exception:  # noqa: BLE001 - any doubt (unreachable, timeout, 429, bad JSON, bad status) is NOT the owner
            return False
        # Only a literal JSON true counts. "true", 1, "yes", a missing key or a non-object are all NOT the owner.
        return isinstance(data, dict) and data.get("match") is True

    async def pending_requests(self) -> list[dict[str, Any]]:
        """Requests waiting for Noor: refs, dates, party sizes, source. Never visitor names or numbers."""
        if self.simulated:
            data = json.loads((self._fixtures / "pending.json").read_text(encoding="utf-8"))
        else:
            data = await self._get("/v1/proposals", {"status": "pending_owner"})
        out: list[dict[str, Any]] = []
        for item in data.get("pending", []) if isinstance(data, dict) else []:
            if isinstance(item, dict):
                out.append({k: item[k] for k in ("ref", "date", "party_size", "source", "filed_at") if k in item})
        return out

    async def feedback_summary(self) -> dict[str, Any]:
        """The feedback loop's painpoint summary (apps/hub/src/feedback): themes with counts, no quotes."""
        if self.simulated:
            return json.loads((self._fixtures / "feedback_summary.json").read_text(encoding="utf-8"))
        return await self._get("/v1/feedback/summary", {})

    async def pending_alert_calls(self) -> list[dict[str, Any]]:
        """Owner-alert calls the hub wants placed: {alert_id, device_id, clip_keys, urgent}. Never a phone number."""
        if self.simulated:
            path = self._fixtures / "pending_alerts.json"
            data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"pending": []}
        else:
            data = await self._get("/v1/owner-alerts/pending", {})
        items = data.get("pending", []) if isinstance(data, dict) else []
        return [i for i in items if isinstance(i, dict)]

    async def _get(self, path: str, params: dict[str, str]) -> Any:
        if httpx is None:
            raise HubError("httpx is not installed")
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False, trust_env=False) as client:
                r = await client.get(self._base + path, params=params, headers=headers)
        except Exception as exc:  # network errors are reported, never logged with URLs that may carry tokens
            raise HubError(f"hub unreachable: {type(exc).__name__}") from exc
        if r.status_code != 200:
            raise HubError(f"hub answered {r.status_code}")
        return r.json()


@dataclass(frozen=True)
class BookingRequest:
    date: str
    party_size: int
    visitor_name: str
    language: str
    note: str = ""


@dataclass(frozen=True)
class FiledRequest:
    ref: str
    action_id: str
    status: str  # always "pending_owner" from here: the agent never confirms
    expires_at: str | None = None


@dataclass(frozen=True)
class FilingRefused:
    """The hub refused to file: nothing is pending. The speaker says why and offers the next step."""

    status: str  # "unavailable" (409) | "invalid" (422) | "needs_owner" (429/503)
    reason: str
    facts: dict[str, Any] = field(default_factory=dict)


FilingOutcome = FiledRequest | FilingRefused

OWNER_CHANGE_KINDS = ("running_late", "close_day", "open_day", "capacity", "message_to_visitor", "other")


class HubActions:
    """The writes the speaker may perform: file a booking request, or an owner proposal, for Noor to approve."""

    def __init__(self, base_url: str, token: str, runtime_dir: Path, tenant_id: str, timeout_s: float = 3.0, fixtures_dir: Path | None = None) -> None:
        self._base = require_loopback("SAUTI_HUB_BASE_URL", base_url).rstrip("/")
        self._token = token
        self._runtime = runtime_dir
        self._tenant = tenant_id
        self._timeout = timeout_s
        self._fixtures = fixtures_dir

    @property
    def simulated(self) -> bool:
        return not self._base

    async def file_booking_request(self, req: BookingRequest, call_id: str) -> FilingOutcome:
        _check_date(req.date)
        if req.party_size < 1 or req.party_size > MAX_PARTY:
            raise HubError(f"party_size must be 1..{MAX_PARTY}")
        body = {
            "tenant_id": self._tenant,
            "source": {"channel": "voice", "call_id": call_id},
            "booking": {"date": req.date, "party_size": req.party_size, "visitor_name": redact_text(req.visitor_name)[:80], "language": req.language},
            "note": redact_text(req.note)[:280],
        }
        if self.simulated:
            refused = await self._simulated_availability_check(req)
            if refused is not None:
                return refused
            n, ref, action_id = self._append_jsonl("proposals.jsonl", lambda n: chr(ord("A") + (n % 26)), "simulated", body)
            return FiledRequest(ref=ref, action_id=action_id, status="pending_owner")
        status, data = await self._post("/v1/proposals", body)
        return self._outcome(status, data)

    async def file_owner_proposal(self, kind: str, text: str, about_ref: str | None, call_id: str, date: str | None = None, capacity: int | None = None) -> FilingOutcome:
        """Noor asked for a change by voice ("nitachelewa kidogo", "funga Jumamosi"). This files a PROPOSAL; the hub reads
        it back to her enrolled phone with a one-time code. Her voice did not approve anything, and neither does this call.
        `date` and `capacity` are sent when the speaker has them, so the hub need not parse them from the text."""
        if kind not in OWNER_CHANGE_KINDS:
            raise HubError("unknown change kind")
        change: dict[str, Any] = {"kind": kind, "text": redact_text(text)[:280], "about_ref": (about_ref or "")[:8]}
        if date:
            _check_date(date)
            change["date"] = date
        if capacity is not None:
            if not isinstance(capacity, int) or capacity < 1 or capacity > MAX_PARTY:
                raise HubError(f"capacity must be 1..{MAX_PARTY}")
            change["capacity"] = capacity
        body = {"tenant_id": self._tenant, "source": {"channel": "voice_owner", "call_id": call_id}, "change": change}
        if self.simulated:
            n, ref, action_id = self._append_jsonl("owner-proposals.jsonl", lambda n: f"N{n + 1}", "simulated-owner", {**body, "read_back": "sms_with_code_to_enrolled_phone"})
            return FiledRequest(ref=ref, action_id=action_id, status="pending_owner")
        status, data = await self._post("/v1/owner-proposals", body)
        return self._outcome(status, data)

    async def report_alert_call(self, alert_id: str, payload: dict[str, Any]) -> None:
        """Tell the hub what happened to an owner-alert call (refused / simulated / dispatched / answered / no_answer / failed). Not an approval of anything."""
        if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", alert_id):
            raise HubError("bad alert id")
        if self.simulated:
            self._runtime.mkdir(parents=True, exist_ok=True)
            with (self._runtime / "owner-alert-results.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"synthetic": True, "alert_id": alert_id, **payload}, ensure_ascii=False) + "\n")
            return
        status, _data = await self._post(f"/v1/owner-alerts/{alert_id}/result", payload)
        if status not in (200, 201, 204):
            raise HubError(f"hub answered {status}")

    # ---- helpers

    @staticmethod
    def _outcome(status: int, data: Any) -> FilingOutcome:
        """Map the hub's answer. Only 200/201 with a ref is a filed request; the refusals carry the hub's reason."""
        reason = _reason(data) or "unknown"
        if status in (200, 201):
            if not isinstance(data, dict) or not isinstance(data.get("ref"), str) or not isinstance(data.get("action_id"), str):
                raise HubError("hub answered without a ref")
            expires = data.get("expires_at")
            return FiledRequest(ref=data["ref"], action_id=data["action_id"], status="pending_owner", expires_at=expires if isinstance(expires, str) else None)
        if status == 409:
            facts = data.get("facts") if isinstance(data, dict) and isinstance(data.get("facts"), dict) else {}
            return FilingRefused("unavailable", reason, facts)
        if status == 422:
            return FilingRefused("invalid", reason)
        if status in (429, 503):
            return FilingRefused("needs_owner", reason)
        raise HubError(f"hub answered {status}")

    async def _post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        if httpx is None:
            raise HubError("httpx is not installed")
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        try:
            async with httpx.AsyncClient(timeout=self._timeout, follow_redirects=False, trust_env=False) as client:
                r = await client.post(self._base + path, json=body, headers=headers)
        except Exception as exc:
            raise HubError(f"hub unreachable: {type(exc).__name__}") from exc
        try:
            data = r.json()
        except Exception:  # noqa: BLE001
            data = None
        return r.status_code, data

    async def _simulated_availability_check(self, req: BookingRequest, today: str | None = None) -> FilingRefused | None:
        """Offline twin of the hub's 409: a past, closed or full day, or a group larger than one tour, is refused the way the hub refuses it."""
        if self._fixtures is None:
            return None
        if req.date < (today or time.strftime("%Y-%m-%d")):
            return FilingRefused("unavailable", "past", {"date": req.date})
        av = await HubReadOnly("", "", self._fixtures).availability(req.date)
        if not av.open:
            return FilingRefused("unavailable", av.reason or "day_closed", av.as_dict())
        if req.party_size > av.capacity:
            return FilingRefused("unavailable", "group_exceeds_capacity", av.as_dict())
        if av.remaining < req.party_size:
            return FilingRefused("unavailable", "full", av.as_dict())
        return None

    def _append_jsonl(self, name: str, ref_for, prefix: str, body: dict[str, Any]) -> tuple[int, str, str]:  # noqa: ANN001
        self._runtime.mkdir(parents=True, exist_ok=True)
        path = self._runtime / name
        n = sum(1 for _ in path.open(encoding="utf-8")) if path.exists() else 0
        ref = ref_for(n)
        action_id = f"{prefix}-{n + 1:04d}"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"synthetic": True, "ref": ref, "action_id": action_id, "status": "pending_owner", **body}, ensure_ascii=False) + "\n")
        return n, ref, action_id
