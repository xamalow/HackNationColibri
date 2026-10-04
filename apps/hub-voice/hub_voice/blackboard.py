"""Append-only per-call blackboard.

Sidecars write advice here; the speaker reads it through one tool call per turn.
Nothing is ever edited or removed, every entry is redacted on the way in, and the
optional JSONL sink is opened in append mode only. The blackboard has no method
that speaks, sends, calls or changes anything: it is memory, not an actor.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .redact import contains_secret_shape, redact_value


@dataclass(frozen=True)
class Event:
    seq: int
    t_ms: int
    call_id: str
    source: str  # "speaker" | "caller" | sidecar name | "system"
    kind: str  # "turn" | "advice" | "timeout" | "error" | "tool" | "note"
    data: dict[str, Any]

    def to_json(self) -> str:
        return json.dumps({"seq": self.seq, "t_ms": self.t_ms, "call_id": self.call_id, "source": self.source, "kind": self.kind, "data": self.data}, ensure_ascii=False, sort_keys=True)


class RedactionError(RuntimeError):
    """An event still carried a phone number or code after redaction. Nothing was recorded."""


@dataclass
class Blackboard:
    call_id: str
    sink_path: Path | None = None
    clock_ms: Any = field(default=lambda: int(time.time() * 1000))
    _events: list[Event] = field(default_factory=list, init=False, repr=False)

    def append(self, source: str, kind: str, data: dict[str, Any]) -> Event:
        safe = redact_value(data)
        # Defence in depth: refuse to record anything that still looks like a number or code.
        rendered = json.dumps(safe, ensure_ascii=False)
        if contains_secret_shape(rendered):
            raise RedactionError(f"event from {source}/{kind} still carries a phone number or code; not recorded")
        ev = Event(seq=len(self._events) + 1, t_ms=int(self.clock_ms()), call_id=self.call_id, source=source, kind=kind, data=safe)
        self._events.append(ev)
        if self.sink_path is not None:
            self.sink_path.parent.mkdir(parents=True, exist_ok=True)
            with self.sink_path.open("a", encoding="utf-8") as fh:
                fh.write(ev.to_json() + "\n")
        return ev

    def events(self) -> tuple[Event, ...]:
        return tuple(self._events)

    def latest_advice(self) -> dict[str, Event]:
        """The newest advice per sidecar."""
        out: dict[str, Event] = {}
        for ev in self._events:
            if ev.kind == "advice":
                out[ev.source] = ev
        return out

    def count(self, source: str | None = None, kind: str | None = None) -> int:
        return sum(1 for ev in self._events if (source is None or ev.source == source) and (kind is None or ev.kind == kind))

    def view_for_speaker(self, max_chars: int = 1200, per_sidecar_chars: int = 240) -> str:
        """One compact text the speaker reads each turn: latest advice per sidecar, newest first. One verbose sidecar cannot crowd out the others."""
        lines: list[str] = []
        for name, ev in sorted(self.latest_advice().items(), key=lambda kv: -kv[1].seq):
            summary = str(ev.data.get("summary", "")).strip()
            if summary:
                lines.append(f"[{name}] {summary[:per_sidecar_chars]}")
        text = "\n".join(lines) if lines else "[sidecars] no advice this turn"
        return text[:max_chars]


def replay(events: Iterable[Event]) -> list[dict[str, Any]]:
    return [json.loads(ev.to_json()) for ev in events]
