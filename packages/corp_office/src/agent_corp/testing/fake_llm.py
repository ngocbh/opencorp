"""A scripted OpenAI-compatible chat server for tests that run composer in worker processes."""

import asyncio
import copy
import itertools
import json
import re
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

LLM_CONFIG: dict[str, Any] = {"provider": "vllm", "model": "stub"}
# The OpenAI SDK retries 5xx replies (composer sets max_retries=6); this header turns that off.
NO_RETRY = {"x-should-retry": "false"}
_PIECES = re.compile(r"\S+\s*|\s+")


def _sse(obj: Any) -> str:
    return f"data: {json.dumps(obj)}\n\n"


class FakeLLM:
    """A chat-completions server on ``127.0.0.1:<free port>`` that answers from a script.

    Each scripted reply is a dict with any of: ``content`` (str), ``tool_calls`` (a list
    of ``{"name", "arguments", "id"?}``), ``usage`` (``prompt_tokens``/``completion_tokens``),
    ``match`` (a substring the request's messages must contain), ``error`` (an HTTP
    status to return instead), and ``hold`` (``True`` to wait until ``release()``, or at
    most that many seconds).
    A request takes the first queued reply it matches; an unmatched request gets a
    ``500`` carrying the request. Error replies are never retried by the SDK.

    Use it as a context manager. Tests script it in-process, or over HTTP with
    ``POST /_script``, ``GET /_requests``, and ``POST /_release``.
    """

    def __init__(self) -> None:
        self.base_url = ""
        self._lock = threading.Lock()
        self._script: list[dict[str, Any]] = []
        self._requests: list[dict[str, Any]] = []
        self._authorizations: list[str | None] = []
        self._holds: list[threading.Event] = []
        self._ids = itertools.count(1)
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> "FakeLLM":
        config = uvicorn.Config(self._app(), host="127.0.0.1", port=0, log_level="warning",
                                lifespan="off", timeout_graceful_shutdown=1)
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="fake-llm", daemon=True)
        self._thread.start()
        deadline = time.monotonic() + 10
        while not self._server.started:
            if not self._thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("the fake LLM server did not start")
            time.sleep(0.01)
        port = self._server.servers[0].sockets[0].getsockname()[1]
        self.base_url = f"http://127.0.0.1:{port}"
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()
        assert self._server is not None and self._thread is not None
        self._server.should_exit = True
        self._thread.join(10)

    def env(self) -> dict[str, str]:
        """The environment that points composer's ``vllm`` provider at this server."""
        return {"VLLM_BASE_URL": f"{self.base_url}/v1"}

    def script(self, *replies: dict[str, Any]) -> None:
        """Queue replies, in order."""
        with self._lock:
            self._script.extend(dict(r) for r in replies)

    def requests(self) -> list[dict[str, Any]]:
        """Every chat request body received so far, one per HTTP request."""
        with self._lock:
            return copy.deepcopy(self._requests)

    def authorizations(self) -> list[str | None]:
        """The ``Authorization`` header of each chat request, in order; None where there was none."""
        with self._lock:
            return list(self._authorizations)

    def pending(self) -> list[dict[str, Any]]:
        """The replies still queued."""
        with self._lock:
            return copy.deepcopy(self._script)

    def release(self) -> None:
        """Let every held reply go."""
        with self._lock:
            holds, self._holds = self._holds, []
        for event in holds:
            event.set()

    def wait_for_requests(self, count: int, timeout: float = 10) -> list[dict[str, Any]]:
        """Block until ``count`` requests have arrived; return them."""
        deadline = time.monotonic() + timeout
        while len(seen := self.requests()) < count:
            if time.monotonic() > deadline:
                raise TimeoutError(f"{len(seen)} of {count} requests arrived")
            time.sleep(0.01)
        return seen

    def _app(self) -> Starlette:
        return Starlette(routes=[
            Route("/v1/chat/completions", self._completions, methods=["POST"]),
            Route("/_script", self._script_route, methods=["POST"]),
            Route("/_requests", self._requests_route, methods=["GET"]),
            Route("/_release", self._release_route, methods=["POST"]),
        ])

    async def _script_route(self, request: Request) -> Response:
        self.script(*(await request.json())["replies"])
        return JSONResponse({"queued": len(self.pending())})

    async def _requests_route(self, request: Request) -> Response:
        return JSONResponse(self.requests())

    async def _release_route(self, request: Request) -> Response:
        self.release()
        return JSONResponse({})

    def _take(self, body: dict[str, Any]) -> dict[str, Any] | None:
        text = json.dumps(body.get("messages", []), ensure_ascii=False)
        for i, reply in enumerate(self._script):
            if "match" not in reply or reply["match"] in text:
                return self._script.pop(i)
        return None

    async def _completions(self, request: Request) -> Response:
        body = await request.json()
        with self._lock:
            self._requests.append(body)
            self._authorizations.append(request.headers.get("authorization"))
            reply = self._take(body)
        if reply is None:
            return JSONResponse({"error": {"message": "no scripted reply matches this request",
                                           "type": "server_error", "request": body}},
                                status_code=500, headers=NO_RETRY)
        if reply.get("hold"):
            event = threading.Event()
            with self._lock:
                self._holds.append(event)
            timeout = None if reply["hold"] is True else float(reply["hold"])
            await asyncio.to_thread(event.wait, timeout)
        if reply.get("error"):
            return JSONResponse({"error": {"message": f"scripted error {reply['error']}", "type": "server_error"}},
                                status_code=int(reply["error"]), headers=NO_RETRY)
        calls = [self._tool_call(c) for c in reply.get("tool_calls", [])]
        if body.get("stream"):
            usage = bool((body.get("stream_options") or {}).get("include_usage"))
            return StreamingResponse(self._stream(reply, body, calls, usage), media_type="text/event-stream")
        message: dict[str, Any] = {"role": "assistant", "content": reply.get("content") or (None if calls else "")}
        if calls:
            message["tool_calls"] = calls
        return JSONResponse({
            "id": "chatcmpl-fake", "object": "chat.completion", "created": int(time.time()),
            "model": body.get("model", "stub"),
            "choices": [{"index": 0, "message": message, "logprobs": None,
                         "finish_reason": "tool_calls" if calls else "stop"}],
            "usage": self._usage(reply),
        })

    def _tool_call(self, call: dict[str, Any]) -> dict[str, Any]:
        args = call.get("arguments", {})
        return {"id": call.get("id") or f"call_{next(self._ids)}", "type": "function",
                "function": {"name": call["name"], "arguments": args if isinstance(args, str) else json.dumps(args)}}

    @staticmethod
    def _usage(reply: dict[str, Any]) -> dict[str, int]:
        usage = reply.get("usage") or {}
        prompt, completion = usage.get("prompt_tokens", 10), usage.get("completion_tokens", 5)
        return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}

    async def _stream(self, reply: dict[str, Any], body: dict[str, Any], calls: list[dict[str, Any]],
                      usage: bool) -> AsyncIterator[str]:
        head = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": int(time.time()),
                "model": body.get("model", "stub")}

        def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
            return head | {"choices": [{"index": 0, "delta": delta, "finish_reason": finish, "logprobs": None}]}

        yield _sse(chunk({"role": "assistant", "content": ""}))
        for piece in _PIECES.findall(reply.get("content", "")):
            yield _sse(chunk({"content": piece}))
        for i, call in enumerate(calls):
            yield _sse(chunk({"tool_calls": [{"index": i, **call}]}))
        yield _sse(chunk({}, "tool_calls" if calls else "stop"))
        if usage:
            yield _sse(head | {"choices": [], "usage": self._usage(reply)})
        yield "data: [DONE]\n\n"
