"""The Source view's office side: the ring of served HEADs, the listing, reading and secret hiding."""

import asyncio
import base64
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
AGENT = "people/minh/person.yaml"


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


async def test_a_secret_in_a_file_name_or_commit_subject_is_hidden(src, company):
    commit(company, {"people/ngocbh/person.yaml": dump(human(devices=[{"name": "macbook-pro",
                                                                        "token_sha256": SHA}]))})
    sha = commit(company, {f"notes/{SHA}.md": "x\n", "notes/$scrypt$abc$def.md": "y\n"}, f"leak {HASH}")
    tree = await src.tree(sha)
    assert tree.skipped == 2 and not any("notes/" in e.path for e in tree.entries)
    assert tree.commit.subject == "(hidden)"
    assert HASH not in tree.model_dump_json() and SHA not in tree.model_dump_json()


async def test_a_device_name_is_not_a_secret(src, company):
    sha = commit(company, {HUMAN: dump(human(devices=[{"name": "macbook-pro", "token_sha256": SHA}])),
                           PROFILE: "Minh pairs on the macbook-pro.\n"}, "devices(@ngocbh): add macbook-pro")
    tree = await src.tree(sha)
    assert tree.commit.subject == "devices(@ngocbh): add macbook-pro"
    assert (await src.file(sha, PROFILE)).text == "Minh pairs on the macbook-pro.\n"


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
    outside = tmp_path / "outside.txt"
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
    sha = commit(company, {"big.bin": b"x" * ((1 << 20) + 1), "big.yaml": "a: b\n" * (60 << 10)})
    await src.tree(sha)
    reads = []
    real = git.read_blob
    monkeypatch.setattr(git, "read_blob", lambda blob: reads.append(blob) or real(blob))
    assert (await src.file(sha, "big.bin")).content == "too_large"
    assert (await src.file(sha, "big.yaml")).content == "too_large"
    assert reads == []


async def test_json_over_the_yaml_limit_is_too_large(src, company):
    got = await show(src, company, {"big.json": "[" + "1," * (130 << 10) + "1]"})
    assert got.content == "too_large"


@pytest.mark.parametrize("data", [b"a\x00b", b"bell \x07", b"esc \x1b[0m", b"\xff\xfe", b"caf\xe9"])
async def test_binary_files(src, company, data):
    assert (await show(src, company, {"f.txt": data})).content == "binary"


async def test_text_keeps_tabs_and_crlf(src, company):
    got = await show(src, company, {"f.txt": b"a\tb\r\nc\n"})
    assert (got.content, got.text) == ("text", "a\tb\r\nc\n")


@pytest.mark.parametrize("name", [".env", ".env.local", "deploy/server.pem", "certs/X.KEY", ".ssh/id_rsa.pub",
                                  "id_ed25519", "id_ecdsa", ".netrc", ".git-credentials", ".ENV", ".npmrc",
                                  "pkg/.pypirc", "web/.htpasswd", "certs/me.p12", "certs/me.PFX", "id_dsa.pub"])
async def test_credential_file_names_are_hidden_unread(src, git, company, monkeypatch, name):
    sha = commit(company, {name: "nothing secret\n"})
    tree = await src.tree(sha)
    assert name in [e.path for e in tree.entries]
    reads = []
    monkeypatch.setattr(git, "read_blob", lambda blob: reads.append(blob))
    got = await src.file(sha, name)
    assert (got.content, got.reason, reads) == ("hidden", "may hold credentials", [])


async def test_rendered_files_are_cached(src, git, company, monkeypatch):
    sha = git.head()
    await src.tree(sha)
    first = await src.file(sha, PROFILE)
    monkeypatch.setattr(git, "read_blob", lambda blob: pytest.fail("read again"))
    assert await src.file(sha, PROFILE) == first


# Secrets: re-rendering


async def test_a_humans_person_yaml_is_rerendered_without_secrets(src, company):
    data = human(devices=[{"name": "mac", "token_sha256": SHA}], password_hash=HASH)
    got = await show(src, company, {HUMAN: "# my file\n" + dump(data)})
    kept = {k: v for k, v in data.items() if k not in ("devices", "password_hash")}
    assert (got.content, got.rewritten, got.text) == ("text", True, yaml.safe_dump(kept, sort_keys=False))
    assert HASH not in got.text and SHA not in got.text


