"""The office's in-process event bus."""

import asyncio


class Bus:
    """Fans office events out to subscribers on the office loop."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def attached(self) -> bool:
        """Whether the bus is bound to a loop."""
        return self._loop is not None

    def attach(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the bus to the office loop."""
        self._loop = loop

    def publish_meta(self, event) -> None:
        """Publish a stored metadata event."""

    def close(self) -> None:
        """End every subscription."""
