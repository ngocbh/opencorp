"""Office extensions: each module here has ``register(office)``, called once at start-up."""

from __future__ import annotations

import importlib
import pkgutil
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from opencorp.daemon.app import Office


class ExtensionError(Exception):
    """An extension failed to load; the message names it."""


def load_extensions(office: Office, package: str = __name__) -> list[str]:
    """Import each module in ``package`` in name order and call its ``register(office)``.

    Modules whose names start with ``_`` are skipped. Returns the names loaded.
    """
    pkg = importlib.import_module(package)
    loaded = []
    for info in sorted(pkgutil.iter_modules(pkg.__path__), key=lambda m: m.name):
        if info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{package}.{info.name}")
            register = getattr(module, "register", None)
            if register is None:
                raise ExtensionError(f"extension {info.name}: no register(office)")
            register(office)
        except ExtensionError:
            raise
        except Exception as exc:
            raise ExtensionError(f"extension {info.name}: {exc}") from exc
        loaded.append(info.name)
    return loaded
