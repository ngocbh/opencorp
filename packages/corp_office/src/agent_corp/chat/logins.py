"""Device sign-ins to the ChatGPT subscription, each adding a connection when it succeeds."""

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

from agent_composer.llm_clients.auth import AuthError, AuthStore, OpenAIAuth

from agent_corp.chat.connections import ConnectionFile, Connections
from agent_corp.chat.models import ModelCache
from agent_corp.chat.provider import ProviderError
from agent_corp.protocol.models import ConnectionLogin
from agent_corp.store import new_id

log = logging.getLogger(__name__)

START_WAIT = 20.0
"""Seconds ``start`` waits for OpenAI to give the sign-in's code."""

FORGET = 600.0
"""Seconds a sign-in is kept after it ends."""

STOP_WAIT = 5.0
"""Seconds ``cancel`` and ``close_all`` wait for a sign-in's thread to stop."""


class LoginNotFound(LookupError):
    """No sign-in with that id that the asking person started."""


class _Stopped(Exception):
    """The sign-in was cancelled."""


class _Login:
    """One sign-in: its state as clients see it, and what its thread and ``start`` wait on."""

    def __init__(self, by: str) -> None:
        self.view = ConnectionLogin(id=new_id(), state="waiting")
        self.by = by
        self.ended: float | None = None
        self.stopped = threading.Event()
        self.shown = threading.Event()  # set once the code is shown, or the sign-in ends without one
        self.thread: threading.Thread | None = None

    def check(self) -> None:
        """Raise ``_Stopped`` once the sign-in is cancelled; composer calls it at each step."""
        if self.stopped.is_set():
            raise _Stopped

    def show(self, url: str, user_code: str) -> None:
        self.view = self.view.model_copy(update={"url": url, "user_code": user_code})
        self.shown.set()


class Logins:
    """Device sign-ins to the ChatGPT subscription, each on its own thread; tokens go only to the auth file.

    A sign-in that succeeds adds a new connection, ``chatgpt``, ``chatgpt-2``, …, on the first model the subscription
    lists. Only the person who started a sign-in sees or cancels it, and it is forgotten ``FORGET`` seconds after it
    ends. ``auth`` makes composer's ``OpenAIAuth`` given ``check_stopped``; ``monotonic`` dates the ends.
    """

    def __init__(self, connections: Connections, *, models: ModelCache | None = None,
                 auth: Callable[..., OpenAIAuth] = OpenAIAuth,
                 monotonic: Callable[[], float] = time.monotonic) -> None:
        self.connections = connections
        self.models = models
        self._auth = auth
        self._monotonic = monotonic
        self._lock = threading.Lock()
        self._logins: dict[str, _Login] = {}

    def start(self, *, by: str) -> ConnectionLogin:
        """Start a sign-in for ``by``; once OpenAI gives its URL and code, or ``START_WAIT`` seconds pass, the
        sign-in as it is then."""
        login = _Login(by)
        login.thread = threading.Thread(target=self._run, args=(login,), name=f"login-{login.view.id}", daemon=True)
        with self._lock:
            self._forget()
            self._logins[login.view.id] = login
        login.thread.start()
        login.shown.wait(START_WAIT)
        return login.view

    def get(self, login_id: str, *, by: str) -> ConnectionLogin:
        """Sign-in ``login_id``; LoginNotFound unless ``by`` started it and it isn't forgotten."""
        return self._find(login_id, by).view

    def cancel(self, login_id: str, *, by: str) -> None:
        """Cancel sign-in ``login_id`` if it still waits, saving nothing; LoginNotFound as ``get``."""
        self._stop([self._find(login_id, by)])

    def close_all(self) -> None:
        """Cancel every sign-in still waiting."""
        with self._lock:
            open_ = [login for login in self._logins.values() if login.ended is None]
        self._stop(open_)

    def _find(self, login_id: str, by: str) -> _Login:
        with self._lock:
            self._forget()
            login = self._logins.get(login_id)
        # Another person's sign-in reads as no sign-in at all, so its id tells them nothing.
        if login is None or login.by != by:
            raise LoginNotFound(f"no sign-in {login_id}")
        return login

    def _forget(self) -> None:
        """Drop sign-ins that ended ``FORGET`` seconds ago; the caller holds the lock."""
        now = self._monotonic()
        for login_id, login in list(self._logins.items()):
            if login.ended is not None and now - login.ended >= FORGET:
                del self._logins[login_id]

    @staticmethod
    def _stop(logins: list[_Login]) -> None:
        for login in logins:
            login.stopped.set()
        for login in logins:
            if login.thread is not None:
                login.thread.join(STOP_WAIT)

    def _run(self, login: _Login) -> None:
        try:
            auth = self._auth(check_stopped=login.check)
            creds = auth.device_login(login.show)
            models = auth.subscription_models(creds)

            def sign_in(path: Path) -> None:
                login.check()  # a cancel that came while the models were listed saves nothing
                AuthStore(path).save("openai", creds, models[0])

            name = self.connections.add(
                "chatgpt", ConnectionFile(method="subscription", llm_config={"provider": "openai", "model": models[0]}),
                sign_in=sign_in)
        except _Stopped:
            self._end(login, state="cancelled")
        except AuthError as exc:
            # Composer's AuthError says only what failed and its HTTP status, never a token.
            self._end(login, state="failed", message=str(exc))
        except ProviderError as exc:
            # Its error may name the office's files; the log says which sign-in, the person gets no path.
            log.warning("sign-in %s couldn't save its connection (%s)", login.view.id, type(exc).__name__)
            self._end(login, state="failed", message="the sign-in couldn't be saved as a connection")
        except Exception as exc:
            log.warning("sign-in %s failed (%s)", login.view.id, type(exc).__name__)  # by type: it may quote a reply
            self._end(login, state="failed", message="the sign-in failed")
        else:
            self._end(login, state="signed_in", connection=name)
            if self.models is not None:
                self.models.warm()

    def _end(self, login: _Login, **update: str) -> None:
        with self._lock:
            login.view = login.view.model_copy(update=update)
            login.ended = self._monotonic()
        login.shown.set()
