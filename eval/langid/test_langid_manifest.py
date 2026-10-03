"""The language-ID manifest publishes no text, and matches the private set when it is present."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "heldout_manifest.json").read_text(encoding="utf-8"))
HELDOUT = HERE / "heldout" / MANIFEST["file"]


def test_manifest_carries_no_text_and_cites_its_sources() -> None:
    assert all("text" not in key for key in MANIFEST)
    assert sum(MANIFEST["categories"].values()) == MANIFEST["count"]
    assert all(s.get("license") and s.get("does_not_cover") for s in MANIFEST["sources"])


@pytest.mark.skipif(not HELDOUT.exists(), reason="held-out texts live only on Nat's machine")
def test_private_set_matches_the_committed_hash() -> None:
    assert hashlib.sha256(HELDOUT.read_bytes()).hexdigest() == MANIFEST["sha256"]
    items = [json.loads(line) for line in HELDOUT.read_text(encoding="utf-8").splitlines() if line]
    assert len(items) == MANIFEST["count"]
    assert all(i["acceptable"] for i in items)
    published = json.dumps(MANIFEST, ensure_ascii=False)
    assert not [i["id"] for i in items if i["text"] in published]  # no held-out text leaks into git
