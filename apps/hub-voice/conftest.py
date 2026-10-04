"""Make `hub_voice` importable when pytest runs from the repo root or from apps/hub-voice,
and run `async def` tests with plain asyncio (CI's Python set has pytest and nothing else)."""

import asyncio
import inspect
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
REPO = HERE.parent.parent
if str(REPO) not in sys.path:  # the Python reference (sauti/) and contracts/ live at the repo root
    sys.path.insert(0, str(REPO))


def pytest_configure(config):  # noqa: ANN001, ANN201
    config.addinivalue_line("markers", "asyncio: coroutine test, run with asyncio.run by conftest")


def pytest_pyfunc_call(pyfuncitem):  # noqa: ANN001, ANN201
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        kwargs = {name: pyfuncitem.funcargs[name] for name in pyfuncitem._fixtureinfo.argnames}
        asyncio.run(pyfuncitem.obj(**kwargs))
        return True
    return None
