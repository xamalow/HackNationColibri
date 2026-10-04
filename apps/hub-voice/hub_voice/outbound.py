"""The "sauti-alert" worker: outbound alert calls to Noor's enrolled phone. Deterministic, no model.

Split agreed in the room (warden #47770, codex #47771): the HUB decides WHEN to call and
WHICH clips (notify.mjs) and lists pending owner-alert calls on its localhost API; THIS
worker places the call through the LiveKit SIP outbound trunk, plays exactly the listed
pre-rendered Chatterbox clips, and reports what happened. The voice never approves;
approvals stay SMS code or Sauti PIN.

Safety, each with a test:
- The ONLY dial target is the enrolled owner number from this process's own configuration
  (SAUTI_OWNER_E164). Nothing in a pending alert or a dispatch metadata can select a phone;
  the alert's device_id must equal SAUTI_OWNER_DEVICE_ID or the call is refused.
- Clip keys are validated against the fixed local library (packages/experience/audio
  manifest). Unknown keys refuse the call; a call with nothing playable is not placed
  (Noor is never rung with silence).
- One call per alert, restart-safe: a durable ledger (JSONL, appended before any dispatch)
  dedupes by alert_id and counts the daily cap per farm day (Africa/Nairobi, UTC+3, no DST).
  The cap is reserved BEFORE LiveKit is asked for anything.
- Dispatch acceptance and answered/played are separate facts, reported separately.
- No phone number, token or provider key appears in errors, reports or the JSONL (sha256 only).

Modes:
  python -m hub_voice.outbound poll      every N seconds: GET pending -> plan -> reserve -> dispatch (or simulate) -> report
  python -m hub_voice.outbound dev|start LiveKit worker "sauti-alert": on dispatch, dial the owner, play the clips, report
  Simulated (no LIVEKIT_URL / trunk): poll plans and ledgers every call and writes runtime/outbound-calls.jsonl.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import struct
import time
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import APP_ROOT, REPO_ROOT, ConfigError, Settings, load_settings
from .hubclient import HubActions, HubError, HubReadOnly
from .owner import normalize_number

log = logging.getLogger("sauti-alert")

CLIP_KEY = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ALERT_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
MAX_CLIPS = 20
DEFAULT_DAILY_CAP = 20
DEFAULT_MANIFEST = REPO_ROOT / "packages" / "experience" / "audio" / "manifest.json"
EAT = timezone(timedelta(hours=3))  # Africa/Nairobi, no DST; fixed offset so no tz database is needed
# Poller facts: refused (never dispatched), simulated, dispatched (accepted), dispatch_unknown (the dispatch request
# failed or its answer was lost: the worker MAY still run, so this is reconcilable, never final; same idea as the
# core's send_unknown transport state). Worker facts, terminal: answered, no_answer, failed.
RESULT_STATUSES = ("refused", "simulated", "dispatched", "dispatch_unknown", "answered", "no_answer", "failed")
TERMINAL_STATUSES = frozenset({"answered", "no_answer", "failed"})
POLLER_STATUSES = frozenset({"refused", "simulated", "dispatched", "dispatch_unknown"})


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def farm_day(now_ms: int) -> str:
    return datetime.fromtimestamp(now_ms / 1000, tz=EAT).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- the fixed clip library


class ClipLibrary:
    """Keys of packages/experience/audio/manifest.json -> wav paths. The only sounds this worker can play."""

    def __init__(self, manifest_path: Path = DEFAULT_MANIFEST) -> None:
        # manifest at packages/experience/audio/manifest.json; its `file` fields ("audio/sw/x.wav") are relative to packages/experience
        self.root = manifest_path.parent.resolve()  # every playable file must live under the audio directory
        base = self.root.parent
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.files: dict[str, Path] = {}
        self.playable_keys: set[str] = set()
        for group in ("copy_clips", "word_clips", "alert_clips", "clips"):
            for clip in data.get(group, []) or []:
                key, file = clip.get("key"), clip.get("file")
                if isinstance(key, str) and isinstance(file, str) and file and CLIP_KEY.match(key):
                    self.files[key] = (base / file).resolve()
                    # Same predicate as the hub's playableKeys (PR #77): RECORDED, audio not false. NOT_RECORDED, SUSPECT and
                    # NO_AUDIO rows are known keys but never played, even if a file exists (codex-mobile on main a5f5601).
                    if clip.get("status") == "RECORDED" and clip.get("audio") is not False:
                        self.playable_keys.add(key)

    def known(self, key: str) -> bool:
        """In the manifest at all (request validation). Not the same as playable."""
        return key in self.files

    def playable(self, key: str) -> bool:
        return key in self.playable_keys

    def resolve_pairs(self, keys: list[str]) -> tuple[list[tuple[str, Path]], list[str]]:
        """([(key, file)] playable in order, keys whose file is not rendered yet). Key and file travel together, so a
        missing earlier clip never shifts which label is reported as played (codex, #65). Validate unknown keys first."""
        playable: list[tuple[str, Path]] = []
        missing: list[str] = []
        for k in keys:
            p = self.files.get(k)
            if p is not None and self.playable(k) and p.is_file() and self.root in p.parents:
                playable.append((k, p))
            else:
                missing.append(k)
        return playable, missing

    def resolve(self, keys: list[str]) -> tuple[list[Path], list[str]]:
        pairs, missing = self.resolve_pairs(keys)
        return [p for _k, p in pairs], missing


# ---------------------------------------------------------------- requests, plans, refusals


@dataclass(frozen=True)
class AlertRequest:
    """A pending owner-alert call as the hub lists it. Carries NO phone number by design."""

    alert_id: str
    device_id: str
    clip_keys: tuple[str, ...]
    urgent: bool = False

    @staticmethod
    def parse(item: Any) -> AlertRequest:
        if not isinstance(item, dict):
            raise ValueError("alert must be an object")
        alert_id = item.get("alert_id")
        if not isinstance(alert_id, str) or not ALERT_ID.match(alert_id):
            raise ValueError("alert_id must be 1..128 of [A-Za-z0-9._:-]")
        device_id = item.get("device_id")
        if not isinstance(device_id, str) or not (1 <= len(device_id) <= 128):
            raise ValueError("device_id required")
        keys = item.get("clip_keys")
        if not isinstance(keys, list) or not keys or len(keys) > MAX_CLIPS:
            raise ValueError(f"clip_keys must be a list of 1..{MAX_CLIPS}")
        for k in keys:
            if not isinstance(k, str) or not CLIP_KEY.match(k):
                raise ValueError("clip key must be lowercase letters, digits, . _ -")
        if any(k in ("to", "number", "phone", "e164") for k in item):
            raise ValueError("an alert must not carry a phone number")
        return AlertRequest(alert_id=alert_id, device_id=device_id, clip_keys=tuple(keys), urgent=bool(item.get("urgent", False)))


@dataclass(frozen=True)
class CallPlan:
    alert_id: str
    clip_keys: tuple[str, ...]
    files: tuple[Path, ...]
    missing: tuple[str, ...]
    farm_day: str


@dataclass(frozen=True)
class Refusal:
    alert_id: str
    reason: str  # device_mismatch | unknown_clip | nothing_to_play | duplicate | cap_exhausted | not_configured
    detail: str = ""


# ---------------------------------------------------------------- the durable ledger


class CallLedger:
    """Durable call state: an append-only JSONL record plus ATOMIC marker files beside it.

    The markers are the truth for anything two processes could race on (codex, #65): a reservation,
    a day's cap slots and the pre-dial claim are each a file created with O_EXCL, which the OS makes
    atomic and which survives restarts. The JSONL rows are the readable record. Read on every
    operation; nothing is cached.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.markers = path.with_suffix(path.suffix + ".d")

    @staticmethod
    def _marker_name(alert_id: str) -> str:
        return hashlib.sha256(alert_id.encode("utf-8")).hexdigest()[:32]  # alert ids may hold ':' which filenames cannot

    def _claim(self, *parts: str) -> bool:
        """Atomically create the marker; False if it already exists."""
        target = self.markers.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(str(target), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        os.close(fd)
        return True

    def _has(self, *parts: str) -> bool:
        return self.markers.joinpath(*parts).exists()

    def _rows(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        rows: list[dict[str, Any]] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue  # a torn last line from a crash is ignored, never trusted
        return rows

    def _append(self, row: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def reserved(self, alert_id: str) -> bool:
        return self._has("reserve", self._marker_name(alert_id)) or any(r.get("kind") == "reserve" and r.get("alert_id") == alert_id for r in self._rows())

    def count(self, day: str) -> int:
        """Reservations that count against the day: marker slots, plus legacy JSONL reservations (written before the
        markers existed, #65) for that day that have no marker. An upgrade mid-day therefore cannot exceed the cap."""
        slots = self.markers / "day" / day
        n = len(list(slots.iterdir())) if slots.is_dir() else 0
        return n + self._legacy_count(day)

    def _legacy_count(self, day: str) -> int:
        legacy = {r.get("alert_id") for r in self._rows() if r.get("kind") == "reserve" and r.get("farm_day") == day and not self._has("reserve", self._marker_name(str(r.get("alert_id"))))}
        return len(legacy)

    def reserve(self, alert_id: str, day: str, cap: int, now_ms: int) -> bool:
        """One reservation per alert, one of `cap` slots per farm day, both claimed atomically BEFORE any dispatch.
        Two pollers cannot both reserve the same alert, and the day never exceeds its cap."""
        if self.reserved(alert_id):
            return False
        # Alert marker FIRST (uniqueness), slot second: a day slot, once claimed, is never given back, so a racing
        # reservation for a different alert can never be refused by a slot that is about to be released.
        if not self._claim("reserve", self._marker_name(alert_id)):
            return False  # another poller reserved this alert
        # Legacy same-day reservations (#65 rows without markers) hold the first slots conceptually, so only the
        # remaining slot indices are claimable: the day never exceeds the cap across an upgrade (codex-mobile).
        legacy = self._legacy_count(day)
        slot: str | None = None
        for n in range(legacy, cap):
            if self._claim("day", day, f"slot-{n:03d}"):
                slot = f"slot-{n:03d}"
                break
        if slot is None:
            os.unlink(self.markers / "reserve" / self._marker_name(alert_id))  # cap exhausted: this alert is not reserved
            return False
        self._append({"kind": "reserve", "alert_id": alert_id, "farm_day": day, "slot": slot, "t_ms": now_ms})
        return True

    def claim_dial(self, alert_id: str, now_ms: int) -> bool:
        """The pre-dial claim: exactly one dispatched job may ever reach create_sip_participant for this alert, even if
        LiveKit dispatches twice or a job restarts. A claim with no later result = an interrupted dial, which stays
        quarantined (never re-dialed); the hub sees it as a missing result and a person follows up."""
        if not self.reserved(alert_id) or not self._claim("dial", self._marker_name(alert_id)):
            return False
        self._append({"kind": "dial", "alert_id": alert_id, "t_ms": now_ms})
        return True

    def dial_claimed(self, alert_id: str) -> bool:
        return self._has("dial", self._marker_name(alert_id))

    def terminal_results(self, alert_id: str) -> list[dict[str, Any]]:
        """Results the WORKER writes after the dial attempt ended. 'dispatched' and 'simulated' are the poller's facts
        about acceptance, not about the call, and never clear a quarantine."""
        return [r for r in self.results(alert_id) if r.get("status") in TERMINAL_STATUSES]

    def quarantined(self, alert_id: str) -> bool:
        """Claimed for dialing with no terminal worker result: an ambiguous interrupted dial (dispatched -> claim -> crash)."""
        return self.dial_claimed(alert_id) and not self.terminal_results(alert_id)

    def record(self, alert_id: str, status: str, now_ms: int, **data: Any) -> None:
        if status not in RESULT_STATUSES:
            raise ValueError("unknown status")
        safe = {k: v for k, v in data.items() if k in ("played", "missing", "reason", "room", "to_sha256", "dispatch_id")}
        self._append({"kind": "result", "alert_id": alert_id, "status": status, "t_ms": now_ms, **safe})

    def results(self, alert_id: str) -> list[dict[str, Any]]:
        return [r for r in self._rows() if r.get("kind") == "result" and r.get("alert_id") == alert_id]


# ---------------------------------------------------------------- planning (pure)


@dataclass(frozen=True)
class OutboundConfig:
    """This process's own idea of who may be called. Not from the hub, not from metadata."""

    owner_e164: str
    owner_device_id: str
    sip_trunk_id: str
    daily_cap: int = DEFAULT_DAILY_CAP
    agent_name: str = "sauti-alert"
    manifest_path: Path = field(default=DEFAULT_MANIFEST)

    @property
    def live(self) -> bool:
        return bool(self.sip_trunk_id and os.environ.get("LIVEKIT_URL"))

    @staticmethod
    def from_env() -> OutboundConfig:
        raw = os.environ.get("SAUTI_OWNER_E164", "").strip()
        number = normalize_number(raw) if raw else None
        if raw and number is None:
            raise ConfigError("SAUTI_OWNER_E164: not a phone number")  # value-free on purpose
        cap_raw = os.environ.get("SAUTI_ALERT_DAILY_CAP", "").strip()
        try:
            cap = int(cap_raw) if cap_raw else DEFAULT_DAILY_CAP
        except ValueError:
            raise ConfigError("SAUTI_ALERT_DAILY_CAP: not an integer") from None  # the parser's message would echo the raw value
        if cap < 1 or cap > 200:
            raise ConfigError("SAUTI_ALERT_DAILY_CAP: 1..200")
        manifest = Path(os.environ.get("SAUTI_CLIP_MANIFEST", "") or DEFAULT_MANIFEST)
        return OutboundConfig(
            owner_e164=number or "",
            owner_device_id=os.environ.get("SAUTI_OWNER_DEVICE_ID", "").strip(),
            sip_trunk_id=os.environ.get("LIVEKIT_SIP_TRUNK_ID", "").strip(),
            daily_cap=cap,
            agent_name=os.environ.get("SAUTI_ALERT_AGENT_NAME", "sauti-alert").strip() or "sauti-alert",
            manifest_path=manifest,
        )


def plan_call(req: AlertRequest, cfg: OutboundConfig, library: ClipLibrary, ledger: CallLedger, now_ms: int) -> CallPlan | Refusal:
    """Everything that must be true before LiveKit is asked for anything. Reserves the cap on success."""
    if not cfg.owner_device_id or not cfg.owner_e164:
        return Refusal(req.alert_id, "not_configured", "SAUTI_OWNER_E164 and SAUTI_OWNER_DEVICE_ID must be set on the hub PC")
    if req.device_id != cfg.owner_device_id:
        return Refusal(req.alert_id, "device_mismatch", "the alert is not for the enrolled owner device")
    unknown = [k for k in req.clip_keys if not library.known(k)]
    if unknown:
        return Refusal(req.alert_id, "unknown_clip", f"{len(unknown)} clip key(s) not in the local library")
    files, missing = library.resolve(list(req.clip_keys))
    if not files:
        return Refusal(req.alert_id, "nothing_to_play", f"none of the {len(req.clip_keys)} clips is rendered yet; not ringing with silence")
    day = farm_day(now_ms)
    if ledger.reserved(req.alert_id):
        return Refusal(req.alert_id, "duplicate", "this alert was already called once")
    if ledger.count(day) >= cfg.daily_cap:
        return Refusal(req.alert_id, "cap_exhausted", f"daily call cap {cfg.daily_cap} reached for {day}")
    if not ledger.reserve(req.alert_id, day, cfg.daily_cap, now_ms):
        return Refusal(req.alert_id, "duplicate", "lost the reservation race")
    return CallPlan(alert_id=req.alert_id, clip_keys=req.clip_keys, files=tuple(files), missing=tuple(missing), farm_day=day)


def dial_target(cfg: OutboundConfig) -> str:
    """The one number this worker may ever dial. Never logged; callers hash it for records."""
    if not cfg.owner_e164:
        raise ConfigError("SAUTI_OWNER_E164 is not set")
    return cfg.owner_e164


# ---------------------------------------------------------------- audio


def wav_frames(path: Path, frame_ms: int = 20) -> Iterator[tuple[bytes, int, int, int]]:
    """(pcm16 bytes, sample_rate, channels, samples_per_channel) per frame from a 16-bit PCM WAV. Last frame is zero-padded."""
    with wave.open(str(path), "rb") as wf:
        if wf.getsampwidth() != 2:
            raise ValueError("clip must be 16-bit PCM")
        rate, channels = wf.getframerate(), wf.getnchannels()
        if rate not in (8000, 16000, 22050, 24000, 44100, 48000) or channels not in (1, 2):
            raise ValueError("clip must be mono or stereo at a standard rate")
        per_frame = rate * frame_ms // 1000
        while True:
            data = wf.readframes(per_frame)
            if not data:
                break
            want = per_frame * channels * 2
            if len(data) < want:
                data = data + b"\x00" * (want - len(data))
            yield data, rate, channels, per_frame


def clip_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as wf:
        return int(wf.getnframes() * 1000 / wf.getframerate())


def make_silence(path: Path, ms: int, rate: int = 24000) -> None:
    """A WAV of silence (tests and the inter-clip pause)."""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(struct.pack("<h", 0) * (rate * ms // 1000))


# ---------------------------------------------------------------- hub boundary


def result_payload(status: str, played: list[str], missing: list[str], reason: str = "") -> dict[str, Any]:
    if status not in RESULT_STATUSES:
        raise ValueError("unknown status")
    out: dict[str, Any] = {"status": status, "played": played, "missing": missing}
    if reason:
        out["reason"] = reason[:64]
    return out


class Poller:
    """GET pending -> plan -> reserve -> dispatch (or simulate) -> report. Never dials anything itself."""

    def __init__(self, settings: Settings, cfg: OutboundConfig, hub_ro: HubReadOnly, hub_actions: HubActions, ledger: CallLedger, library: ClipLibrary, dispatcher=None) -> None:  # noqa: ANN001
        self.settings, self.cfg, self.hub_ro, self.hub_actions, self.ledger, self.library = settings, cfg, hub_ro, hub_actions, ledger, library
        self.dispatcher = dispatcher  # async (CallPlan) -> dispatch_id; None = simulated

    async def tick(self, now_ms: int | None = None) -> list[dict[str, Any]]:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        out: list[dict[str, Any]] = []
        try:
            pending = await self.hub_ro.pending_alert_calls()
        except HubError as exc:
            log.warning("pending alerts unavailable: %s", type(exc).__name__)
            return out
        for item in pending:
            try:
                req = AlertRequest.parse(item)
            except ValueError:
                # Never copy a malformed id into output or logs (it could carry a number): a fixed label plus a hash of the raw item.
                raw = json.dumps(item, sort_keys=True, ensure_ascii=False, default=str) if item is not None else "null"
                out.append({"alert_id": f"invalid:{sha(raw)[:16]}", "status": "refused", "reason": "invalid"})
                continue
            plan = plan_call(req, self.cfg, self.library, self.ledger, now)
            if isinstance(plan, Refusal):
                if plan.reason != "duplicate":  # a duplicate was already reported once
                    await self._report(req.alert_id, result_payload("refused", [], [], plan.reason), now)
                out.append({"alert_id": req.alert_id, "status": "refused", "reason": plan.reason})
                continue
            played_keys = [k for k in plan.clip_keys if k not in plan.missing]
            if self.dispatcher is None:
                to_hash = sha(dial_target(self.cfg))
                self.ledger.record(plan.alert_id, "simulated", now, played=played_keys, missing=list(plan.missing), to_sha256=to_hash)
                self._simulated_log({"synthetic": True, "alert_id": plan.alert_id, "to_sha256": to_hash, "clip_keys": list(plan.clip_keys), "played": played_keys, "missing": list(plan.missing), "farm_day": plan.farm_day, "t_ms": now})
                await self._report(plan.alert_id, result_payload("simulated", played_keys, list(plan.missing)), now)
                out.append({"alert_id": plan.alert_id, "status": "simulated", "played": played_keys})
                continue
            try:
                dispatch_id = await self.dispatcher(plan)
            except Exception as exc:  # noqa: BLE001 - the reservation stands (no retry storm)
                # The dispatch request failed OR its answer was lost: LiveKit may still run the job, so this is NOT a
                # terminal failure. dispatch_unknown stays visible for reconciliation and a later worker result (answered /
                # no_answer / failed) supersedes it (codex-mobile, #70 contract question).
                self.ledger.record(plan.alert_id, "dispatch_unknown", now, reason=f"dispatch:{type(exc).__name__}")
                await self._report(plan.alert_id, result_payload("dispatch_unknown", [], list(plan.missing), f"dispatch:{type(exc).__name__}"), now)
                out.append({"alert_id": plan.alert_id, "status": "dispatch_unknown"})
                continue
            self.ledger.record(plan.alert_id, "dispatched", now, dispatch_id=str(dispatch_id)[:64])
            await self._report(plan.alert_id, result_payload("dispatched", [], list(plan.missing)), now)
            out.append({"alert_id": plan.alert_id, "status": "dispatched"})
        return out

    async def _report(self, alert_id: str, payload: dict[str, Any], now_ms: int) -> None:
        try:
            await self.hub_actions.report_alert_call(alert_id, payload)
        except HubError as exc:
            log.warning("result for %s not delivered: %s", alert_id, type(exc).__name__)

    def _simulated_log(self, row: dict[str, Any]) -> None:
        path = self.settings.runtime_dir / "outbound-calls.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------- LiveKit (live only; imported lazily)


RINGING_TIMEOUT_S = 40
MAX_CALL_DURATION_S = 180


def build_sip_request(cfg: OutboundConfig, room_name: str):  # noqa: ANN201 - livekit.api.CreateSIPParticipantRequest
    """The exact outbound request. Limits use the protobuf Duration type the installed livekit-api accepts (codex, #65:
    `api.Duration` does not exist in livekit-api 1.2.1, so a guarded alias silently dropped both limits)."""
    from google.protobuf.duration_pb2 import Duration
    from livekit import api

    return api.CreateSIPParticipantRequest(
        sip_trunk_id=cfg.sip_trunk_id,
        sip_call_to=dial_target(cfg),  # the ONLY number this worker dials
        room_name=room_name,
        participant_identity="owner-phone",
        participant_name="Noor",
        wait_until_answered=True,
        play_dialtone=False,
        ringing_timeout=Duration(seconds=RINGING_TIMEOUT_S),
        max_call_duration=Duration(seconds=MAX_CALL_DURATION_S),
    )


def make_dispatcher(cfg: OutboundConfig):  # noqa: ANN201
    """Explicit dispatch of the sauti-alert worker into a per-alert room. Metadata carries alert_id + clip keys, never a number."""
    from livekit import api

    async def dispatch(plan: CallPlan) -> str:
        async with api.LiveKitAPI() as lk:  # LIVEKIT_URL / API_KEY / API_SECRET from the environment
            d = await lk.agent_dispatch.create_dispatch(
                api.CreateAgentDispatchRequest(agent_name=cfg.agent_name, room=f"alert-{plan.alert_id}", metadata=json.dumps({"alert_id": plan.alert_id, "clip_keys": list(plan.clip_keys)}))
            )
            return str(getattr(d, "id", "") or "dispatched")

    return dispatch


async def alert_entrypoint(ctx) -> None:  # noqa: ANN001 - livekit JobContext
    """In the room: dial the enrolled owner, play the listed clips, report. No model, no tools, no approval."""
    from livekit import api, rtc

    settings = load_settings()
    cfg = OutboundConfig.from_env()
    library = ClipLibrary(cfg.manifest_path)
    ledger = CallLedger(settings.runtime_dir / "outbound-ledger.jsonl")
    hub_actions = HubActions(settings.hub_base_url, settings.hub_token(), settings.runtime_dir, settings.tenant_id)
    now = int(time.time() * 1000)

    meta = json.loads(getattr(ctx.job, "metadata", "") or "{}")
    alert_id = str(meta.get("alert_id", ""))
    keys = [k for k in meta.get("clip_keys", []) if isinstance(k, str) and library.known(k)]  # re-validated here, never trusted
    if not ALERT_ID.match(alert_id) or not keys or not ledger.reserved(alert_id):
        log.warning("dispatch without a valid, reserved alert; leaving")
        return
    pairs, missing = library.resolve_pairs(keys)
    if not pairs:
        ledger.record(alert_id, "failed", now, reason="nothing_to_play")
        return
    # The pre-dial claim: a second dispatch for the same alert, or a restarted job, leaves here and never dials again.
    if not ledger.claim_dial(alert_id, now):
        log.warning("alert already claimed for dialing (duplicate dispatch, restart, or quarantined interrupted dial); leaving")
        return

    await ctx.connect()
    answered = False
    played: list[str] = []
    try:
        async with api.LiveKitAPI() as lk:
            await lk.sip.create_sip_participant(build_sip_request(cfg, ctx.room.name))
        answered = True
        source = rtc.AudioSource(24000, 1)
        track = rtc.LocalAudioTrack.create_audio_track("alert", source)
        await ctx.room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
        await asyncio.sleep(0.8)
        for key, path in pairs:  # key and file travel together: a missing earlier clip never shifts the played labels
            for data, rate, channels, spc in wav_frames(path):
                await source.capture_frame(rtc.AudioFrame(data, rate, channels, spc))
            played.append(key)
            await asyncio.sleep(0.35)
        await asyncio.sleep(1.0)
    except Exception as exc:  # noqa: BLE001
        status = "no_answer" if not answered else "failed"
        ledger.record(alert_id, status, now, played=played, missing=missing, reason=type(exc).__name__)
        await _report_quietly(hub_actions, alert_id, result_payload(status, played, missing, type(exc).__name__))
    else:
        ledger.record(alert_id, "answered", now, played=played, missing=missing)
        await _report_quietly(hub_actions, alert_id, result_payload("answered", played, missing))
    finally:
        try:
            async with api.LiveKitAPI() as lk:
                await lk.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))
        except Exception:  # noqa: BLE001
            pass


async def _report_quietly(hub_actions: HubActions, alert_id: str, payload: dict[str, Any]) -> None:
    try:
        await hub_actions.report_alert_call(alert_id, payload)
    except HubError as exc:
        log.warning("result for %s not delivered: %s", alert_id, type(exc).__name__)


async def poll_forever(interval_s: float = 5.0) -> None:
    settings = load_settings()
    cfg = OutboundConfig.from_env()
    library = ClipLibrary(cfg.manifest_path)
    ledger = CallLedger(settings.runtime_dir / "outbound-ledger.jsonl")
    hub_ro = HubReadOnly(settings.hub_base_url, settings.hub_token(), settings.fixtures_dir)
    hub_actions = HubActions(settings.hub_base_url, settings.hub_token(), settings.runtime_dir, settings.tenant_id)
    dispatcher = make_dispatcher(cfg) if cfg.live else None
    log.info("sauti-alert poller: %s", "LIVE (LiveKit dispatch)" if dispatcher else "SIMULATED (no trunk configured)")
    poller = Poller(settings, cfg, hub_ro, hub_actions, ledger, library, dispatcher)
    while True:
        results = await poller.tick()
        for r in results:
            log.info("alert %s -> %s %s", r.get("alert_id"), r.get("status"), r.get("reason", ""))
        await asyncio.sleep(interval_s)


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if len(argv) >= 2 and argv[1] == "poll":
        asyncio.run(poll_forever())
        return 0
    from livekit.agents import WorkerOptions, cli

    cfg = OutboundConfig.from_env()
    cli.run_app(WorkerOptions(entrypoint_fnc=alert_entrypoint, agent_name=cfg.agent_name))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))


__all__ = ["AlertRequest", "CallLedger", "CallPlan", "ClipLibrary", "OutboundConfig", "Poller", "Refusal", "dial_target", "farm_day", "plan_call", "result_payload", "wav_frames", "APP_ROOT"]
