"""Who may manage the office's model connections."""

import pytest

from agent_corp.company.loader import load_repo
from agent_corp.perm.office import may_manage_connections

AVA = {"people/ava/person.yaml": {"handle": "ava", "name": "Ava", "kind": "human", "title": "Designer",
                                  "manager": "ngocbh", "groups": ["design"]},
       "groups/design.yaml": {"id": "design", "name": "Design", "parent": None, "head": None}}


def grant(who: str, can: list[str], kind: str = "office") -> dict:
    return {"assets/offices.yaml": {"id": "offices", "kind": kind, "tools": {"connections": {}},
                                    "grants": [{"who": who, "can": can}]}}


@pytest.mark.parametrize("person,owner,assets,ok", [
    ("ava", "ava", {}, True),                     # the office owner
    ("ava", "ngocbh", {}, False),                 # anyone else, by default
    ("ngocbh", "ava", {}, False),                 # the CEO isn't implicit once there is an owner
    ("ngocbh", None, {}, True),                   # no identity yet: the CEO
    ("ava", None, {}, False),                     # ... and only the CEO
    ("ava", "ngocbh", grant("ava", ["connections"]), True),
    ("ava", "ngocbh", grant("group:design", ["admin"]), True),           # via her group
    ("minh", "ngocbh", grant("group:design", ["connections"]), False),  # another group's grant
    ("ava", "ngocbh", grant("ava", ["connections"], kind="cluster"), False),  # not an office asset
])
def test_who_may_manage_connections(person, owner, assets, ok, make_company):
    repo = load_repo(make_company(**AVA, **assets))
    assert may_manage_connections(repo, person, owner=owner) is ok