async def test_a_non_ascii_name_above_the_hash(src, company):
    text = f"handle: ngocbh\nname: Nguyễn Văn Ánh\nkind: human\ntitle: CEO\nmanager: null\npassword_hash: {HASH}\n"
    got = await show(src, company, {HUMAN: text})
    assert got.rewritten and HASH not in got.text and "$scrypt$" not in got.text
    assert yaml.safe_load(got.text)["name"] == "Nguyễn Văn Ánh"  # safe_dump escapes it, as the office writes it


async def test_a_bom_before_the_hash(src, company):
    got = await show(src, company, {HUMAN: "﻿" + dump(human(name="Ánh", password_hash=HASH))})
    assert got.rewritten and "$scrypt$" not in got.text


async def test_a_block_scalar_hash(src, company):
    text = dump(human()) + "password_hash: |\n  " + HASH + "\n"
    got = await show(src, company, {HUMAN: text})
    assert HASH not in (got.text or "") and "$scrypt$" not in (got.text or "")


async def test_a_human_without_secrets_is_shown_as_written(src, company):
    text = "# the CEO\n" + dump(human())
    got = await show(src, company, {HUMAN: text})
    assert (got.text, got.rewritten) == (text, False)


async def test_a_person_yaml_elsewhere_is_hidden_not_rerendered(src, company):
    got = await show(src, company, {"backup/person.yaml": dump(human(password_hash=HASH))})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


# Secrets: layer 1 hides whole files


@pytest.mark.parametrize("rel,data", [
    (HUMAN, human(devices=[{"name": "mac", "token_sha256": SHA, "token": "plaintexttoken"}])),
    (HUMAN, human(password="hunter2hunter2")),
    ("assets/fake.yaml", {"id": "fake", "token": "plaintexttoken"}),
    ("assets/deep.yml", {"a": {"b": [{"Client-Secret": "x"}]}}),
    (AGENT, person("minh", password_hash=HASH, title=7)),  # doesn't validate as a Person
])
async def test_other_secret_keys_hide_the_whole_file(src, company, rel, data):
    got = await show(src, company, {rel: dump(data)})
    assert (got.content, got.reason, got.text) == ("hidden", "holds a secret-named key", None)


async def test_a_secret_key_in_a_yaml_pair_list_hides_it(src, company):
    got = await show(src, company, {"notes/pairs.yaml": f"- password_hash: '{HASH}'\n"})
    assert got.content == "hidden"


async def test_a_hash_in_a_yaml_list_without_a_key_is_hidden(src, company):
    # The hash is a parsed string that fails the check, so the file is hidden, not scrubbed.
    got = await show(src, company, {"notes/pairs.yaml": f"- [password_hash, '{HASH}']\n"})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_a_hash_in_a_yaml_comment_is_scrubbed(src, company):
    got = await show(src, company, {"notes/x.yaml": f"# old: {HASH}\nk: v\n"})
    assert (got.content, got.text) == ("text", "# old: (hidden)\nk: v\n")


@pytest.mark.parametrize("text", [
    "a: &a [*a]\n",
    "a: &a {x: *a}\n",
    "a: 1\n---\nb: 2\n",
    "a: [unclosed\n",
])
async def test_hostile_yaml_is_hidden(src, company, text):
    got = await show(src, company, {"assets/x.yaml": text})
    assert (got.content, got.reason) == ("hidden", "couldn't read this YAML safely")


async def test_an_alias_bomb_is_hidden_quickly(src, company):
    bomb = "a: &a [x,x,x,x,x,x,x,x,x]\n" + "".join(
        f"{chr(98 + i)}: &{chr(98 + i)} [{','.join(['*' + chr(97 + i)] * 9)}]\n" for i in range(8))
    start = time.monotonic()
    got = await show(src, company, {"assets/bomb.yaml": bomb})
    assert got.content == "hidden" and time.monotonic() - start < 3


