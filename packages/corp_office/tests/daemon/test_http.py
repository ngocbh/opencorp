"""Request bodies: the size cap and bodies that don't parse."""

import json
from typing import Annotated, Literal

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from opencorp.daemon.app import create_app
from opencorp.daemon.http import MAX_BODY, _errors
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


# A 422 never echoes the body: a password or key sent there would come back in the response.

SENTINEL = "sk-ant-sentinel-a7d93c10e5b2"


async def test_a_short_password_is_422_without_the_password(client):
    short = "Zq7xWv"
    r = await client.put("/people/ngocbh/password", json={"password": short})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")
    assert short not in r.text and "password" in r.json()["message"]


async def test_an_extra_key_is_422_without_its_name(client):
    r = await client.put("/people/ngocbh/password", json={"password": "long-enough-password", SENTINEL: 1})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")
    assert SENTINEL not in r.text and "an extra field" in r.json()["message"]


async def test_a_bad_login_body_is_422_without_its_values_or_extra_keys(client):
    body = {"handle": "ngocbh", "password": [SENTINEL], "device": "laptop", "token_sha256": "0" * 64,
            SENTINEL: SENTINEL}
    r = await client.post("/login", json=body)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_body")
    assert SENTINEL not in r.text


class _Cat(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["cat"]


class _Dog(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["dog"]


class _Pets(BaseModel):
    model_config = ConfigDict(extra="forbid")
    colour: Literal["red", "blue"]
    pet: Annotated[_Cat | _Dog, Field(discriminator="type")]


def test_errors_name_neither_a_literal_nor_a_union_tag_input():
    with pytest.raises(ValidationError) as exc:
        _Pets.model_validate({"colour": SENTINEL, "pet": {"type": SENTINEL}})
    text = _errors(_Pets, exc.value)
    assert SENTINEL not in text
    assert text == "colour: isn't an allowed value; pet: isn't an allowed value"


async def test_a_body_that_isnt_json_is_422(client, office):
    q = _open_question(office)
    r = await client.post(f"/questions/{q.id}/answer", content=b"{" + SENTINEL.encode())
    assert (r.status_code, r.json()) == (422, {"error": "invalid_body", "message": "the body isn't JSON"})
