"""Request bodies: the size cap and bodies that don't parse."""

import json

from agent_corp.daemon.app import create_app
from agent_corp.daemon.http import MAX_BODY
from tests.daemon.conftest import served
from tests.store.conftest import question, session


def _answer(text: bytes) -> bytes:
    return b'{"answer": "' + text + b'", "answer_kind": "text"}'


def _answer_of_size(size: int) -> bytes:
    return _answer(b"x" * (size - len(_answer(b""))))


def _open_question(office):
    s = office.store.create_session(session())
    return office.store.add_question(question(s.id))


async def test_a_body_at_the_cap_is_read(client, office):
    q = _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", content=_answer_of_size(MAX_BODY))
    assert r.status_code == 200 and len(r.json()["answer"]) > MAX_BODY - 100


async def test_a_body_over_the_cap_is_413(client, office):
    q = _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", content=_answer_of_size(MAX_BODY + 1))
    assert r.status_code == 413
    assert r.json() == {"error": "body_too_large", "message": f"request body is over {MAX_BODY} bytes"}
    assert office.store.get_question(q.id).status == "open"


async def test_a_too_large_content_length_is_refused_before_reading(office):
    q = _open_question(office)
    received, sent = [], []

    async def receive():
        received.append(1)
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "method": "POST", "path": f"/questions/{q.id}/answer",
             "raw_path": f"/questions/{q.id}/answer".encode(), "query_string": b"",
             "headers": [(b"content-length", str(64 * MAX_BODY).encode())], "scheme": "http",
             "server": None, "client": None, "root_path": "", "http_version": "1.1"}
    await office.start()
    try:
        await create_app(office)(scope, receive, send)
    finally:
        await office.stop()
    assert sent[0]["status"] == 413 and not received


async def test_a_chunked_body_stops_being_read_past_the_cap(client, office):
    q = _open_question(office)
    chunk = 64 * 1024
    pulled = 0

    async def chunks():
        nonlocal pulled
        for _ in range(64 * MAX_BODY // chunk):
            pulled += 1
            yield b"x" * chunk

    r = await client.post(f"/questions/{q.id}/answer", content=chunks())
    assert r.status_code == 413 and r.json()["error"] == "body_too_large"
    assert pulled <= MAX_BODY // chunk + 1


async def test_deeply_nested_json_is_422(client, office):
    q = _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", content=b"[" * 100_000 + b"]" * 100_000)
    assert r.status_code == 422 and r.json()["error"] == "invalid_body"


async def test_over_the_cap_on_a_real_socket_leaves_the_client_working(office, short_dir):
    q = _open_question(office)

    async def chunks():
        for _ in range(64):
            yield b"x" * (64 * 1024)

    async with served(office, short_dir / "o.sock") as c:
        for content in (b"x" * (4 * MAX_BODY), chunks()):
            r = await c.post(f"/questions/{q.id}/answer", content=content)
            assert r.status_code == 413 and json.loads(r.content)["error"] == "body_too_large"
            assert (await c.get("/people")).status_code == 200
