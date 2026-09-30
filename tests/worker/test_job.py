import pytest
from langchain_core.tools import StructuredTool
from pydantic import ValidationError

from agent_corp.tools.workspace import workspace_tool_functions
from agent_corp.worker.job import (
    Job,
    ProfileMemorySpec,
    SessionMemorySpec,
    group_specs,
    person_flow,
    tool_spec,
)

BASE = {"kind": "chat", "session_id": "s1", "run_id": "r1", "person_id": "minh", "pin": "/pins/abc",
        "flow": "people/minh/../../shared/flows/chat.yaml", "log": "/runs/r1.jsonl"}


def test_a_job_round_trips_through_json():
    job = Job(**BASE, memory={"profile": {"kind": "profile", "store": "profile"}, "session": {"kind": "session", "storage": "/s.db"}},
              groups={"workspace": [{"name": "shell"}]}, env={"VLLM_BASE_URL": "http://x/v1"})
    assert isinstance(job.memory["profile"], ProfileMemorySpec)
    assert isinstance(job.memory["session"], SessionMemorySpec)
    assert job.inputs == {} and job.skills == [] and job.feedback is None and job.num_workers == 8
    assert Job.model_validate(job.model_dump(mode="json")) == job


@pytest.mark.parametrize("change", [{"pin": "pins/abc"}, {"log": "r1.jsonl"}, {"flow": "/etc/flow.yaml"},
                                    {"groups": {"ask_user": []}}, {"extra": 1}, {"kind": "debrief"}])
def test_bad_jobs_are_refused(change):
    with pytest.raises(ValidationError):
        Job(**(BASE | change))


def test_person_flow_is_relative_to_the_person_directory():
    assert person_flow("minh", "../../shared/flows/chat.yaml") == "people/minh/../../shared/flows/chat.yaml"


def test_tool_spec_of_a_function():
    def read_file(path: str, offset: int = 0, limit: int | None = None) -> str:
        """Read a file.

        `offset` is 0-based.
        """
        return ""

    spec = tool_spec("read_file", read_file)
    assert spec.name == "read_file"
    assert spec.description == "Read a file.\n\n`offset` is 0-based."
    params = spec.parameters
    assert params["required"] == ["path"]
    assert params["properties"]["offset"]["default"] == 0
    assert {"type": "null"} in params["properties"]["limit"]["anyOf"]


def test_tool_spec_of_a_base_tool_uses_the_given_name():
    tool = StructuredTool.from_function(lambda text: text, name="shout", description="Shout it.")
    spec = tool_spec("yell", tool)
    assert (spec.name, spec.description, spec.parameters["required"]) == ("yell", "Shout it.", ["text"])


def test_group_specs_names_tools_by_their_keys():
    groups = group_specs({"workspace": workspace_tool_functions(lambda name, args: "")})
    assert [s.name for s in groups["workspace"]] == ["read_file", "write_file", "edit_file", "list", "search", "shell"]
