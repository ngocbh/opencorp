"""The extension loader calls register(office) on each module in a package."""

import textwrap
import uuid

import pytest

from opencorp.extensions import ExtensionError, load_extensions


@pytest.fixture
def ext_pkg(tmp_path, monkeypatch):
    name = f"ext_{uuid.uuid4().hex[:8]}"  # unique, so sys.modules never hands back an old one
    root = tmp_path / "extpath" / name
    root.mkdir(parents=True)
    (root / "__init__.py").write_text("")
    monkeypatch.syspath_prepend(str(tmp_path / "extpath"))

    def add(module: str, body: str) -> None:
        (root / f"{module}.py").write_text(textwrap.dedent(body))

    return name, add


CALLS = """
def register(office):
    office.extras.setdefault("calls", []).append(__name__.rsplit(".", 1)[1])
"""


def test_register_is_called_in_name_order(office, ext_pkg):
    name, add = ext_pkg
    add("b", CALLS)
    add("a", CALLS)
    add("_private", "raise RuntimeError('never imported')")
    assert load_extensions(office, name) == ["a", "b"]
    assert office.extras["calls"] == ["a", "b"]


def test_a_module_that_raises_stops_loading_and_is_named(office, ext_pkg):
    name, add = ext_pkg
    add("a", "def register(office):\n    raise RuntimeError('no db')\n")
    add("b", CALLS)
    with pytest.raises(ExtensionError, match=r"extension a: no db") as info:
        load_extensions(office, name)
    assert isinstance(info.value.__cause__, RuntimeError)
    assert "calls" not in office.extras


def test_a_module_without_register_is_an_error(office, ext_pkg):
    name, add = ext_pkg
    add("a", "X = 1\n")
    with pytest.raises(ExtensionError, match=r"extension a: no register\(office\)"):
        load_extensions(office, name)


def test_the_default_package_is_opencorp_extensions(office, tmp_path, monkeypatch):
    # Point the real package at a temp dir, so extensions added later don't change this test.
    import opencorp.extensions as package

    module = f"m_{uuid.uuid4().hex[:8]}"
    (tmp_path / f"{module}.py").write_text(CALLS)
    monkeypatch.setattr(package, "__path__", [str(tmp_path)])
    assert load_extensions(office) == [module]
    assert office.extras["calls"] == [module]
