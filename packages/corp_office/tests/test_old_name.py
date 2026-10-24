"""The old name, agent-corp, stays only where the move from it needs it."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

ALLOWED = {
    "packages/corp_office/src/opencorp/install/legacy.py",  # finds what an install from before the rename left
    "packages/corp_office/src/opencorp/sandbox/policy.py",  # keeps an unmoved old home out of workspaces
    "packages/corp_office/tests/install/test_legacy.py",
    "packages/corp_office/tests/test_old_name.py",
    "packages/office/tests/python_ids.txt",  # the snapshot of test ids holds test_policy.py's old-home cases
    "packages/tui/src/theme/index.ts",  # a theme saved under the old default name still loads
    "packages/tui/test/upstream-name.test.ts",  # pins that alias
}


def test_the_old_name_is_left_only_where_the_move_needs_it():
    grep = subprocess.run(
        ["git", "grep", "-liE", "agent[-_ ]?corp|AGENT_CORP", "--", ".", ":!packages/yian"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    # legacy.py always matches, so anything but 0 means git or the checkout is missing and nothing was searched.
    assert grep.returncode == 0, grep.stderr
    assert sorted(set(grep.stdout.split()) - ALLOWED) == []
