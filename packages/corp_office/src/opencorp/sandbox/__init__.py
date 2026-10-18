"""Default-deny sandbox for model-controlled code: Seatbelt on macOS, bubblewrap on Linux."""

from opencorp.sandbox.policy import SandboxPolicy, UnsafeWorkspace
from opencorp.sandbox.run import Result, SandboxUnavailable, run

__all__ = ["Result", "SandboxPolicy", "SandboxUnavailable", "UnsafeWorkspace", "run"]
