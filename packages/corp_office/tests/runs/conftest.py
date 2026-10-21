"""Run Logs fixtures: the learning harness (debrief and profile-manager flows, a second connection, and Lan, a human
who isn't the CEO) and Learning on it."""

import pytest

from tests.profile.conftest import (LEARNING_FILES, _isolate_git, fake_llm, learning, make_harness,  # noqa: F401
                                    workspace)

LAN = {"people/lan/person.yaml": {"handle": "lan", "name": "Lan", "kind": "human", "title": "Designer",
                                  "manager": "ngocbh"}}


@pytest.fixture
def harness(make_harness):  # noqa: F811
    return make_harness(files={**LEARNING_FILES, **LAN}, connections={"second": "stub-2"})
