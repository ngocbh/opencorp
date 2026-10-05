"""Session cost: model-call usage priced per model, and the session's cap."""

from collections.abc import Mapping
from typing import Any

from agent_corp.chat.provider import Price
from agent_corp.protocol.models import CompanyDefaults, Session

DEFAULT_PRICE = Price(input=15.0, output=75.0)
"""The price of a model the provider file doesn't list: high, so an unknown model hits its cap early."""

ZERO_PRICE = Price(input=0, output=0)
"""The price of a subscription's model the provider file doesn't list: the subscription already pays for it."""


def call_usd(prices: Mapping[str, Price], model: str | None, usage: Mapping[str, Any], *,
             default: Price = DEFAULT_PRICE) -> float:
    """The price of one model call's ``usage`` (a composer ``TokenUsage`` as a dict); ``default`` prices a model
    ``prices`` doesn't list."""
    price = prices.get(model or "", default)
    return (usage["input_tokens"] * price.input + usage["output_tokens"] * price.output) / 1_000_000


def cost_cap(session: Session, defaults: CompanyDefaults) -> float:
    """The session's cap in USD: its own, else the company default."""
    return defaults.cost_cap_usd if session.cost_cap_usd is None else session.cost_cap_usd
