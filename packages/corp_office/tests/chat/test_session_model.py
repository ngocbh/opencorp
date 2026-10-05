"""The connection and model a chat runs on: at the start the request's pick, the person's model, else the default;
then whatever the chat is switched to."""

import json
import os
import signal
import time

import pytest
from agent_composer.llm_clients.auth import AuthStore, OAuthCredentials

from agent_corp.chat.connections import AUTH_FILE_ENV, ConnectionFile, read_run_record
from agent_corp.chat.cost import ZERO_PRICE
from agent_corp.chat.harness import HarnessError, _refused_key
from agent_corp.chat.models import TIMED_OUT, Listing, own_models
from agent_corp.company.loader import load_repo
from agent_corp.chat.provider import Price
from agent_corp.protocol.models import ModelOption
from agent_corp.secrets import write_private
from tests.chat.conftest import errors, say, spawned, status, texts, wait_for
from tests.company.conftest import person


def wants(model):
    """Company files in which minh's person.yaml asks for ``model``."""
    return {"people/minh/person.yaml": person("minh", model=model)}


def start(harness, workspace, **pick):
    session = harness.start_session("minh", str(workspace), **pick)
    wait_for(lambda: status(harness, session.id) == "idle", what="the first turn")
    return session


def minh(harness):
    """minh as the harness's company has him now."""
    return load_repo(harness.git.pin(harness.git.head())).people["minh"]


def chose(session):
    return session.connection, session.model, session.model_note


def record_of(harness, sid):
    run_id = harness.store.get_session(sid).run_ids[-1]
    return read_run_record(harness.office.paths.run_dir(sid) / "runs" / f"{run_id}.model.json")


