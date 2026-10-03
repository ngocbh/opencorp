"""Side chats: the person who asked a question, in a session of its own, talking it through with the human."""

import os
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_corp.chat.harness import LIVE, Harness, HarnessError, RunSpec
from agent_corp.chat.identity import person_inputs
from agent_corp.chat.turns import MAIN_CHAT
from agent_corp.company.loader import load_repo
from agent_corp.profile import GitProfileStore
from agent_corp.protocol.models import CompanyDefaults, DiscussionEntry, Session
from agent_corp.store import Store
from agent_corp.tools import ToolContext, build
from agent_corp.tools.workspace import WorkspaceTools
from agent_corp.worker import ProfileMemorySpec, SessionMemorySpec

SIDE_CHAT_FLOW = "shared/flows/side_chat.yaml"
PACKAGED_FLOW = files("agent_corp.company_template").joinpath(SIDE_CHAT_FLOW)
SIDE_CHAT = MAIN_CHAT
"""The side chat flow has the main chat's shape: turn ``chat/ask``, reply ``chat/reply``, exit ``/exit``."""
EXIT_WORDS = frozenset({"/exit", "/quit", "/end"})
BACK_HINT = "use /back to return to the question"
SEED_FILE = "seed.md"
"""The side session's seed, in its run dir: kept off ``Session`` so session events stay small."""


def side_spec(harness: Harness, session: Session) -> RunSpec:
    """The run spec of a side session: the side chat flow, who the asker is, read-only lookups, and memory that keeps the seed.

    A pinned commit without the side chat flow (a company made before side chats) gets
    the packaged one. Raises ``HarnessError`` (``422``) when that path is taken by
    something other than a file, or leads out of the commit's checkout, the asker isn't
    in the commit, or the folder is gone or unsafe.
    """
    pin = harness.git.pin(session.repo_commit)
    _ensure_flow(harness, pin)
    repo = load_repo(pin)
    person = repo.people.get(session.person)
    if person is None:
        raise HarnessError(422, "not_found", f"no person {session.person} at commit {session.repo_commit[:12]}")
    defaults = (repo.company.defaults if repo.company else None) or CompanyDefaults()
    run_dir = harness.office.paths.run_dir(session.id)
    # Read-only and offline whatever the person's harness_policy says: a side chat explains, it doesn't act.
    workspace = WorkspaceTools(harness._policy(person.handle, None, session.cwd, session.id))
    question = harness.store.get_question(session.question_id) if session.question_id else None

    def groups(s: Session, run_id: str, on_question: Any) -> dict[str, dict[str, Any]]:
        return build(("workspace", "work_items"), ToolContext(
            store=harness.store, session=s, run_id=run_id, monitor=harness.monitor, workspace=workspace,
            read_only=True, question=question))

    # The seed is the first turn; composer summarizes history past the budget, so leave room for it.
    budget = defaults.side_seed_max_chars + SessionMemorySpec().history_budget_chars
    return RunSpec(
        flow=SIDE_CHAT_FLOW, groups=groups, inputs={"person": person_inputs(repo, person)}, chat=SIDE_CHAT,
        learnable=False,
        memory={"profile": ProfileMemorySpec(store="profile", max_chars=defaults.profile_max_chars),
                "session": SessionMemorySpec(storage=str(run_dir / "memory.sqlite"), history_budget_chars=budget)},
        stores={"profile": GitProfileStore(harness.git, person.handle)},
        names=(person.handle, person.name), workspace=workspace)


def write_seed(run_dir: Path, seed: str) -> None:
    """Keep a side session's seed in its run dir, readable only by the office's user."""
    run_dir.mkdir(parents=True, exist_ok=True)
    path = run_dir / SEED_FILE
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(seed)


def read_seed(run_dir: Path) -> str | None:
    """A side session's seed, or ``None`` if it has none."""
    try:
        return (run_dir / SEED_FILE).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def _ensure_flow(harness: Harness, pin: Path) -> None:
    """Write the packaged side chat flow into ``pin`` if its commit has none.

    The worker loads flows only from inside the pin, so the flow has to be there. It is
    written read-only, like the pin's own files.
    """
    path = pin / SIDE_CHAT_FLOW
    with harness.git.lock:
        # Never use, or write through, a link that leads out of the pin: the worker would refuse the flow.
        inside = path.resolve().is_relative_to(pin.resolve())
        if inside and path.is_file():
            return
        if not inside or path.exists() or path.is_symlink():
            raise HarnessError(422, "no_side_chat_flow",
                               f"{SIDE_CHAT_FLOW} in the company repo is not a file inside the repo")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(PACKAGED_FLOW.read_text())
        path.chmod(0o444)


def discussion(store: Store, side_session_id: str) -> list[DiscussionEntry]:
    """The discussion so far in a side session: each human message and each reply's final text, in order.

    A reply still running (the session is busy and no turn is open) isn't final yet, so
    what follows the last human message is left out.
    """
    messages = store.list_messages(side_session_id)
    side = store.get_session(side_session_id)
    turn_open = any(SIDE_CHAT.is_turn(q.node_id)
                    for q in store.list_questions(session_id=side_session_id, status="open", source="human_input"))
    if side is not None and side.status == "busy" and not turn_open:
        last_user = max((n for n, m in enumerate(messages) if m.role == "user"), default=-1)
        messages = messages[:last_user + 1]
    entries = []
    for message in messages:
        texts = [p.text for p in message.parts if p.type == "text" and p.text.strip()]
        if not texts:
            continue
        if message.role == "user":
            entries.append(DiscussionEntry(role="user", text="\n\n".join(texts)))
        else:
            entries.append(DiscussionEntry(role="assistant", text=texts[-1]))
    return entries


def is_live(session: Session | None) -> bool:
    """True for a session with (or about to have) a live run."""
    return session is not None and session.status in LIVE
