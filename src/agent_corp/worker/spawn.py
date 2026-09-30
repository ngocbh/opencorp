"""Spawn run workers, at most one per session, and route their frames to office handlers."""

import logging
import os
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psutil

from agent_corp.store import Store
from agent_corp.worker.channel import Channel, ChannelClosed
from agent_corp.worker.job import Job
from agent_corp.worker.reaper import kill_group, reap, start_time
from agent_corp.worker.rpc import REQUEST_REPLIES, WorkerHandlers, answer_request

log = logging.getLogger(__name__)

_NOTIFICATIONS = ("event", "stream", "result", "error")


class WorkerExists(RuntimeError):
    """The session already has a live worker."""


# The only parts of the office's environment a worker inherits; anything else it needs
# (provider keys, endpoints, proxies) arrives in ``Job.env``.
INHERITED_ENV = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TZ")


def worker_env() -> dict[str, str]:
    """The environment a worker starts with: ``INHERITED_ENV`` and ``LC_*`` from the office's."""
    return {key: value for key, value in os.environ.items()
            if key in INHERITED_ENV or key.startswith("LC_")}


def spawn_process(session_dir: Path) -> tuple[subprocess.Popen[bytes], socket.socket]:
    """Start ``python -I -m agent_corp.worker.main`` holding one end of a socket pair.

    The worker runs in ``session_dir`` (never a workspace, so a model-written ``.py``
    there can't shadow an import) as the leader of a new process group, with stdout
    and stderr appended to ``session_dir/worker.log``, and with ``worker_env()`` as its
    environment. Returns the process and the
    office's end of the pair.
    """
    session_dir.mkdir(parents=True, exist_ok=True)
    office_end, worker_end = socket.socketpair()
    fd = worker_end.fileno()
    try:
        with open(session_dir / "worker.log", "ab") as out:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-m", "agent_corp.worker.main", "--fd", str(fd)],
                cwd=session_dir, env=worker_env(), pass_fds=[fd], start_new_session=True,
                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
            )
    except BaseException:
        office_end.close()
        raise
    finally:
        worker_end.close()
    return proc, office_end


EXIT_GRACE = 5.0  # seconds a worker has to exit after its channel closes, before its group is killed


def _wait_exited(pid: int, timeout: float) -> bool:
    """Wait until ``pid`` has exited, without reaping it; False on timeout."""
    deadline, pause = time.monotonic() + timeout, 0.001
    while True:
        try:
            if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                return True
        except psutil.NoSuchProcess:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(pause)
        pause = min(pause * 2, 0.05)


class Worker:
    """A live worker process and the office's end of its channel."""

    def __init__(self, job: Job, proc: subprocess.Popen[bytes], channel: Channel,
                 handlers: WorkerHandlers, on_exit: Callable[["Worker"], None]) -> None:
        self.job = job
        self.session_id = job.session_id
        self.proc = proc
        self.pid = proc.pid
        self.pgid = proc.pid  # start_new_session makes the worker its group's leader
        self.channel = channel
        self.handlers = handlers
        self.returncode: int | None = None
        self._on_exit = on_exit
        self._done = threading.Event()
        self._reap_lock = threading.Lock()
        self._reader = threading.Thread(target=self._read, name=f"worker-{self.session_id}", daemon=True)

    def start(self) -> None:
        """Send the ``start`` frame and begin reading the worker's frames.

        Raises ``FrameTooLarge`` or ``ChannelClosed`` if the frame can't be sent.
        """
        self.channel.send({"type": "start", "job": self.job.model_dump(mode="json")})
        self._reader.start()

    def abandon(self) -> None:
        """Tear down a worker whose ``start`` failed: close the channel, kill its group, reap it."""
        try:
            self.channel.discard()
            with self._reap_lock:
                kill_group(self.pgid)
                self.returncode = self.proc.wait()
        finally:
            # A close() racing the failed start waits on this; there is no reader to set it.
            self._done.set()

    def kill(self) -> None:
        """SIGKILL the worker's process group, unless the worker has been reaped."""
        # Once reaped, its pid (and so its group id) may belong to someone else.
        with self._reap_lock:
            if self.returncode is None:
                kill_group(self.pgid)

    def steer(self, node_id: str, text: str) -> bool:
        """Queue ``text`` for the node ``node_id``; False if the worker is gone or its run is over.

        Once this returns True, the run either reads the steer or hands it back through
        ``handlers.steer_left`` (before or after ``result``). Call it off the reader thread:
        a notification handler must not call ``steer`` or ``interrupt``.
        """
        return self._send({"type": "steer", "node_id": node_id, "text": text})

    def interrupt(self, node_id: str) -> bool:
        """Ask the steerable node ``node_id`` to stop and return its text so far; False if the worker is gone.

        An interrupt for a node that hasn't started stops it when it starts; one for a
        finished node is dropped.
        """
        return self._send({"type": "interrupt", "node_id": node_id})

    def close_channel(self) -> None:
        """Close the office's end; the worker exits (code 3) if its job has not finished."""
        self.channel.close()

    def wait(self, timeout: float | None = None) -> int | None:
        """The exit code once the worker is gone and ``handlers.exited`` has run; None on timeout."""
        self._done.wait(timeout)
        return self.returncode if self._done.is_set() else None

    def _send(self, frame: dict[str, Any]) -> bool:
        try:
            self.channel.send(frame)
        except ChannelClosed:
            return False
        return True

    def _read(self) -> None:
        try:
            while True:
                self._dispatch(self.channel.recv())
        except ChannelClosed:
            pass
        except Exception:
            log.exception("worker %s sent a bad frame; closing its channel", self.session_id)
        finally:
            self._finish()

    def _finish(self) -> None:
        # Each step runs even if an earlier one fails, and wait() always returns.
        try:
            for step in (self.channel.close, self._reap, lambda: self._on_exit(self),
                         lambda: self.handlers.exited(self, self.returncode)):
                try:
                    step()
                except Exception:
                    log.exception("worker %s: an exit step failed", self.session_id)
        finally:
            self._done.set()

    def _reap(self) -> None:
        # Kill what the worker leaves in its group (a subprocess of the run, say) after the
        # leader exits by itself, but before reaping it frees the group id for reuse.
        _wait_exited(self.pid, EXIT_GRACE)
        with self._reap_lock:
            kill_group(self.pgid)
            self.returncode = self.proc.wait()

    def _dispatch(self, frame: dict[str, Any]) -> None:
        kind = frame.get("type")
        if kind in REQUEST_REPLIES:
            # Requests may block (a question waits for a person), so each gets a thread.
            threading.Thread(target=self._answer, args=(frame,), daemon=True).start()
        elif kind == "steer_left":
            self._notify(self.handlers.steer_left, frame["node_id"], frame["texts"])
        elif kind in _NOTIFICATIONS:
            self._notify(getattr(self.handlers, kind), frame)
            if kind in ("result", "error"):
                # The run is over: later steers fail here, and the worker, having answered
                # the ones already sent, sees the end of stream and exits.
                self.channel.close_send()
        else:
            log.warning("worker %s sent an unknown frame type %r", self.session_id, kind)

    def _notify(self, handler: Callable[..., None], *args: Any) -> None:
        try:
            handler(self, *args)
        except Exception:
            log.exception("worker %s handler %s failed", self.session_id, handler.__name__)

    def _answer(self, frame: dict[str, Any]) -> None:
        # Always reply, or the worker's request waits forever.
        try:
            self.channel.send(answer_request(frame, self.handlers, self))
        except ChannelClosed:
            pass
        except Exception as exc:  # e.g. FrameTooLarge
            log.warning("worker %s: could not answer a %s request", self.session_id, frame.get("type"),
                        exc_info=True)
            self._send({"type": REQUEST_REPLIES[frame["type"]], "id": frame.get("id"), "error": "failed",
                        "message": f"{type(exc).__name__}: {exc}"})


