"""Settings from the environment. No value here is ever a secret default.

Simulated is the default: with no base URLs configured the sidecars that need a
model return no advice (fail-open), the hub client answers from local fixtures,
and nothing is sent anywhere. Real servers are selected by setting the URLs.
Provider keys come from the environment only (never git, never the room, never
a log line).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_ROOT = HERE.parent
REPO_ROOT = APP_ROOT.parent.parent
FIXTURES = APP_ROOT / "fixtures"
RUNTIME = APP_ROOT / "runtime"  # gitignored: blackboards, simulated outbox, traces


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # Local model servers, all OpenAI-compatible. Empty = not configured = simulated.
    stt_base_url: str = ""  # faster-whisper server, e.g. http://127.0.0.1:8001/v1
    stt_model: str = "whisper-1"
    llm_base_url: str = ""  # llama.cpp / Ollama serving Gemma 4 E4B, e.g. http://127.0.0.1:8080/v1
    llm_model: str = "gemma-4-e4b-it"
    tts_base_url: str = ""  # Chatterbox wrapper; the model name MUST be tts-1 for the plugin
    tts_model: str = "tts-1"
    tts_voice: str = "sauti"
    # The hub (apps/hub). Empty = simulated against fixtures.
    hub_base_url: str = ""
    hub_token_env: str = "HUB_TOKEN"  # name of the env var holding the bearer token; the value is read at call time
    # Behaviour
    agent_name: str = "sauti-hub"
    sidecar_budget_ms: int = 1500
    languages: tuple[str, ...] = ("sw", "en")
    tenant_id: str = "demo-farm-001"
    runtime_dir: Path = field(default=RUNTIME)
    fixtures_dir: Path = field(default=FIXTURES)

    @property
    def simulated_models(self) -> bool:
        return not (self.stt_base_url and self.llm_base_url and self.tts_base_url)

    @property
    def simulated_hub(self) -> bool:
        return not self.hub_base_url

    def hub_token(self) -> str:
        """Read at use, never stored on the object, never logged."""
        return _env(self.hub_token_env)


def load_settings() -> Settings:
    return Settings(
        stt_base_url=_env("SAUTI_STT_BASE_URL"),
        stt_model=_env("SAUTI_STT_MODEL", "whisper-1"),
        llm_base_url=_env("SAUTI_LLM_BASE_URL"),
        llm_model=_env("SAUTI_LLM_MODEL", "gemma-4-e4b-it"),
        tts_base_url=_env("SAUTI_TTS_BASE_URL"),
        tts_model="tts-1",
        tts_voice=_env("SAUTI_TTS_VOICE", "sauti"),
        hub_base_url=_env("SAUTI_HUB_BASE_URL"),
        agent_name=_env("SAUTI_AGENT_NAME", "sauti-hub"),
        sidecar_budget_ms=_env_int("SAUTI_SIDECAR_BUDGET_MS", 1500),
        tenant_id=_env("SAUTI_TENANT_ID", "demo-farm-001"),
        runtime_dir=Path(_env("SAUTI_RUNTIME_DIR") or RUNTIME),
        fixtures_dir=Path(_env("SAUTI_FIXTURES_DIR") or FIXTURES),
    )
