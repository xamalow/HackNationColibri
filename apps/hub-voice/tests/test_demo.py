"""The voice demo without telephony: loopback token server, embedded agent dispatch, gated demo owner mode, blackboard panel."""

from __future__ import annotations

import json
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from hub_voice import demo
from hub_voice.agent import call_id_for, demo_mode_override
from hub_voice.config import ConfigError, Settings, load_settings
from hub_voice.demo import Handler, demo_room_name, is_demo_room, mint_token, read_blackboard

DEV = {"LIVEKIT_URL": "ws://127.0.0.1:7880", "LIVEKIT_API_KEY": "devkey", "LIVEKIT_API_SECRET": "secret"}


def test_room_names_and_call_ids() -> None:
    r = demo_room_name("owner")
    assert is_demo_room(r) and r.startswith("demo-owner-")
    assert not is_demo_room("alert-0001") and not is_demo_room("demo-owner-x") and not is_demo_room("")
    assert call_id_for(r) == r  # predictable blackboard file for the audience panel
    assert call_id_for("sip-room-123").startswith("call-") and len(call_id_for("sip-room-123")) == 17
    with pytest.raises(ValueError):
        demo_room_name("admin")


def test_token_embeds_the_agent_dispatch_and_leaks_no_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("livekit.api")
    for k, v in DEV.items():
        monkeypatch.setenv(k, v)
    t = mint_token("owner", "sauti-hub")
    assert set(t) == {"url", "token", "room", "identity", "mode"} and t["mode"] == "owner" and is_demo_room(t["room"])
    assert "secret" not in json.dumps(t).replace(t["token"], "")
    # decode the JWT payload without verifying: the dispatch is in the token, the metadata names the mode and room
    import base64

    payload = json.loads(base64.urlsafe_b64decode(t["token"].split(".")[1] + "=="))
    cfg = payload.get("roomConfig") or payload.get("room_config")
    assert cfg and cfg["agents"][0]["agentName"] == "sauti-hub"
    assert json.loads(cfg["agents"][0]["metadata"]) == {"demo_mode": "owner", "room": t["room"]}
    assert payload["video"]["room"] == t["room"] and payload["video"]["roomJoin"] is True
    assert "devkey" not in t["token"].split(".")[1]  # the key id is in the header, the secret nowhere


def test_livekit_env_must_be_loopback_and_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in DEV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("LIVEKIT_URL", "wss://cloud.livekit.example")
    with pytest.raises(ConfigError) as info:
        demo.livekit_env()
    assert "cloud.livekit.example" not in str(info.value)
    monkeypatch.setenv("LIVEKIT_URL", "ws://127.0.0.1:7880")
    monkeypatch.delenv("LIVEKIT_API_SECRET")
    with pytest.raises(ConfigError):
        demo.livekit_env()


def test_demo_owner_mode_is_gated_by_the_hub_pc_flag_and_the_room_name() -> None:
    room = demo_room_name("owner")
    meta = json.dumps({"demo_mode": "owner"})
    assert demo_mode_override(room, meta, allow=True) == "owner"
    assert demo_mode_override(room, meta, allow=False) is None  # default: metadata cannot select a mode
    assert demo_mode_override("sip-inbound-77", meta, allow=True) is None  # a real call never takes it from metadata
    assert demo_mode_override(room, json.dumps({"demo_mode": "admin"}), allow=True) is None
    assert demo_mode_override(room, "not json", allow=True) is None
    assert demo_mode_override(room, None, allow=True) is None
    assert Settings().demo_allow_metadata_mode is False


def test_load_settings_reads_the_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SAUTI_DEMO_ALLOW_METADATA_MODE", raising=False)
    assert load_settings().demo_allow_metadata_mode is False
    monkeypatch.setenv("SAUTI_DEMO_ALLOW_METADATA_MODE", "1")
    assert load_settings().demo_allow_metadata_mode is True
    monkeypatch.setenv("SAUTI_DEMO_ALLOW_METADATA_MODE", "yes")
    assert load_settings().demo_allow_metadata_mode is False  # only the literal 1


def test_blackboard_panel_reads_only_demo_rooms_and_only_new_events(tmp_path: Path) -> None:
    room = demo_room_name("tourist")
    bb = tmp_path / "blackboards"
    bb.mkdir()
    rows = [{"seq": 1, "source": "caller", "kind": "turn", "data": {"text": "habari"}}, {"seq": 2, "source": "language", "kind": "advice", "data": {"summary": "sw"}}]
    (bb / f"{room}.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\nnot json\n", encoding="utf-8")
    (bb / "call-abc.jsonl").write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
    assert [e["seq"] for e in read_blackboard(tmp_path, room)] == [1, 2]
    assert [e["seq"] for e in read_blackboard(tmp_path, room, after_seq=1)] == [2]
    assert read_blackboard(tmp_path, "call-abc") == []  # a real call's board is never served
    assert read_blackboard(tmp_path, "../../etc/passwd") == []


def test_server_binds_loopback_and_serves_page_vendor_token_and_board(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("livekit.api")
    for k, v in DEV.items():
        monkeypatch.setenv(k, v)
    Handler.runtime_dir = tmp_path
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    try:
        base = f"http://127.0.0.1:{port}"
        assert httpd.server_address[0] == "127.0.0.1"
        page = urllib.request.urlopen(base + "/").read().decode("utf-8")
        assert "Sauti" in page and "/vendor/livekit-client.umd.js" in page and "never confirms a booking" in page
        js = urllib.request.urlopen(base + "/vendor/livekit-client.umd.js").read()
        assert len(js) > 100_000 and b"LivekitClient" in js
        req = urllib.request.Request(base + "/token", data=json.dumps({"mode": "tourist"}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        tok = json.loads(urllib.request.urlopen(req).read())
        assert tok["mode"] == "tourist" and is_demo_room(tok["room"]) and tok["url"] == "ws://127.0.0.1:7880"
        bad = urllib.request.Request(base + "/token", data=json.dumps({"mode": "admin"}).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with pytest.raises(urllib.error.HTTPError) as info:
            urllib.request.urlopen(bad)
        assert info.value.code == 400
        board = json.loads(urllib.request.urlopen(base + f"/blackboard?room={tok['room']}").read())
        assert board == {"events": []}
        with pytest.raises(urllib.error.HTTPError) as nf:
            urllib.request.urlopen(base + "/vendor/../hub_voice/config.py")
        assert nf.value.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
