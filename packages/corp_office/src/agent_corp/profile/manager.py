"""The profile manager: a chat that proposes edits to one person's profile, and applying a proposal."""

import difflib
from collections.abc import Callable
from typing import Any

from agent_composer.memory.storage.markdown import MarkdownVersionMismatch

from agent_corp.chat.harness import Harness, RunSpec
from agent_corp.chat.turns import MAIN_CHAT
from agent_corp.company.git import CompanyGit
from agent_corp.profile.store import GitProfileStore
from agent_corp.protocol import now
from agent_corp.protocol.models import Profile, ProfileProposal, Session
from agent_corp.questions.ask import OnQuestion
from agent_corp.store import InvalidTransition, Store, new_id
from agent_corp.worker import SessionMemorySpec

MANAGER_FLOW = "shared/flows/profile_manager.yaml"
"""The profile manager's flow, relative to the session's pinned commit."""


class ProposalNotOpen(Exception):
    """The profile proposal is no longer open: applied, discarded, or stale."""


def profile_tools(store: Store, profile: GitProfileStore, session: Session) -> dict[str, Callable[..., Any]]:
    """The ``profile`` tool group of a profile-manager session: ``read`` and ``propose_edit``."""

    def read() -> dict[str, str]:
        """Read the profile: its current text and version."""
        text, version = profile.read()
        return {"text": text, "version": version}

    def propose_edit(text: str, base_version: str) -> str:
        """Propose the complete new text of the profile, as an edit of the version you read.

        The owner reviews the diff and applies it.
        """
        base, _ = profile.read(base_version)  # LookupError for a version the model made up
        proposal = propose(store, session, profile, base_version, base, text)
        return f"Proposed edit {proposal.id}. The owner can apply it from the profile view."

    return {"read": read, "propose_edit": propose_edit}


def propose(store: Store, session: Session, profile: GitProfileStore, base_version: str, base: str,
            text: str) -> ProfileProposal:
    """Store a proposal of ``text`` over ``base``; the session's earlier open proposals are discarded."""
    diff = "".join(difflib.unified_diff(base.splitlines(keepends=True), text.splitlines(keepends=True),
                                        f"a/{profile.path}", f"b/{profile.path}"))
    with profile.git.lock:  # waits for an apply in progress, which then isn't discarded under it
        for older in store.list_profile_proposals(profile.person_id, status="open"):
            if older.session_id == session.id:
                try:
                    store.set_profile_proposal_status(older.id, "discarded", commit=None)
                except InvalidTransition:
                    pass  # applied meanwhile
        return store.add_profile_proposal(ProfileProposal(
            id=new_id(), session_id=session.id, person=profile.person_id, base_version=base_version, text=text,
            diff=diff, status="open", created_at=now()))


def apply_proposal(store: Store, git: CompanyGit, proposal_id: str, *, owner: str, max_chars: int) -> Profile:
    """Write an open proposal over its base version and commit it as ``<owner> via profile manager``.

    Raises ``LookupError`` for an unknown proposal, ``ProposalNotOpen`` for one that isn't
    open, and ``MarkdownVersionMismatch`` when the profile has moved on (the proposal is then
    ``stale``); the profile store's own errors pass through. Emits ``profile.updated``.
    """
    # The repo lock, held from the check to the status change, keeps a newer propose_edit
    # (see propose) from discarding the proposal after it is committed.
    with git.lock:
        proposal = store.get_profile_proposal(proposal_id)
        if proposal is None:
            raise LookupError(f"no profile proposal {proposal_id}")
        if proposal.status != "open":
            raise ProposalNotOpen(f"profile proposal {proposal_id} is {proposal.status}")
        profile = GitProfileStore(git, proposal.person)
        commit_id = f"proposal-{proposal.id}"
        try:
            version = profile.write(proposal.text, base_version=proposal.base_version,
                                    provenance={"source": f"{owner} via profile manager", "commit_id": commit_id})
        except MarkdownVersionMismatch:
            store.set_profile_proposal_status(proposal.id, "stale", commit=None)
            raise
        # A proposal of the text as it was commits nothing; its commit is then the current one.
        commit = git.find_commit(profile.path, f"Commit-Id: {commit_id}") or git.head()
        store.set_profile_proposal_status(proposal.id, "applied", commit=commit)
    applied = Profile(person=proposal.person, text=proposal.text, version=version,
                      over_budget=len(proposal.text) > max_chars)
    store.emit("profile.updated", proposal.person, applied)
    return applied


def manager_spec(harness: Harness, session: Session) -> RunSpec:
    """The run spec of a profile-manager session over ``session.person``'s profile.

    It has session memory only: it edits the profile rather than learning from it, and its
    runs are not learned from.
    """
    profile = GitProfileStore(harness.git, session.person)

    def groups(s: Session, run_id: str, on_question: OnQuestion) -> dict[str, dict[str, Any]]:
        return {"profile": profile_tools(harness.store, profile, s)}

    memory = {"session": SessionMemorySpec(storage=str(harness.office.paths.run_dir(session.id) / "memory.sqlite"))}
    return RunSpec(flow=MANAGER_FLOW, groups=groups, chat=MAIN_CHAT, memory=memory)
