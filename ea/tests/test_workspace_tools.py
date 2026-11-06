from typing import Any

import pytest
from fakes import TASK_DOCS, TASK_LOGOUT, FakeSeti, make_task

from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

MAIN = "w-main"
SIDE = "w-side"


@pytest.fixture(autouse=True)
def workspaces(fake_seti: FakeSeti) -> None:
    fake_seti.workspaces = [
        {"id": MAIN, "name": "Main", "position": 0, "agents": 2, "needs_you": 1},
        {"id": SIDE, "name": "Side project", "position": 1, "agents": 1, "needs_you": 0},
    ]
    for task in fake_seti.tasks:
        task["workspace_id"] = SIDE if task["id"] == TASK_DOCS else MAIN


async def confirm(tools: EaTools, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call("change_workspace", args)
    tools.user_turn()
    done = await tools.call("change_workspace", {**args, "confirmed": True})
    return asked, done


async def test_list_workspaces_counts_agents_and_the_ones_that_need_you(tools: EaTools) -> None:
    result = await tools.call("list_workspaces", {})
    assert result.ok
    assert result.text == (
        "2 workspaces, the first takes new agents:\n- Main: 2 agents, 1 need you\n- Side project: 1 agent"
    )


async def test_list_tasks_names_each_workspace_and_filters_by_one(tools: EaTools) -> None:
    every = await tools.call("list_tasks", {})
    assert "- Write deploy docs in Side project: " in every.text
    assert "- Fix the logout button in Main: " in every.text
    side = await tools.call("list_tasks", {"workspace": "side"})
    assert side.text.splitlines()[0] == "1 task in Side project: 1 stopped with an error."
    assert "Fix the logout button" not in side.text


async def test_get_task_says_which_workspace(tools: EaTools) -> None:
    result = await tools.call("get_task", {"task": "deploy docs"})
    assert "It is in the workspace Side project." in result.text.splitlines()


async def test_start_task_joins_the_named_workspace_or_sends_none(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    await tools.call("start_task", {"prompt": "write tests", "workspace": "side"})
    await tools.call("start_task", {"prompt": "write more tests"})
    assert [body.get("workspace_id") for path, body in fake_seti.posts() if path == "/api/tasks/start"] == [
        SIDE,
        None,
    ]
    unknown = await tools.call("start_task", {"prompt": "x", "workspace": "nowhere"})
    assert not unknown.ok
    assert unknown.text.startswith('No workspace matches "nowhere".')


async def test_create_rename_and_delete_ask_first(tools: EaTools, fake_seti: FakeSeti) -> None:
    asked, created = await confirm(tools, {"action": "create", "name": "Ops"})
    assert asked.text.startswith("Not done yet")
    assert 'This creates the workspace "Ops".' in asked.text
    assert created.text == 'Created the workspace "Ops".'
    _, renamed = await confirm(tools, {"action": "rename", "workspace": "ops", "name": "Operations"})
    assert renamed.text == 'Renamed the workspace "Ops" to "Operations".'
    _, deleted = await confirm(tools, {"action": "delete", "workspace": "operations"})
    assert deleted.text == 'Deleted the workspace "Operations".'
    assert [(method, path) for method, path, _, _ in fake_seti.writes()] == [
        ("POST", "/api/workspaces"),
        ("PATCH", "/api/workspaces/w3"),
        ("DELETE", "/api/workspaces/w3"),
    ]


async def test_change_workspace_relays_refusals(tools: EaTools, fake_seti: FakeSeti) -> None:
    _, taken = await confirm(tools, {"action": "create", "name": "main"})
    assert not taken.ok
    assert taken.text == 'Seti did not do it: A workspace named "main" already exists'
    _, busy = await confirm(tools, {"action": "delete", "workspace": "side"})
    assert not busy.ok
    assert busy.text.startswith("Seti did not do it: Move or delete the 1 agents first")
    same = await tools.call("change_workspace", {"action": "rename", "workspace": "main", "name": "Main"})
    assert not same.ok
    bad = await tools.call("change_workspace", {"action": "merge"})
    assert bad.text == "Unknown action merge. Use one of create, rename, delete."


async def test_move_agent_patches_its_workspace_archived_ones_too(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    moved = await tools.call("move_agent_to_workspace", {"task": "logout", "workspace": "side"})
    assert moved.text == 'Moved "Fix the logout button" to the workspace Side project.'
    fake_seti.archived = [make_task("arch-1", "Old spike", "idle", workspace_id=MAIN)]
    archived = await tools.call("move_agent_to_workspace", {"task": "old spike", "workspace": "side"})
    assert archived.ok
    already = await tools.call("move_agent_to_workspace", {"task": "login", "workspace": "main"})
    assert already.text == '"Fix the login redirect bug" is already in Main.'
    assert fake_seti.writes() == [
        ("PATCH", f"/api/tasks/{TASK_LOGOUT}", {}, {"workspace_id": SIDE}),
        ("PATCH", "/api/tasks/arch-1", {}, {"workspace_id": SIDE}),
    ]
