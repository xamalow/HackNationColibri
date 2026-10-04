"""Voice demo without Twilio: a browser talks to "sauti-hub" through a LOCAL LiveKit server on the hub PC.

    python -m hub_voice.demo serve        # http://127.0.0.1:8790  (loopback only)

What it does, and nothing more:
- serves demo/index.html and the vendored livekit-client bundle (Apache-2.0, see demo/vendor/LICENSE-livekit-client.txt);
- POST /token {"mode": "tourist" | "owner"} mints a room token for the browser (dev keys from the environment) with the
  "sauti-hub" agent dispatch EMBEDDED in the token, so the agent joins the room when the browser does;
- GET /blackboard?room=<room> streams the call's blackboard (what the sidecars advised) for the audience panel.

Owner mode in production comes from the enrolled phone's caller id. A browser has none, so the demo passes
{"demo_mode": "owner"} in the dispatch metadata, and the agent honours it ONLY when SAUTI_DEMO_ALLOW_METADATA_MODE=1
is set on the hub PC (off by default, tested). Even then the mode grants nothing: no tool approves anything.

No model, no phone number, no secret in any response or log. The LiveKit API secret is read from the environment when a
token is minted and never serialised.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import sys
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .config import APP_ROOT, ConfigError, load_settings

log = logging.getLogger("sauti-demo")

DEMO_DIR = APP_ROOT / "demo"
DEFAULT_PORT = 8790
MODES = ("tourist", "owner")
ROOM = re.compile(r"^demo-(tourist|owner)-[a-z0-9]{8}$")
TOKEN_TTL = timedelta(minutes=30)


def demo_room_name(mode: str) -> str:
    if mode not in MODES:
        raise ValueError("mode must be tourist or owner")
    return f"demo-{mode}-{secrets.token_hex(4)}"


def is_demo_room(room: str) -> bool:
    return bool(ROOM.match(room or ""))


def livekit_env() -> tuple[str, str, str]:
    """(ws url for the browser, api key, api secret). The URL must be loopback; the secret is never returned to a client."""
    url = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880").strip()
    host = (urlsplit(url).hostname or "").lower()
    if urlsplit(url).scheme not in ("ws", "wss", "http", "https") or host not in ("127.0.0.1", "localhost", "::1"):
        raise ConfigError("LIVEKIT_URL: the demo LiveKit server must run on this PC (127.0.0.1)")
    key, secret = os.environ.get("LIVEKIT_API_KEY", "").strip(), os.environ.get("LIVEKIT_API_SECRET", "").strip()
    if not key or not secret:
        raise ConfigError("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set (livekit-server --dev uses devkey / secret)")
    return url, key, secret


def mint_token(mode: str, agent_name: str = "sauti-hub") -> dict[str, Any]:
    """A join token for one fresh demo room, with the agent dispatch embedded. Returns what the browser needs and no more."""
    from livekit import api

    url, key, secret = livekit_env()
    room = demo_room_name(mode)
    identity = f"browser-{secrets.token_hex(3)}"
    metadata = json.dumps({"demo_mode": mode, "room": room})
    token = (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name("Demo caller" if mode == "tourist" else "Demo: Noor's phone")
        .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True, can_publish_data=False))
        .with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=agent_name, metadata=metadata)]))
        .with_ttl(TOKEN_TTL)
        .to_jwt()
    )
    return {"url": url, "token": token, "room": room, "identity": identity, "mode": mode}


def read_blackboard(runtime_dir: Path, room: str, after_seq: int = 0) -> list[dict[str, Any]]:
    """Events of a demo room's blackboard (the agent names the file after the room). Redacted at write time already."""
    if not is_demo_room(room):
        return []
    path = runtime_dir / "blackboards" / f"{room}.jsonl"
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if int(ev.get("seq", 0)) > after_seq:
            out.append(ev)
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "sauti-demo/0.1"
    runtime_dir: Path = APP_ROOT / "runtime"
    agent_name: str = "sauti-hub"

    def log_message(self, fmt: str, *args: Any) -> None:  # quiet: no request lines with tokens/rooms in the console
        return

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: Any) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        parts = urlsplit(self.path)
        if parts.path in ("/", "/index.html"):
            self._send(200, (DEMO_DIR / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif parts.path == "/vendor/livekit-client.umd.js":
            self._send(200, (DEMO_DIR / "vendor" / "livekit-client.umd.js").read_bytes(), "application/javascript; charset=utf-8")
        elif parts.path == "/blackboard":
            q = parse_qs(parts.query)
            room = (q.get("room") or [""])[0]
            try:
                after = int((q.get("after") or ["0"])[0])
            except ValueError:
                after = 0
            self._json(200, {"events": read_blackboard(self.runtime_dir, room, after)})
        elif parts.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/token":
            self._json(404, {"error": "not found"})
            return
        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            mode = str(body.get("mode", "tourist"))
            if mode not in MODES:
                raise ValueError("mode")
            self._json(200, mint_token(mode, self.agent_name))
        except (ValueError, ConfigError) as exc:
            # value-free: the message names the setting, never a value
            self._json(400, {"error": str(exc) if isinstance(exc, ConfigError) else "mode must be tourist or owner"})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": type(exc).__name__})


def serve(port: int = DEFAULT_PORT) -> None:
    settings = load_settings()
    Handler.runtime_dir = settings.runtime_dir
    Handler.agent_name = settings.agent_name
    livekit_env()  # fail early with a value-free message
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)  # loopback only, by construction
    log.info("voice demo: open http://127.0.0.1:%d  (LiveKit on this PC, agent %s)", port, settings.agent_name)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    if len(argv) >= 2 and argv[1] == "serve":
        port = int(argv[2]) if len(argv) >= 3 else DEFAULT_PORT
        serve(port)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