@pytest.mark.parametrize("text", [
    'note: "\\x24scrypt\\x24ln=15\\x24salt\\x24hash"\n',  # a PHC string spelled with escapes
    'note: "act_' + "Z" * 20 + '\\\n  ' + "Z" * 23 + '"\n',  # a token split by an escaped line break
])
async def test_an_encoded_secret_in_yaml_hides_the_file(src, company, text):
    got = await show(src, company, {"assets/x.yaml": text})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_an_escaped_known_value_in_yaml_hides_the_file(src, company):
    commit(company, {HUMAN: dump(human(devices=[{"name": "mac", "token_sha256": SHA}]))})
    got = await show(src, company, {"assets/x.yaml": f'old: "\\x64{SHA[1:]}"\n'})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_a_rerendered_person_yaml_passes_the_decoded_check(src, company):
    got = await show(src, company, {HUMAN: dump(human(password_hash=HASH))})
    assert (got.content, got.rewritten) == ("text", True)


async def test_json_with_a_secret_key_is_hidden(src, company):
    got = await show(src, company, {"assets/creds.json": '{"id": "x", "client_secret": "abcdefghij"}\n'})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


async def test_json_with_an_escaped_hash_is_hidden(src, company):
    got = await show(src, company, {"notes/x.json": '{"note": "\\u0024scrypt\\u0024ln=15\\u0024s\\u0024h"}\n'})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_plain_json_is_shown_as_written(src, company):
    text = '{"id": "x", "secrets": ["OPENAI_KEY"], "max_tokens": 10}\n'
    got = await show(src, company, {"notes/x.json": text})
    assert (got.content, got.text) == ("text", text)


async def test_json_yaml_cant_parse_is_walked_as_json(src, company):
    text = '{\n\t"note": "plain",\n\t"x": 1\n}\n'  # tab indents, which PyYAML refuses
    got = await show(src, company, {"notes/x.json": text})
    assert (got.content, got.text) == ("text", text)


@pytest.mark.parametrize("text, reason", [
    ('{\n\t"auth": {"clientSecret": "abcdefghij"}\n}\n', "holds a secret-named key"),
    ('{\n\t"note": "\\u0024scrypt\\u0024ln=15\\u0024s\\u0024h"\n}\n', "a secret couldn't be removed"),
    ('{\n\t"note": "' + HASH + '"\n}\n', "a secret couldn't be removed"),
    ('{"\u0090": 1, "token": "abcdefghij"}\n', "holds a secret-named key"),  # a character YAML refuses
    ('{\n\t"x": ' + "[" * 100_000 + "]" * 100_000 + '\n}\n', "couldn't read this YAML safely"),
], ids=["key", "escaped hash", "hash", "control character", "deep"])
async def test_json_yaml_cant_parse_is_checked_as_json(src, company, text, reason):
    got = await show(src, company, {"notes/x.json": text})
    assert (got.content, got.reason) == ("hidden", reason)


async def test_a_json_file_neither_parser_reads_falls_back_to_the_scrub(src, company):
    text = '{\n\t// a comment\n\t"compilerOptions": {"strict": true,},\n\t"note": "' + HASH + '"\n}\n'
    got = await show(src, company, {"notes/tsconfig.json": text})
    assert (got.content, got.text) == ("text", text.replace(HASH, "(hidden)"))


@pytest.mark.parametrize("text", [
    '{\n\t"clientSecret": "abcdefghij",\n\t"n": ' + "9" * 5000 + '\n}\n',  # an int too long for int()
    '{\n\t"password": "abcdefghij",\n\t"n": NaN\n}\n',
    '{\n\t"password": "abcdefghij",\n}\n',  # a trailing comma
    '{\n\t// the database\n\t"db.password": "abcdefghij"\n}\n',
    "{\n\t// single quotes\n\t'apiKey': 'abcdefghij'\n}\n",
    '{\n\t// a lookalike key\n\t"api\u212aey": "abcdefghij"\n}\n',
    '{\n\t// a fullwidth underscore\n\t"api\uff3fkey": "abcdefghij"\n}\n',
], ids=["long int", "NaN", "trailing comma", "comment", "single quotes", "kelvin sign", "fullwidth underscore"])
async def test_a_secret_key_in_json_no_parser_reads_hides_the_file(src, company, text):
    got = await show(src, company, {"notes/x.json": text})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


@pytest.mark.parametrize("text", ["auth:\n  accessToken: abcdefghij\n", "api.key: abcdefghij\n",
                                  "spring.datasource.password: abcdefghij\n", "AWS_SECRET_ACCESS_KEY: abcdefghij\n",
                                  "secret_key: abcdefghij\n", "passphrase: abcdefghij\n", "accesstoken: abcdefghij\n",
                                  "\uff41pi_key: abcdefghij\n"])
