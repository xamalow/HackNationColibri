"""W2 text interface: Noor's evening session on the tourist inbox (voice comes with W6).

    python -m sauti.interfaces.inbox_cli fetch            # pull the simulated inbox, make proposals
    python -m sauti.interfaces.inbox_cli review           # hear each proposal, say ndiyo / hapana / rudia
    python -m sauti.interfaces.inbox_cli flush --offline  # airplane mode: nothing leaves, all stays queued
    python -m sauti.interfaces.inbox_cli flush            # connectivity: send the approved replies
    python -m sauti.interfaces.inbox_cli pasted I         # the Airbnb/GYG reply I was pasted by hand
    python -m sauti.interfaces.inbox_cli status

Each approval is tied to the proposal's short ID and to the hash of exactly what
was shown, so an answer can never approve a different or newer version.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3

from sauti import config
from sauti.farm_sheet import FarmSheet
from sauti.interfaces.session import TECHNICAL_PROBLEM, setup_logging
from sauti.lang.swahili import parse_confirmation
from sauti.storage import db
from sauti.transport.simulated import SimulatedInbox, SimulatedOutbox
from sauti.workflows import approve, outbox
from sauti.workflows.answer_tourist import Models, process_inbox

log = logging.getLogger("sauti.w2.cli")

INBOX_DIR = config.ROOT / "data" / "synthetic" / "inbox"
OUTBOX_FILE = config.ROOT / "data" / "runtime" / "outbox_simulated.jsonl"
MANUAL_CHANNELS = ("airbnb_manual", "gyg_manual")

NO_FARM_SHEET = "Bado sina taarifa za shamba. Tafadhali fanya usanidi wa shamba kwanza (W1)."
NOTHING_NEW = "Hakuna maombi mapya."


def _say(text: str) -> None:
    print(f"\nSauti > {text}")


def _farm_sheet(conn: sqlite3.Connection) -> FarmSheet | None:
    current = db.get_current_farm_sheet(conn)
    return None if current is None else current[1]


def cmd_fetch(conn: sqlite3.Connection, sheet: FarmSheet) -> None:
    ids = process_inbox(conn, [SimulatedInbox(INBOX_DIR)], sheet, Models.baseline())
    _say(f"Maombi mapya: {len(ids)}." if ids else NOTHING_NEW)


def cmd_review(conn: sqlite3.Connection, sheet: FarmSheet) -> None:
    pending = approve.list_open(conn)
    if not pending:
        _say(NOTHING_NEW)
        return
    for short_id, presented_hash, summary in pending:
        while True:
            _say(summary)
            body = _body(conn, short_id)
            if body:
                print(f"         (text to send: {body})")
            answer = parse_confirmation(_listen())
            if answer == "repeat":
                continue
            break
        if answer == "yes":
            result = approve.approve(conn, short_id, presented_hash, sheet)
            _report(result)
        elif answer == "no":
            approve.reject(conn, short_id)
            _say(f"Sawa, ombi {short_id} limekataliwa. Halitatumwa.")
        else:
            _say(f"Sikuelewa. Ombi {short_id} linabaki likisubiri.")


def _body(conn: sqlite3.Connection, short_id: str) -> str | None:
    row = conn.execute(
        "SELECT content FROM proposals WHERE short_id = ? AND state = 'PROPOSED'", (short_id,)
    ).fetchone()
    return json.loads(row[0]).get("body") if row else None


def _listen() -> str:
    try:
        return input("Noor  > ")
    except EOFError:
        return ""


def _report(result: approve.ApproveResult) -> None:
    messages = {
        "queued": f"Nimeidhinisha {result.short_id}. Litatumwa mtandao ukipatikana.",
        "nothing_to_send": f"Ombi {result.short_id} halina jibu la kutuma. Niambie la kujibu.",
        "not_found": f"Sikupata ombi {result.short_id}.",
    }
    if result.outcome in ("changed", "slot_taken"):
        _say(f"Ombi {result.short_id} limebadilika, sijatuma chochote. Toleo jipya:")
        _say(result.summary_sw or "")
    else:
        _say(messages.get(result.outcome, result.outcome))


def cmd_flush(conn: sqlite3.Connection, online: bool) -> None:
    sim = SimulatedOutbox(OUTBOX_FILE, online=online)
    report = outbox.flush(conn, {"sms": sim, "whatsapp": sim})
    if report.offline:
        _say("Hakuna mtandao. Majibu yaliyoidhinishwa yanasubiri.")
    if report.sent:
        _say(f"Majibu {len(report.sent)} yametumwa.")
    if report.failed or report.uncertain:
        _say("Kuna majibu ambayo hayakutumwa. Angalia hali.")
    manual = conn.execute(
        "SELECT COUNT(*) FROM outbox WHERE status = 'QUEUED' AND channel IN (?, ?)", MANUAL_CHANNELS
    ).fetchone()[0]
    if manual:
        _say(f"Majibu {manual} ya Airbnb au GetYourGuide yanasubiri kubandikwa na binti yako.")


def cmd_pasted(conn: sqlite3.Connection, short_id: str) -> None:
    row = conn.execute(
        "SELECT p.id FROM proposals p JOIN outbox o ON o.proposal_id = p.id"
        " WHERE p.short_id = ? AND o.status = 'QUEUED' AND o.channel IN (?, ?) ORDER BY p.id DESC LIMIT 1",
        (short_id.strip().upper(), *MANUAL_CHANNELS),
    ).fetchone()
    if row is None:
        _say(f"Sikupata jibu {short_id} linalosubiri kubandikwa.")
        return
    outbox.mark_manual_sent(conn, row[0])
    _say(f"Sawa, jibu {short_id} limetumwa.")


def cmd_status(conn: sqlite3.Connection) -> None:
    for short_id, kind, state, content in conn.execute(
        "SELECT short_id, kind, state, content FROM proposals ORDER BY id"
    ):
        c = json.loads(content)
        print(f"{short_id:>3}  {state:<9}  {kind:<10}  {c.get('template') or c.get('reason')}")
    for channel, status, n in conn.execute(
        "SELECT channel, status, COUNT(*) FROM outbox GROUP BY channel, status ORDER BY channel"
    ):
        print(f"outbox  {channel:<14} {status:<9} {n}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Sauti Host, W2 answer a tourist (text).")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("fetch")
    sub.add_parser("review")
    flush = sub.add_parser("flush")
    flush.add_argument("--offline", action="store_true", help="simulate airplane mode")
    pasted = sub.add_parser("pasted")
    pasted.add_argument("short_id")
    sub.add_parser("status")
    args = parser.parse_args(argv)

    config.force_offline()
    setup_logging()
    conn = db.connect(config.DB_PATH)
    try:
        if args.command == "status":
            cmd_status(conn)
            return
        if args.command == "flush":
            cmd_flush(conn, online=not args.offline)
            return
        if args.command == "pasted":
            cmd_pasted(conn, args.short_id)
            return
        sheet = _farm_sheet(conn)
        if sheet is None:
            _say(NO_FARM_SHEET)
            return
        if args.command == "fetch":
            cmd_fetch(conn, sheet)
        else:
            cmd_review(conn, sheet)
    except Exception:
        # Full trace to the log file, never to Noor.
        log.exception("W2 command %s failed", args.command)
        _say(TECHNICAL_PROBLEM)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
