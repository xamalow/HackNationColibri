"""The SDK clients the livekit plugins use are pinned to loopback with no proxy and no redirects (codex, PR #62)."""

from __future__ import annotations

import asyncio
import inspect

import pytest

from hub_voice import agent as agent_mod
from hub_voice.agent import HTTP_CLIENT_OPTIONS, guarded_http_client, local_openai_client
from hub_voice.config import ConfigError

httpx = pytest.importorskip("httpx")


def test_guarded_http_client_has_no_proxy_and_no_redirects() -> None:
    assert HTTP_CLIENT_OPTIONS == {"trust_env": False, "follow_redirects": False}
    c = guarded_http_client(7.5)
    try:
        assert c.trust_env is False and c.follow_redirects is False
        assert c.timeout.connect == 7.5
    finally:
        asyncio.run(c.aclose())


def test_local_openai_client_is_loopback_only_with_the_guarded_http_client(monkeypatch: pytest.MonkeyPatch) -> None:
    openai_sdk = pytest.importorskip("openai")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:3128")
    monkeypatch.delenv("NO_PROXY", raising=False)
    client = local_openai_client("SAUTI_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    try:
        assert isinstance(client, openai_sdk.AsyncOpenAI)
        assert str(client.base_url).startswith("http://127.0.0.1:8080/v1")
        assert client._client.trust_env is False and client._client.follow_redirects is False
        assert client.max_retries == 1
    finally:
        asyncio.run(client.close())
    for bad in ("https://api.openai.com/v1", "http://192.168.0.9:8080/v1", "http://user:secret@127.0.0.1:8080/v1"):
        with pytest.raises(ConfigError) as info:
            local_openai_client("SAUTI_LLM_BASE_URL", bad)
        assert "secret" not in str(info.value) and "openai.com" not in str(info.value) and "192.168" not in str(info.value)


def test_every_plugin_constructor_in_entrypoint_takes_the_guarded_client() -> None:
    src = inspect.getsource(agent_mod.entrypoint)
    for plugin in ("openai.STT(", "openai.LLM(", "openai.TTS("):
        start = src.index(plugin)
        call = src[start : src.index(")", start) + 1] if plugin != "openai.LLM(" else src[start : start + 400]
        assert "client=local_openai_client(" in call, plugin
        assert "base_url=" not in call and "api_key=" not in call, plugin
