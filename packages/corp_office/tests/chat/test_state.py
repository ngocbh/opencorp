"""Session status writes that must not race the steps that finish a session."""

from opencorp.chat.state import guarded_update
from tests.store.conftest import session, store  # noqa: F401


def test_a_guarded_update_writes_only_from_the_given_statuses(store):  # noqa: F811
    s = store.create_session(session(status="idle"))
    assert guarded_update(store, s.id, ("idle",), status="busy").status == "busy"
    assert guarded_update(store, s.id, ("idle",), status="ending") is None
    assert store.get_session(s.id).status == "busy"
    assert guarded_update(store, "01K6A0000000000000000000ZZ", ("idle",), status="busy") is None
