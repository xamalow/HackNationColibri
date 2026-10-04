"""Escalator sidecar: recommends "Muulize mtu" (ask a person), never executes it.

Reads the blackboard: unsupported or unclear language, safety flags, repeated
misunderstanding, or a request outside policy (payments, discounts, anything
the agent may not promise). It writes a recommendation; the speaker decides how
to say it, and a person calls back. There is no tool here that calls anyone.
"""

from __future__ import annotations

import re

from .base import Advice, SidecarContext, Turn

OUT_OF_POLICY = ["discount", "punguzo", "bei ya chini", "cheaper", "refund", "rudisha pesa", "pay now", "lipa sasa", "mpesa", "m-pesa", "card", "kadi", "deposit", "malipo", "cancel noor", "noor's number", "nambari ya noor", "her number", "address of noor", "anaishi wapi"]


class EscalatorSidecar:
    name = "escalator"
    phase = 2  # reads language and safety advice from the same turn

    async def run(self, turn: Turn, ctx: SidecarContext) -> Advice | None:
        reasons: list[str] = []
        latest = ctx.board.latest_advice()
        lang = latest.get("language")
        if lang and lang.data.get("action") in ("unsupported_language", "ask_a_person_if_persists"):
            und_streak = sum(1 for ev in ctx.board.events()[-6:] if ev.source == "language" and ev.data.get("action") != "ok")
            if lang.data.get("action") == "unsupported_language" or und_streak >= 2:
                reasons.append("language")
        safety = latest.get("safety")
        if safety and safety.data.get("turn") == turn.index and any(k in safety.data.get("flags", {}) for k in ("emergency", "abuse", "injection")):
            reasons.append("safety")
        low = turn.text.lower()
        policy_hits = [c for c in OUT_OF_POLICY if re.search(rf"(?<!\w){re.escape(c)}(?!\w)", low)]
        if policy_hits:
            reasons.append("out_of_policy")
        misunderstandings = ctx.board.count(source="speaker", kind="misunderstanding")
        if misunderstandings >= 2:
            reasons.append("repeated_misunderstanding")
        if not reasons:
            return None
        return Advice(
            self.name,
            "RECOMMEND handover: say 'Muulize mtu' / 'let me have a person call you back', take name and preferred time, promise nothing else. Reasons: " + ", ".join(reasons),
            {"recommend": "handover", "reasons": reasons, "out_of_policy_cues": policy_hits},
        )
