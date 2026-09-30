"""The office secret store: asset credentials, one private file each."""

import errno
import os
import re
import stat
import tempfile
from pathlib import Path

NAME = re.compile(r"^[a-z0-9_][a-z0-9_.-]{0,127}$")
MIN_VALUE_CHARS = 8
"""Shortest value accepted: results are scrubbed of every secret value, so a short one would mangle them."""


class SecretStore:
    """Secrets as files in ``root`` (mode ``0700``, owned by this user), each a regular file of mode ``0600``.

    A value is read from its file each time it is needed and never kept, logged, or put
    in an environment or argv. A root or secret file that is a symlink, or that others
    could read or write, is refused with ``PermissionError`` rather than trusted.
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
            PermissionError: the root or the secret's file is not private to this user.
        """
        path = self._path(name)
        if not self._checked_root():
            raise KeyError(f"secret {name!r} is not set")
        try:
            # O_NONBLOCK so a FIFO planted in place of a secret can't hang the open.
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            raise KeyError(f"secret {name!r} is not set") from None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.EMLINK):  # a symlink, refused by O_NOFOLLOW
                raise PermissionError(f"secret {name!r} is a symlink") from None
            if exc.errno == errno.EACCES:
                raise PermissionError(f"secret {name!r} must be mode 0600") from None
            raise
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise PermissionError(f"secret {name!r} is not a regular file")
            if stat.S_IMODE(st.st_mode) != 0o600:
                raise PermissionError(f"secret {name!r} must be mode 0600")
            with os.fdopen(fd, "rb", closefd=False) as f:
                return f.read().decode("utf-8")
        finally:
            os.close(fd)

    def set(self, name: str, value: str) -> None:
        """Set the secret ``name`` to ``value``, replacing any old value atomically.

        Creates the root, mode ``0700``, if it does not exist.

        Raises:
            ValueError: ``name`` is not a valid secret name, or ``value`` (without
                surrounding whitespace) is shorter than ``MIN_VALUE_CHARS``.
            PermissionError: the root is not a private directory of this user.
        """
        path = self._path(name)
        if len(value.strip()) < MIN_VALUE_CHARS:
            raise ValueError(f"secret {name!r} must be at least {MIN_VALUE_CHARS} characters")
        if not self._checked_root():
            self.root.parent.mkdir(parents=True, exist_ok=True)
            self.root.mkdir(mode=0o700)
            # Set the mode through a handle on the new directory itself, never a symlink, since
            # the umask may have narrowed it.
            fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fchmod(fd, 0o700)
            finally:
                os.close(fd)
            self._checked_root()
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".set-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                os.fchmod(f.fileno(), 0o600)
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
            PermissionError: the root is not a private directory of this user.
        """
        path = self._path(name)
        if not self._checked_root():
            raise KeyError(f"secret {name!r} is not set")
        try:
            path.unlink()
        except FileNotFoundError:
            raise KeyError(f"secret {name!r} is not set") from None

    def _checked_root(self) -> bool:
        """Whether the root exists; raises ``PermissionError`` if it does but is not private to this user."""
        try:
            st = os.lstat(self.root)
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(st.st_mode):
            raise PermissionError(f"secret store {str(self.root)!r} is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            raise PermissionError(f"secret store {str(self.root)!r} is not a directory")
        if st.st_uid != os.geteuid():
            raise PermissionError(f"secret store {str(self.root)!r} belongs to another user")
        if stat.S_IMODE(st.st_mode) & 0o077:
            raise PermissionError(f"secret store {str(self.root)!r} must be mode 0700")
        return True

    def _path(self, name: str) -> Path:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError(f"secret name {name!r} must match {NAME.pattern}")
        return self.root / name
