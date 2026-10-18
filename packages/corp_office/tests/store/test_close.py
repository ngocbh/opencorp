"""Closing the store while other threads still use it."""

import sqlite3
import subprocess
import sys
import threading

import pytest

from opencorp.store import Store

# A thread's BEGIN IMMEDIATE waits (without the GIL) on another connection's write lock
# while the main thread closes the store. Run in a subprocess, so a crash fails the test
# instead of killing pytest.
CLOSE_DURING_A_WRITE = """
import sqlite3, sys, threading, time
from opencorp.store import Store

path = sys.argv[1]
store = Store(path)
blocker = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
blocker.execute("BEGIN IMMEDIATE")
errors = []

def write():
    try:
        store.remove_worker("s1")
    except Exception as exc:
        errors.append(type(exc).__name__)

writer = threading.Thread(target=write)
writer.start()
time.sleep(0.3)  # the writer is now waiting for the blocker's lock
threading.Timer(0.3, blocker.rollback).start()
store.close()
writer.join()
print(errors)
"""


def test_closing_the_store_during_another_threads_write_doesnt_crash(tmp_path):
    done = subprocess.run(
        [sys.executable, "-c", CLOSE_DURING_A_WRITE, str(tmp_path / "s.sqlite")],
        capture_output=True, text=True, timeout=60,
    )
    assert done.returncode == 0, done.stderr
    # The write either finished before the close or failed cleanly.
    assert done.stdout.strip() in ("[]", "['ProgrammingError']")


def test_a_closed_store_refuses_reads_and_writes_on_every_thread(tmp_path):
    s = Store(tmp_path / "s.sqlite")
    s.list_workers()
    s.close()
    with pytest.raises(sqlite3.ProgrammingError):
        s.list_workers()
    with pytest.raises(sqlite3.ProgrammingError):
        s.remove_worker("s1")

    # A thread that never had a connection doesn't open a new one either.
    raised = []

    def use():
        try:
            s.get_session("s1")
        except sqlite3.ProgrammingError:
            raised.append(True)

    t = threading.Thread(target=use)
    t.start()
    t.join()
    assert raised == [True]
    assert len(s._conns) == 0
