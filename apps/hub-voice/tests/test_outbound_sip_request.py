"""The exact SIP request, built with the installed SDK: the only number, both call limits present (codex, #65)."""

from __future__ import annotations

from pathlib import Path

import pytest

from hub_voice.outbound import MAX_CALL_DURATION_S, RINGING_TIMEOUT_S, OutboundConfig, build_sip_request

# Hard imports on purpose (codex-mobile on #66): livekit-api is pinned in requirements.txt so this check RUNS in CI; a
# missing SDK is a failure, not a skip.
import google.protobuf.duration_pb2  # noqa: E402, F401
import livekit.api  # noqa: E402, F401

OWNER = "+254700000002"


def test_sip_request_dials_only_the_owner_with_both_limits_set(tmp_path: Path) -> None:
    cfg = OutboundConfig(owner_e164=OWNER, owner_device_id="demo-basic-phone-001", sip_trunk_id="ST_test", manifest_path=tmp_path / "m.json")
    req = build_sip_request(cfg, "alert-0001")
    assert req.sip_call_to == OWNER and req.sip_trunk_id == "ST_test" and req.room_name == "alert-0001"
    assert req.participant_identity == "owner-phone" and req.wait_until_answered is True and req.play_dialtone is False
    # the limits survive construction with the real protobuf type (a non-existent api.Duration alias used to drop both)
    assert req.HasField("ringing_timeout") and req.HasField("max_call_duration")
    assert req.ringing_timeout.seconds == RINGING_TIMEOUT_S == 40
    assert req.max_call_duration.seconds == MAX_CALL_DURATION_S == 180
    # nothing in a request object can be pointed elsewhere by metadata: the number comes from cfg alone
    import inspect

    from hub_voice import outbound

    assert "sip_call_to=dial_target(cfg)" in inspect.getsource(outbound.build_sip_request)


def test_sip_request_refuses_an_unconfigured_owner(tmp_path: Path) -> None:
    from hub_voice.config import ConfigError

    cfg = OutboundConfig(owner_e164="", owner_device_id="d", sip_trunk_id="ST_test", manifest_path=tmp_path / "m.json")
    with pytest.raises(ConfigError):
        build_sip_request(cfg, "alert-0001")
