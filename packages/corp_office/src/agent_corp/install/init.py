"""``ac init``: create the company once (its name, its CEO, its first teammates, a remote), then onboard this machine."""

import os
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from agent_corp.auth.passwords import hash_password, password_problem
from agent_corp.chat.hire import agent_files
from agent_corp.company.git import CompanyGitError
from agent_corp.company_template import Owner, is_new, template_files, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install.launch import REPO, Host, launch
from agent_corp.install.onboard import (TRIES, NoTerminal, OnboardError, Prompter, ask_until, handle_problem,
                                        login_defaults, make_device, make_home, onboard, redact, slug, user_git)
from agent_corp.protocol.models import HireRequest

STEPS = 5
"""The steps: the company, you, the first teammates, the remote, and this machine."""

COMPANY = "Company name"
YOUR_NAME = "Your name"
YOUR_HANDLE = "Your handle"
YOUR_TITLE = "Your title"
YOUR_PASSWORD = "Your password, to log in new devices with (at least 8 characters; not shown)"
PASSWORD_AGAIN = "Your password again"
THEIR_NAME = "Their name"
THEIR_HANDLE = "Their handle"
THEIR_TITLE = "Their title"
ABOUT = "One sentence about their work (empty to skip)"
ANOTHER = "Hire another? (y/N)"
REMOTE = "Git remote URL (empty to skip)"
"""The questions, by which command-line flags preset their answers."""

FIRST_TEAMMATE = ("Minh", "Engineer")
"""The first teammate's default name, and every teammate's default title."""


@dataclass(frozen=True)
class Teammate:
    """A first teammate: an agent reporting to the CEO, with a sentence that seeds their profile."""

    name: str
    handle: str
    title: str
    about: str = ""


def _ask_owner(prompter: Prompter, company: str) -> Owner:
    name, handle = login_defaults()
    who = prompter.ask(YOUR_NAME, name)
    me = ask_until(prompter, YOUR_HANDLE, handle, handle_problem)
    owner = Owner(handle=me, name=who, title=prompter.ask(YOUR_TITLE, "CEO"), password_hash=_ask_password(prompter))
    try:
        template_files(company, owner)  # validates without writing
    except ValueError as exc:
        raise OnboardError(f"that company doesn't work: {exc}") from None
    return owner


def _ask_password(prompter: Prompter) -> str | None:
    """The hash of a new password, asked twice without echo; None when there's no terminal to ask on.

    Raises:
        OnboardError: no password worked.
    """
    for _ in range(TRIES):
        try:
            password = prompter.secret(YOUR_PASSWORD)
        except NoTerminal:
            prompter.say("Password: none, since there's no terminal to ask on; set one later with `ac password`")
            return None
        if why := password_problem(password):
            prompter.say(f"That doesn't work: {why}")
        elif prompter.secret(PASSWORD_AGAIN) != password:
            prompter.say("That doesn't work: the two passwords differ")
        else:
            return hash_password(password)
    raise OnboardError("no usable password")


def _ask_team(prompter: Prompter, owner: Owner) -> list[Teammate]:
    team: list[Teammate] = []
    while True:
        # Only the first teammate has a default name; an empty name for a later one stops hiring.
        name = prompter.ask(THEIR_NAME, "" if team else FIRST_TEAMMATE[0])
        if not name:
            return team
        taken = {owner.handle, *(t.handle for t in team)}

        def problem(handle: str) -> str | None:
            return handle_problem(handle) or (f"@{handle} is taken" if handle in taken else None)

        handle = ask_until(prompter, THEIR_HANDLE, slug(name) or "agent", problem)
        title = prompter.ask(THEIR_TITLE, FIRST_TEAMMATE[1])
        team.append(Teammate(name, handle, title, prompter.ask(ABOUT)))
        if prompter.ask(ANOTHER).strip().lower() not in ("y", "yes"):
            return team