async def test_a_camel_case_or_dotted_secret_key_hides_the_file(src, company, text):
    got = await show(src, company, {"assets/x.yaml": text})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


async def test_ordinary_keys_holding_secret_words_are_shown(src, company):
    text = "max_tokens: 100\ntokens_used: 5\nsecretary: Ann\nkeyboard: us\npasswordless_login: true\n"
    got = await show(src, company, {"assets/x.yaml": text})
    assert (got.content, got.text) == ("text", text)


async def test_a_binary_scalar_holding_a_hash_hides_the_file(src, company):
    encoded = base64.b64encode(HASH.encode()).decode()
    got = await show(src, company, {"assets/x.yaml": f"note: !!binary {encoded}\n"})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


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
    if flow.name == "init.yaml":  # never in a company; its node "password" is a secret-named key, not a tag problem
        assert got.content == "hidden" and got.reason != "couldn't read this YAML safely"
    else:
        assert (got.content, got.text, got.rewritten) == ("text", text, False)


async def test_a_tagged_mapping_holding_a_secret_key_is_hidden(src, company):
    text = f"input:\n  person: !Person {{name: x, password_hash: '{HASH}'}}\n"
    got = await show(src, company, {"shared/flows/leak.yaml": text})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


async def test_a_tagged_scalar_holding_a_hash_is_hidden(src, company):
    got = await show(src, company, {"shared/flows/leak.yaml": f'note: !str "{HASH}"\n'})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_a_humans_person_yaml_with_a_custom_tag_and_a_hash_is_hidden_not_rerendered(src, company):
    text = dump(human()).replace("kind: human", "kind: !Kind human") + f"password_hash: {HASH}\n"
    got = await show(src, company, {HUMAN: text})
    assert (got.content, got.reason) == ("hidden", "holds a secret-named key")


# Secrets: layer 2 scrubs every text


async def test_a_commented_out_hash_in_an_agents_person_yaml(src, company):
    text = f"# password_hash: {HASH}\n" + dump(person("minh"))
    got = await show(src, company, {AGENT: text})
    assert got.content == "text" and not got.rewritten
    assert got.text == text.replace(HASH, "(hidden)")


@pytest.mark.parametrize("rel", [PROFILE, f"{HUMAN}.bak", "notes/x.txt"])
async def test_a_hash_or_token_anywhere_is_scrubbed(src, company, rel):
    got = await show(src, company, {rel: f"see {HASH} and glued{TOKEN}x and https://bob:hunter22@host/\n"})
    assert got.content == "text"
    assert HASH not in got.text and TOKEN not in got.text and "hunter22" not in got.text


# Secrets: layer 3, the final check


async def test_a_known_token_hash_copied_into_a_note_hides_it(src, company):
    commit(company, {HUMAN: dump(human(devices=[{"name": "mac", "token_sha256": SHA}]))})
    got = await show(src, company, {"notes/copy.md": f"old device {SHA}\n"})
    assert (got.content, got.reason) == ("hidden", "a secret couldn't be removed")


async def test_a_known_value_in_a_symlink_target_hides_it(src, company):
    commit(company, {HUMAN: dump(human(devices=[{"name": "mac", "token_sha256": SHA}]))})
    os.symlink(f"../{SHA}", company / "link")
    sha = commit(company, {})
    await src.tree(sha)
    got = await src.file(sha, "link")
    assert (got.content, got.target) == ("hidden", None)


async def test_a_rerender_that_still_holds_a_known_value_is_hidden(src, company):
    data = human(title=f"{SHA}", devices=[{"name": "mac", "token_sha256": SHA}])
    got = await show(src, company, {HUMAN: dump(data)})
    assert got.content == "hidden" and got.text is None


async def test_nothing_secret_reaches_the_responses(src, company):
    data = human(devices=[{"name": "mac", "token_sha256": SHA}], password_hash=HASH)
    sha = commit(company, {HUMAN: dump(data), PROFILE: f"{HASH}\n{SHA}\n", "x.yaml": f"# {HASH}\nk: v\n"})
    tree = await src.tree(sha)
    out = [tree.model_dump_json()]
    for e in tree.entries:
        if e.type != "folder":
            out.append((await src.file(sha, e.path)).model_dump_json())
    joined = "\n".join(out)
    assert HASH not in joined and SHA not in joined and "$scrypt$" not in joined
