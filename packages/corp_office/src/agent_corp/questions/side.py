"""Side chats: the person who asked a question, in a session of its own, talking it through with the human."""

import json
import os
from collections.abc import Callable
from importlib.resources import files
from pathlib import Path
from typing import Any

from agent_corp.chat.harness import LIVE, Harness, HarnessError, RunSpec
from agent_corp.chat.identity import person_inputs
from agent_corp.chat.turns import MAIN_CHAT
from agent_corp.company.loader import load_repo
from agent_corp.profile import GitProfileStore
from agent_corp.protocol.models import CompanyDefaults, DiscussionEntry, Question, Session
from agent_corp.store import Store
from agent_corp.tools.workspace import WorkspaceTools, workspace_tool_functions
from agent_corp.worker import ProfileMemorySpec, SessionMemorySpec

SIDE_CHAT_FLOW = "shared/flows/side_chat.yaml"
PACKAGED_FLOW = files("agent_corp.company_template").joinpath(SIDE_CHAT_FLOW)
SIDE_CHAT = MAIN_CHAT
"""The side chat flow has the main chat's shape: turn ``chat/ask``, reply ``chat/reply``, exit ``/exit``."""
READ_TOOLS = ("read_file", "list", "search")
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
        calls = workspace_tool_functions(harness.monitor.workspace(workspace, person.handle, run_id, session_id=s.id))
        return {"workspace": {name: calls[name] for name in READ_TOOLS},
                "work_items": work_item_tools(harness.store, person.handle, question)}

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


def work_item_tools(store: Store, handle: str, question: Question | None) -> dict[str, Callable[..., str]]:
    """Read-only work item tools for a side chat of ``handle`` about ``question``.

    The person sees the question's work item and the work item of the session that
    asked, their parents, and their children, plus items they requested or are
    assigned. Anything else is "no work item".
    """
    roots = [question.work_item_id] if question and question.work_item_id else []
    asker = store.get_session(question.session_id) if question else None
    if asker and asker.work_item_id:
        roots.append(asker.work_item_id)
    chain: set[str] = set()
    for item_id in roots:
        while item_id and item_id not in chain and (item := store.get_work_item(item_id)) is not None:
            chain.add(item.id)
            item_id = item.parent_id

    def visible(item: Any) -> bool:
        return (item.id in chain or item.parent_id in chain
                or handle in (item.requester, item.assignee))

    def list_work_items() -> str:
        """List the work items you can see (yours, and those around this question), newest first, as JSON."""
        items = [i for i in store.list_work_items(limit=None) if visible(i)]
        return json.dumps([{"id": i.id, "title": i.title, "status": i.status, "assignee": i.assignee,
                            "parent_id": i.parent_id} for i in items], ensure_ascii=False)

    def read_work_item(work_item_id: str) -> str:
        """Read one work item with its comments and children, as JSON."""
        item = store.get_work_item(work_item_id)
        if item is None or not visible(item):
            raise ValueError(f"no work item {work_item_id}")
        children = [{"id": c.id, "title": c.title, "status": c.status}
                    for c in store.list_work_items(limit=None) if c.parent_id == item.id]
        return json.dumps(item.model_dump(mode="json", exclude={"version"})
                          | {"comments": [{"author": c.author, "body": c.body, "created_at": c.created_at}
                                          for c in store.list_comments(item.id)],
                             "children": children}, ensure_ascii=False)

    return {"list_work_items": list_work_items, "read_work_item": read_work_item}


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
