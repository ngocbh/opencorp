"""Private files: the office secret store of asset credentials, and ``write_private``/``read_private`` for other
secrets."""

import errno
import os
import re
import stat
from contextlib import suppress
from pathlib import Path

NAME = re.compile(r"^[a-z0-9_][a-z0-9_.-]{0,127}$")
MIN_VALUE_CHARS = 8
"""Shortest value accepted: results are scrubbed of every secret value, so a short one would mangle them."""

type Stamp = tuple[int, int, int, int, int, int, int]
"""What says a file changed, from its stat: device, inode, size, mtime, ctime, mode and owner. An edit in place moves
the ctime even when the size and mtime are kept."""


def stamp(st: os.stat_result) -> Stamp:
    """``st`` as a ``Stamp``."""
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_uid


# The final component of a symlink under O_NOFOLLOW fails with ELOOP (EMLINK on some BSDs).
_SYMLINK_ERRNOS = (errno.ELOOP, errno.EMLINK)


class SecretStore:
    """Secrets as files in ``root`` (mode ``0700``, owned by this user), each a regular file of mode ``0600``.

    A value is read from its file each time it is needed and never kept, logged, or put
    in an environment or argv. A root or secret file that is a symlink, or that is not
    private to this user, is refused with ``PermissionError`` rather than trusted. The root
    is opened and checked once per call, and the call then works through that handle, so
    swapping the root's path afterwards changes nothing.
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
            PermissionError: the root or the secret's file is not private to this user, or
                the value is too short to scrub.
        """
        self._check_name(name)
        root = self._open_root(create=False)
        if root is None:
            raise KeyError(f"secret {name!r} is not set")
        try:
            try:
                # O_NONBLOCK so a FIFO planted in place of a secret can't hang the open.
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            except FileNotFoundError:
                raise KeyError(f"secret {name!r} is not set") from None
            except OSError as exc:
                if exc.errno in _SYMLINK_ERRNOS:
                    raise PermissionError(f"secret {name!r} is a symlink") from None
                if exc.errno == errno.EACCES:
                    raise PermissionError(f"secret {name!r} is not readable") from None
                raise
        finally:
            os.close(root)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise PermissionError(f"secret {name!r} is not a regular file")
            if st.st_uid != os.geteuid():
                raise PermissionError(f"secret {name!r} belongs to another user")
            if stat.S_IMODE(st.st_mode) != 0o600:
                raise PermissionError(f"secret {name!r} must be mode 0600")
            with os.fdopen(fd, "rb", closefd=False) as f:
                value = f.read().decode("utf-8")
        finally:
            os.close(fd)
        if len(value.strip()) < MIN_VALUE_CHARS:
            raise PermissionError(f"secret {name!r} is shorter than {MIN_VALUE_CHARS} characters")
        return value

    def names(self) -> list[str]:
        """The names in the root that could name a secret, sorted; none when there is no root.

        Raises:
            PermissionError: the root is not a private directory of this user.
        """
        root = self._open_root(create=False)
        if root is None:
            return []
        try:
            return sorted(name for name in os.listdir(root) if NAME.fullmatch(name))
        finally:
            os.close(root)

    def stamps(self) -> tuple[Stamp, tuple[tuple[str, Stamp | None], ...]] | None:
        """What says a secret changed: the root's stamp and each name's (``names``), not following symlinks; None
        when there is no root.

        Raises:
            PermissionError: the root is not a private directory of this user.
        """
        root = self._open_root(create=False)
        if root is None:
            return None
        try:
            found = []
            for name in sorted(n for n in os.listdir(root) if NAME.fullmatch(n)):
                try:
                    found.append((name, stamp(os.stat(name, dir_fd=root, follow_symlinks=False))))
                except FileNotFoundError:  # removed meanwhile
                    found.append((name, None))
            return stamp(os.fstat(root)), tuple(found)
        finally:
            os.close(root)

    def set(self, name: str, value: str) -> None:
        """Set the secret ``name`` to ``value``, replacing any old value atomically.

        Creates the root, mode ``0700``, if it does not exist.

        Raises:
            ValueError: ``name`` is not a valid secret name, or ``value`` (without
                surrounding whitespace) is shorter than ``MIN_VALUE_CHARS``.
            PermissionError: the root is not a private directory of this user.
        """
        self._check_name(name)
        if len(value.strip()) < MIN_VALUE_CHARS:
            raise ValueError(f"secret {name!r} must be at least {MIN_VALUE_CHARS} characters")
        root = self._open_root(create=True)
        try:
            tmp = f".set-{os.urandom(8).hex()}"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    os.fchmod(f.fileno(), 0o600)  # the umask may have narrowed it
                    f.write(value)
                os.replace(tmp, name, src_dir_fd=root, dst_dir_fd=root)
            except BaseException:
                with suppress(FileNotFoundError):
                    os.unlink(tmp, dir_fd=root)
                raise
        finally:
            os.close(root)

    def delete(self, name: str) -> None:
        """Remove the secret ``name``.

        Raises:
            KeyError: no secret has that name.
            ValueError: ``name`` is not a valid secret name.
            PermissionError: the root is not a private directory of this user.
        """
        self._check_name(name)
        root = self._open_root(create=False)
        if root is None:
            raise KeyError(f"secret {name!r} is not set")
        try:
            os.unlink(name, dir_fd=root)
        except FileNotFoundError:
            raise KeyError(f"secret {name!r} is not set") from None
        finally:
            os.close(root)

    def _open_root(self, *, create: bool) -> int | None:
        """An open handle on the checked root, or None if it doesn't exist and ``create`` is false.

        Raises ``PermissionError`` if the root is a symlink, not a directory, owned by
        another user, or open to group or others.
        """
        created = False
        if create:
            self.root.parent.mkdir(parents=True, exist_ok=True)
            with suppress(FileExistsError):  # another call may create it at the same time
                self.root.mkdir(mode=0o700)
                created = True
        try:
            fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except FileNotFoundError:
            if create:
                raise
            return None
        except OSError as exc:
            if exc.errno in (*_SYMLINK_ERRNOS, errno.ENOTDIR):
                raise PermissionError(f"secret store {str(self.root)!r} must be a directory, not a symlink") from None
            raise
        try:
            if created:
                os.fchmod(fd, 0o700)  # the umask may have narrowed it
            st = os.fstat(fd)
            if st.st_uid != os.geteuid():
                raise PermissionError(f"secret store {str(self.root)!r} belongs to another user")
            if stat.S_IMODE(st.st_mode) & 0o077:
                raise PermissionError(f"secret store {str(self.root)!r} must be mode 0700")
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _check_name(name: str) -> None:
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError(f"secret name {name!r} must match {NAME.pattern}")


def write_private(path: Path, data: bytes) -> None:
    """Replace ``path`` with ``data`` as a 0600 file, atomically; a symlink at ``path`` is replaced, not followed."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.unlink(missing_ok=True)  # left by a crashed run with the same pid
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def read_private(path: Path) -> bytes:
    """The contents of ``path``, which must be a regular file private to its owner.

    Raises:
        FileNotFoundError: there is no file.
        PermissionError: the file is a symlink, not a regular file, another user's, or readable by others, or
            can't be opened.
    """
    try:
        # O_NONBLOCK so a FIFO planted in its place can't hang the open; fstat then refuses it.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise PermissionError(f"can't open {path}: {exc.strerror}") from None
    st = os.fstat(fd)  # before fdopen, which refuses a directory with IsADirectoryError
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        os.close(fd)
        raise PermissionError(f"{path} must be a regular file private to its owner (mode 0600)")
    with os.fdopen(fd, "rb") as f:
        return f.read()
