import re

import pytest

from opencorp.sandbox import seatbelt
from opencorp.sandbox.policy import SandboxPolicy


@pytest.fixture
def make(tmp_path):
    ws, tmp, extra = tmp_path / "ws", tmp_path / "tmp", tmp_path / "py"
    for d in (ws, tmp, extra):
        d.mkdir()

    def make(writable=True, network=False):
        return SandboxPolicy(ws, writable, network, tmp, read_only=(extra,))

    return make


def rules(text, op):
    return [line for line in text.splitlines() if line.startswith(f"(allow {op}") or line.startswith(f"(deny {op}")]


def test_denies_by_default(make):
    text = seatbelt.profile(make())
    assert text.splitlines()[:2] == ["(version 1)", "(deny default)"]


def test_workspace_read_write_with_git_protected(make):
    policy = make()
    text = seatbelt.profile(policy)
    ws = str(policy.workspace)
    allow = f'(allow file-read* file-write* (subpath "{ws}"))'
    deny = (
        f'(deny file-write* (literal "{ws}/.git") (subpath "{ws}/.git/hooks") '
        f'(literal "{ws}/.git/config"))'
    )
    assert allow in text and deny in text
    # Seatbelt applies the last matching rule, so the deny must come after the allow.
    assert text.index(deny) > text.index(allow)


def test_read_only_workspace_has_no_write_rule(make):
    policy = make(writable=False)
    text = seatbelt.profile(policy)
    assert f'(allow file-read* (subpath "{policy.workspace}"))' in text
    assert not any(str(policy.workspace) in line for line in rules(text, "file-write"))


def test_tmpdir_and_read_only_paths(make):
    policy = make()
    text = seatbelt.profile(policy)
    assert f'(allow file-read* file-write* (subpath "{policy.tmpdir}"))' in text
    assert f'(allow file-read* (subpath "{policy.read_only[0]}"))' in text


def test_ancestors_get_metadata_only(make):
    policy = make()
    text = seatbelt.profile(policy)
    parent = str(policy.workspace.parent)
    assert f'(literal "{parent}")' in "\n".join(rules(text, "file-read-metadata"))
    assert f'(subpath "{parent}")' not in text


def test_no_network_rules_when_off(make):
    text = seatbelt.profile(make(network=False))
    assert not rules(text, "network")
    assert "com.apple.dnssd.service" not in text


def test_network_is_ip_only_when_on(make):
    text = seatbelt.profile(make(network=True))
    assert "(allow network-outbound (remote ip))" in text
    # Unix sockets (the office socket, tmux) stay closed; only the DNS responder opens.
    unix = [line for line in text.splitlines() if "unix-socket" in line]
    assert unix == ['(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))']
    assert "(allow network*)" not in text and "(allow network-outbound)" not in text


def test_mach_lookups_are_the_minimal_set(make):
    for network in (False, True):
        text = seatbelt.profile(make(network=network))
        names = set(re.findall(r'\(global-name "([^"]+)"\)', text))
        expected = set(seatbelt.MACH_SERVICES) | (set(seatbelt.NETWORK_MACH_SERVICES) if network else set())
        assert names == expected
        # No Apple Events, LaunchServices, or pasteboard.
        assert not any("appleevents" in n or "launchservices" in n or "pasteboard" in n for n in names)


def test_sysctl_read_is_a_list(make):
    text = seatbelt.profile(make())
    assert "(allow sysctl-read)" not in text
    assert '(sysctl-name "hw.ncpu")' in text or '(sysctl-name-prefix "hw.")' in text


def test_process_rules_stay_in_the_sandbox(make):
    text = seatbelt.profile(make())
    assert "(allow signal (target same-sandbox))" in text
    assert "(allow process-info* (target same-sandbox))" in text


def test_std_stream_paths(make):
    text = seatbelt.profile(make())
    assert '(allow file-read* file-write-data (subpath "/dev/fd") (literal "/dev/stdout") (literal "/dev/stderr"))' in text


def test_canary_gets_a_write_data_rule(make, tmp_path):
    policy = make()
    assert "file-write-data (literal" not in seatbelt.profile(policy).replace('(literal "/dev/null")', "")
    text = seatbelt.profile(policy, tmp_path / "canary")
    assert f'(allow file-write-data (literal "{tmp_path / "canary"}"))' in text


def test_quotes_in_paths_are_escaped(tmp_path):
    ws = tmp_path / 'we"ird\\ws'
    tmp = tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    text = seatbelt.profile(SandboxPolicy(ws, True, False, tmp))
    assert '(subpath "' + str(ws.resolve()).replace("\\", "\\\\").replace('"', '\\"') + '")' in text
