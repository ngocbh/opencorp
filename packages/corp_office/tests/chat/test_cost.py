import pytest

from agent_corp.chat.cost import DEFAULT_PRICE, ZERO_PRICE, call_usd, cost_cap
from agent_corp.chat.provider import Price
from agent_corp.protocol.models import CompanyDefaults
from tests.store.conftest import session


def test_a_listed_model_uses_its_price():
    usage = {"input_tokens": 1_000_000, "output_tokens": 2_000_000, "total_tokens": 3_000_000}
    assert call_usd({"m": Price(input=3, output=15)}, "m", usage) == pytest.approx(33.0)


def test_an_unlisted_or_missing_model_uses_the_default_price():
    usage = {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13}
    expected = (10 * DEFAULT_PRICE.input + 3 * DEFAULT_PRICE.output) / 1_000_000
    assert call_usd({}, "stub", usage) == pytest.approx(expected)
    assert call_usd({}, None, usage) == pytest.approx(expected)


def test_a_zero_default_prices_an_unpriced_model_at_nothing_and_a_priced_one_at_its_price():
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "total_tokens": 2_000_000}
    assert call_usd({}, "gpt-5.5", usage, default=ZERO_PRICE) == 0
    assert call_usd({"gpt-5.5": Price(input=1, output=2)}, "gpt-5.5", usage, default=ZERO_PRICE) == pytest.approx(3.0)


def test_the_cap_is_the_sessions_own_else_the_company_default():
    defaults = CompanyDefaults(cost_cap_usd=5)
    assert cost_cap(session(), defaults) == 5
    assert cost_cap(session(cost_cap_usd=0.5), defaults) == 0.5
    assert cost_cap(session(cost_cap_usd=0), defaults) == 0