def test_a_new_chat_records_the_default_connection_and_its_own_model(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("office", None, None)


def test_the_requested_pick_wins(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"}, files=wants("stub"))
    fake_llm.script({"content": "on two"})
    s = start(h, workspace, connection="second")
    assert chose(s) == ("second", None, None)
    assert say(h, s.id, "hi") == "on two"
    assert fake_llm.requests()[-1]["model"] == "stub-2"


def test_a_requested_model_alone_is_on_the_default(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    h.connections.set_default("second")
    fake_llm.script({"content": "on five"})
    s = start(h, workspace, model="stub-5")
    assert chose(s) == ("second", "stub-5", None)
    say(h, s.id, "hi")
    assert fake_llm.requests()[-1]["model"] == "stub-5"


def test_a_pick_equal_to_the_connections_own_model_is_stored_as_null(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace), connection="second", model="stub-2")
    assert chose(s) == ("second", None, None)


def test_an_unknown_requested_connection_falls_through_with_a_note(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace), connection="gone", model="stub-2")
    assert chose(s) == ("office", None, "Your last pick 'gone' isn't on this office; this chat uses office/stub.")


def test_an_unknown_pick_falls_through_to_the_persons_model(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"}, files=wants("stub-2"))
    s = h.start_session("minh", str(workspace), connection="gone")
    assert chose(s) == ("second", None, "Your last pick 'gone' isn't on this office; this chat uses second/stub-2.")


def test_person_model_resolves_to_a_connection_that_lists_it(make_harness, workspace, fake_llm):
    # A fresh office: nothing is listed yet, so second is listed now.
    h = make_harness(connections={"second": "stub-3"}, listings={"second": ["stub-2", "stub-3"]},
                     files=wants("stub-2"))
    fake_llm.script({"content": "on two"})
    s = start(h, workspace)
    assert chose(s) == ("second", "stub-2", None)
    say(h, s.id, "hi")
    assert fake_llm.requests()[-1]["model"] == "stub-2"


def test_the_default_connection_wins_when_two_offer_it(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2", "third": "stub-3"},
                     listings={"second": ["stub-7"], "third": ["stub-7"]}, files=wants("stub-7"))
    h.connections.set_default("third")
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("third", "stub-7", None)


def test_after_the_default_the_others_are_tried_by_name(make_harness, workspace):
    h = make_harness(connections={"zed": "stub-2", "abe": "stub-3"},
                     listings={"zed": ["stub-7"], "abe": ["stub-7"]}, files=wants("stub-7"))
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("abe", "stub-7", None)


def test_after_a_default_other_than_office_the_others_are_tried_by_name(make_harness, workspace):
    h = make_harness(connections={"zed": "stub-2", "abe": "stub-3"},
                     listings={"office": ["stub-7"], "abe": ["stub-7"], "zed": []}, files=wants("stub-7"))
    h.connections.set_default("zed")
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("abe", "stub-7", None)


def test_a_pick_that_cant_be_used_falls_through_with_a_note(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2", "third": "stub-3"}, files=wants("stub-3"))
    write_private(h.connections.dir / "second.json", b"{not json")
    s = h.start_session("minh", str(workspace), connection="second", model="stub-5")
    assert chose(s) == ("third", None, "Your last pick 'second' can't be used on this office; "
                                       "this chat uses third/stub-3.")


def test_a_default_that_cant_be_read_still_takes_the_pick_and_the_persons_model(make_harness, workspace, caplog):
    h = make_harness(connections={"second": "stub-2"}, files=wants("stub-2"))
    write_private(h.connections.dir / "_default.json", b"[]")
    assert h._choose(minh(h), "second", "stub-5") == ("second", "stub-5", None)
    assert h._choose(minh(h), None, None) == ("second", None, None)
    assert "default connection can't be read" in caplog.text
    assert str(h.connections.dir) not in caplog.text


def test_a_chat_on_the_office_because_the_default_cant_be_read_says_so(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    write_private(h.connections.dir / "_default.json", b"[]")
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("office", None, "The office's default connection can't be read; this chat uses office/stub.")
    assert h._choose(minh(h), "office", None) == ("office", None, None)  # picked, not fallen back on
    assert h._choose(minh(h), None, "stub-5") == (
        "office", "stub-5", "The office's default connection can't be read; this chat uses office/stub-5.")


def test_a_connection_that_cant_be_read_offers_nothing(make_harness, workspace):
    h = make_harness(connections={"zed": "stub-2"}, listings={"zed": ["stub-7"]}, files=wants("stub-7"))
    write_private(h.connections.dir / "bad.json", b"{not json")
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("zed", "stub-7", None)


def test_an_unresolved_person_model_falls_back_with_a_note(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"}, files=wants("stub-9"))
    s = h.start_session("minh", str(workspace))
    assert chose(s) == ("office", None, "@minh asks for stub-9, which no connection on this office offers; "
                                        "this chat uses office/stub.")


def test_the_note_names_a_default_with_no_configured_model_by_its_name(make_harness):
    h = make_harness(files=wants("stub-9"), llm_config={"provider": "vllm"})
    # A run without a model can't start; only the choice matters here.
    assert h._choose(minh(h), None, None) == (
        "office", None, "@minh asks for stub-9, which no connection on this office offers; this chat uses office.")


def test_resolution_has_one_deadline_and_falls_back_with_a_note(make_harness):
    def slow(conn, name, *, deadline, auth_file):
        # Each listing alone fits the deadline; the two together don't.
        time.sleep(min(0.6, deadline))
        if deadline < 0.6:
            return own_models(conn, name, TIMED_OUT)
        return Listing(connection=name, models=[ModelOption(id="stub-8")], listed=True)

    h = make_harness(connections={"second": "stub-2"}, models=slow, choose_deadline=1.0, files=wants("stub-9"))
    began = time.monotonic()
    choice = h._choose(minh(h), None, None)
    assert time.monotonic() - began < 3.0
    assert choice == ("office", None, "Couldn't check in time which connection offers stub-9; "
                                      "this chat uses office/stub.")


def test_changing_the_default_never_moves_an_existing_chat(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "still one"})
    s = start(h, workspace)
    h.connections.set_default("second")
    assert say(h, s.id, "hi") == "still one"
    assert fake_llm.requests()[-1]["model"] == "stub"
    assert chose(h.store.get_session(s.id)) == ("office", None, None)
    assert len(h.store.get_session(s.id).run_ids) == 1


def test_a_new_chat_on_a_second_connection_records_it(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = start(h, workspace, connection="second", model="stub-5")
    record = record_of(h, s.id)
    assert (record.connection, record.model) == ("second", "stub-5")


FRESH = ("This chat continues on a fresh run because its model or connection changed. "
         "If your last message got no reply, send it again.")


def user_texts(request):
    """The text of each user message in a model request, in order."""
    return [m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])
            for m in request["messages"] if m["role"] == "user"]


def test_set_model_takes_effect_on_the_next_turn_with_a_fresh_run(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "on one"}, {"content": "on five"})
    s = start(h, workspace)
    say(h, s.id, "first-turn-text")
    switched = h.set_model(s.id, "second", "stub-5")
    assert chose(switched) == ("second", "stub-5", None)
    assert len(h.store.get_session(s.id).run_ids) == 1  # nothing restarts before the next turn
    assert say(h, s.id, "b") == "on five"
    assert fake_llm.requests()[-1]["model"] == "stub-5"
    assert len(h.store.get_session(s.id).run_ids) == 2
    assert (record_of(h, s.id).connection, record_of(h, s.id).model) == ("second", "stub-5")
    assert "first-turn-text" in json.dumps(fake_llm.requests()[-1]["messages"])  # session memory carried it over


def test_a_switch_during_a_reply_lets_it_finish_on_the_old_model(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "Done on one.", "hold": 30}, {"content": "on two"})
    s = start(h, workspace)
    h.prompt(s.id, "a")
    fake_llm.wait_for_requests(1)
    h.set_model(s.id, "second", "stub-2")
    fake_llm.release()
    wait_for(lambda: texts(h, s.id)[-1:] == ["Done on one."] and status(h, s.id) == "idle", what="the reply")
    assert [r["model"] for r in fake_llm.requests()] == ["stub"]
    assert len(h.store.get_session(s.id).run_ids) == 1
    assert say(h, s.id, "b") == "on two"
    assert fake_llm.requests()[-1]["model"] == "stub-2"


def test_a_queued_message_after_a_switch_reaches_the_new_model_once(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "held", "hold": 30}, {"content": "on two"})
    s = start(h, workspace)
    statuses = []
    h.store.add_listener(lambda e: statuses.append(e.data["status"])
                         if e.type == "session.updated" and e.data["id"] == s.id else None)
    h.prompt(s.id, "a")
    fake_llm.wait_for_requests(1)
    h._live[s.id].worker.steer = lambda node, text: False  # the reply can't take it: it waits for the next turn
    assert h.prompt(s.id, "queued-1") == "queued"
    h.set_model(s.id, "second", "stub-2")
    fake_llm.release()
    wait_for(lambda: texts(h, s.id)[-1:] == ["on two"] and status(h, s.id) == "idle", what="the queued reply")
    requests = fake_llm.requests()
    assert requests[-1]["model"] == "stub-2"
    assert [r for r in requests if "queued-1" in json.dumps(r["messages"])] == [requests[-1]]
    assert user_texts(requests[-1])[-1] == "queued-1"
    assert not {"ending", "ended"} & set(statuses)
    assert len(h.store.get_session(s.id).run_ids) == 2


