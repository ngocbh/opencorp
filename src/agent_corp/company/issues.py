"""Problems found while loading or linting a company repo."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class RepoIssue:
    """One problem in one repo file. Mirrors the protocol ``RepoIssue`` field for field."""

    path: str
    code: str
    message: str
    severity: Literal["error", "warning"] = "error"
