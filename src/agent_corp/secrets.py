"""The office secret store: asset credentials, one private file each."""

import os
import re
import tempfile
from pathlib import Path

NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")
MIN_VALUE_CHARS = 8
"""Shortest value accepted: results are scrubbed of every secret value, so a short one would mangle them."""


class SecretStore:
    """Secrets as files in ``root`` (mode ``0700``), each mode ``0600``.

    A value is read from its file each time it is needed and never kept, logged, or put
    in an environment or argv.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def __repr__(self) -> str:
        return f"SecretStore({str(self.root)!r})"

    def get(self, name: str) -> str:
        """Return the secret ``name``.

        Raises:
            KeyError: no secret has that name.
            ValueError: ``name`` is not a valid secret name.
        """
        try:
            return self._path(name).read_text(encoding="utf-8")
        except FileNotFoundError:
            raise KeyError(f"secret {name!r} is not set") from None

    def set(self, name: str, value: str) -> None:
        """Set the secret ``name`` to ``value``, replacing any old value atomically.

        Raises:
            ValueError: ``name`` is not a valid secret name, or ``value`` (without
                surrounding whitespace) is shorter than ``MIN_VALUE_CHARS``.
        """
        path = self._path(name)
        if len(value.strip()) < MIN_VALUE_CHARS:
            raise ValueError(f"secret {name!r} must be at least {MIN_VALUE_CHARS} characters")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".set-")  # created 0600
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(value)
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def delete(self, name: str) -> None:
        """Remove the secret ``name``.

        Raises:
            KeyError: no secret has that name.
            ValueError: ``name`` is not a valid secret name.
        """
        try:
            self._path(name).unlink()
        except FileNotFoundError:
            raise KeyError(f"secret {name!r} is not set") from None

    def _path(self, name: str) -> Path:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError(f"secret name {name!r} must match {NAME.pattern}")
        return self.root / name