def test_set_model_refuses_ended_sessions_and_unknown_connections(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    s = start(h, workspace)
    with pytest.raises(HarnessError) as err:
        h.set_model(s.id, "gone", "stub-2")
    assert (err.value.status, err.value.code) == (422, "unknown_connection")
    with pytest.raises(HarnessError) as err:
        h.set_model("01J0000000000000000000000Z", "second", "stub-2")
    assert (err.value.status, err.value.code) == (404, "not_found")
    h.end(s.id)
    wait_for(lambda: status(h, s.id) == "ended", what="the end")
    with pytest.raises(HarnessError) as err:
        h.set_model(s.id, "second", "stub-2")
    assert (err.value.status, err.value.code) == (409, "not_live")
    assert chose(h.store.get_session(s.id)) == ("office", None, None)


def test_set_model_refuses_a_session_that_is_ending(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"content": "never", "hold": 30})
    s = start(h, workspace)
    h.prompt(s.id, "hi")
    fake_llm.wait_for_requests(1)
    h.end(s.id)
    assert status(h, s.id) == "ending"
    with pytest.raises(HarnessError) as err:
        h.set_model(s.id, "second", "stub-2")
    assert (err.value.status, err.value.code) == (409, "ending")
    fake_llm.release()
    wait_for(lambda: status(h, s.id) == "ended", what="the end")


