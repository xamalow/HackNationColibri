"""Seed the demo database with the example farm sheet, so W2 can run without doing W1 first.

    python scripts/seed_demo_data.py

The example farm sheet is invented for the demo (see data/DATASETS.md).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sauti import config
from sauti.farm_sheet import FarmSheet
from sauti.storage import db

EXAMPLE = config.ROOT / "data" / "farm_sheet.example.json"


def main() -> None:
    sheet = FarmSheet.model_validate_json(EXAMPLE.read_text(encoding="utf-8"))
    conn = db.connect(config.DB_PATH)
    try:
        current = db.get_current_farm_sheet(conn)
        if current is not None and current[1].content_hash() == sheet.content_hash():
            print(f"farm sheet already seeded (version {current[0]})")
            return
        version = db.save_farm_sheet(conn, sheet, source="seed_example", transcript=None)
        print(f"seeded example farm sheet as version {version} in {config.DB_PATH}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
