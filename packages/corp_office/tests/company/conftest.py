"""Build throwaway company repos for tests."""

import os
import subprocess
from pathlib import Path

import pytest
import yaml

CHAT = """\
id: chat
name: chat
nodes:
  ask:
    kind: human_input
    prompt: "you> "
    output: str
  reply:
    kind: agent
    input:
      message: ${ask.output}
    output: str
    prompt: "${message}"
output: ${reply.output}
"""


def _clean_env() -> dict[str, str]:
    """os.environ without GIT_* and without the user's or system git config."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    return env | {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


@pytest.fixture(autouse=True)
def _isolate_git(monkeypatch):
    """Keep the caller's GIT_* variables and git config out of every test."""
    for key in [k for k in os.environ if k.startswith("GIT_")]:
        monkeypatch.delenv(key)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t",
                           *args], check=True, capture_output=True, text=True,
                          env=_clean_env()).stdout.strip()


def base_files() -> dict[str, object]:
    return {
        "company.yaml": {"name": "test-corp", "ceo": "ngocbh",
                         "defaults": {"cost_cap_usd": 5, "idle_end": "2h", "max_turns": 500}},
        "people/ngocbh/person.yaml": {"handle": "ngocbh", "name": "Hong Ngoc Bui",
                                      "kind": "human", "title": "CEO", "manager": None},
        "people/minh/person.yaml": {"handle": "minh", "name": "Minh", "kind": "agent",
                                    "title": "Engineer", "manager": "ngocbh", "groups": ["eng"],
                                    "main": "../../shared/flows/chat.yaml", "skills": ["code-review"],
                                    "harnesses": ["composer"],
                                    "harness_policy": {"sandbox": "workspace-write", "network": False}},
        "people/minh/profile.md": "# Minh, Engineer\n",
        "shared/flows/chat.yaml": CHAT,
        "shared/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Review code.\n---\nReview.\n",
        "groups/eng.yaml": {"id": "eng", "name": "Engineering", "parent": None, "head": None},
        "assets/fake.yaml": {"id": "fake", "kind": "fake", "tools": {"echo": {}},
                             "grants": [{"who": "group:eng", "can": ["echo"]}], "secrets": []},
    }


def write_repo(root: Path, files: dict[str, object]) -> Path:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content if isinstance(content, str) else yaml.safe_dump(content, sort_keys=False))
    _git(root, "init", "-q", "-b", "main")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "init")
    return root


def person(folder: str, **changes) -> dict:
    """The base person file in ``people/<folder>/`` with ``changes`` applied."""
    return dict(base_files()[f"people/{folder}/person.yaml"], **changes)


@pytest.fixture
def company(tmp_path):
    return write_repo(tmp_path / "company", base_files())


@pytest.fixture
def make_company(tmp_path):
    def make(**overrides):
        files = base_files()
        for rel, content in overrides.items():
            if content is None:
                files.pop(rel, None)
            else:
                files[rel] = content
        return write_repo(tmp_path / "company", files)
    return make
