from typing import Any

from fakes import REPO_SETI, REPO_WEB, TASK_LOGOUT, FakeSeti

from seti_ea.actions import ACTION_SPECS
from seti_ea.tools import EaTools


def logout(fake_seti: FakeSeti) -> dict[str, Any]:
    return next(t for t in fake_seti.tasks if t["id"] == TASK_LOGOUT)


def test_no_tool_changes_where_an_agent_works() -> None:
    names = {spec.name for spec in ACTION_SPECS}
    gone = {"add_agent_repo", "add_agent_directory", "remove_from_agent", "set_agent_working_directory"}
    assert not names & gone


async def test_get_task_shows_where_the_agent_works(tools: EaTools, fake_seti: FakeSeti) -> None:
    task = logout(fake_seti)
    task["repos"].append({"id": REPO_WEB, "slug": "Octocat/web", "dir": "/w/web-1", "worktree": True})
    task["dirs"] = ["/home/u/notes"]
    result = await tools.call("get_task", {"task": "logout"})
    assert "Working directory: /home/u/seti." in result.text
    assert "It can also edit web at /w/web-1 (worktree), /home/u/notes." in result.text
    alone = await tools.call("get_task", {"task": "login"})
    assert "It can also edit" not in alone.text
    assert REPO_SETI in {r["id"] for r in task["repos"]}
