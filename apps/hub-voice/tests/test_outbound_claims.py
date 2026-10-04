"""codex on #65: the one-call guarantee must hold in the worker itself and under two pollers."""

from __future__ import annotations

import inspect
import json
import threading
from pathlib import Path

from hub_voice import outbound as ob
from hub_voice.outbound import CallLedger, ClipLibrary

T0 = 1_791_000_000_000
DAY = ob.farm_day(T0)


def test_pre_dial_claim_is_once_per_alert_across_instances_and_after_results(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    assert CallLedger(path).reserve("alert:0001", DAY, 5, T0)
    assert CallLedger(path).claim_dial("alert:0001", T0 + 1)  # the first dispatched job dials
    assert not CallLedger(path).claim_dial("alert:0001", T0 + 2)  # a duplicate dispatch or restarted job does not
    assert CallLedger(path).quarantined("alert:0001")  # claimed, no result yet: interrupted = quarantined
    CallLedger(path).record("alert:0001", "answered", T0 + 3, played=["a"], missing=[])
    assert not CallLedger(path).quarantined("alert:0001")
    assert not CallLedger(path).claim_dial("alert:0001", T0 + 4)  # never again after an answered result either
    assert not CallLedger(path).claim_dial("alert:9999", T0)  # an unreserved alert cannot be dialed at all
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    assert [r["kind"] for r in rows] == ["reserve", "dial", "result"]


def test_two_pollers_cannot_both_reserve_one_alert_or_exceed_the_cap(tmp_path: Path) -> None:
    path = tmp_path / "ledger.jsonl"
    cap = 3
    results: list[tuple[str, bool]] = []
    lock = threading.Lock()

    def worker(alert_id: str) -> None:
        ok = CallLedger(path).reserve(alert_id, DAY, cap, T0)  # a fresh instance per thread = a separate poller process
        with lock:
            results.append((alert_id, ok))

    # 8 racing attempts: the same alert 4 times, plus 4 distinct alerts; cap 3 for the day
    ids = ["dup"] * 4 + ["a", "b", "c", "d"]
    threads = [threading.Thread(target=worker, args=(i,)) for i in ids]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # invariants under any interleaving: the duplicated alert is reserved at most once, and the day never exceeds its cap
    assert sum(ok for i, ok in results if i == "dup") <= 1
    assert sum(ok for _i, ok in results) == cap
    assert CallLedger(path).count(DAY) == cap
    assert len({i for i, ok in results if ok}) == cap  # each successful reservation is a distinct alert
    # and deterministically, alone: the same alert from two "pollers" reserves exactly once
    solo = tmp_path / "solo.jsonl"
    assert CallLedger(solo).reserve("same", DAY, cap, T0) is True
    assert CallLedger(solo).reserve("same", DAY, cap, T0) is False
    assert CallLedger(solo).count(DAY) == 1  # the losing attempt gave its slot back
    # the next day starts fresh; yesterday's slots are not reused today
    assert CallLedger(path).reserve("tomorrow", "2026-10-04", cap, T0)


def test_played_labels_follow_the_files_when_an_earlier_clip_is_missing(tmp_path: Path) -> None:
    audio = tmp_path / "audio"
    (audio / "sw").mkdir(parents=True)
    keys = ["first.missing", "second.ok", "third.ok"]
    (audio / "manifest.json").write_text(json.dumps({"copy_clips": [{"key": k, "file": f"audio/sw/{k}.wav", "status": "RECORDED"} for k in keys]}), encoding="utf-8")
    for k in ("second.ok", "third.ok"):
        ob.make_silence(audio / "sw" / f"{k}.wav", 40)
    pairs, missing = ClipLibrary(audio / "manifest.json").resolve_pairs(keys)
    assert missing == ["first.missing"]
    assert [(k, p.name) for k, p in pairs] == [("second.ok", "second.ok.wav"), ("third.ok", "third.ok.wav")]


def test_worker_claims_before_dialing_and_never_zips_keys_with_files() -> None:
    src = inspect.getsource(ob.alert_entrypoint)
    assert src.index("ledger.claim_dial(") < src.index("create_sip_participant(")
    assert "zip(" not in src and "for key, path in pairs" in src
