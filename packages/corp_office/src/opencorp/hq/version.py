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
    docs-only commit doesn't mark the app out of date; just the installed version without one."""
    pyproject = checkout / "pyproject.toml"
    schema = checkout / "packages" / "protocol" / "schema" / "protocol.schema.json"
    if pyproject.is_file() and schema.is_file():
        version = tomllib.loads(pyproject.read_text())["project"]["version"]
        return f"{version}+{hashlib.sha256(schema.read_bytes()).hexdigest()[:12]}"
    return importlib.metadata.version("opencorp")


class BuildInfo:
    """The built app's ``build.json`` under ``app_dir``, parsed again only when its content changes."""

    def __init__(self, app_dir: Path | None) -> None:
        self.path = None if app_dir is None else app_dir / "build.json"
        self._raw: bytes | None = None
        self._build: AppBuild | None = None

    def read(self) -> AppBuild | None:
        """The app's build and key; None when it isn't built or the file isn't valid."""
        if self.path is None:
            return None
        try:
            # A few hundred bytes, read once per /api/health. Comparing bytes, not the mtime: two builds within one
            # tick of Linux's coarse inode clock have the same mtime.
            raw = self.path.read_bytes()
        except OSError:
            self._raw = self._build = None
            return None
        if raw != self._raw:
            self._raw = raw
            try:
                self._build = AppBuild.model_validate(json.loads(raw))
            except ValueError:  # bad JSON, bad UTF-8 and pydantic's ValidationError are all ValueErrors
                self._build = None
        return self._build
