"""``python -m agent_corp.install {init,onboard,offboard,doctor,start,restart}``: what ``ac init``,
``ac onboard``, ``ac offboard``, ``ac doctor``, ``ac start`` and ``ac restart`` run.

Exit codes: 0 done, 1 failed, 3 (``start``, ``restart``) no office yet.
"""

import argparse
import io
import os
import sys
from pathlib import Path

from agent_corp.company_template import is_new
from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import OfficeStartError
from agent_corp.install import doctor, init, offboard, service
from agent_corp.install.interview import Known
from agent_corp.install.launch import Host, Launch, ServiceError, launch
from agent_corp.install.onboard import SET_UP, WHO, OnboardError, TtyPrompter, handle_problem, onboard

NOT_ONBOARDED = 3


def _home(value: str | None) -> Path:
    return Path(value or os.environ.get("AGENT_CORP_HOME") or "~/.agent-corp").expanduser()


def _provider_stdin(args: argparse.Namespace) -> io.StringIO | None:
    # The provider is read before any question, so stdin is free of it; with it on stdin
    # nothing is asked, and questions without a flag take their defaults.
    return io.StringIO(sys.stdin.read()) if args.provider_stdin else None


def _init(args: argparse.Namespace) -> int:
    # Handles from flags are checked before anything is asked, so a bad one doesn't cost the owner an interview.
    for flag, handle in (("--handle", args.handle), ("--agent-handle", args.agent_handle)):
        if handle and (problem := handle_problem(handle)):
            print(f"ac init: {flag} {handle!r}: {problem}", file=sys.stderr)
            return 1
    if args.handle and args.agent_handle == args.handle:
        print(f"ac init: --agent-handle {args.agent_handle!r} is the same as --handle", file=sys.stderr)
        return 1
    known = Known(company=args.company or "", name=args.name or "", handle=args.handle or "",
                  title=args.title or "", agent=args.agent or "", agent_handle=args.agent_handle or "",
                  remote=args.remote or "")
    stdin = _provider_stdin(args)
    try:
        init.init(_home(args.home), TtyPrompter(interactive=stdin is None), known=known, mode=args.service,
                  stdin=stdin, device=not args.no_device)
    except OnboardError as exc:
        print(f"ac init: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        # Ctrl-C at a question leaves the cursor mid-line; end the line instead of showing a traceback.
        print(file=sys.stderr)
        return 130
    return 0


def _onboard(args: argparse.Namespace) -> int:
    stdin = _provider_stdin(args)
    try:
        onboard(_home(args.home), TtyPrompter({WHO: args.handle}, interactive=stdin is None), mode=args.service,
                stdin=stdin, source=args.source)
    except OnboardError as exc:
        print(f"ac onboard: {exc}", file=sys.stderr)
        return 1
    return 0


def _offboard(args: argparse.Namespace) -> int:
    # Without a terminal the confirmation takes its default, No, so only --yes removes anything.
    prompter = TtyPrompter(interactive=sys.stdin.isatty())
    try:
        offboard.offboard(_home(args.home), prompter, yes=args.yes, delete_company=args.delete_company)
    except (offboard.OffboardError, OnboardError) as exc:
        declined = isinstance(exc, offboard.Declined) and not prompter.interactive
        hint = "; there's no terminal to ask on, so pass --yes to remove it" if declined else ""
        print(f"ac offboard: {exc}{hint}", file=sys.stderr)
        return 1
    return 0


def _doctor(args: argparse.Namespace) -> int:
    found = doctor.checks(_home(args.home), probe=doctor.sandbox_problem)
    print(doctor.report(found), end="")
    return doctor.exit_code(found)


def _came_up(run: Launch, host: Host, how) -> bool:
    """Start the office with ``how`` (``service.start`` or ``service.restart``) and wait for it to answer."""
    try:
        started = how(run, host)
        for note in started.notes:
            print(f"ac: {note}; started the office in the background instead", file=sys.stderr)
        service.wait(run, host)
    except (ServiceError, OfficeStartError) as exc:
        print(f"ac: {exc}", file=sys.stderr)
        return False
    return True


def _start(args: argparse.Namespace) -> int:
    host = Host()
    run = launch(_home(args.home), user_home=host.user_home)
    if host.answers(run.socket):
        print(f"The office is already running (pid {service.pid(run)}).")
        return 0
    if is_new(OfficePaths(run.home).company):
        print(f"ac: no office at {run.home} yet; {SET_UP}", file=sys.stderr)
        return NOT_ONBOARDED
    if not _came_up(run, host, service.start):
        return 1
    print(f"Started the office (pid {service.pid(run)}).")
    return 0


def _restart(args: argparse.Namespace) -> int:
    host = Host()
    run = launch(_home(args.home), user_home=host.user_home)
    if is_new(OfficePaths(run.home).company):
        print(f"ac: no office at {run.home} yet; {SET_UP}", file=sys.stderr)
        return NOT_ONBOARDED
    was = service.pid(run) if host.answers(run.socket) else None
    if not _came_up(run, host, service.restart):
        return 1
    if was is None:
        print(f"The office wasn't running; started it (pid {service.pid(run)}).")
    else:
        print(f"Restarted the office (pid {service.pid(run)}; was {was}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run one command; returns the exit code."""
    parser = argparse.ArgumentParser(prog="python -m agent_corp.install")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("init", "create the company, then set up this office"),
                       ("onboard", "set up this office for an existing company"),
                       ("offboard", "remove this office from this machine"), ("doctor", "check the office"),
                       ("start", "start the office if it isn't running"),
                       ("restart", "stop the office and start it again")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("--home", help="agent-corp home (default: $AGENT_CORP_HOME or ~/.agent-corp)")
    for name in ("init", "onboard"):
        sub = commands.choices[name]
        sub.add_argument("--service", choices=("auto", *service.MODES), default="auto",
                         help="how to run the office (default: the first that works)")
        sub.add_argument("--provider-stdin", action="store_true",
                         help="read office/provider.json's content from stdin, replacing the file; ask nothing")
    init_args = commands.choices["init"]
    for flag, what in (("company", "the company's name"), ("name", "your name"), ("handle", "your handle"),
                       ("title", "your title"), ("agent", "the first teammate's name"),
                       ("agent-handle", "the first teammate's handle")):
        init_args.add_argument(f"--{flag}", help=f"use {what} without asking")
    init_args.add_argument("--remote", metavar="URL",
                           help="push the company to this git remote without asking; the model never sees it")
    init_args.add_argument("--no-device", action="store_true",
                           help="don't register this device; the office stays open to requests without a token"
                                " until someone runs `ac login`")
    onboard_args = commands.choices["onboard"]
    onboard_args.add_argument("--from", dest="source", metavar="URL",
                              help="clone the company from this git URL when there's none here yet")
    onboard_args.add_argument("--handle", help="which of a cloned company's humans you are")
    offboard_args = commands.choices["offboard"]
    offboard_args.add_argument("--yes", action="store_true", help="remove without asking first")
    offboard_args.add_argument("--delete-company", action="store_true",
                               help="delete the company repo even if some of it isn't pushed anywhere")
    args = parser.parse_args(argv)
    return {"init": _init, "onboard": _onboard, "offboard": _offboard, "doctor": _doctor,
            "start": _start, "restart": _restart}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
