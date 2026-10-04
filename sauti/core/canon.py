"""Canonical JSON (RFC 8785) and domain-separated digests.

Why a vetted canonicalizer: two devices, or a phone and a server, must compute
the same digest for the same envelope, or an approval given on one cannot be
checked on the other. json.dumps(sort_keys=True) is not a standard and differs
across languages in number and string escaping. rfc8785 (Trail of Bits) is.

Why no floats: JCS serialises floats, but an approval must never depend on how
0.1 was rounded. Envelopes carry integers and strings only; a float anywhere is
rejected before hashing.
"""

from __future__ import annotations

import hashlib
import math
from typing import Any

import rfc8785

ENVELOPE_DOMAIN = b"sauti.action_envelope.v1"
APPROVAL_DOMAIN = b"sauti.approval_record.v1"
SOURCE_DOMAIN = b"sauti.source_text.v1"
# r1.1 (2026-10-04): new record types get their own domains; the three above are unchanged.
OWNER_ALERT_DOMAIN = b"sauti.owner_alert.v1"
APPROVAL_CODE_DOMAIN = b"sauti.approval_code.v1"


class CanonError(ValueError):
    """The value cannot be canonicalised safely."""


def _check(value: Any, path: str = "$") -> None:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        if abs(value) > 2**53 - 1:
            raise CanonError(f"{path}: integer outside the exactly representable range")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonError(f"{path}: non-finite number")
        if value.is_integer() and abs(value) <= 2**53 - 1:
            return  # "1.0" parses as a float in Python and as 1 in JS; JCS serialises both as 1, see _normalize
        raise CanonError(f"{path}: floats are not allowed in envelopes; use integer units")
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonError(f"{path}: object keys must be strings")
            _check(item, f"{path}.{key}")
        return
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _check(item, f"{path}[{index}]")
        return
    raise CanonError(f"{path}: unsupported type {type(value).__name__}")


def _normalize(value: Any) -> Any:
    """Integral floats become ints so Python and JS hash the same bytes; everything else passes through."""
    if isinstance(value, float):
        return int(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize(v) for v in value]
    return value


def canonical_bytes(value: Any) -> bytes:
    """RFC 8785 bytes of a JSON-compatible value made of objects, arrays, strings, ints, bools, null."""
    _check(value)
    return rfc8785.dumps(_normalize(value))


def digest(domain: bytes, value: Any) -> str:
    """Lowercase hex sha256 over domain || 0x00 || canonical JSON. The domain prefix keeps an
    envelope digest from ever colliding with an approval or source digest of the same bytes."""
    if not domain or b"\x00" in domain:
        raise CanonError("domain must be non-empty and contain no NUL byte")
    return hashlib.sha256(domain + b"\x00" + canonical_bytes(value)).hexdigest()


def source_text_hash(text: str) -> str:
    """Digest of an immutable original source text (a review, a message), UTF-8."""
    return hashlib.sha256(SOURCE_DOMAIN + b"\x00" + text.encode("utf-8")).hexdigest()
