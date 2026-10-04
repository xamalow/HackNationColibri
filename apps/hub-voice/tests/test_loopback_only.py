"""All AI runs on the hub PC: model and hub URLs must be loopback, in every path that can carry one (codex, #47716 preflight)."""

from __future__ import annotations

import pytest

from hub_voice import config as cfg
from hub_voice.config import FIXTURES, ConfigError, Settings, load_settings, require_loopback
from hub_voice.hubclient import HubActions, HubReadOnly

REMOTE = ["http://api.openai.com/v1", "https://10.0.0.5:8080/v1", "http://hub.local:8787", "http://192.168.1.20:8001/v1", "http://localhost.evil.example/v1", "http://127.0.0.1.nip.io/v1", "http://0.0.0.0:8080/v1", "ftp://127.0.0.1/v1", "127.0.0.1:8080/v1", "http://[::2]:8080/v1"]
LOCAL = ["http://127.0.0.1:8080/v1", "http://localhost:8001", "https://127.0.0.1/v1/", "http://[::1]:8787", "http://127.0.0.1", "http://LOCALHOST:5000/v1"]


@pytest.mark.parametrize("url", LOCAL)
def test_loopback_urls_are_accepted(url: str) -> None:
    assert require_loopback("SAUTI_LLM_BASE_URL", url) == url
    Settings(fixtures_dir=FIXTURES, stt_base_url=url, llm_base_url=url, tts_base_url=url, hub_base_url=url)


@pytest.mark.parametrize("url", REMOTE)
def test_remote_or_malformed_urls_are_refused_everywhere(url: str) -> None:
    with pytest.raises(ConfigError):
        require_loopback("SAUTI_LLM_BASE_URL", url)
    for field in ("stt_base_url", "llm_base_url", "tts_base_url", "hub_base_url"):
        with pytest.raises(ConfigError):
            Settings(fixtures_dir=FIXTURES, **{field: url})
    with pytest.raises(ConfigError):
        HubReadOnly(url, "t", FIXTURES)
    with pytest.raises(ConfigError):
        HubActions(url, "t", FIXTURES, "demo-farm-001")


def test_empty_means_simulated_and_is_fine() -> None:
    s = Settings(fixtures_dir=FIXTURES)
    assert s.simulated_models and s.simulated_hub
    HubReadOnly("", "", FIXTURES)


def test_load_settings_refuses_a_cloud_url_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAUTI_LLM_BASE_URL", "https://api.openai.com/v1")
    with pytest.raises(ConfigError):
        load_settings()
    monkeypatch.setenv("SAUTI_LLM_BASE_URL", "http://127.0.0.1:8080/v1")
    monkeypatch.setenv("SAUTI_HUB_BASE_URL", "http://127.0.0.1:8787")
    s = load_settings()
    assert s.llm_base_url == "http://127.0.0.1:8080/v1" and not s.simulated_hub


def test_http_clients_never_follow_redirects_or_read_proxy_env() -> None:
    import inspect

    from hub_voice import hubclient
    from hub_voice.sidecars import translation

    for mod in (hubclient, translation):
        src = inspect.getsource(mod)
        n = src.count("httpx.AsyncClient(")
        assert n > 0 and n == src.count("follow_redirects=False") == src.count("trust_env=False"), mod.__name__
    assert cfg.LOOPBACK_HOSTS == frozenset({"127.0.0.1", "localhost", "::1"})


@pytest.mark.parametrize(
    "url",
    [
        "http://user:s3cr3t@127.0.0.1:8080/v1",
        "http://token-abc@localhost/v1",
        "http://[::1/v1",
        "http://[zz::1]:8080/v1",
        "http://:@127.0.0.1/v1",
        "http://127.0.0.1:synthetic-secret-marker/v1",
        "http://127.0.0.1:99999/v1",
        "http://127.0.0.1:/v1",
        "http://[::1]:marker/v1",
    ],
    ids=["basic-auth", "bare-user", "unclosed-bracket", "bad-ipv6", "empty-auth", "text-port", "port-out-of-range", "empty-port", "ipv6-text-port"],
)
def test_credentialed_or_malformed_urls_fail_closed_without_echoing_anything(url: str) -> None:
    with pytest.raises(ConfigError) as info:
        require_loopback("SAUTI_HUB_BASE_URL", url)
    msg = str(info.value)
    for secret in ("s3cr3t", "token-abc", "127.0.0.1", "localhost", "zz::1", "[", "ValueError", "synthetic-secret-marker", "marker", "99999"):
        assert secret not in msg, msg
    assert msg.startswith("SAUTI_HUB_BASE_URL: ")
    assert info.value.__cause__ is None  # parser details suppressed
