"""The livekit-agents worker "sauti-hub": the only voice on the call.

STT, LLM and TTS are OpenAI-compatible servers on the hub PC (faster-whisper,
llama.cpp or Ollama serving Gemma 4 E4B, a Chatterbox wrapper that answers as
model "tts-1"); LiveKit and Twilio carry only audio. Silero VAD + the local
multilingual turn detector; interruptions allowed with no minimum word count.

Two modes, one speaker, the same sidecars:
- tourist (default): consult_sidecars, farm_facts, check_availability (read) and
  file_booking_request (the ONE write: a request Noor approves).
- owner: the caller id's sha256 matches the enrolled owner phone. Tools:
  consult_sidecars, farm_facts, pending_requests, feedback_summary (read) and
  propose_change (a proposal the hub reads back to her phone with a one-time
  code). There is no approve tool in either mode: a voice never approves.

Run:  python -m hub_voice.agent download-files   (once)
      python -m hub_voice.agent console           (local mic, no LiveKit server)
      python -m hub_voice.agent dev | start       (LIVEKIT_URL/API_KEY/API_SECRET in env)
Dispatch: a SIP dispatch rule with agent_name "sauti-hub" (explicit dispatch).

livekit imports are inside the builders so the sidecar and gate modules can be
tested without the agent stack installed. API checked against livekit-agents 1.8.4.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from .blackboard import Blackboard
from .config import Settings, load_settings
from .hubclient import BookingRequest, FilingRefused, HubActions, HubError, HubReadOnly
from .owner import OWNER_CHANGE_KINDS, Mode, classify_caller
from .policy import DISCLOSURE_EN, DISCLOSURE_SW, OWNER_DISCLOSURE_SW, owner_instructions, speaker_instructions
from .redact import redact_text
from .sidecars import PreparerDisplay, PreparerSidecar, SidecarContext, Turn, default_sidecars, run_sidecars

log = logging.getLogger("sauti-hub")

# Every HTTP client this process creates for a model server: no proxy from the environment, no redirects, a timeout.
# codex (PR #62): the SDK defaults (trust_env=True, redirects) would let HTTP_PROXY route "loopback" traffic elsewhere.
HTTP_CLIENT_OPTIONS = {"trust_env": False, "follow_redirects": False}


def guarded_http_client(timeout_s: float = 30.0):  # noqa: ANN201 - httpx.AsyncClient, imported lazily
    import httpx

    return httpx.AsyncClient(timeout=timeout_s, **HTTP_CLIENT_OPTIONS)


def local_openai_client(name: str, base_url: str, timeout_s: float = 30.0):  # noqa: ANN201 - openai.AsyncOpenAI, imported lazily
    """The OpenAI-compatible SDK client the livekit plugins use, pinned to a loopback base URL and a guarded HTTP client."""
    import openai as openai_sdk

    from .config import require_loopback

    return openai_sdk.AsyncOpenAI(base_url=require_loopback(name, base_url), api_key="local", http_client=guarded_http_client(timeout_s), max_retries=1)

TOURIST_TOOLS = ("consult_sidecars", "farm_facts", "check_availability", "file_booking_request")
OWNER_TOOLS = ("consult_sidecars", "farm_facts", "pending_requests", "feedback_summary", "propose_change")


class CallState:
    """Per-call wiring: blackboard, sidecars, hub clients, turn counter, mode."""

    def __init__(self, settings: Settings, call_id: str, display: PreparerDisplay | None = None, mode: Mode = "tourist") -> None:
        self.settings = settings
        self.call_id = call_id
        self.mode: Mode = mode
        self.board = Blackboard(call_id=call_id, sink_path=settings.runtime_dir / "blackboards" / f"{call_id}.jsonl")
        self.hub_ro = HubReadOnly(settings.hub_base_url, settings.hub_token(), settings.fixtures_dir)
        self.hub_actions = HubActions(settings.hub_base_url, settings.hub_token(), settings.runtime_dir, settings.tenant_id, fixtures_dir=settings.fixtures_dir)
        self.sidecars = default_sidecars(display)
        self.preparer: PreparerSidecar = next(s for s in self.sidecars if isinstance(s, PreparerSidecar))
        self.turns = 0
        self.language_hint: str | None = "sw" if mode == "owner" else None

    def ctx(self) -> SidecarContext:
        return SidecarContext(settings=self.settings, hub=self.hub_ro, board=self.board, now_ms=int(time.time() * 1000), call_id=self.call_id)

    async def on_caller_turn(self, text: str, is_final: bool = True) -> str:
        """Run the sidecars on a caller turn; returns the speaker view. Never raises."""
        self.turns += 1
        self.board.append("caller", "turn", {"turn": self.turns, "text": text, "final": is_final})
        turn = Turn(index=self.turns, text=text, language_hint=self.language_hint, is_final=is_final)
        report = await run_sidecars(self.sidecars, turn, self.ctx(), self.board)
        lang = next((a for a in report.advices if a.source == "language"), None)
        if lang and lang.data.get("action") == "ok":
            self.language_hint = str(lang.data.get("lang"))
        return self.board.view_for_speaker()

    # ---- the tool bodies, callable without livekit (tests, simulate)

    async def tool_farm_facts(self) -> dict[str, Any]:
        facts = await self.hub_ro.farm_facts()
        self.board.append("speaker", "tool", {"tool": "farm_facts"})
        return facts

    async def tool_check_availability(self, date: str) -> dict[str, Any]:
        av = await self.hub_ro.availability(date)
        self.board.append("speaker", "tool", {"tool": "check_availability", **av.as_dict()})
        return av.as_dict()

    async def tool_file_booking_request(self, date: str, party_size: int, visitor_name: str, note: str = "") -> dict[str, Any]:
        outcome = await self.hub_actions.file_booking_request(
            BookingRequest(date=date, party_size=int(party_size), visitor_name=visitor_name, language=self.language_hint or "sw", note=note), self.call_id
        )
        if isinstance(outcome, FilingRefused):
            # The hub said no (409 unavailable / 422 invalid / 429-503 needs_owner): nothing is pending, the screen stays as it was, the speaker says why.
            self.board.append("speaker", "tool", {"tool": "file_booking_request", "status": outcome.status, "reason": outcome.reason, "party_size": int(party_size), "date": date})
            return {"status": outcome.status, "reason": outcome.reason, "facts": outcome.facts, "say": refusal_line(outcome)}
        filed = outcome
        self.board.append("speaker", "tool", {"tool": "file_booking_request", "ref": filed.ref, "status": filed.status, "party_size": int(party_size), "date": date})
        # "Getting that done for you right now": the live view prepares the change with the banner while the caller is still on the line. No save.
        try:
            await self.preparer.show(filed.ref, {"date": date, "party_size": int(party_size)})
        except Exception as exc:  # noqa: BLE001 - the screen is not the record; a display failure never fails the call
            self.board.append("preparer", "error", {"message": f"display: {type(exc).__name__}"})
        return {"ref": filed.ref, "status": filed.status, "say": f"Ombi {filed.ref} limepokelewa; Noor atathibitisha. / Request {filed.ref} received; Noor will confirm."}

    async def tool_pending_requests(self) -> dict[str, Any]:
        pending = await self.hub_ro.pending_requests()
        self.board.append("speaker", "tool", {"tool": "pending_requests", "count": len(pending)})
        return {"pending": pending, "count": len(pending)}

    async def tool_feedback_summary(self) -> dict[str, Any]:
        summary = await self.hub_ro.feedback_summary()
        self.board.append("speaker", "tool", {"tool": "feedback_summary", "themes": len(summary.get("themes", []))})
        return summary

    async def tool_propose_change(self, kind: str, text: str, about_ref: str | None = None, date: str | None = None, capacity: int | None = None) -> dict[str, Any]:
        if kind not in OWNER_CHANGE_KINDS:
            raise HubError(f"kind must be one of {', '.join(OWNER_CHANGE_KINDS)}")
        outcome = await self.hub_actions.file_owner_proposal(kind, text, about_ref, self.call_id, date=date or None, capacity=capacity if isinstance(capacity, int) and capacity > 0 else None)
        if isinstance(outcome, FilingRefused):
            self.board.append("speaker", "tool", {"tool": "propose_change", "kind": kind, "status": outcome.status, "reason": outcome.reason, "about_ref": about_ref or ""})
            return {"status": outcome.status, "reason": outcome.reason, "say": refusal_line(outcome, owner=True)}
        filed = outcome
        self.board.append("speaker", "tool", {"tool": "propose_change", "kind": kind, "ref": filed.ref, "status": filed.status, "about_ref": about_ref or "", "date": date or "", "capacity": capacity or 0})
        return {
            "ref": filed.ref,
            "status": filed.status,
            "say": "Nimekutumia ujumbe wa kuthibitisha kwa simu yako; jibu NDIYO na nambari iliyo kwenye ujumbe. Hakuna kilichobadilika bado.",
        }


# What the speaker says when the hub refuses to file. Facts in these lines come from the hub's reason code, never from a model.
REFUSAL_LINES: dict[str, str] = {
    "full": "Samahani, siku hiyo imejaa. Tuchague siku nyingine? / Sorry, that day is full. Shall we pick another day?",
    "closed_day": "Samahani, shamba limefungwa siku hiyo. Siku nyingine? / Sorry, the farm is closed that day. Another day?",
    "day_closed": "Samahani, shamba limefungwa siku hiyo. Siku nyingine? / Sorry, the farm is closed that day. Another day?",
    # the hub's availability reason vocabulary (voice_api.mjs): closed_by_owner, platform_blocked, ask_a_person
    "closed_by_owner": "Samahani, shamba limefungwa siku hiyo. Siku nyingine? / Sorry, the farm is closed that day. Another day?",
    "platform_blocked": "Samahani, siku hiyo haipatikani. Siku nyingine? / Sorry, that day is not available. Another day?",
    "ask_a_person": "Samahani, siwezi kuthibitisha siku hiyo mwenyewe; mtu atakupigia. / Sorry, I cannot settle that day myself; a person will call you back.",
    "not_a_tour_day": "Samahani, hakuna ziara siku hiyo ya wiki. Siku nyingine? / Sorry, there are no tours on that weekday. Another day?",
    "past": "Samahani, tarehe hiyo imepita. Tarehe nyingine? / Sorry, that date has passed. Another date?",
    "hours": "Samahani, muda huo haupo ndani ya saa za shamba. / Sorry, that time is outside the farm's hours.",
    "too_late": "Samahani, ni kuchelewa mno kwa siku hiyo. Siku nyingine? / Sorry, it is too late for that day. Another day?",
    "budget_exhausted": "Samahani, leo siwezi kutuma ombi lingine; mtu atakupigia. / Sorry, I cannot file another request today; a person will call you back.",
    # Nat O3 / warden routing (2026-10-04): a group larger than one tour gets a person, not "another day": no day will fit.
    "group_exceeds_capacity": "Samahani, kikundi ni kikubwa kuliko ziara moja{cap}. Mtu atakupigia kupanga ziara ya kikundi. / Sorry, the group is larger than one tour{cap_en}; a person will call you to arrange a group visit.",
}


def refusal_line(outcome: FilingRefused, owner: bool = False) -> str:
    if outcome.reason in REFUSAL_LINES:
        cap = outcome.facts.get("capacity") if isinstance(outcome.facts, dict) else None
        cap_sw = f" (watu {cap} kwa ziara)" if isinstance(cap, int) and cap > 0 else ""
        cap_en = f" ({cap} people per tour)" if isinstance(cap, int) and cap > 0 else ""
        return REFUSAL_LINES[outcome.reason].replace("{cap}", cap_sw).replace("{cap_en}", cap_en)
    if outcome.status == "invalid":
        return "Samahani, sikuelewa vizuri. Tuseme tena tarehe na idadi ya watu. / Sorry, I did not get that right. Let us say the date and the number of people again." if not owner else "Samahani, sikuelewa vizuri. Tuseme tena. / Sorry, I did not get that right. Let us say it again."
    # needs_owner (429/503) and anything unknown: no retry on the call, a person follows up.
    return "Samahani, siwezi kutuma ombi sasa hivi; mtu atakupigia. / Sorry, I cannot file the request right now; a person will call you back."


def build_tourist_speaker(state: CallState):  # noqa: ANN201 - returns a livekit Agent subclass built lazily
    from livekit.agents import Agent, RunContext, ToolError, function_tool

    class SautiSpeaker(Agent):
        def __init__(self) -> None:
            super().__init__(instructions=speaker_instructions(state.settings.languages))

        @function_tool()
        async def consult_sidecars(self, context: RunContext) -> str:
            """Read the sidecars' advice for the caller's latest words: language, availability facts, safety and tone cues, handover recommendation. Call this first every turn."""
            return state.board.view_for_speaker()

        @function_tool()
        async def farm_facts(self, context: RunContext) -> dict[str, Any]:
            """The owner-approved facts about the farm: price per person, open days and hours, directions, what is included. The only source for any number you say."""
            try:
                return await state.tool_farm_facts()
            except HubError as exc:
                raise ToolError(f"facts unavailable: {exc}") from exc

        @function_tool()
        async def check_availability(self, context: RunContext, date: str) -> dict[str, Any]:
            """Seats left on a date (YYYY-MM-DD). Information only; it does not reserve anything."""
            try:
                return await state.tool_check_availability(date)
            except HubError as exc:
                raise ToolError(str(exc)) from exc

        @function_tool()
        async def file_booking_request(self, context: RunContext, date: str, party_size: int, visitor_name: str, note: str = "") -> dict[str, Any]:
            """File a visit REQUEST for Noor to approve. Use only after reading the date, party size and name back to the caller. Returns a reference letter. This does not confirm anything."""
            try:
                return await state.tool_file_booking_request(date, party_size, visitor_name, note)
            except HubError as exc:
                raise ToolError(f"could not file the request: {exc}") from exc

    return SautiSpeaker


def build_owner_speaker(state: CallState):  # noqa: ANN201
    from livekit.agents import Agent, RunContext, ToolError, function_tool

    class SautiOwnerSpeaker(Agent):
        def __init__(self) -> None:
            super().__init__(instructions=owner_instructions(state.settings.languages))

        @function_tool()
        async def consult_sidecars(self, context: RunContext) -> str:
            """Read the sidecars' advice for the latest words: language, facts, safety and tone cues. Call this first every turn."""
            return state.board.view_for_speaker()

        @function_tool()
        async def farm_facts(self, context: RunContext) -> dict[str, Any]:
            """The approved farm facts (price, days, hours, directions, inclusions)."""
            try:
                return await state.tool_farm_facts()
            except HubError as exc:
                raise ToolError(f"facts unavailable: {exc}") from exc

        @function_tool()
        async def pending_requests(self, context: RunContext) -> dict[str, Any]:
            """Requests waiting for the owner: reference letter, date, party size, source. No visitor names or numbers."""
            try:
                return await state.tool_pending_requests()
            except HubError as exc:
                raise ToolError(str(exc)) from exc

        @function_tool()
        async def feedback_summary(self, context: RunContext) -> dict[str, Any]:
            """Visitor feedback painpoints: themes with the number of different visitors who said so."""
            try:
                return await state.tool_feedback_summary()
            except HubError as exc:
                raise ToolError(str(exc)) from exc

        @function_tool()
        async def propose_change(self, context: RunContext, kind: str, text: str, about_ref: str = "", date: str = "", capacity: int = 0) -> dict[str, Any]:
            """File the owner's requested change as a PROPOSAL (kind: running_late, close_day, open_day, capacity, message_to_visitor, other). Pass date (YYYY-MM-DD) for close_day/open_day and capacity for capacity when she said them. The hub reads it back to her phone with a one-time code; nothing changes until she replies to that SMS."""
            try:
                return await state.tool_propose_change(kind, text, about_ref or None, date or None, capacity or None)
            except HubError as exc:
                raise ToolError(str(exc)) from exc

    return SautiOwnerSpeaker


