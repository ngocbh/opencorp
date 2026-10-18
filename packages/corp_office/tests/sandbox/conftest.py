import os
import sys

import pytest

from opencorp.sandbox.policy import SandboxPolicy

ON_MAC = sys.platform == "darwin"
ON_LINUX = sys.platform.startswith("linux")


@pytest.fixture(scope="session")
def sandbox_available(tmp_path_factory):
    """Skip when the sandbox can't start here (e.g. inside another sandbox), except on CI."""
    from opencorp.sandbox.run import run

    root = tmp_path_factory.mktemp("probe")
    (root / "ws").mkdir()
    (root / "tmp").mkdir()
    policy = SandboxPolicy(root / "ws", False, False, root / "tmp")
    try:
        result = run(policy, ["/bin/sh", "-c", "exit 0"], timeout=30)
        problem = None if result.exit == 0 else result.stderr.decode(errors="replace").strip()
    except (OSError, RuntimeError) as exc:
        problem = str(exc)
    if problem:
        if os.environ.get("CI"):
            pytest.fail(f"sandbox unavailable on CI: {problem}")
        pytest.skip(f"sandbox unavailable here: {problem}")


@pytest.fixture
def ws(tmp_path):
    path = tmp_path / "ws"
    path.mkdir()
    return path


@pytest.fixture
def make_policy(tmp_path, ws):
    tmp = tmp_path / "tmp"
    tmp.mkdir()

    def make(writable=True, network=False, read_only=()):
        return SandboxPolicy(ws, writable, network, tmp, read_only=read_only)

    return make
