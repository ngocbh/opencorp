"""One-time pairing codes: 128 bits, single use, 5 minutes, never logged, no failure throttle."""

import logging
import os
import stat
import threading
from datetime import UTC, datetime

from opencorp.hq import pairing
from opencorp.hq.pairing import MAX_PENDING, TTL, PairCodes

T0 = datetime(2026, 10, 19, 10, 0, tzinfo=UTC)


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now


URL = "http://127.0.0.1:49380/pair#{}"


async def test_a_code_is_128_bits_and_works_once(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=False)
    assert len(minted.code) == 22 and minted.file is None and minted.expires_at == T0 + TTL
    pending = codes.redeem(minted.code)
    assert (pending.handle, pending.issuer) == ("ngocbh", "ngocbh")
    assert codes.redeem(minted.code) is None


async def test_a_code_expires_after_five_minutes_and_its_file_goes(tmp_path):
    clock = Clock()
    codes = PairCodes(tmp_path, clock=clock)
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    assert minted.file.parent == tmp_path and stat.S_IMODE(os.stat(minted.file).st_mode) == 0o600
    assert URL.format(minted.code) in minted.file.read_text()
    clock.now = T0 + TTL
    codes.sweep()
    assert not minted.file.exists() and codes.redeem(minted.code) is None


async def test_using_a_code_deletes_its_file(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    codes.redeem(minted.code)
    assert not minted.file.exists()


async def test_no_file_without_a_url(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=lambda code: None, open_file=True)
    assert minted.file is None and list(tmp_path.iterdir()) == []


async def test_at_most_16_pending_and_the_oldest_goes_first(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    first = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    rest = [await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=False)
            for _ in range(MAX_PENDING)]
    assert codes.redeem(first.code) is None and not first.file.exists()
    assert all(codes.redeem(m.code) is not None for m in rest)


async def test_many_wrong_codes_never_block_the_right_one(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=False)
    for i in range(1000):
        assert codes.redeem(f"wrong{i}") is None
    assert codes.redeem(minted.code) is not None


async def test_close_forgets_every_code_and_deletes_the_files(tmp_path):
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    codes.close()
    assert codes.redeem(minted.code) is None and list(tmp_path.iterdir()) == []


async def test_a_code_is_never_logged(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    codes = PairCodes(tmp_path, clock=Clock())
    minted = await codes.mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    codes.redeem(minted.code)
    codes.redeem(minted.code)
    assert "pairing code" in caplog.text and minted.code not in caplog.text


async def test_the_file_is_written_off_the_loop(tmp_path, monkeypatch):
    threads = []
    real = pairing.write_private
    monkeypatch.setattr(pairing, "write_private", lambda *a: threads.append(threading.current_thread()) or real(*a))
    await PairCodes(tmp_path, clock=Clock()).mint("ngocbh", issuer="ngocbh", url=URL.format, open_file=True)
    assert threads and threads[0] is not threading.main_thread()
