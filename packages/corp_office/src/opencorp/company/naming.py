"""Naming rules: person handles, and the names the model sees for asset tools."""

import re
from typing import Annotated

from pydantic import TypeAdapter, ValidationError

from opencorp.protocol.models import HireRequest


_HANDLE = TypeAdapter(Annotated[str, *HireRequest.model_fields["handle"].metadata])


def handle_problem(handle: str) -> str | None:
    """Why ``handle`` can't be a person's handle, or None if it can."""
    try:
        _HANDLE.validate_python(handle)
    except ValidationError as exc:
        return exc.errors(include_url=False)[0]["msg"]
    return None


TOOL_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def asset_tool_name(asset_id: str, tool: str) -> str:
    """Return the model-visible name of ``tool`` on ``asset_id``: ``cluster-a`` + ``submit_job`` → ``cluster_a__submit_job``.

    Ids have no ``_`` (protocol ``Id``), so the mapping is one-to-one and the first ``__``
    always ends the asset part.
    """
    return f"{asset_id.replace('-', '_')}__{tool}"
