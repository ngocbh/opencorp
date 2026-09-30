import pytest

from agent_corp.company.flows import load_confined
from tests.company.test_lint import CHILD, parent_flow


def test_root_need_not_be_resolved(company, tmp_path):
    (tmp_path / "link").symlink_to(company)
    link = tmp_path / "link"
    assert load_confined(link, link / "people/minh/../../shared/flows/chat.yaml").name == "chat"


def test_cross_file_cycle_is_refused(make_company):
    root = make_company(**{"shared/flows/a.yaml": parent_flow("b"),
                           "shared/flows/b.yaml": parent_flow("a").replace("id: chat", "id: b", 1)})
    with pytest.raises(ValueError, match="cycle"):
        load_confined(root, root / "shared/flows/a.yaml")


def test_pinned_version_is_checked(make_company):
    root = make_company(**{"shared/flows/chat.yaml": parent_flow("echo@2"),
                           "shared/flows/echo.yaml": CHILD.replace("id: echo", "id: echo\nversion: '1'", 1)})
    with pytest.raises(ValueError, match="version"):
        load_confined(root, root / "shared/flows/chat.yaml")
