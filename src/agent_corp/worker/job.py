"""The job the office hands a worker, and helpers that describe office-side tools."""

import inspect
from collections.abc import Callable, Mapping
from pathlib import PurePath
from typing import Annotated, Any, Literal

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, ConfigDict, Field, field_validator


class ToolSpec(BaseModel):
    """A tool the office serves over the channel, as the model sees it."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})


class ProfileMemorySpec(BaseModel):
    """A composer ``ProfileMemory`` over the office store named ``store``."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["profile"] = "profile"
    store: str
    max_chars: int = 32000
    llm_config: dict[str, Any] | None = None


class SessionMemorySpec(BaseModel):
    """A composer ``SessionMemory``; ``storage`` is its SQLite file, or None for in-memory."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["session"] = "session"
    storage: str | None = None
    history_budget_chars: int = 32000
    recent_turns: int = 4


MemorySpec = Annotated[ProfileMemorySpec | SessionMemorySpec, Field(discriminator="kind")]


class Job(BaseModel):
    """What one worker runs: a flow from a pinned company worktree, and how to run it.

    ``kind`` is ``chat`` (``run_flow``), ``resume`` (``resume_flow``), or ``backward``
    (``resume_flow`` then ``backward(feedback)``). ``flow`` is relative to ``pin``.
    ``env`` is applied to the worker's ``os.environ`` after it reads this job, so
    values such as provider keys never appear in the worker's exec environment.
    Validation errors leave out input values, so an error frame can't echo ``env``.
    """

    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)

    kind: Literal["chat", "resume", "backward"]
    session_id: str
    run_id: str
    person_id: str
    pin: str
    flow: str
    log: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    llm_config: dict[str, Any] | None = None
    learnable: bool = False
    skills: list[str] = Field(default_factory=list)
    feedback: Any = None
    num_workers: int = 8
    groups: dict[str, list[ToolSpec]] = Field(default_factory=dict)
    memory: dict[str, MemorySpec] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)

    @field_validator("pin", "log")
    @classmethod
    def _absolute(cls, value: str) -> str:
        if not PurePath(value).is_absolute():
            raise ValueError(f"must be an absolute path, got {value!r}")
        return value

    @field_validator("flow")
    @classmethod
    def _relative(cls, value: str) -> str:
        if PurePath(value).is_absolute():
            raise ValueError(f"must be relative to pin, got {value!r}")
        return value

    @field_validator("groups")
    @classmethod
    def _not_ask_user(cls, value: dict[str, list[ToolSpec]]) -> dict[str, list[ToolSpec]]:
        if "ask_user" in value:
            raise ValueError("'ask_user' is the worker's own tool, not a group")
        return value


def person_flow(person_id: str, main: str) -> str:
    """The pin-relative path of a person's main flow (``main`` is relative to the person directory)."""
    return f"people/{person_id}/{main}"


def tool_spec(name: str, tool: BaseTool | Callable[..., Any]) -> ToolSpec:
    """The spec a worker needs to offer ``tool`` under ``name``; a function's docstring is its description."""
    built = tool if isinstance(tool, BaseTool) else StructuredTool.from_function(tool, name=name)
    schema = built.tool_call_schema
    parameters = schema if isinstance(schema, dict) else schema.model_json_schema()
    return ToolSpec(name=name, description=inspect.cleandoc(built.description or ""), parameters=parameters)


def group_specs(groups: Mapping[str, Mapping[str, BaseTool | Callable[..., Any]]]) -> dict[str, list[ToolSpec]]:
    """``Job.groups`` for office tool groups given as ``{group: {tool name: tool}}``."""
    return {group: [tool_spec(name, tool) for name, tool in tools.items()] for group, tools in groups.items()}
