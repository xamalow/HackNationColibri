"""The vendored browser bundle is exactly the file VENDOR.md says it is (warden on #80)."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from hub_voice.config import APP_ROOT

VENDOR = APP_ROOT / "demo" / "vendor"


def test_vendored_livekit_client_matches_vendor_md() -> None:
    md = (VENDOR / "VENDOR.md").read_text(encoding="utf-8")
    bundle = VENDOR / "livekit-client.umd.js"
    actual = hashlib.sha256(bundle.read_bytes()).hexdigest()
    declared = re.search(r"file sha256\s*\|\s*`([0-9a-f]{64})`", md)
    assert declared, "VENDOR.md must declare the bundle's sha256"
    assert declared.group(1) == actual, "the vendored bundle changed without VENDOR.md changing"
    assert "livekit-client" in md and re.search(r"\b2\.\d+\.\d+\b", md), "package name and exact version"
    assert "Apache-2.0" in md and (VENDOR / "LICENSE-livekit-client.txt").exists()
    assert "registry.npmjs.org/livekit-client" in md, "source URL (npm tarball)"
    assert "dist/livekit-client.umd.js" in md, "path inside the tarball"


def test_vendor_dir_holds_only_the_declared_files() -> None:
    names = sorted(p.name for p in VENDOR.iterdir())
    assert names == ["LICENSE-livekit-client.txt", "VENDOR.md", "livekit-client.umd.js"]
    assert not list(Path(VENDOR).glob("*.map"))  # no source maps, no extra code
