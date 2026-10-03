"""The failure matrix stays well-formed, and no case claims a result without the revision it ran on."""

from __future__ import annotations

import json
from pathlib import Path

CASES = json.loads((Path(__file__).resolve().parent / "failure-cases.json").read_text(encoding="utf-8"))
REQUIRED = {"id", "area", "refs", "trigger", "expected_safe_state", "implementation_under_test", "observed"}


def test_ids_are_unique_and_cases_complete() -> None:
    ids = [case["id"] for case in CASES["cases"]]
    assert len(ids) == len(set(ids))
    for case in CASES["cases"]:
        assert REQUIRED <= set(case), case["id"]
        assert case["expected_safe_state"].get("must_not") or case["expected_safe_state"].get("result"), case["id"]


def test_an_observed_result_names_what_was_tested() -> None:
    for case in CASES["cases"]:
        if case["observed"] is not None:
            assert case["implementation_under_test"], f"{case['id']}: observed without a revision"
            assert {"revision", "result", "evidence"} <= set(case["observed"]), case["id"]
