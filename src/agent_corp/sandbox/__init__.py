"""Default-deny sandbox for model-controlled code: Seatbelt on macOS, bubblewrap on Linux."""

from agent_corp.sandbox.policy import SandboxPolicy, UnsafeWorkspace

__all__ = ["SandboxPolicy", "UnsafeWorkspace"]
