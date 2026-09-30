"""Monitor fixtures: a company repo, a store, a secret store, and test asset kinds."""

import pytest
import yaml

from agent_corp.assets import fake
from agent_corp.assets.registry import KindTool
from agent_corp.perm.monitor import Monitor
from agent_corp.secrets import SecretStore
from tests.company.conftest import _isolate_git, base_files, make_company  # noqa: F401
from tests.store.conftest import store  # noqa: F401

TOKEN = "s3cr3t-t0ken-value"


def use_key(asset, args, secrets):
    """A kind tool that needs its secret, and would leak it if the office let it."""
    if secrets.get("vault_token") != TOKEN:
        raise RuntimeError("no token")
    return f"ran {args.get('job')} on {args.get('partition')} with {secrets['vault_token']}"


def boom(asset, args, secrets):
    raise RuntimeError(f"cannot reach host (token {secrets['vault_token']})")


KINDS = {
    "fake": fake.TOOLS,
    "cluster": {
        "submit_job": KindTool(use_key, "Submit a job.", {
            "type": "object", "properties": {"job": {"type": "string"}, "partition": {"type": "string"},
                                             "vault_token": {"type": "string"}}, "required": ["job"]}),
        "read_logs": KindTool(lambda a, args, s: "logs"),
        "delete_data": KindTool(lambda a, args, s: "deleted"),
        "broken": KindTool(boom),
    },
}


def cluster(grants, **over):
    return {"id": "cluster-a", "kind": "cluster", "secrets": ["vault_token"], "grants": grants,
            "tools": {"submit_job": {}, "read_logs": {}, "delete_data": {"risk": "gated"}, "broken": {}}, **over}


@pytest.fixture
def secrets(tmp_path):
    s = SecretStore(tmp_path / "office" / "secrets")
    s.set("vault_token", TOKEN)
    return s


@pytest.fixture
def make_monitor(make_company, store, secrets):  # noqa: F811
    def make(**files):
        root = make_company(**files)
        return Monitor(root, store, secrets, KINDS)
    return make


def set_file(root, rel, content):
    (root / rel).write_text(yaml.safe_dump(content, sort_keys=False))
