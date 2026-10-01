"""A real office whose owner registered this device at onboarding: `ac` and the TUI's client use its token, and nothing else gets in."""

import json
import subprocess

import pytest

from agent_corp.auth.identity import identity_path, read_identity
from agent_corp.auth.tokens import token_sha256
from agent_corp.install.launch import REPO

from .fixtures.office import RunningOffice

pytestmark = pytest.mark.timeout(180)

TUI_CLIENT = """
import { createOfficeClient } from "./packages/tui/src/office/client"
import { readIdentity } from "./packages/tui/src/office/identity"
import { defaultSocket, identityPath } from "./packages/tui/src/office/paths"

const me = readIdentity(identityPath())
const client = createOfficeClient({ socket: defaultSocket(), token: me?.token })
const seen = { whoami: await client.whoami(), people: (await client.people.list()).map((p) => p.handle) }
const stream = await new Promise((resolve) => {
  const sub = client.events.subscribe((e) => {
    if (e.type === "connected" || e.type === "unreachable") {
      sub.close()
      resolve(e.type === "connected" ? "connected" : String(e.error))
    }
  }, { minDelayMs: 50 })
})
console.log(JSON.stringify({ ...seen, stream }))
"""


@pytest.fixture
def owned(ac_ready, short_dir, fake_llm):
    """A running office onboarded with this device registered for the owner, stopped afterwards."""
    running = RunningOffice(short_dir, fake_llm)
    try:
        running.onboard(device=True)
        yield running
    finally:
        running.stop()


def tui_client(office: RunningOffice) -> dict:
    """What the TUI's office client reads from ``office`` as this device: who it is, the people, the stream."""
    done = subprocess.run(["bun", "-e", TUI_CLIENT], cwd=REPO, env=office._ac_env(),
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    return json.loads(done.stdout)


def test_ac_and_the_tui_use_the_device_token_and_nothing_else_gets_in(owned, workspace):
    me = read_identity(identity_path(owned.home))
    outputs = []

    def ac(*args, check=True):
        done = owned.ac(*args, cwd=workspace, check=check)
        outputs.extend([done.stdout, done.stderr])
        return done

    # The first commit already lists the device, by its token's hash.
    git = ["git", "-C", str(owned.paths.company)]
    root = subprocess.run([*git, "rev-list", "--max-parents=0", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.strip()
    first = subprocess.run([*git, "show", f"{root}:people/ngocbh/person.yaml"],
                           check=True, capture_output=True, text=True).stdout
    assert me.device in first and token_sha256(me.token) in first
    whoami = ac("whoami").stdout
    assert f"The office: @ngocbh, from device {me.device}" in whoami

    # Without the token: only the liveness probe answers.
    anonymous = owned.client()
    assert anonymous.get("/health").json() == {"ok": True}
    refused = anonymous.get("/people")
    assert (refused.status_code, refused.json()["error"]) == (401, "unauthenticated")
    with anonymous.stream("GET", "/events") as events:
        assert events.status_code == 401
    anonymous.close()

    # The TUI's client: requests and the event stream, with the token from identity.json.
    assert tui_client(owned) == {"whoami": {"person": "ngocbh", "device": me.device},
                                 "people": ["minh", "ngocbh"], "stream": "connected"}

    # `ac` commands: a session ends, and the device list shows names only.
    owned.fake.script({"content": "Hi."})
    sid = owned.start_chat(owned.person("minh"), workspace)
    ac("end", sid)
    assert owned.status(sid) in ("ending", "ended")
    assert ac("devices", "list").stdout == f"{me.device}  (this device)\n"

    # Logging out removes the last device, so the office is open again.
    ac("logout")
    assert owned.client().get("/people").status_code == 200
    assert "devices(@ngocbh): remove " + me.device == owned.git_log()[0]
    for text in outputs:
        assert me.token not in text
