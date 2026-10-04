"""The preparer never commits without a matching, live, unreplayed approved digest."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hub_voice.sidecars.preparer import CONTRACTS, PreparerGate

FIX = CONTRACTS / "fixtures" / "good"
NOW = 1_791_000_000_000  # 2026-10-03T06:40:00Z, inside the fixtures' validity windows


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_good_pair_commits_once_then_is_a_replay() -> None:
    gate = PreparerGate()
    env, approval = load("send_message_simulated.json"), load("approval_send_message.json")
    assert gate.may_commit(approval, env, env["digest"], NOW).ok
    assert gate.commit(approval, env, env["digest"], NOW).ok
    again = gate.commit(approval, env, env["digest"], NOW)
    assert not again.ok and again.reason == "replayed"


def test_r1_1_sms_code_approval_commits_the_voice_envelope() -> None:
    if not (FIX / "send_message_voice.json").exists():
        pytest.skip("contracts r1.1 fixtures not on this branch yet (PR #37)")
    gate = PreparerGate()
    env, approval = load("send_message_voice.json"), load("approval_sms_code.json")
    now = 1_791_100_000_000  # 2026-10-04T10:26:40Z < valid_until 2026-10-05T08:00:00Z
    d = gate.may_commit(approval, env, env["digest"], now)
    assert d.ok, d


def test_wrong_digest_expired_and_other_action_never_commit() -> None:
    gate = PreparerGate()
    env, approval = load("send_message_simulated.json"), load("approval_send_message.json")
    other = load("record_payment_owner_record.json")
    assert gate.may_commit(approval, env, "0" * 64, NOW).reason == "digest_mismatch"
    edited = {**env, "payload": {**env["payload"], "body": env["payload"]["body"] + " Bure!"}}
    assert gate.may_commit(approval, edited, env["digest"], NOW).reason == "digest_mismatch"
    assert gate.may_commit(approval, other, other["digest"], NOW).reason in ("digest_mismatch", "action_mismatch")
    late = 1_900_000_000_000  # 2030
    assert gate.may_commit(approval, env, env["digest"], late).reason == "expired"
    rejected = {**approval, "decision": "rejected"}
    assert gate.may_commit(rejected, env, env["digest"], NOW).reason == "not_approved"
    no_ctx = {k: v for k, v in approval.items() if k != "owner_context"}
    assert gate.may_commit(no_ctx, env, env["digest"], NOW).reason == "approval_invalid"
    assert gate.may_commit("yes", env, env["digest"], NOW).reason == "malformed"
    assert gate.may_commit({"decision": "approved", "digest": env["digest"]}, env, env["digest"], NOW).reason == "approval_invalid"
    assert not gate.commit(approval, env, "0" * 64, NOW).ok  # nothing recorded on a refusal
    assert gate.may_commit(approval, env, env["digest"], NOW).ok


def test_gate_has_no_browser_or_network(tmp_path: Path) -> None:
    import hub_voice.sidecars.preparer as mod

    src = Path(mod.__file__).read_text(encoding="utf-8")
    for forbidden in ("playwright", "httpx", "requests", "subprocess", "webbrowser"):
        assert forbidden not in src
