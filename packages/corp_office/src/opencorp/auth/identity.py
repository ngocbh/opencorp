"""This device's identity: ``<home>/identity.json`` (0600) holds the handle, device name and token.

``ac`` reads and writes the same file. The token in it is never printed, logged or committed.
"""

import json
import re
import socket
from dataclasses import asdict, dataclass
from pathlib import Path

from opencorp.secrets import write_private


def identity_path(home: Path) -> Path:
    """Where the device identity lives under an agent-corp home."""
    return home / "identity.json"


def device_name(hostname: str | None = None) -> str:
    """A device name from the host's short name, lowercased, with what a name can't hold made '-'."""
    short = (hostname if hostname is not None else socket.gethostname()).split(".")[0].lower()
    name = re.sub(r"^[^a-z0-9]+", "", re.sub(r"[^a-z0-9._-]+", "-", short))[:63]
    return name or "device"


@dataclass(frozen=True)
class Identity:
    """Who this device acts as, its name, and its token."""

    handle: str
    device: str
    token: str

    def __repr__(self) -> str:
        return f"Identity(handle={self.handle!r}, device={self.device!r})"  # never the token

    def headers(self) -> dict[str, str]:
        """The header that makes a request act as this device's person."""
        return {"Authorization": f"Bearer {self.token}"}


def write_identity(path: Path, identity: Identity) -> None:
    """Replace the identity file with ``identity``, atomically, created 0600 before the token is written."""
    write_private(path, (json.dumps(asdict(identity), indent=2) + "\n").encode())


def read_identity(path: Path) -> Identity | None:
    """The identity in ``path``, or None if there is none or it isn't one."""
    try:
        data = json.loads(path.read_text())
        return Identity(str(data["handle"]), str(data["device"]), str(data["token"]))
    except (OSError, ValueError, KeyError, TypeError):
        return None
