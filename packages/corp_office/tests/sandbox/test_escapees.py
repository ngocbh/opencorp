import sys
import tempfile
from pathlib import Path

import pytest

from opencorp.sandbox.escapees import Canary

# The run tests cover the sweep itself (test_setsid_child_dies_with_the_call).
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="macOS escape sweep")


def test_canary_directories_exist_until_closed():
    canary = Canary()
    assert canary.allowed.is_dir() and canary.denied.is_dir()
    assert canary.allowed.parent == canary.denied.parent == canary.root
    canary.close()
    assert not canary.root.exists()


def test_canary_is_created_outside_writable_paths():
    # Under a writable path, `denied` would be writable too and nothing would match.
    tmp = Path(tempfile.gettempdir()).resolve()
    canary = Canary(avoid=(tmp,))
    try:
        assert not canary.root.is_relative_to(tmp)
    finally:
        canary.close()