def test_set_model_refuses_a_connection_that_cant_be_read_without_naming_its_file(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace))
    write_private(h.connections.dir / "second.json", b"{not json")
    with pytest.raises(HarnessError) as err:
        h.set_model(s.id, "second", "stub-5")
    assert (err.value.status, err.value.code) == (409, "connection_unusable")
    assert "second" in err.value.message and str(h.connections.dir) not in err.value.message
    assert chose(h.store.get_session(s.id)) == ("office", None, None)


def test_set_model_clears_the_note(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace), connection="gone")
    assert s.model_note
    seen = []
    h.store.add_listener(lambda e: seen.append(e.data) if e.type == "session.updated" else None)
    assert chose(h.set_model(s.id, "second", "stub-5")) == ("second", "stub-5", None)
    assert (seen[-1]["connection"], seen[-1]["model"], seen[-1]["model_note"]) == ("second", "stub-5", None)


def test_set_model_to_the_connections_own_model_stores_null(make_harness, workspace):
    h = make_harness(connections={"second": "stub-2"})
    s = h.start_session("minh", str(workspace))
    assert chose(h.set_model(s.id, "second", "stub-2")) == ("second", None, None)
    assert chose(h.set_model(s.id, "office", "stub")) == ("office", None, None)
    assert chose(h.set_model(s.id, "office", "stub-2")) == ("office", "stub-2", None)


def test_restore_after_a_switch_starts_a_fresh_run(make_harness, workspace, fake_llm):
    fake_llm.script({"content": "on two"})
    first = make_harness(connections={"second": "stub-2"})
    s = start(first, workspace)
    old = first.store.get_session(s.id).run_ids
    first.set_model(s.id, "second", "stub-2")
    first._stopping = True  # the office died: nothing of it acts on its worker again

    second = make_harness()
    second.restore()
    wait_for(lambda: s.id in second._live and second._live[s.id].worker and second._live[s.id].turn_q,
             what="the restored turn")
    session = second.store.get_session(s.id)
    assert len(session.run_ids) == 2 and session.run_ids[-1] not in old
    assert record_of(second, s.id).connection == "second"
    assert session.model_note == FRESH
    assert say(second, s.id, "b") == "on two"
    assert fake_llm.requests()[-1]["model"] == "stub-2"


def test_a_refused_key_says_which_connection_to_check(make_harness, workspace, fake_llm):
    h = make_harness(connections={"second": "stub-2"})
    fake_llm.script({"error": 401}, {"error": 500})
    s = start(h, workspace, connection="second")
    h.prompt(s.id, "hi")
    wait_for(lambda: len(h.store.get_session(s.id).run_ids) == 2 and status(h, s.id) == "idle", what="the new run")
    (error,) = errors(h, s.id)
    assert error.endswith("Send your message again. Check connection 'second', or pick another model with /model.")
    h.prompt(s.id, "again")
    wait_for(lambda: len(errors(h, s.id)) == 2, what="the second failure")
    assert "/model" not in errors(h, s.id)[1]  # a failure that isn't the key says nothing of it


