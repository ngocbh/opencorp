"""A composer ``MarkdownStore`` served by the office over the worker channel."""

from typing import Any

from yian.memory.storage.markdown import MarkdownVersionMismatch

from agent_corp.worker.channel import jsonable
from agent_corp.worker.rpc import RemoteError, Rpc


class RemoteMarkdownStore:
    """``read``/``write`` on the office store named ``store``, one request frame per call.

    Error replies are raised as the local store would raise them:
    ``MarkdownVersionMismatch`` for ``mismatch``, ``LookupError`` for ``unknown_version``,
    ``ValueError`` for ``invalid``, and ``OSError`` for anything else.
    """

    def __init__(self, rpc: Rpc, store: str) -> None:
        self.rpc = rpc
        self.store = store

    def read(self, version: str | None = None) -> tuple[str, str]:
        """The document at ``version`` (latest when None) and its version."""
        reply = self._call("store_read", version=version)
        return reply["text"], reply["version"]

    def write(self, text: str, *, base_version: str, provenance: dict[str, Any] | None = None) -> str:
        """Replace the document if ``base_version`` is current; return the new version."""
        return self._call("store_write", text=text, base_version=base_version,
                          provenance=jsonable(provenance))["version"]

    def _call(self, type_: str, **fields: Any) -> dict[str, Any]:
        try:
            return self.rpc.request(type_, store=self.store, **fields)
        except RemoteError as exc:
            if exc.code == "mismatch":
                raise MarkdownVersionMismatch(exc.reply.get("expected"), exc.reply.get("current")) from None
            if exc.code == "unknown_version":
                raise LookupError(str(exc)) from None
            if exc.code == "invalid":
                raise ValueError(str(exc)) from None
            raise OSError(str(exc)) from None
