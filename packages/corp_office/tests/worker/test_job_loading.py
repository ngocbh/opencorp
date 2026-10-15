import json

from yian.memory.storage.markdown import FileMarkdownStore

from agent_corp.worker.job import ProfileMemorySpec, SessionMemorySpec, group_specs
from agent_corp.worker.main import pick_skills

from tests.worker.conftest import Recorder, run, write_files

SKILLS = {
    "people/minh/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Personal review.\n---\nMine.\n",
    "shared/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Shared review.\n---\nOurs.\n",
    "shared/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship it.\n---\nShip.\n",
}


CHILD = "id: echo\nname: echo\ninput:\n  text: !str\noutput: str\nkind: agent\nprompt: \"${text}\"\n"
ESCAPE = ("id: escape\nname: escape\nuses:\n  echo: ../../echo\nnodes:\n  reply:\n    kind: call\n    call: echo\n"
          "    input:\n      text: hi\noutput: ${reply.output}\n")


def shout(text: str) -> str:
    """Return text in capitals."""
    return text.upper()


def test_office_tool_groups_run_in_the_office(fake_llm, registry, make_job, session_dir):
    fake_llm.script({"content": "Working", "tool_calls": [{"name": "shout", "arguments": {"text": "hi"}}]},
                    {"content": "Done."})
    tools = {"toolbox": {"shout": shout}}
    rec = run(registry, make_job("flows/tools.yaml", groups=group_specs(tools)), Recorder(tools=tools), session_dir)
    assert rec.outcome["output"] == "Done."
    first, second = fake_llm.requests()
    assert [t["function"]["name"] for t in first["tools"]] == ["shout"]
    assert "HI" in json.dumps(second["messages"])
    tool_events = [f["data"] for f in rec.frames if f.get("name") == "ToolCallFinished"]
    assert [e["name"] for e in tool_events] == ["shout"]


def test_a_missing_group_fails_before_any_model_call(fake_llm, registry, make_job, session_dir):
    rec = run(registry, make_job("flows/tools.yaml"), Recorder(), session_dir)
    assert rec.returncode == 1
    assert rec.outcome["message"].startswith("ValueError: AGENT node 'reply' grants unknown tool or group 'toolbox'")
    assert fake_llm.requests() == []


def test_a_flow_reaching_outside_the_pin_is_refused(fake_llm, registry, make_job, pin, session_dir):
    (pin.parent / "echo.yaml").write_text(CHILD)
    write_files(pin, {"flows/escape.yaml": ESCAPE})
    rec = run(registry, make_job("flows/escape.yaml", inputs={}), Recorder(), session_dir)
    assert rec.returncode == 1 and rec.outcome["message"].startswith("FlowOutsideRepo")
    assert fake_llm.requests() == []


def test_pick_skills_filters_and_prefers_personal_skills(tmp_path):
    pin = write_files(tmp_path / "pin", SKILLS)
    picked = pick_skills(pin, "minh", ["code-review", "missing"])
    assert list(picked) == ["code-review"] and picked["code-review"].description == "Personal review."
    assert pick_skills(pin, "nobody", ["deploy"])["deploy"].description == "Ship it."


def test_only_listed_skills_reach_the_prompt(fake_llm, registry, make_job, pin, session_dir):
    write_files(pin, SKILLS)
    fake_llm.script({"content": "ok"})
    rec = run(registry, make_job("flows/skilled.yaml", skills=["code-review"]), Recorder(), session_dir)
    assert rec.outcome["status"] == "succeeded"
    prompt = json.dumps(fake_llm.requests()[0])
    assert "Personal review." in prompt and "Shared review." not in prompt and "Ship it." not in prompt


def test_profile_memory_reads_through_the_office(fake_llm, registry, make_job, tmp_path, session_dir):
    (tmp_path / "profile.md").write_text("# Minh\nPrefers terse answers.\n")
    fake_llm.script({"content": "ok"})
    job = make_job("flows/profiled.yaml", memory={"profile": ProfileMemorySpec(store="minh-profile")})
    handlers = Recorder(stores={"minh-profile": FileMarkdownStore(tmp_path / "profile.md")})
    assert run(registry, job, handlers, session_dir).outcome["status"] == "succeeded"
    assert "Prefers terse answers." in json.dumps(fake_llm.requests()[0]["messages"])


def test_session_memory_carries_history_between_runs(fake_llm, registry, make_job, tmp_path, session_dir):
    memory = {"session": SessionMemorySpec(storage=str(tmp_path / "session.sqlite"))}
    for n, message in enumerate(["remember the word teal", "which word?"]):
        fake_llm.script({"content": "ok"})
        job = make_job("flows/session.yaml", run_id=f"r{n}", inputs={"message": message}, memory=memory)
        assert run(registry, job, Recorder(), session_dir).outcome["status"] == "succeeded"
    assert "teal" in json.dumps(fake_llm.requests()[1]["messages"])


def test_a_planted_json_module_is_not_imported(fake_llm, registry, make_job, tmp_path, session_dir, monkeypatch):
    planted = "raise SystemExit('planted json imported')\n"
    write_files(session_dir, {"json.py": planted})
    write_files(tmp_path / "pp", {"json.py": planted})
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "pp"))
    fake_llm.script({"content": "ok"})
    rec = run(registry, make_job(), Recorder(), session_dir)
    assert rec.returncode == 0 and rec.outcome["output"] == "ok"
