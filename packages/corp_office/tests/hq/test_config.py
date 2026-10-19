"""HQ's settings in office/hq.json."""

import json

import pytest

from opencorp.hq.config import DEFAULT_PORT, load_config


def write(office_dir, data):
    office_dir.mkdir(parents=True, exist_ok=True)
    (office_dir / "hq.json").write_text(data if isinstance(data, str) else json.dumps(data))


@pytest.mark.parametrize(("platform", "tcp"), [("darwin", True), ("linux", False)])
def test_tcp_is_on_by_default_only_on_macos(tmp_path, platform, tcp):
    config = load_config(tmp_path, platform=platform, checkout=tmp_path)
    assert (config.tcp, config.port, config.dev_origins, config.problem) == (tcp, DEFAULT_PORT, (), None)


def test_the_app_dir_defaults_to_the_checkouts_dist_and_is_none_outside_a_checkout(tmp_path):
    assert load_config(tmp_path, checkout=tmp_path).app_dir is None
    (tmp_path / "packages" / "app").mkdir(parents=True)
    assert load_config(tmp_path, checkout=tmp_path).app_dir == tmp_path / "packages" / "app" / "dist"


def test_settings_override_the_defaults(tmp_path):
    write(tmp_path, {"tcp": True, "port": 0, "app_dir": "web", "dev_origins": ["http://localhost:5173"]})
    config = load_config(tmp_path, platform="linux", checkout=tmp_path)
    assert (config.tcp, config.port, config.app_dir, config.dev_origins) == (
        True, 0, tmp_path / "web", ("http://localhost:5173",))


@pytest.mark.parametrize("bad", ["{", "[]", {"tcp": "yes"}, {"port": 70000}, {"port": True}, {"colour": 1},
                                 {"dev_origins": ["localhost:5173"]}, {"dev_origins": ["http://a/b"]},
                                 {"app_dir": "~nosuchuser-opencorp/dist"},
                                 pytest.param("[" * 100_000 + "]" * 100_000, id="deeply-nested")])
def test_a_bad_file_is_ignored_and_says_why(tmp_path, bad, caplog):
    write(tmp_path, bad)
    config = load_config(tmp_path, platform="darwin", checkout=tmp_path)
    assert config.tcp is True and config.port == DEFAULT_PORT and "hq.json" in config.problem
    assert "hq.json" in caplog.text