def test_a_refused_key_is_told_by_its_cause_or_status_not_any_401():
    assert _refused_key({"cause_type": "OpenAIAuthenticationError"}, "")
    assert _refused_key({"cause_type": "PermissionDeniedError"}, "")
    assert _refused_key({"cause_type": "APIStatusError"}, "APIStatusError: Error code: 401 - unauthorized")
    assert not _refused_key({"cause_type": "BadRequestError"}, "BadRequestError: your messages resulted in 140100 tokens")
    assert not _refused_key({}, "no reason given")


# Subscriptions.

ACCESS = "fake-access-7d2c91e0"
REFRESH = "fake-refresh-4a6b03f8"

NO_NETWORK = {"HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9"}
"""A subscription runs against chatgpt.com; should a test's worker ever call it, the call goes nowhere."""


def subscribe(harness, name="chatgpt", prices=None):
    """Add subscription ``name`` on model ``gpt-sub``, signed in with fake tokens good for a year; its auth file."""
    creds = OAuthCredentials(ACCESS, REFRESH, time.time() + 365 * 86400, "account-test")
    harness.connections.add(name, ConnectionFile(method="subscription", llm_config={"provider": "openai",
                                                                                     "model": "gpt-sub"},
                                                 env=NO_NETWORK, prices=prices or {}),
                            sign_in=lambda path: AuthStore(path).save("openai", creds, "gpt-sub"))
    return harness.connections.auth_file(name)


def test_a_subscription_chat_runs_on_its_own_sign_in_without_a_key(make_harness, workspace, fake_llm):
    h = make_harness()
    auth = subscribe(h)
    jobs = spawned(h)
    s = start(h, workspace, connection="chatgpt")
    [job] = jobs
    assert job.env[AUTH_FILE_ENV] == str(auth)
    assert job.llm_config == {"provider": "openai", "model": "gpt-sub"}
    assert ACCESS not in json.dumps(job.env) and REFRESH not in json.dumps(job.env)
    assert chose(h.store.get_session(s.id)) == ("chatgpt", None, None)
    assert fake_llm.requests() == []


@pytest.mark.parametrize(("prices", "usd"), [(None, 0), ({"gpt-sub": Price(input=1, output=2)}, 3.0)])
def test_a_subscriptions_usage_is_free_unless_its_file_prices_it(make_harness, workspace, prices, usd):
    h = make_harness()
    subscribe(h, prices=prices)
    s = start(h, workspace, connection="chatgpt")
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "total_tokens": 2_000_000}
    h._charge(h._live[s.id], {"model": "gpt-sub", "usage": usage})
    assert h.store.get_session(s.id).cost == pytest.approx(usd)
    assert [(u.input_tokens, u.usd) for u in h.store.list_usage(s.id)] == [(1_000_000, pytest.approx(usd))]


def test_a_subscription_run_is_recorded_on_it_and_resumed_and_learned_from_on_the_same_sign_in(make_harness,
                                                                                               workspace):
    h = make_harness()
    auth = subscribe(h)
    jobs = spawned(h, lambda job: (job.kind, job.env.get(AUTH_FILE_ENV)))
    s = start(h, workspace, connection="chatgpt")
    record = record_of(h, s.id)
    assert (record.connection, record.model) == ("chatgpt", None)
    run_log = h.office.paths.run_dir(s.id) / "runs" / f"{h.store.get_session(s.id).run_ids[-1]}.jsonl"
    assert h.connections.for_run(record, run_log, exact=False).env[AUTH_FILE_ENV] == str(auth)  # backward
    old = h._live[s.id].worker
    os.killpg(old.pgid, signal.SIGKILL)
    wait_for(lambda: h._live[s.id].worker not in (None, old) and h._live[s.id].turn_q, what="the resume")
    assert jobs == [("chat", str(auth)), ("resume", str(auth))]
    assert h._live[s.id].default_price == ZERO_PRICE
