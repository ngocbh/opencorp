"""The one-reply check of a connection whose provider can't list its models, run in a child process.

``python -I -m opencorp.chat.check`` reads a provider as JSON on stdin and prints one line, ``{"problem": ...}``.
"""

import contextlib
import json
import logging
import subprocess
import sys
import tempfile

from opencorp.chat.provider import Provider
from opencorp.worker.spawn import worker_env

log = logging.getLogger(__name__)

TIMEOUT = 90.0
"""Seconds the check may take: one short reply from the model."""

NO_RESULT = "the check didn't give a result"
NOT_FINISHED = "the check didn't finish"


def one_reply_problem(provider: Provider, *, timeout: float = TIMEOUT) -> str | None:
    """Why ``provider``'s model doesn't answer a one-word request made as an office run makes it, or None when it
    answers.

    The check runs in a child, as a worker does (isolated, in a directory of its own, with a worker's environment),
    because it swaps ``os.environ`` for the provider's. The key goes to it on stdin only.
    """
    with tempfile.TemporaryDirectory(prefix="ac-check-") as cwd:
        try:
            # Its stderr is dropped, never read: composer's errors there could quote the request.
            done = subprocess.run([sys.executable, "-I", "-m", "opencorp.chat.check"],
                                  input=provider.model_dump_json(), env=worker_env(), cwd=cwd,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return NOT_FINISHED
    problem = _result(done.stdout)
    if problem == NO_RESULT:
        log.warning("the one-reply check gave no result (exit code %s)", done.returncode)
    return problem


def _result(stdout: str) -> str | None:
    """The problem on the last line of the child's ``stdout``; ``NO_RESULT`` if that line isn't a result."""
    lines = stdout.splitlines()
    try:
        result = json.loads(lines[-1])
    except (IndexError, ValueError):
        return NO_RESULT
    if not isinstance(result, dict) or result.keys() != {"problem"}:
        return NO_RESULT
    problem = result["problem"]
    return problem if problem is None or isinstance(problem, str) else NO_RESULT


def main() -> None:
    """Check the provider on stdin and print its one result line."""
    # Imported here: interview imports onboarding, which imports the daemon, whose routes import this module.
    from opencorp.install.interview import model_problem

    provider = Provider.model_validate_json(sys.stdin.read())
    # Whatever composer prints must not land where the parent reads the result.
    with contextlib.redirect_stdout(sys.stderr):
        problem = model_problem(provider)
    print(json.dumps({"problem": problem}), flush=True)


if __name__ == "__main__":
    main()
