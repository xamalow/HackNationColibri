"""Offline driver: a transcript in, a blackboard out. No LiveKit, no models, no network.

    python -m hub_voice.simulate fixtures/calls/booking_sw.jsonl
    python -m hub_voice.simulate fixtures/calls/owner_sw.jsonl --owner

Each line is {"role": "caller"|"speaker", "text": "..."}. Caller lines run the
sidecars exactly as the live agent does; speaker lines are recorded. The
blackboard JSONL lands under runtime/blackboards (gitignored) and is printed.
Use it for the demo screen and to show the fail-open behaviour.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from .agent import CallState
from .config import load_settings


async def run_file(path: Path, mode: str = "tourist") -> CallState:
    settings = load_settings()
    state = CallState(settings, f"sim-{path.stem}", mode="owner" if mode == "owner" else "tourist")
    state.board.append("system", "note", {"event": "simulation_start", "file": path.name, "mode": state.mode})
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        if item.get("role") == "caller":
            view = await state.on_caller_turn(str(item.get("text", "")))
            print(f"\ncaller> {item.get('text', '')}\n--- speaker reads:\n{view}")
        elif item.get("role") == "speaker":
            state.board.append("speaker", "turn", {"text": str(item.get("text", ""))})
            print(f"\nspeaker> {item.get('text', '')}")
    return state


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    mode = "owner" if "--owner" in argv[2:] else "tourist"
    state = asyncio.run(run_file(Path(argv[1]), mode))
    print(f"\n{len(state.board.events())} blackboard events -> {state.board.sink_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
