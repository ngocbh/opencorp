import pytest

from agent_corp.chat.turns import MAIN_CHAT, ChatFlow, seconds, turn_path


@pytest.mark.parametrize(("node_id", "path"), [
    ("chat#3/ask", "chat/ask"),
    ("chat#0/ask", "chat/ask"),
    ("chat#3/sub#1/ask", "chat/sub/ask"),
    ("chat#3/sub/ask", "chat/sub/ask"),
    ("ask", "ask"),
    ("chat~1", "chat~1"),
    ("a#b/ask", "a#b/ask"),
])
def test_turn_path_strips_each_occurrence_suffix(node_id, path):
    assert turn_path(node_id) == path


def test_the_main_chat_names_its_turn_and_reply():
    assert MAIN_CHAT.is_turn("chat#12/ask") and not MAIN_CHAT.is_turn("chat#12/sub/ask")
    assert not MAIN_CHAT.is_turn(None) and not MAIN_CHAT.is_turn("ask")
    assert MAIN_CHAT.is_reply("chat#0/reply") and not MAIN_CHAT.is_reply("chat#0/ask")
    assert ChatFlow(turn="talk/ask").is_turn("talk#2/ask")


@pytest.mark.parametrize(("text", "value"), [("1s", 1), ("90s", 90), ("15m", 900), ("2h", 7200), ("1d", 86400)])
def test_seconds(text, value):
    assert seconds(text) == value


@pytest.mark.parametrize("text", ["", "2", "h", "1.5h", "2w", " 2h"])
def test_seconds_refuses_other_text(text):
    with pytest.raises(ValueError, match="not a duration"):
        seconds(text)


def test_the_reply_after_a_turn_is_in_the_same_occurrence():
    assert MAIN_CHAT.reply_after("chat#3/ask") == "chat#3/reply"
    assert MAIN_CHAT.reply_after("chat#0/ask") == "chat#0/reply"
    assert ChatFlow(turn="talk/ask", reply="work/reply").reply_after("talk#1/ask") is None
