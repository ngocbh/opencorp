"""Names the model sees for asset tools."""

import re

TOOL_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def asset_tool_name(asset_id: str, tool: str) -> str:
    """Return the model-visible name of ``tool`` on ``asset_id``: ``cluster-a`` + ``submit_job`` → ``cluster_a__submit_job``.

    Ids have no ``_`` (protocol ``Id``), so the mapping is one-to-one and the first ``__``
    always ends the asset part.
    """
    return f"{asset_id.replace('-', '_')}__{tool}"