def _turn_detector():  # noqa: ANN202
    """The local ONNX turn detector (livekit-plugins-turn-detector). It is marked deprecated in 1.8 in favour of
    livekit.agents.inference, which is a hosted service: not acceptable here (all AI stays on the hub PC). If the plugin
    is gone, fall back to VAD-only endpointing."""
    try:
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            from livekit.plugins.turn_detector.multilingual import MultilingualModel
        return MultilingualModel()
    except Exception:  # noqa: BLE001
        log.warning("local turn detector unavailable; using VAD endpointing only")
        return None


async def entrypoint(ctx) -> None:  # noqa: ANN001 - livekit JobContext
    from livekit.agents import AgentSession, room_io
    from livekit.plugins import openai, silero

    settings = load_settings()
    call_id = f"call-{uuid.uuid4().hex[:12]}"

    await ctx.connect()
    participant = await ctx.wait_for_participant()
    attributes = dict(getattr(participant, "attributes", {}) or {})
    hub_ro = HubReadOnly(settings.hub_base_url, settings.hub_token(), settings.fixtures_dir)
    who = await classify_caller(attributes.get("sip.phoneNumber"), hub_ro)  # the number is compared as a hash and never stored
    state = CallState(settings, call_id, mode=who.mode)
    state.board.append("system", "note", {"event": "call_start", "mode": who.mode, "mode_reason": who.reason, "room": redact_text(getattr(ctx.room, "name", "") or ""), "simulated_models": settings.simulated_models, "simulated_hub": settings.simulated_hub, "sip": bool(attributes.get("sip.callID"))})

    if settings.simulated_models:
        log.warning("model servers not configured (SAUTI_STT_BASE_URL / SAUTI_LLM_BASE_URL / SAUTI_TTS_BASE_URL): the worker cannot speak; use `simulate` for an offline run")
        return

    stt = openai.STT(client=local_openai_client("SAUTI_STT_BASE_URL", settings.stt_base_url), model=settings.stt_model, language="sw")
    # Gemma 4 via llama.cpp thinks by default and then answers with nothing (warden #47669). Serve with `--reasoning off`
    # (or `--reasoning-budget 0`); the request fields below ask for the same per call.
    llm = openai.LLM(
        client=local_openai_client("SAUTI_LLM_BASE_URL", settings.llm_base_url),
        model=settings.llm_model,
        temperature=0.2,
        extra_body={"reasoning_format": "none", "chat_template_kwargs": {"enable_thinking": False}},
    )
    tts = openai.TTS(client=local_openai_client("SAUTI_TTS_BASE_URL", settings.tts_base_url), model="tts-1", voice=settings.tts_voice, response_format="wav")
    turn_handling: dict[str, Any] = {"interruption": {"enabled": True, "min_words": 0}}
    detector = _turn_detector()
    if detector is not None:
        turn_handling["turn_detection"] = detector
    session = AgentSession(stt=stt, llm=llm, tts=tts, vad=silero.VAD.load(), turn_handling=turn_handling, max_tool_steps=3, user_away_timeout=20.0)

    def on_transcribed(ev) -> None:  # noqa: ANN001
        if getattr(ev, "is_final", False) and getattr(ev, "transcript", ""):
            asyncio.create_task(state.on_caller_turn(ev.transcript, True))

    def on_item(ev) -> None:  # noqa: ANN001
        item = getattr(ev, "item", None)
        if item is not None and getattr(item, "role", "") == "assistant":
            state.board.append("speaker", "turn", {"text": str(getattr(item, "text_content", "") or "")})

    session.on("user_input_transcribed", on_transcribed)
    session.on("conversation_item_added", on_item)

    Speaker = build_owner_speaker(state) if who.mode == "owner" else build_tourist_speaker(state)
    await session.start(agent=Speaker(), room=ctx.room, room_options=room_io.RoomOptions())
    opening = OWNER_DISCLOSURE_SW if who.mode == "owner" else f"{DISCLOSURE_SW} {DISCLOSURE_EN}"
    await session.say(opening, allow_interruptions=True)
    state.board.append("speaker", "turn", {"text": "[disclosure]", "mode": who.mode})


def main() -> None:
    from livekit.agents import WorkerOptions, cli

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    settings = load_settings()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=settings.agent_name))


if __name__ == "__main__":
    main()
