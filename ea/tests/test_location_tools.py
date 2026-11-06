from typing import Any

from fakes import REPO_SETI, REPO_WEB, TASK_LOGOUT, FakeSeti

from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

LOGOUT = f"/api/tasks/{TASK_LOGOUT}"


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


def logout(fake_seti: FakeSeti) -> dict[str, Any]:
    return next(t for t in fake_seti.tasks if t["id"] == TASK_LOGOUT)


async def test_add_repo_asks_first_then_adds_a_worktree(tools: EaTools, fake_seti: FakeSeti) -> None:
    args = {"task": "logout", "repo": "octocat/web", "worktree": True, "ref": "dev"}
    asked, done = await confirm(tools, "add_agent_repo", args)
    assert "Not done yet" in asked.text
    assert "read and edit a fresh worktree of web from dev from its next turn" in asked.text
    assert done.text == (
        "Added web to Fix the logout button as a fresh worktree of web from dev; "
        "it applies from its next turn."
    )
    assert fake_seti.writes() == [
        ("POST", f"{LOGOUT}/repos", {}, {"repo_id": REPO_WEB, "worktree": True, "ref": "dev"})
    ]


async def test_add_repo_reports_what_seti_refused(tools: EaTools, fake_seti: FakeSeti) -> None:
    _, done = await confirm(tools, "add_agent_repo", {"task": "logout", "repo": "seti"})
    assert not done.ok
    assert done.text == "Seti did not add it: Octocat/seti is already part of this agent"


async def test_add_directory_then_remove_it(tools: EaTools, fake_seti: FakeSeti) -> None:
    unconfirmed = await tools.call(
        "add_agent_directory", {"task": "logout", "path": "~/notes", "confirmed": True}
    )
    assert unconfirmed.text.startswith("You had not put this to the user yet.")
    assert not fake_seti.writes()
    tools.user_turn()
    _, added = await confirm(tools, "add_agent_directory", {"task": "logout", "path": "~/notes"})
    assert (
        added.text == "Added the directory ~/notes to Fix the logout button; it applies from its next turn."
    )
    assert logout(fake_seti)["dirs"] == ["~/notes"]

    asked, removed = await confirm(tools, "remove_from_agent", {"task": "logout", "what": "~/notes/"})
    assert (
        "takes ~/notes off Fix the logout button from its next turn. Nothing on disk is deleted."
        in asked.text
    )
    assert removed.text == "Took ~/notes off Fix the logout button; its files stay."
    assert fake_seti.writes()[-1] == ("DELETE", f"{LOGOUT}/dirs", {"path": "~/notes"}, None)


async def test_remove_repo_but_never_the_working_directory(tools: EaTools, fake_seti: FakeSeti) -> None:
    here = await tools.call("remove_from_agent", {"task": "logout", "what": "seti", "confirmed": True})
    assert not here.ok
    assert "seti is where Fix the logout button works" in here.text
    logout(fake_seti)["repos"].append(
        {"id": REPO_WEB, "slug": "Octocat/web", "dir": "/home/u/web", "worktree": True}
    )
    _, removed = await confirm(tools, "remove_from_agent", {"task": "logout", "what": "web"})
    assert removed.text == "Took web off Fix the logout button; its files stay."
    assert fake_seti.writes() == [("DELETE", f"{LOGOUT}/repos/{REPO_WEB}", {}, None)]
    missing = await tools.call("remove_from_agent", {"task": "logout", "what": "infra"})
    assert missing.text == 'Fix the logout button has no repo or directory matching "infra". It has seti.'


async def test_set_working_directory_moves_the_agent(tools: EaTools, fake_seti: FakeSeti) -> None:
    logout(fake_seti)["dirs"] = ["/home/u/notes"]
    same = await tools.call("set_agent_working_directory", {"task": "logout", "where": "seti"})
    assert same.text == "Fix the logout button already works in /home/u/seti."
    asked, done = await confirm(
        tools, "set_agent_working_directory", {"task": "logout", "where": "/home/u/notes"}
    )
    assert "keeps its conversation, and /home/u/seti stays attached" in asked.text
    assert (
        done.text
        == "Fix the logout button works in /home/u/notes from its next turn and keeps its conversation."
    )
    assert fake_seti.writes() == [("PATCH", LOGOUT, {}, {"cwd": "/home/u/notes"})]


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
