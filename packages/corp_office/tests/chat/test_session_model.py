"""The connection and model a new chat starts on: the request's pick, the person's model, else the default."""

import time

from agent_corp.chat.connections import read_run_record
from agent_corp.chat.models import TIMED_OUT, Listing, own_models
from agent_corp.company.loader import load_repo
from agent_corp.protocol.models import ModelOption
from agent_corp.secrets import write_private
from tests.chat.conftest import say, status, wait_for
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
    def slow(conn, name, *, deadline):
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
