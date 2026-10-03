"""Priority 3: kill the process mid-queue, restart: no message lost, none sent twice."""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

from sauti.storage.states import OutboxStatus
from sauti.transport.simulated import SimulatedOutbox
from sauti.workflows import approve, outbox
from tests.w2_helpers import SHEET, RecordingTransport, connect, propose_one, state

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = [
    "Hi! How much does the tour cost for 4 people?",
    "Was kostet die Tour für 2 Personen?",
    "Combien coûte la visite pour 3 personnes ?",
]


def _queue_three(db_path: Path) -> list[int]:
    conn = connect(db_path)
    pids = []
    for i, q in enumerate(QUESTIONS):
        pid, short_id, h, _ = propose_one(conn, q, ext=f"r{i}")
        assert approve.approve(conn, short_id, h, SHEET).outcome == "queued"
        pids.append(pid)
    conn.close()
    return pids


def _sent_lines(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_process_killed_after_send_before_commit_does_not_duplicate(tmp_path):
    db_path, out_path = tmp_path / "sauti.db", tmp_path / "outbox.jsonl"
    pids = _queue_three(db_path)

    # The child sends the first message, then dies before recording that it did.
    child = textwrap.dedent(f"""
        import os, sys
        sys.path.insert(0, {str(ROOT)!r})
        from pathlib import Path
        from sauti.storage import db
        from sauti.transport.simulated import SimulatedOutbox
        from sauti.workflows import outbox

        class DiesAfterSend(SimulatedOutbox):
            def send(self, message):
                super().send(message)
                os._exit(137)

        conn = db.connect({str(db_path)!r})
        t = DiesAfterSend(Path({str(out_path)!r}))
        outbox.flush(conn, {{"sms": t}})
    """)
    proc = subprocess.run([sys.executable, "-c", child], capture_output=True, timeout=60, check=False)
    assert proc.returncode == 137, proc.stderr.decode(errors="replace")
    assert len(_sent_lines(out_path)) == 1

    # Restart: recovery asks the transport, marks the first as sent, sends the other two once.
    conn = connect(db_path)
    report = outbox.flush(conn, {"sms": SimulatedOutbox(out_path)})
    lines = _sent_lines(out_path)
    assert len(lines) == 3
    assert len({line["idempotency_key"] for line in lines}) == 3
    assert sorted(report.sent) == sorted(pids)
    assert all(state(conn, pid) == "SENT" for pid in pids)

    # Another restart changes nothing.
    outbox.flush(conn, {"sms": SimulatedOutbox(out_path)})
    assert len(_sent_lines(out_path)) == 3


def test_crash_before_send_requeues_and_sends_once(tmp_path):
    db_path = tmp_path / "sauti.db"
    [pid, *_] = _queue_three(db_path)
    conn = connect(db_path)
    with conn:  # what a crash right after the SENDING mark leaves behind
        conn.execute("UPDATE outbox SET status = ? WHERE proposal_id = ?", (OutboxStatus.SENDING.value, pid))
    transport = RecordingTransport()
    outbox.flush(conn, {"sms": transport})
    assert len(transport.sent) == 3
    assert state(conn, pid) == "SENT"


def test_transport_that_cannot_tell_is_never_resent_blindly(tmp_path):
    db_path = tmp_path / "sauti.db"
    [pid, *_] = _queue_three(db_path)
    conn = connect(db_path)
    with conn:
        conn.execute("UPDATE outbox SET status = ? WHERE proposal_id = ?", (OutboxStatus.SENDING.value, pid))
    transport = RecordingTransport(knows=False)
    report = outbox.flush(conn, {"sms": transport})
    assert report.uncertain == [pid]
    assert pid not in [p for p in report.sent]
    assert len(transport.sent) == 2  # the other two only
    status = conn.execute("SELECT status FROM outbox WHERE proposal_id = ?", (pid,)).fetchone()[0]
    assert status == OutboxStatus.UNCERTAIN.value
    assert state(conn, pid) == "FAILED"
    # Only Noor's explicit retry puts it back in the queue.
    outbox.retry(conn, pid)
    outbox.flush(conn, {"sms": RecordingTransport()})
    assert state(conn, pid) == "SENT"


def test_offline_keeps_everything_queued_without_counting_attempts(tmp_path):
    db_path = tmp_path / "sauti.db"
    pids = _queue_three(db_path)
    conn = connect(db_path)
    for _ in range(5):
        report = outbox.flush(conn, {"sms": RecordingTransport(online=False)})
        assert report.offline
    rows = conn.execute("SELECT status, attempts FROM outbox ORDER BY id").fetchall()
    assert rows == [("QUEUED", 0)] * 3
    assert all(state(conn, pid) == "QUEUED" for pid in pids)


def test_repeated_refusals_end_in_failed_not_in_a_loop(tmp_path):
    db_path = tmp_path / "sauti.db"
    pids = _queue_three(db_path)
    conn = connect(db_path)
    for _ in range(outbox.MAX_ATTEMPTS):
        outbox.flush(conn, {"sms": RecordingTransport(fail=True)})
    assert all(state(conn, pid) == "FAILED" for pid in pids)
