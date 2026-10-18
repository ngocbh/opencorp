import os
from pathlib import Path

import pytest

from opencorp.sandbox.policy import SandboxPolicy, UnsafeWorkspace


def dirs(tmp_path):
    ws, tmp = tmp_path / "ws", tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    return ws, tmp


def test_paths_are_resolved(tmp_path):
    ws, tmp = dirs(tmp_path)
    link = tmp_path / "link"
    link.symlink_to(ws)
    policy = SandboxPolicy(workspace=link, writable=True, network=False, tmpdir=tmp)
    assert policy.workspace == Path(os.path.realpath(ws))
    assert policy.tmpdir == Path(os.path.realpath(tmp))


def test_read_only_paths_are_resolved_tuples(tmp_path):
    ws, tmp = dirs(tmp_path)
    policy = SandboxPolicy(ws, True, False, tmp, read_only=[str(tmp_path)])
    assert policy.read_only == (Path(os.path.realpath(tmp_path)),)


def test_workspace_must_exist(tmp_path):
    _, tmp = dirs(tmp_path)
    with pytest.raises(ValueError, match="workspace"):
        SandboxPolicy(tmp_path / "missing", True, False, tmp)


def test_tmpdir_must_exist(tmp_path):
    ws, _ = dirs(tmp_path)
    with pytest.raises(ValueError, match="tmpdir"):
        SandboxPolicy(ws, True, False, tmp_path / "missing")


def test_root_is_not_a_workspace(tmp_path):
    _, tmp = dirs(tmp_path)
    with pytest.raises(UnsafeWorkspace):
        SandboxPolicy(Path("/"), False, False, tmp)


def test_home_and_its_ancestors_are_not_workspaces(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    _, tmp = dirs(tmp_path)
    monkeypatch.setenv("HOME", str(home))
    for ws in (home, tmp_path):
        with pytest.raises(UnsafeWorkspace):
            SandboxPolicy(ws, False, False, tmp)
    project = home / "project"
    project.mkdir()
    assert SandboxPolicy(project, False, False, tmp).workspace.name == "project"


@pytest.mark.parametrize("rel", [
    ".agent-corp", ".agent-corp/office/runs", ".ssh", ".aws", ".gnupg", ".config/yian",
    "Library/Keychains", ".claude", ".codex", ".docker", ".kube", ".netrc",
])
def test_sensitive_home_paths_are_not_workspaces(tmp_path, monkeypatch, rel):
    home = tmp_path / "home"
    (home / rel).mkdir(parents=True)
    _, tmp = dirs(tmp_path)
    monkeypatch.setenv("HOME", str(home))
    with pytest.raises(UnsafeWorkspace, match="sensitive"):
        SandboxPolicy(home / rel, False, False, tmp)


def test_sensitive_paths_are_compared_resolved(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    _, tmp = dirs(tmp_path)
    link = tmp_path / "innocent"
    link.symlink_to(home / ".ssh")
    monkeypatch.setenv("HOME", str(tmp_path / "home-link"))
    (tmp_path / "home-link").symlink_to(home)
    with pytest.raises(UnsafeWorkspace):
        SandboxPolicy(link, False, False, tmp)
    # Names that merely start like a sensitive path are fine.
    (home / ".sshfs-mounts").mkdir()
    assert SandboxPolicy(home / ".sshfs-mounts", False, False, tmp).workspace.name == ".sshfs-mounts"


def test_protected_paths(tmp_path):
    ws, tmp = dirs(tmp_path)
    policy = SandboxPolicy(ws, True, False, tmp)
    git = policy.workspace / ".git"
    assert policy.protected == (git, git / "hooks", git / "config")