class WorkerRegistry:
    """The office's live workers, at most one per session, each recorded in the store for ``reap``."""

    def __init__(self, store: Store) -> None:
        self.store = store
        self._lock = threading.Lock()
        self._workers: dict[str, Worker] = {}
        self._starting: set[str] = set()

    def spawn(self, job: Job, session_dir: Path, handlers: WorkerHandlers) -> Worker:
        """Start a worker for ``job.session_id`` running ``job``; raise ``WorkerExists`` if one is live.

        A worker of the session left by an earlier office is reaped first. If the worker
        can't be started (for example a start frame over ``MAX_FRAME``), nothing is left
        behind: no process, registry entry, store record, or socket.
        """
        session_id = job.session_id
        with self._lock:
            if session_id in self._workers or session_id in self._starting:
                raise WorkerExists(f"session {session_id} already has a live worker")
            # Reserve the session so the store calls below run outside the registry lock.
            self._starting.add(session_id)
        try:
            reap(self.store, session_id)
            proc, sock = spawn_process(Path(session_dir))
            worker = Worker(job, proc, Channel(sock), handlers, self._exited)
            try:
                self.store.record_worker(session_id, pid=proc.pid, pgid=worker.pgid,
                                         start_time=start_time(proc.pid) or 0.0)
                with self._lock:
                    self._workers[session_id] = worker
                worker.start()
            except BaseException:
                self._abandon(worker)
                raise
        finally:
            with self._lock:
                self._starting.discard(session_id)
        return worker

    def get(self, session_id: str) -> Worker | None:
        """The session's live worker, if any."""
        with self._lock:
            return self._workers.get(session_id)

    def close(self, session_id: str, timeout: float = 5.0) -> int | None:
        """Stop the session's worker (close its channel, then SIGKILL its group after ``timeout``); return its exit code."""
        worker = self.get(session_id)
        if worker is None:
            return None
        self._stop([worker], timeout)
        return worker.returncode

    def close_all(self, timeout: float = 5.0) -> None:
        """Stop every live worker, as ``close`` does, all at once."""
        with self._lock:
            workers = list(self._workers.values())
        self._stop(workers, timeout)

    def _stop(self, workers: list[Worker], timeout: float) -> None:
        for worker in workers:
            worker.close_channel()
        deadline = time.monotonic() + timeout
        for worker in workers:
            if worker.wait(max(0.0, deadline - time.monotonic())) is None:
                worker.kill()
                worker.wait(timeout)

    def _abandon(self, worker: Worker) -> None:
        try:
            worker.abandon()
        finally:
            with self._lock:
                if self._workers.get(worker.session_id) is worker:
                    del self._workers[worker.session_id]
            try:
                self.store.remove_worker(worker.session_id)
            except Exception:
                log.exception("could not remove the record of worker %s", worker.session_id)

    def _exited(self, worker: Worker) -> None:
        # Never write to the store while holding the registry lock: the store holds its write
        # lock through transactions and listeners, which may call get(). The record goes
        # first, while the entry still refuses a new spawn for the session, so a new worker's
        # record is never the one removed.
        with self._lock:
            if self._workers.get(worker.session_id) is not worker:
                return
        try:
            self.store.remove_worker(worker.session_id)
        finally:
            with self._lock:
                if self._workers.get(worker.session_id) is worker:
                    del self._workers[worker.session_id]
