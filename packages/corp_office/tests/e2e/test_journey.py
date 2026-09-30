"""The M1 journey on a real office: Minh edits a file, is steered and stopped, debriefs, learns, and starts his next session changed."""

import pytest

pytestmark = pytest.mark.timeout(180)


def test_the_m1_journey(office, workspace, sandbox_available):
    # 1. `ac` in a fresh folder: the office is healthy, the picker offers Minh, and he edits a file.
    doctor = office.ac("doctor", cwd=workspace)
    assert not [line for line in doctor.stdout.splitlines() if line.startswith("fail")], doctor.stdout
    minh = office.person("minh")
    assert office.folder_people(workspace) == []
