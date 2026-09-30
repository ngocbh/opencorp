"""Default-deny sandbox for model-controlled code: Seatbelt on macOS, bubblewrap on Linux."""

from agent_corp.sandbox.policy import SandboxPolicy, UnsafeWorkspace
from agent_corp.sandbox.run import Result, SandboxUnavailable, run

__all__ = ["Result", "SandboxPolicy", "SandboxUnavailable", "UnsafeWorkspace", "run"]
