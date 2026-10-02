"""``ac init``: ask for the model, create the company from an interview with it (its name, its CEO, its first
teammates), add a password and a remote, then onboard this machine."""

import os
import shlex
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import TextIO

from agent_corp.auth.passwords import hash_password, password_problem
from agent_corp.chat.hire import agent_files
from agent_corp.company.git import CompanyGitError
from agent_corp.company_template import is_new, write_company
from agent_corp.daemon.app import OfficePaths
from agent_corp.install.interview import Known, interview
from agent_corp.install.launch import REPO, Host, launch
from agent_corp.install.onboard import (TRIES, NoTerminal, OnboardError, Prompter, ensure_provider, make_device,
                                        make_home, onboard, redact, user_git)
from agent_corp.protocol.models import HireRequest

STEPS = 5
"""The steps: the model, the company, your password, the remote, and this machine."""

YOUR_PASSWORD = ("Your password, to log in new devices with"
                 " (at least 12 characters, one you use nowhere else; not shown)")
PASSWORD_AGAIN = "Your password again"
REMOTE = "Git remote URL (empty to skip)"
"""The questions init asks itself; the interview asks the rest."""


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


def init(home: Path, prompter: Prompter, *, known: Known = Known(), mode: str = "auto",
         stdin: TextIO | None = None, host: Host | None = None, repo: Path = REPO,
         environ: Mapping[str, str] = os.environ, device: bool = True) -> None:
    """Create the company at ``home``, then set up this machine's office with ``onboard``.

    The model comes first: ``office/provider.json`` from ``stdin`` or asked for. The company,
    its CEO (you), and its first teammates come from an interview with that model, which starts
    from ``known`` (or from ``known`` and defaults alone, without a terminal). They are one
    commit, each teammate with a seeded ``profile.md``. The CEO's ``person.yaml`` holds only
    the hash of their password, which is asked without echo (and skipped without a terminal);
    with ``device``, it lists this device, whose token goes in ``identity.json``. A remote,
    ``known.remote`` or asked for, is added and pushed to.

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

    prompter.step(1, STEPS, "Model", "Your agents think with this model; its key stays in this office, readable"
                                     " only by you.")
    provider = paths.office / "provider.json"
    wrote = ensure_provider(provider, prompter, stdin)
    prompter.say(f"Model provider: {'saved to' if wrote else 'up to date at'} {provider}")

    prompter.step(2, STEPS, "Company", "Tell the model about you, the company and your first AI teammates; it asks"
                                       " until it has what it needs.")
    answers = interview(provider, prompter, known)

    prompter.step(3, STEPS, "Password", "Your password logs in your new devices; only its hash is kept.")
    owner = replace(answers.owner, password_hash=_ask_password(prompter))
    if device:
        owner = make_device(paths.home, owner)
    extra: dict[str, bytes] = {}
    for t in answers.team:
        extra |= {rel: text.encode() for rel, text in agent_files(
            HireRequest(name=t.name, handle=t.handle, title=t.title, manager=owner.handle), t.about)[1].items()}
    try:
        write_company(paths.company, paths.worktrees, company=answers.company, owner=owner, extra=extra)
    except (CompanyGitError, OSError, ValueError) as exc:
        raise OnboardError(f"can't write the company repo at {paths.company}: {exc}") from None
    hired = ", ".join(f"{t.name} (@{t.handle})" for t in answers.team) or "no one yet"
    prompter.say(f"Company repo: created at {paths.company}, with you as CEO and {hired}")

    prompter.step(4, STEPS, "Remote", "A git remote, such as a private GitHub repo, lets other machines join the"
                                      " company with `ac onboard --from URL`.")
    if url := known.remote or prompter.ask(REMOTE):
        push(paths.company, url, prompter)
    else:
        prompter.say("Remote: none; the company lives only on this machine for now.")

    prompter.step(5, STEPS, "This machine", "The office service and this device, as `ac onboard` sets them up.")
    # The provider stdin was used up by the model step; onboard finds the file it wrote and keeps it.
    onboard(home, prompter, mode=mode, stdin=None, host=host, repo=repo, environ=environ, steps=False)
