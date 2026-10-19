"""HQ's settings: ``$OPENCORP_HOME/office/hq.json``, read when the office starts (restart to apply)."""

import dataclasses
import json
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from opencorp.hq.version import CHECKOUT

log = logging.getLogger(__name__)

DEFAULT_PORT = 49380
"""A fixed port, so a bookmark and an SSH forward keep working across restarts."""

_ORIGIN = re.compile(r"https?://[^/\s]+")
_KEYS = {"tcp", "port", "app_dir", "dev_origins"}


@dataclass(frozen=True)
class HqConfig:
    """Whether HQ listens on TCP and on which port (0: any free one), where the built app is, and the extra origins
    ``/api`` accepts (a Vite dev server)."""

    tcp: bool
    port: int
    app_dir: Path | None
    dev_origins: tuple[str, ...] = ()
    problem: str | None = None
    """Why ``hq.json`` was ignored, when it was."""


def default_app_dir(checkout: Path = CHECKOUT) -> Path | None:
    """``packages/app/dist`` in a checkout; None for an install from PyPI, which has no app yet."""
    app = checkout / "packages" / "app"
    return app / "dist" if app.is_dir() else None


def load_config(office_dir: Path, *, platform: str = sys.platform, checkout: Path = CHECKOUT) -> HqConfig:
    """``office_dir/hq.json`` over the defaults. A file that isn't valid is ignored, logged, and named in ``problem``.

    TCP is on by default only on macOS: on a host with other users, whoever holds the port while the office doesn't
    is the origin the browser trusts, so HQ listens there on ``hq.sock`` alone unless the owner opts in.
    """
    defaults = HqConfig(tcp=platform == "darwin", port=DEFAULT_PORT, app_dir=default_app_dir(checkout))
    path = office_dir / "hq.json"
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return defaults
    except (OSError, ValueError) as exc:
        return _ignored(defaults, f"{path} can't be read: {exc}")
    try:
        return _apply(defaults, data, office_dir)
    except ValueError as exc:
        return _ignored(defaults, f"{path}: {exc}")


def _apply(defaults: HqConfig, data: Any, office_dir: Path) -> HqConfig:
    if not isinstance(data, dict):
        raise ValueError("must be a JSON object")
    if unknown := set(data) - _KEYS:
        raise ValueError(f"unknown keys {sorted(unknown)}; known: {sorted(_KEYS)}")
    changes: dict[str, Any] = {}
    if "tcp" in data:
        if not isinstance(data["tcp"], bool):
            raise ValueError("tcp must be true or false")
        changes["tcp"] = data["tcp"]
    if "port" in data:
        port = data["port"]
        if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
            raise ValueError("port must be an integer from 0 (any free port) to 65535")
        changes["port"] = port
    if "app_dir" in data:
        if not isinstance(data["app_dir"], str) or not data["app_dir"]:
            raise ValueError("app_dir must be a path")
        app_dir = Path(data["app_dir"]).expanduser()
        changes["app_dir"] = app_dir if app_dir.is_absolute() else office_dir / app_dir
    if "dev_origins" in data:
        origins = data["dev_origins"]
        if not isinstance(origins, list) or not all(isinstance(o, str) and _ORIGIN.fullmatch(o) for o in origins):
            raise ValueError("dev_origins must be a list of origins such as http://localhost:5173")
        changes["dev_origins"] = tuple(origins)
    return dataclasses.replace(defaults, **changes)


def _ignored(defaults: HqConfig, why: str) -> HqConfig:
    log.error("ignoring HQ settings: %s", why)
    return dataclasses.replace(defaults, problem=why)
