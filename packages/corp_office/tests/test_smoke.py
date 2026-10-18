"""The office package imports next to yian."""

import yian
import opencorp


def test_office_and_composer_import():
    assert opencorp.__version__ == "0.0.1"
    assert hasattr(yian, "run_flow")