def push(company: Path, url: str, prompter: Prompter) -> bool:
    """Add ``url`` as ``origin`` and push ``main`` to it, tracking it; return whether that worked.

    A failure is only a warning: the company is made, and the warning says how to retry.
    """
    where = shlex.quote(str(company))
    added = user_git("-C", str(company), "remote", "add", "origin", url)
    if added.returncode != 0:
        prompter.say(f"Warning: couldn't add the remote: {redact(added.stderr.strip())}. Add it and push with"
                     f" `git -C {where} remote add origin URL && git -C {where} push -u origin main`.")
        return False
    pushed = user_git("-C", str(company), "push", "-u", "origin", "main")
    if pushed.returncode != 0:
        prompter.say(f"Warning: couldn't push to the remote: {redact(pushed.stderr.strip())}."
                     f" Retry with `git -C {where} push -u origin main`.")
        return False
    prompter.say(f"Remote: pushed the company to {redact(url)}; other machines join it with"
                 f" `ac onboard --from {shlex.quote(redact(url))}`.")
    return True


def init(home: Path, prompter: Prompter, *, mode: str = "auto", stdin: TextIO | None = None,
         host: Host | None = None, repo: Path = REPO, environ: Mapping[str, str] = os.environ,
         device: bool = True) -> None:
    """Create the company at ``home``, then set up this machine's office with ``onboard``.

    The company, its CEO (you), and its first teammates, each with a seeded ``profile.md``, are
    one commit. The CEO's ``person.yaml`` holds only the hash of their password, which is asked
    without echo (and skipped without a terminal); with ``device``, it lists this device, whose
    token goes in ``identity.json``. A remote, if given, is added and pushed to.

    Raises:
        OnboardError: a company already exists here, or a step failed.
    """
    host = host or Host()
    run = launch(home, repo=repo, environ=environ, user_home=host.user_home)
    paths = OfficePaths(run.home)
    if not is_new(paths.company):
        raise OnboardError(f"there's already a company at {paths.company}; run `ac onboard` to set up"
                           " this office for it")
    make_home(paths)
    if host.answers(run.socket):
        raise OnboardError(f"the office is running, but {paths.company} has no company yet;"
                           " stop it and run `ac init` again")

    prompter.step(1, STEPS, "Company", "The company repo holds your people, their profiles, and how they work.")
    company = prompter.ask(COMPANY, "My company")
    prompter.step(2, STEPS, "You", "You're the CEO: the human every teammate reports to.")
    owner = _ask_owner(prompter, company)
    prompter.step(3, STEPS, "First teammates", "Your AI teammates; the sentence about each one's work starts"
                                                " the profile they work from.")
    team = _ask_team(prompter, owner)
    if device:
        owner = make_device(paths.home, owner)
    extra: dict[str, bytes] = {}
    for t in team:
        extra |= {rel: text.encode() for rel, text in agent_files(
            HireRequest(name=t.name, handle=t.handle, title=t.title, manager=owner.handle), t.about)[1].items()}
    try:
        write_company(paths.company, paths.worktrees, company=company, owner=owner, extra=extra)
    except (CompanyGitError, OSError, ValueError) as exc:
        raise OnboardError(f"can't write the company repo at {paths.company}: {exc}") from None
    hired = ", ".join(f"{t.name} (@{t.handle})" for t in team) or "no one yet"
    prompter.say(f"Company repo: created at {paths.company}, with you as CEO and {hired}")

    prompter.step(4, STEPS, "Remote", "A git remote, such as a private GitHub repo, lets other machines join the"
                                      " company with `ac onboard --from URL`.")
    if url := prompter.ask(REMOTE):
        push(paths.company, url, prompter)
    else:
        prompter.say("Remote: none; the company lives only on this machine for now.")

    prompter.step(5, STEPS, "This machine", "The model, the office service, and this device, as `ac onboard` sets"
                                            " them up.")
    onboard(home, prompter, mode=mode, stdin=stdin, host=host, repo=repo, environ=environ, steps=False)
