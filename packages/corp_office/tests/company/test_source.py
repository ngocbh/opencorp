"""The Source view's office side: the ring of served HEADs, the listing, and reading files as stored."""

import asyncio
import os
import subprocess
import time
from importlib.resources import files

import pytest
import yaml

from opencorp.company import source as source_mod
from opencorp.company.git import CompanyGit
from opencorp.company.source import CompanySource, SourceError
from tests.company.conftest import _clean_env, _git, person

HASH = "$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"
SHA = "d" * 64
TOKEN = "act_" + "Z" * 43
HUMAN = "people/ngocbh/person.yaml"
PROFILE = "people/minh/profile.md"


@pytest.fixture
def git(company, tmp_path):
    return CompanyGit(company, tmp_path / "worktrees")


@pytest.fixture
def src(git):
    return CompanySource(git)


def commit(root, files: dict[str, str | bytes | None], message="edit") -> str:
    """Write (or, for None, delete) ``files`` and commit everything; return the new HEAD."""
    for rel, content in files.items():
        path = root / rel
        if content is None:
            path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "--allow-empty", "-m", message)
    return _git(root, "rev-parse", "HEAD")


async def served(src, sha):
    """The tree at ``sha``, which puts ``sha`` in the ring."""
    return await src.tree(sha)


async def show(src, root, files=None, path=None, message="edit"):
    """Commit ``files``, serve the tree at the new HEAD and read ``path`` (default: the only file given)."""
    sha = commit(root, files or {}, message)
    await served(src, sha)
    return await src.file(sha, path or next(iter(files)))


def human(**changes) -> dict:
    return person("ngocbh", **changes)


def dump(data) -> str:
    return yaml.safe_dump(data, sort_keys=False)


# The tree


async def test_tree_lists_entries_breadth_first_with_the_commit(src, git, company):
    tree = await src.tree(git.head())
    paths = [e.path for e in tree.entries]
    depth = [p.count("/") for p in paths]
    assert depth == sorted(depth) and paths[:3] == sorted(paths[:3])
    kinds = {e.path: (e.type, e.size) for e in tree.entries}
    assert kinds["people"] == ("folder", None)
    assert kinds[PROFILE] == ("file", len("# Minh, Engineer\n"))
    assert (tree.commit.id, tree.commit.subject, tree.commit.author) == (git.head(), "init", "t")
    assert (tree.truncated, tree.skipped) == (False, 0)


async def test_one_load_per_commit_however_many_ask(src, git, monkeypatch):
    calls = []
    real = git.list_tree

    def counting(sha):
        calls.append(sha)
        time.sleep(0.05)
        return real(sha)

    monkeypatch.setattr(git, "list_tree", counting)
    a, b = await asyncio.gather(src.tree(git.head()), src.tree(git.head()))
    await src.tree(git.head())
    assert a == b and calls == [git.head()]


async def test_truncation_is_breadth_first_and_a_deep_link_still_opens(src, company, monkeypatch):
    monkeypatch.setattr(source_mod, "TREE_CAP", 5)
    sha = commit(company, {"a/b/c/deep.md": "deep\n"})
    tree = await src.tree(sha)
    assert tree.truncated and len(tree.entries) == 5
    assert [e.path for e in tree.entries] == ["a", "assets", "company.yaml", "groups", "people"]
    assert (await src.file(sha, "a/b/c/deep.md")).text == "deep\n"


async def test_a_non_utf8_name_is_skipped_and_counted(src, git, company):
    blob = _git(company, "hash-object", "-w", PROFILE)
    _git(company, "update-index", "--add", "--cacheinfo", f"100644,{blob},b\udcffd.md")
    _git(company, "commit", "-q", "-m", "odd path")
    tree = await src.tree(git.head())
    assert tree.skipped == 1 and all("\udcff" not in e.path for e in tree.entries)
    tree.model_dump_json()  # a lone surrogate would fail here
    with pytest.raises(SourceError) as exc:
        await src.file(git.head(), "b\udcffd.md")
    assert exc.value.code == "no_file"


def _mktree(root, lines: str) -> str:
    return subprocess.run(["git", "-C", str(root), "mktree"], input=lines, capture_output=True, text=True,
                          check=True, env=_clean_env()).stdout.strip()


