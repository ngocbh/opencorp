"""Which node of a conversation flow is the turn."""

import re
from dataclasses import dataclass

_OCCURRENCE = re.compile(r"#\d+$")


def turn_path(node_id: str) -> str:
    """``node_id`` without the ``#<n>`` LOOP/MAP occurrence suffix of each segment (``chat#3/ask`` → ``chat/ask``)."""
    return "/".join(_OCCURRENCE.sub("", segment) for segment in node_id.split("/"))


@dataclass(frozen=True)
class ChatFlow:
    """A conversation flow's shape: its turn node, its steerable reply node, and its exit command."""

    turn: str = "chat/ask"
    reply: str = "chat/reply"
    exit: str = "/exit"

    def is_turn(self, node_id: str | None) -> bool:
        """True for an occurrence of the turn node."""
        return node_id is not None and turn_path(node_id) == self.turn

    def is_reply(self, node_id: str | None) -> bool:
        """True for an occurrence of the reply node."""
        return node_id is not None and turn_path(node_id) == self.reply

    def reply_after(self, turn_node_id: str) -> str | None:
        """The reply node id that follows this occurrence of the turn, when both share a parent."""
        parent, _, _ = self.turn.rpartition("/")
        reply_parent, _, reply = self.reply.rpartition("/")
        if parent != reply_parent:
            return None
        prefix, _, _ = turn_node_id.rpartition("/")
        return f"{prefix}/{reply}" if prefix else reply


MAIN_CHAT = ChatFlow()
"""The shape of ``shared/flows/chat.yaml``; a person's own main flow must keep these node names."""

