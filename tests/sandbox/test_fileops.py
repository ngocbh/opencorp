import io
import json

import pytest

from agent_corp.sandbox import fileops
from agent_corp.sandbox.fileops import OpError


@pytest.fixture(autouse=True)
def in_ws(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def test_write_then_read():
    assert fileops.write_file("a/b.txt", "one\ntwo\nthree\n") == "wrote 14 bytes to a/b.txt"
    assert fileops.read_file("a/b.txt") == "one\ntwo\nthree\n"
    assert fileops.read_file("a/b.txt", offset=1, limit=1) == "two\n"


def test_read_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(fileops, "MAX_READ_CHARS", 5)
    (tmp_path / "big.txt").write_text("x" * 50)
    assert fileops.read_file("big.txt").startswith("xxxxx\n[truncated")


def test_edit(tmp_path):
    (tmp_path / "f.py").write_text("a = 1\nb = 1\n")
    with pytest.raises(OpError, match="2 times"):
        fileops.edit_file("f.py", "= 1", "= 2")
    assert fileops.edit_file("f.py", "a = 1", "a = 3") == "replaced 1 occurrence in f.py"
    assert fileops.edit_file("f.py", "= ", "=", replace_all=True) == "replaced 2 occurrences in f.py"
    assert (tmp_path / "f.py").read_text() == "a =3\nb =1\n"
    with pytest.raises(OpError, match="not found"):
        fileops.edit_file("f.py", "zzz", "y")
    with pytest.raises(OpError, match="empty"):
        fileops.edit_file("f.py", "", "y")


def test_list(tmp_path):
    (tmp_path / "d").mkdir()
    (tmp_path / "f").write_text("")
    assert fileops.list_dir(".") == "d/\nf"
    assert fileops.list_dir("d") == "(empty)"


def test_search(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src/a.py").write_text("def foo():\n    return 1\n")
    (tmp_path / "src/b.txt").write_text("foo bar\n")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git/x").write_text("foo\n")
    (tmp_path / "bin").write_bytes(b"foo\0")
    assert fileops.search("foo") == "src/a.py:1:def foo():\nsrc/b.txt:1:foo bar"
    assert fileops.search("foo", glob="*.py") == "src/a.py:1:def foo():"
    assert fileops.search("nothing") == "(no matches)"
    with pytest.raises(OpError, match="bad pattern"):
        fileops.search("(")


def run_main(monkeypatch, request):
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request)))
    out = io.StringIO()
    monkeypatch.setattr("sys.stdout", out)
    with pytest.raises(SystemExit) as exit_info:
        fileops.main()
    return exit_info.value.code, json.loads(out.getvalue())


def test_main_round_trip(monkeypatch, tmp_path):
    (tmp_path / "f").write_text("hi")
    assert run_main(monkeypatch, {"op": "read_file", "path": "f"}) == (0, {"ok": True, "output": "hi"})


def test_main_reports_errors(monkeypatch):
    code, reply = run_main(monkeypatch, {"op": "read_file", "path": "missing"})
    assert code == 1 and reply["ok"] is False and "No such file" in reply["error"]
    code, reply = run_main(monkeypatch, {"op": "rm", "path": "x"})
    assert code == 1 and "unknown op" in reply["error"]