async def test_dot_segments_in_a_crafted_tree_are_skipped_and_counted(src, company):
    blob = _git(company, "rev-parse", f"HEAD:{PROFILE}")
    inner = _mktree(company, f"100644 blob {blob}\tok.md\n")
    root = _mktree(company, f"040000 tree {inner}\t..\n100644 blob {blob}\tfine.md\n")
    sha = _git(company, "commit-tree", root, "-m", "crafted")
    tree = await src.tree(sha)
    assert [e.path for e in tree.entries] == ["fine.md"] and tree.skipped == 2


async def test_file_names_and_the_commit_subject_are_listed_as_stored(src, company):
    commit(company, {HUMAN: dump(human(devices=[{"name": "macbook-pro", "token_sha256": SHA}]))})
    sha = commit(company, {f"notes/{SHA}.md": "x\n", "notes/$scrypt$abc$def.md": "y\n"}, f"leak {HASH}")
    tree = await src.tree(sha)
    assert tree.skipped == 0 and {f"notes/{SHA}.md", "notes/$scrypt$abc$def.md"} <= {e.path for e in tree.entries}
    assert tree.commit.subject == f"leak {HASH}"


# Which commit


@pytest.mark.parametrize("at", ["HEAD", "HEAD@{1}", "stash@{0}", ":/init", "-x", "main", None, "",
                                "HEAD:people/minh/profile.md"])
async def test_at_must_be_a_served_head(src, git, at):
    await src.tree(git.head())
    with pytest.raises(SourceError) as exc:
        await src.file(at, PROFILE)
    assert (exc.value.status, exc.value.code) == (409, "stale_commit")


async def test_a_short_id_a_dangling_sha_and_an_unserved_commit_are_stale(src, git, company):
    first = git.head()
    dangling = _git(company, "commit-tree", _git(company, "rev-parse", "HEAD^{tree}"), "-m", "dangling")
    second = commit(company, {PROFILE: "# two\n"})
    await src.tree(second)
    for at in (second[:12], dangling, first, second.upper()):
        with pytest.raises(SourceError) as exc:
            await src.file(at, PROFILE)
        assert exc.value.code == "stale_commit", at


async def test_a_head_that_left_the_ring_is_stale(src, git, company):
    first = git.head()
    await src.tree(first)
    assert (await src.file(first, PROFILE)).text == "# Minh, Engineer\n"
    for i in range(source_mod.RING):
        await src.tree(commit(company, {PROFILE: f"# {i}\n"}))
    with pytest.raises(SourceError) as exc:
        await src.file(first, PROFILE)
    assert exc.value.code == "stale_commit"


async def test_git_never_sees_request_input(src, git, monkeypatch):
    sha = git.head()
    await src.tree(sha)
    seen = []
    real = git._git

    def recording(*args, **kwargs):
        seen.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr(git, "_git", recording)
    for at, path in ((f"{sha}:company.yaml", "company.yaml"), (sha, f"{sha}:company.yaml"), (sha, ":company.yaml")):
        with pytest.raises(SourceError):
            await src.file(at, path)
    assert seen == []


# Paths


@pytest.mark.parametrize("path", ["", "/company.yaml", "people/", "people//minh", "people/./minh", "people/../x",
                                  "..", ".", "a\0b", None])
async def test_malformed_paths_are_bad_path(src, git, path):
    await src.tree(git.head())
    with pytest.raises(SourceError) as exc:
        await src.file(git.head(), path)
    assert (exc.value.status, exc.value.code) == (400, "bad_path")


@pytest.mark.parametrize("path", ["nope.md", "people", "people/minh", ":people/minh/profile.md",
                                  "PEOPLE/minh/profile.md"])
async def test_a_path_not_in_the_listing_or_a_folder_is_no_file(src, git, path):
    await src.tree(git.head())
    with pytest.raises(SourceError) as exc:
        await src.file(git.head(), path)
    assert (exc.value.status, exc.value.code) == (404, "no_file")


async def test_uncommitted_and_staged_edits_are_not_shown(src, git, company):
    sha = git.head()
    (company / PROFILE).write_text("# staged\n")
    _git(company, "add", PROFILE)
    (company / "groups/eng.yaml").write_text("dirty\n")
    (company / "new.md").write_text("new\n")
    tree = await src.tree(sha)
    assert "new.md" not in [e.path for e in tree.entries]
    assert (await src.file(sha, PROFILE)).text == "# Minh, Engineer\n"


# Entry kinds, sizes, text


async def test_a_symlink_shows_its_target_and_is_not_followed(src, company, tmp_path):
    outside = tmp_path / SHA
    outside.write_text(f"password_hash: {HASH}\n")
    os.symlink(str(outside), company / "link")
    sha = commit(company, {})
    await src.tree(sha)
    got = await src.file(sha, "link")
    assert (got.content, got.target, got.text) == ("symlink", str(outside), None)


