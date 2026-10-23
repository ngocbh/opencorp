"""The office's tool specs, as a worker's job carries them, equal the saved copy the TypeScript office is checked
against (tool schemas match today's output exactly)."""

import json
from pathlib import Path

from opencorp.company.loader import load_repo
from opencorp.perm.monitor import Monitor
from opencorp.secrets import SecretStore
from opencorp.tools import ToolContext, build
from opencorp.worker import group_specs
from tests.store.conftest import session, work_item

GOLDEN = Path(__file__).resolve().parents[3] / "office" / "tests" / "fixtures" / "tool_specs.json"
GROUPS = ("toolbox", "workspace", "company", "work_items")


def spec_text(store, company, tmp_path) -> str:
    """Every office tool group's specs for a run of minh, as the saved copy holds them.

    The base company grants minh (group eng) the ``fake`` asset's ``echo``, so ``toolbox`` lists the
    built-in kind through a real ``Monitor``. ``workspace=object()`` stands in for ``WorkspaceTools``:
    building specs never calls it.
    """
    item = store.create_work_item(work_item(requester="minh"))
    s = store.create_session(session(person="minh", work_item_id=item.id))
    monitor = Monitor(company, store, SecretStore(tmp_path / "office" / "secrets"))
    ctx = ToolContext(store=store, repo=load_repo(company), session=s, run_id="run-1",
                      on_question=lambda q, *, work_item=None: q, monitor=monitor, workspace=object())
    specs = {group: [spec.model_dump(mode="json") for spec in specs]
             for group, specs in group_specs(build(GROUPS, ctx)).items()}
    return json.dumps(specs, indent=2, ensure_ascii=False) + "\n"


def test_the_office_tool_specs_equal_the_saved_copy(store, company, tmp_path):
    assert spec_text(store, company, tmp_path) == GOLDEN.read_text(encoding="utf-8")
