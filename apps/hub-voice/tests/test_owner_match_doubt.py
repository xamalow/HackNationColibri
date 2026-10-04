"""'Any doubt = tourist mode' as tests against the LIVE hub path (warden, PR #42).

A false owner match has no approval power, but it would expose the pending-request
summary and the feedback summary, and let any caller spam Noor with proposals. So
every way the hub can fail to say a literal `true` must land in tourist mode:
match:false, a missing key, a non-bool, a non-object body, a non-200 status, a
network error, a timeout, bad JSON, and even a client that raises something that
is not a HubError.
"""

from __future__ import annotations

import asyncio

import pytest

from hub_voice.config import FIXTURES
from hub_voice.hubclient import HubError, HubReadOnly
from hub_voice.owner import classify_caller, number_hash

OWNER = "+254700000002"
LIVE = "http://hub.invalid:1"  # non-empty base_url = live path; _get is replaced below, nothing is ever contacted


def live_client(responder) -> HubReadOnly:  # noqa: ANN001
    client = HubReadOnly(LIVE, "token-from-env", FIXTURES)

    async def fake_get(path: str, params: dict[str, str]):  # noqa: ANN202
        assert path == "/v1/owner/match" and params == {"sha256": number_hash(OWNER)}
        result = responder()
        if isinstance(result, BaseException):
            raise result
        return result

    client._get = fake_get  # type: ignore[method-assign]
    return client


@pytest.mark.parametrize(
    "body",
    [
        {"match": False},
        {},
        {"match": None},
        {"match": "true"},
        {"match": 1},
        {"match": "yes"},
        {"matched": True},
        [True],
        "true",
        None,
    ],
    ids=["false", "missing", "null", "string-true", "int-1", "yes", "wrong-key", "list", "bare-string", "no-body"],
)
def test_anything_but_literal_true_is_tourist(body) -> None:  # noqa: ANN001
    client = live_client(lambda: body)
    assert asyncio.run(client.owner_match(number_hash(OWNER))) is False
    who = asyncio.run(classify_caller(OWNER, client))
    assert who.mode == "tourist" and who.reason == "not_enrolled"


@pytest.mark.parametrize(
    "exc",
    [HubError("hub answered 500"), HubError("hub unreachable: ConnectError"), HubError("hub unreachable: ReadTimeout"), ValueError("bad json"), asyncio.TimeoutError(), RuntimeError("boom")],
    ids=["http-500", "connect-error", "timeout-as-huberror", "bad-json", "asyncio-timeout", "unexpected"],
)
def test_any_failure_is_tourist_and_never_raises(exc: BaseException) -> None:
    client = live_client(lambda: exc)
    assert asyncio.run(client.owner_match(number_hash(OWNER))) is False
    who = asyncio.run(classify_caller(OWNER, client))
    assert who.mode == "tourist"


def test_literal_true_is_owner_and_malformed_hash_never_asks_the_hub() -> None:
    client = live_client(lambda: {"match": True})
    assert asyncio.run(classify_caller(OWNER, client)).mode == "owner"
    calls: list[str] = []

    async def counting_get(path: str, params: dict[str, str]):  # noqa: ANN202
        calls.append(path)
        return {"match": True}

    strict = HubReadOnly(LIVE, "t", FIXTURES)
    strict._get = counting_get  # type: ignore[method-assign]
    assert asyncio.run(strict.owner_match("not-a-hash")) is False
    assert asyncio.run(strict.owner_match("ABCDEF" * 10 + "ABCD")) is False  # uppercase is not the canonical hex
    assert calls == []


def test_classifier_requires_literal_true_from_the_client_too() -> None:
    class Truthy(HubReadOnly):
        async def owner_match(self, caller_sha256: str):  # noqa: ANN201 - deliberately wrong return type
            return "yes"

    assert asyncio.run(classify_caller(OWNER, Truthy(LIVE, "t", FIXTURES))).mode == "tourist"

    class Raising(HubReadOnly):
        async def owner_match(self, caller_sha256: str) -> bool:
            raise KeyError("not a HubError")

    who = asyncio.run(classify_caller(OWNER, Raising(LIVE, "t", FIXTURES)))
    assert who.mode == "tourist" and who.reason.startswith("owner_lookup_failed")