async def test_a_submodule_has_no_content(src, git, company):
    _git(company, "update-index", "--add", "--cacheinfo", f"160000,{git.head()},vendor/lib")
    _git(company, "commit", "-q", "-m", "a submodule")
    sha = git.head()
    tree = await src.tree(sha)
    assert ("vendor/lib", "submodule") in [(e.path, e.type) for e in tree.entries]
    got = await src.file(sha, "vendor/lib")
    assert (got.content, got.text, got.target) == ("submodule", None, None)


async def test_large_files_are_too_large_without_being_read(src, git, company, monkeypatch):
    sha = commit(company, {"big.bin": b"x" * ((1 << 20) + 1), "big.yaml": "a: b\n" * ((1 << 18) + 1),
                           "ok.yaml": "a: b\n" * (60 << 10)})
    await src.tree(sha)
    reads = []
    real = git.read_blob
    monkeypatch.setattr(git, "read_blob", lambda blob: reads.append(blob) or real(blob))
    assert (await src.file(sha, "big.bin")).content == "too_large"
    assert (await src.file(sha, "big.yaml")).content == "too_large"
    assert reads == []
    assert (await src.file(sha, "ok.yaml")).content == "text"  # YAML isn't parsed: only the 1 MiB cap applies


@pytest.mark.parametrize("data", [b"a\x00b", b"bell \x07", b"esc \x1b[0m", b"\xff\xfe", b"caf\xe9"])
async def test_binary_files(src, company, data):
    assert (await show(src, company, {"f.txt": data})).content == "binary"


async def test_text_keeps_tabs_and_crlf(src, company):
    got = await show(src, company, {"f.txt": b"a\tb\r\nc\n"})
    assert (got.content, got.text) == ("text", "a\tb\r\nc\n")


@pytest.mark.parametrize("name", [".env", "deploy/server.pem", ".ssh/id_rsa", ".netrc"])
async def test_credential_file_names_are_shown_as_stored(src, company, name):
    got = await show(src, company, {name: f"API_KEY=sk-ant-{'a' * 40}\n"})
    assert (got.content, got.text, got.reason) == ("text", f"API_KEY=sk-ant-{'a' * 40}\n", None)


async def test_rendered_files_are_cached(src, git, company, monkeypatch):
    sha = git.head()
    await src.tree(sha)
    first = await src.file(sha, PROFILE)
    monkeypatch.setattr(git, "read_blob", lambda blob: pytest.fail("read again"))
    assert await src.file(sha, PROFILE) == first


# Files are shown as stored


async def test_a_humans_person_yaml_is_shown_byte_for_byte(src, company):
    text = "# my file\n" + dump(human(devices=[{"name": "mac", "token_sha256": SHA}], password_hash=HASH))
    got = await show(src, company, {HUMAN: text})
    assert (got.content, got.text, got.rewritten, got.reason) == ("text", text, False, None)


@pytest.mark.parametrize(("rel", "text"), [
    ("assets/keys.yaml", f"client_secret: abc\napi_key: sk-ant-{'b' * 40}\n"),
    ("assets/creds.json", '{"token": "%s", "password": "hunter2hunter2"}\n' % TOKEN),
    ("assets/broken.yaml", "a: [unclosed\n"),
    ("assets/broken.json", '{"token": "x",}\n'),
    (PROFILE, f"see {HASH} and glued{TOKEN}x and https://bob:hunter22@host/\n"),
    ("notes/copy.md", f"old device {SHA}\n"),
])
async def test_secrets_in_any_file_are_shown_as_stored(src, company, rel, text):
    got = await show(src, company, {rel: text})
    assert (got.content, got.text, got.reason) == ("text", text, None)


async def test_a_harmless_alias_is_shown_as_written(src, company):
    text = "# shared\ndefaults: &d {model: gpt}\nminh: *d\n"
    got = await show(src, company, {"assets/alias.yaml": text})
    assert (got.content, got.text) == ("text", text)


@pytest.mark.parametrize("flow", [
    f for d in (files("opencorp.company_template") / "shared" / "flows", files("opencorp.install") / "flows")
    for f in d.iterdir() if f.name.endswith(".yaml")], ids=lambda f: f.name)
async def test_every_packaged_flow_file_is_shown_as_written(src, company, flow):
    text = flow.read_text()
    got = await show(src, company, {f"shared/flows/{flow.name}": text})
    assert (got.content, got.text, got.rewritten) == ("text", text, False)
