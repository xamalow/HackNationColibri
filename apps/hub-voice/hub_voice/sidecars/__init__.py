from .base import Advice, Sidecar, SidecarContext, SidecarRunReport, Turn, run_sidecars
from .booking import BookingSidecar
from .escalator import EscalatorSidecar
from .language import LanguageSidecar
from .preparer import PreparerDisplay, PreparerGate, PreparerSidecar, RecordingDisplay
from .safety import SafetySidecar
from .translation import TranslationSidecar

__all__ = [
    "Advice",
    "BookingSidecar",
    "EscalatorSidecar",
    "LanguageSidecar",
    "PreparerDisplay",
    "PreparerGate",
    "PreparerSidecar",
    "RecordingDisplay",
    "SafetySidecar",
    "Sidecar",
    "SidecarContext",
    "SidecarRunReport",
    "TranslationSidecar",
    "Turn",
    "default_sidecars",
    "run_sidecars",
]


def default_sidecars(display: PreparerDisplay | None = None) -> list[Sidecar]:
    """The standard set, in the order their advice is most useful to read."""
    return [LanguageSidecar(), SafetySidecar(), BookingSidecar(), TranslationSidecar(), EscalatorSidecar(), PreparerSidecar(display)]
