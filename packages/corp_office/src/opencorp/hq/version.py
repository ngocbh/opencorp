"""The ids that keep the web app and the office in step: the ``api`` compatibility key and the app's build."""

import hashlib
import importlib.metadata
import json
import tomllib
from pathlib import Path

from opencorp.protocol.models import AppBuild

CHECKOUT = Path(__file__).resolve().parents[5]
"""The checkout this code runs from (``packages/corp_office/src/opencorp/hq`` up five)."""


def office_api(checkout: Path = CHECKOUT) -> str:
    """The compatibility key: ``<version>+<first 12 hex of sha256(protocol.schema.json)>`` in a checkout, so a
    docs-only commit doesn't mark the app out of date; just the installed version without one, or when the checkout's
    ``pyproject.toml`` isn't opencorp's with a static version."""
    schema = checkout / "packages" / "protocol" / "schema" / "protocol.schema.json"
    try:
        project = tomllib.loads((checkout / "pyproject.toml").read_text())["project"]
        if project["name"] == "opencorp" and isinstance(version := project["version"], str):
            return f"{version}+{hashlib.sha256(schema.read_bytes()).hexdigest()[:12]}"
    except (OSError, ValueError, KeyError, TypeError):  # tomllib.TOMLDecodeError is a ValueError
        pass
    return importlib.metadata.version("opencorp")


MAX_BUILD_JSON = 64 * 1024
"""The largest build.json read; a bigger one isn't valid."""


class BuildInfo:
    """The built app's ``build.json`` under ``app_dir``, parsed again only when its content changes."""

    def __init__(self, app_dir: Path | None) -> None:
        self.path = None if app_dir is None else app_dir / "build.json"
        # The bytes last read and what they parsed to, swapped in one assignment so a reader on another thread never
        # pairs one file's bytes with another's build.
        self._cache: tuple[bytes, AppBuild | None] | None = None

    def read(self) -> AppBuild | None:
        """The app's build and key; None when it isn't built or the file isn't valid."""
        if self.path is None:
            return None
        # A few hundred bytes, read once per /api/health. Comparing bytes, not the mtime: two builds within one tick
        # of Linux's coarse inode clock have the same mtime. Only a regular file is read (a FIFO would block).
        raw = None
        if self.path.is_file():
            try:
                with self.path.open("rb") as f:
                    raw = f.read(MAX_BUILD_JSON + 1)
            except OSError:
                pass
        if raw is None or len(raw) > MAX_BUILD_JSON:
            self._cache = None
            return None
        cache = self._cache
        if cache is not None and cache[0] == raw:
            return cache[1]
        try:
            build: AppBuild | None = AppBuild.model_validate(json.loads(raw))
        # Bad JSON, bad UTF-8 and pydantic's ValidationError are all ValueErrors; deep nesting is a RecursionError.
        except (ValueError, RecursionError):
            build = None
        self._cache = (raw, build)
        return build
