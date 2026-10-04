"""Preflight for the voice demo: is every local piece reachable? Loopback only, no secrets printed.

    python -m hub_voice.preflight          # exit 0 when everything the configured mode needs answers

Checks (each a GET with a short timeout to the configured loopback URL):
  LiveKit server   LIVEKIT_URL (ws -> http) /            livekit-server answers "OK"
  STT              SAUTI_STT_BASE_URL  /models           faster-whisper OpenAI-compatible server
  LLM              SAUTI_LLM_BASE_URL  /models           llama-server / Ollama serving Gemma 4 (start with --reasoning off)
  TTS              SAUTI_TTS_BASE_URL  /models (or /)    Chatterbox wrapper answering as tts-1
  Hub              SAUTI_HUB_BASE_URL  /v1/health        apps/hub
Unset URL = "simulated", reported as such, not as a failure.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from .config import load_settings, require_loopback


@dataclass(frozen=True)
class Probe:
    name: str
    url: str  # "" = not configured
    paths: tuple[str, ...]


@dataclass(frozen=True)
class Result:
    name: str
    state: str  # ready | simulated | down | misconfigured
    detail: str


def http_base(ws_url: str) -> str:
    parts = urlsplit(ws_url)
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, "", "", ""))


def probe(p: Probe, timeout_s: float = 2.0) -> Result:
    if not p.url:
        return Result(p.name, "simulated", "not configured")
    try:
        require_loopback(p.name, p.url if p.url.startswith("http") else http_base(p.url))
    except Exception as exc:  # noqa: BLE001 - ConfigError is value-free
        return Result(p.name, "misconfigured", str(exc))
    base = p.url if p.url.startswith("http") else http_base(p.url)
    last = ""
    for path in p.paths:
        url = base.rstrip("/") + path
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=timeout_s) as r:  # noqa: S310 - loopback only, checked above
                if 200 <= r.status < 500:
                    return Result(p.name, "ready", f"HTTP {r.status} on {path}")
                last = f"HTTP {r.status}"
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return Result(p.name, "ready", f"HTTP {exc.code} on {path}")  # the server is up; the path just is not it
            last = f"HTTP {exc.code}"
        except Exception as exc:  # noqa: BLE001
            last = type(exc).__name__
    return Result(p.name, "down", last or "no answer")


def probes() -> list[Probe]:
    s = load_settings()
    return [
        Probe("LiveKit", os.environ.get("LIVEKIT_URL", "").strip(), ("/",)),
        Probe("STT (faster-whisper)", s.stt_base_url, ("/models", "/health", "/")),
        Probe("LLM (Gemma 4)", s.llm_base_url, ("/models", "/health")),
        Probe("TTS (Chatterbox as tts-1)", s.tts_base_url, ("/models", "/health", "/")),
        Probe("Hub", s.hub_base_url, ("/v1/health",)),
    ]


def main() -> int:
    results = [probe(p) for p in probes()]
    width = max(len(r.name) for r in results)
    for r in results:
        print(f"{r.name.ljust(width)}  {r.state.upper():<13} {r.detail}")
    ok = all(r.state in ("ready", "simulated") for r in results)
    print(json.dumps({"ok": ok, "results": [r.__dict__ for r in results]}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
