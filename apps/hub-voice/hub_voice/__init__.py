"""Sauti hub voice agent: one speaker, bounded advisory sidecars, an append-only blackboard.

Lane 10 (Domain, 2026-10-04). Everything that speaks, sends or changes anything is
the single speaker "sauti-hub" acting under policy and @sauti/core; sidecars only
advise. All AI runs on the hub PC; telephony only carries audio and SMS.
"""

__all__ = ["__version__"]
__version__ = "0.1.0"
