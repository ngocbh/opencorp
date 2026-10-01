"""``python -m agent_corp.install {onboard,doctor,start}``: what ``ac onboard`` and ``ac doctor`` run.

Exit codes: 0 done, 1 failed, 3 (``start``) no office yet.
"""

import argparse
import io
import os
import sys
from pathlib import Path

from agent_corp.company_template import is_new
from agent_corp.daemon.app import OfficePaths
from agent_corp.daemon.main import OfficeStartError
from agent_corp.install import doctor, service
from agent_corp.install.launch import Host, ServiceError, launch
from agent_corp.install.onboard import OnboardError, TtyPrompter, handle_problem, onboard

NOT_ONBOARDED = 3


def _home(value: str | None) -> Path:
    return Path(value or os.environ.get("AGENT_CORP_HOME") or "~/.agent-corp").expanduser()


def _onboard(args: argparse.Namespace) -> int:
    # The provider is read before any question, so stdin is free of it; with it on stdin
    # nothing is asked, and questions without a flag take their defaults.
    # A preset answer comes back unchanged each time a question is asked again, so a bad one stops here.
    for flag, handle in (("--handle", args.handle), ("--agent-handle", args.agent_handle)):
        if handle and (problem := handle_problem(handle)):
            print(f"ac onboard: {flag} {handle!r}: {problem}", file=sys.stderr)
            return 1
    stdin = io.StringIO(sys.stdin.read()) if args.provider_stdin else None
    prompter = TtyPrompter({"Company name": args.company, "Your name": args.name, "Your handle": args.handle,
                            "Name your first agent": args.agent, "Their handle": args.agent_handle},
                           interactive=stdin is None)
    try:
        onboard(_home(args.home), prompter, mode=args.service, stdin=stdin, hire=not args.no_hire,
                device=not args.no_device)
    except OnboardError as exc:
        print(f"ac onboard: {exc}", file=sys.stderr)
        return 1
    return 0


def _doctor(args: argparse.Namespace) -> int:
    found = doctor.checks(_home(args.home), probe=doctor.sandbox_problem)
    print(doctor.report(found), end="")
    return doctor.exit_code(found)


def _start(args: argparse.Namespace) -> int:
    host = Host()
    run = launch(_home(args.home), user_home=host.user_home)
    if host.answers(run.socket):
        print(f"The office is already running (pid {service.pid(run)}).")
        return 0
    if is_new(OfficePaths(run.home).company):
        print(f"ac: no office at {run.home} yet; run `ac onboard` to set one up", file=sys.stderr)
        return NOT_ONBOARDED
    try:
        started = service.start(run, host)
        for note in started.notes:
            print(f"ac: {note}; started the office in the background instead", file=sys.stderr)
        service.wait(run, host)
    except (ServiceError, OfficeStartError) as exc:
        print(f"ac: {exc}", file=sys.stderr)
        return 1
    print(f"Started the office (pid {service.pid(run)}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Parse arguments and run one command; returns the exit code."""
    parser = argparse.ArgumentParser(prog="python -m agent_corp.install")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (("onboard", "set up the office"), ("doctor", "check the office"),
                       ("start", "start the office if it isn't running")):
        sub = commands.add_parser(name, help=text)
        sub.add_argument("--home", help="agent-corp home (default: $AGENT_CORP_HOME or ~/.agent-corp)")
    onboard_args = commands.choices["onboard"]
    onboard_args.add_argument("--service", choices=("auto", *service.MODES), default="auto",
                              help="how to run the office (default: the first that works)")
    onboard_args.add_argument("--provider-stdin", action="store_true",
                              help="read office/provider.json's content from stdin, replacing the file;"
                                   " ask nothing")
    for flag in ("company", "name", "handle", "agent"):
        onboard_args.add_argument(f"--{flag}", help=f"answer the {flag} question")
    onboard_args.add_argument("--agent-handle", help="answer the first agent's handle question")
    onboard_args.add_argument("--no-hire", action="store_true", help="don't hire a first agent")
    onboard_args.add_argument("--no-device", action="store_true",
                              help="don't register this device for a new company; the office stays open to"
                                   " requests without a token until someone runs `ac login`")
    args = parser.parse_args(argv)
    return {"onboard": _onboard, "doctor": _doctor, "start": _start}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
