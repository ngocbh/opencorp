"""The app's Playwright fixture server sends the office's own CSP, so the app's CSP check tests what the office
serves."""

import re

import pytest

from opencorp.hq.guard import CSP
from opencorp.hq.version import CHECKOUT

FIXTURE = CHECKOUT / "packages/app/e2e/fixture.ts"


@pytest.mark.skipif(not FIXTURE.exists(), reason="needs packages/app")
def test_the_fixture_server_uses_the_offices_csp():
    # The formatter may break the line after "=", so match any whitespace there.
    found = re.search(r'const CSP =\s*"([^"]*)"', FIXTURE.read_text())
    assert found is not None and found.group(1) == CSP
