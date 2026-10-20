"""Who else uses this host, for the warning when TCP is on."""

from types import SimpleNamespace

from opencorp.hq.status import other_users


def test_on_macos_other_accounts_under_users_count(tmp_path):
    for name in ("owner", "ann", "Shared", "Guest", ".localized"):
        (tmp_path / name).mkdir()
    assert other_users("darwin", users_dir=tmp_path, me="owner") == ["ann"]


def test_on_linux_other_logged_in_users_count(monkeypatch):
    monkeypatch.setattr("psutil.users", lambda: [SimpleNamespace(name="owner"), SimpleNamespace(name="bob"),
                                                 SimpleNamespace(name="bob")])
    assert other_users("linux", me="owner") == ["bob"]
