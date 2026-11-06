from typing import Any

import pytest
from fakes import TASK_LOGOUT, FakeSeti

from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

LOGOUT = f"/api/tasks/{TASK_LOGOUT}"
LEAD = "5e710000-0000-4000-8000-000000000002"
OWN = "4b2e8f6a-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
TEXT = "Lead: you delegate the logout work.\n- Hand implementation to background subagents."


@pytest.fixture(autouse=True)
def role_packs(fake_seti: FakeSeti) -> None:
    fake_seti.packs.extend(
        [
            {
                "id": LEAD,
                "name": "Lead",
                "description": "",
                "body": "Lead: delegate.",
                "kind": "role",
                "builtin": True,
            },
            {"id": OWN, "name": "Release owner", "description": "", "body": "Own it.", "kind": "role"},
        ]
    )


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


async def test_set_role_asks_first_then_links_the_role_pack(tools: EaTools, fake_seti: FakeSeti) -> None:
    asked, done = await confirm(tools, "set_agent_role", {"task": "logout", "role": "lead"})
    assert "Not done yet" in asked.text
    assert "gives Fix the logout button the role Lead from its next turn" in asked.text
    assert asked.summary == "Asked first: give Fix the logout button the role Lead"
    assert done.text == "Gave Fix the logout button the role Lead; it applies from its next turn."
    assert fake_seti.writes() == [("PUT", f"{LOGOUT}/role", {}, {"pack_id": LEAD})]


async def test_another_role_replaces_the_current_one(tools: EaTools, fake_seti: FakeSeti) -> None:
    await confirm(tools, "set_agent_role", {"task": "logout", "role": "Lead"})
    same = await tools.call("set_agent_role", {"task": "logout", "role": "Lead"})
    assert same.text == "Fix the logout button already has the role Lead."
    asked, _ = await confirm(tools, "set_agent_role", {"task": "logout", "role": "Release owner"})
    assert "the role Release owner in place of Lead" in asked.text
    roles = [p["name"] for p in fake_seti.task_packs[TASK_LOGOUT] if p["kind"] == "role"]
    assert roles == ["Release owner"]


async def test_set_role_with_confirmed_but_unasked_only_asks(tools: EaTools, fake_seti: FakeSeti) -> None:
    tools.user_turn()
    result = await tools.call("set_agent_role", {"task": "logout", "role": "Lead", "confirmed": True})
    assert result.text.startswith("You had not put this to the user yet.")
    assert fake_seti.writes() == []


async def test_creates_a_role_pack_from_text_after_a_yes(tools: EaTools, fake_seti: FakeSeti) -> None:
    asked, done = await confirm(tools, "set_agent_role", {"task": "logout", "text": TEXT})
    assert (
        "creates the role pack Fix the logout button role and gives it to Fix the logout button" in asked.text
    )
    assert done.text == (
        "Created the role Fix the logout button role and gave it to Fix the logout button; "
        "it applies from its next turn."
    )
    body = {"name": "Fix the logout button role", "description": "", "body": TEXT, "kind": "role"}
    assert fake_seti.writes() == [
        ("POST", "/api/context/packs", {}, body),
        ("PUT", f"{LOGOUT}/role", {}, {"pack_id": "new-pack"}),
    ]


async def test_a_taken_name_is_refused(tools: EaTools, fake_seti: FakeSeti) -> None:
    args = {"task": "logout", "text": TEXT, "name": "Release owner"}
    _, done = await confirm(tools, "set_agent_role", args)
    assert not done.ok
    assert done.text.startswith('Seti did not change the role: A context pack named "Release owner"')


async def test_clear_role_and_refuse_unclear_calls(tools: EaTools, fake_seti: FakeSeti) -> None:
    none = await tools.call("set_agent_role", {"task": "logout", "clear": True})
    assert none.text == "Fix the logout button has no role."
    await confirm(tools, "set_agent_role", {"task": "logout", "role": "Lead"})
    asked, done = await confirm(tools, "set_agent_role", {"task": "logout", "clear": True})
    assert "removes the role Lead from Fix the logout button from its next turn; the pack stays" in asked.text
    assert done.text == "Removed the role of Fix the logout button; it applies from its next turn."
    assert fake_seti.writes()[-1] == ("PUT", f"{LOGOUT}/role", {}, {"pack_id": None})
    both = await tools.call("set_agent_role", {"task": "logout", "role": "Lead", "text": TEXT})
    assert not both.ok
    assert both.text.startswith("Pass exactly one of role")
    missing = await tools.call("set_agent_role", {"task": "logout"})
    assert not missing.ok


async def test_unknown_role_lists_the_roles(tools: EaTools) -> None:
    result = await tools.call("set_agent_role", {"task": "logout", "role": "Triage sources"})
    assert not result.ok
    assert "The roles are Lead and Release owner." in result.text


async def test_role_packs_are_given_by_set_agent_role_only(tools: EaTools, fake_seti: FakeSeti) -> None:
    link = await tools.call("link_context_pack", {"task": "logout", "pack": "Lead"})
    assert not link.ok
    assert link.text.startswith("Lead is a role; give it with set_agent_role")
    default = await tools.call("update_context_pack", {"pack": "Release owner", "linked_by_default": True})
    assert not default.ok
    listed = (await tools.call("list_context_packs", {})).text
    assert "- Lead (about 2 words; a role, given per agent with set_agent_role, built into Seti" in listed
    assert fake_seti.writes() == []


async def test_get_task_shows_the_role_pack(tools: EaTools) -> None:
    assert "No role." in (await tools.call("get_task", {"task": "logout"})).text
    await confirm(tools, "set_agent_role", {"task": "logout", "role": "Lead"})
    text = (await tools.call("get_task", {"task": "logout"})).text
    assert "Role: the role pack Lead, in its system prompt; get_context_pack reads it." in text
