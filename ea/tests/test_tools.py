import httpx
import pytest
from fakes import (
    REPO_SETI,
    REPO_WEB,
    TASK_DOCS,
    TASK_LOGIN,
    TASK_LOGOUT,
    FakeSeti,
    make_task,
    subtask,
)

from seti_ea.actions import ACTION_SPECS
from seti_ea.seti import SetiClient
from seti_ea.settings_tools import SETTINGS_SPECS
from seti_ea.tools import TOOL_SPECS, EaTools, queued_updates
from seti_ea.wake import SLEEP_SPEC


async def test_requests_identify_the_ea(tools: EaTools, fake_seti: FakeSeti) -> None:
    await tools.call("list_tasks", {})
    request = fake_seti.requests[0]
    assert request.url.path == "/api/tasks"
    assert request.headers["host"] == "seti.localhost:3006"
    assert request.headers["origin"] == "http://seti.localhost:3006"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["x-seti-via"] == "ea"


@pytest.mark.parametrize(
    ("ref", "task_id"),
    [
        (TASK_LOGIN, TASK_LOGIN),
        ("22222222", TASK_LOGOUT),
        ("write deploy docs", TASK_DOCS),
        ("Fix the logout button", TASK_LOGOUT),
        ("login redirect", TASK_LOGIN),
        ("the deploy docs task", TASK_DOCS),
        ("redirect bug for login", TASK_LOGIN),
    ],
)
async def test_resolves_tasks_by_id_or_approximate_title(tools: EaTools, ref: str, task_id: str) -> None:
    task = await tools.resolve_task(ref)
    assert task["id"] == task_id


async def test_ambiguous_names_list_the_candidates(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("get_task", {"task": "fix"})
    assert not result.ok
    assert '"fix" matches 2 tasks' in result.text
    assert "Fix the login redirect bug (running)" in result.text
    assert "Fix the logout button (idle)" in result.text
    assert "Ask the user which one" in result.text
    assert result.summary == '"fix" is ambiguous'
    assert not fake_seti.posts()


async def test_short_title_words_do_not_match_everything(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks = [make_task("id-1", "A b c", "idle"), make_task("id-2", "Tune the cache", "idle")]
    task = await tools.resolve_task("tuning cache")
    assert task["id"] == "id-2"


async def test_unknown_task_says_so(tools: EaTools) -> None:
    result = await tools.call("stop_task", {"task": "database migration"})
    assert not result.ok
    assert 'No task matches "database migration"' in result.text


async def test_list_tasks_is_compact_and_newest_first(tools: EaTools) -> None:
    result = await tools.call("list_tasks", {})
    assert result.ok
    lines = result.text.splitlines()
    assert lines[0] == "3 tasks: 1 running, 1 idle, 1 stopped with an error."
    assert lines[1] == "- Fix the login redirect bug: running, seti, updated 2 minutes ago"
    assert result.summary == "Listed 3 agents"
    assert "{" not in result.text


async def test_list_tasks_filters_by_status(tools: EaTools) -> None:
    result = await tools.call("list_tasks", {"status": "idle"})
    assert result.text.splitlines()[1].startswith("- Fix the logout button: idle, not seen yet, seti")
    assert len(result.text.splitlines()) == 2
    empty = await tools.call("list_tasks", {"status": "stopped"})
    assert empty.text == "There are no stopped tasks."
    bad = await tools.call("list_tasks", {"status": "sleeping"})
    assert not bad.ok


async def test_list_and_get_task_show_the_status_line(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[0].update(status_line="waiting on CI", status_line_at="2026-09-27T11:57:00.000Z")
    listed = await tools.call("list_tasks", {})
    assert '- Fix the login redirect bug: running, "waiting on CI", seti, updated' in listed.text
    assert "- Fix the logout button: idle, not seen yet, seti" in listed.text
    detail = await tools.call("get_task", {"task": "login"})
    assert 'Its status line reads "waiting on CI", set 3 minutes ago.' in detail.text
    other = await tools.call("get_task", {"task": "logout"})
    assert "status line" not in other.text


async def test_get_task_reads_the_agents_todo_list(tools: EaTools, fake_seti: FakeSeti) -> None:
    item = {"id": "1", "content": "Run tests", "active_form": "Running tests", "status": "in_progress"}
    done = {"id": "2", "content": "Read code", "active_form": None, "status": "completed"}
    fake_seti.tasks[0]["todos"] = [done, item, {**item, "id": "3", "status": "pending"}]
    detail = await tools.call("get_task", {"task": "login"})
    assert 'Its todo list has 1 of 3 items done; now: "Running tests".' in detail.text
    fake_seti.tasks[0]["todos"] = [done]
    assert "Its todo list has 1 of 1 item done." in (await tools.call("get_task", {"task": "login"})).text
    assert "todo list" not in (await tools.call("get_task", {"task": "logout"})).text


async def test_list_tasks_says_which_agents_ask_the_user(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1]["asking"] = True
    result = await tools.call("list_tasks", {"status": "asking"})
    assert result.text.splitlines() == [
        "1 task: 1 asking you a question.",
        "- Fix the logout button: asking you a question, not seen yet, seti, updated 5 minutes ago",
    ]
    assert (await tools.call("list_tasks", {"status": "idle"})).text == "There are no idle tasks."


async def test_a_task_with_running_subagents_counts_as_running(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.subtasks[TASK_LOGOUT] = [subtask("toolu_bg", "Watch CI", "running", background=True)]
    running = await tools.call("list_tasks", {"status": "running"})
    assert running.text.startswith("2 tasks: 2 running.")
    assert "- Fix the logout button: running" in running.text
    idle = await tools.call("list_tasks", {"status": "idle"})
    assert idle.text == "There are no idle tasks."
    detail = await tools.call("get_task", {"task": "logout"})
    assert detail.text.startswith("Task Fix the logout button is running")
    assert "Its own turn has ended; 1 subagent it started still running." in detail.text


async def test_get_task_reports_prs_updates_and_digest(tools: EaTools) -> None:
    result = await tools.call("get_task", {"task": "login"})
    assert result.ok
    text = result.text
    assert "Task Fix the login redirect bug is running, in seti." in text
    assert "Cost so far at API prices 3.4 dollars." in text
    assert (
        "- seti PR 28, fix: login redirect: CI failing (e2e), changes requested, preview out of date"
    ) in text
    assert "- seti PR 7: not open in a registered repo" in text
    assert "2 updates waiting for the agent (the agent gets them when this turn ends)" in text
    assert "CI failed on seti#28; Review on seti#28" in text
    assert "old update" not in text
    assert "- user, 10 minutes ago: Fix the redirect after login" in text
    assert "- agent, 3 minutes ago: Tests pass, see [link]" in text
    assert "https://" not in text
    assert result.summary == "Read agent Fix the login redirect bug"


async def test_get_task_survives_a_missing_digest_route(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.digest = None
    result = await tools.call("get_task", {"task": "logout"})
    assert result.ok
    assert "Recent transcript unavailable: Not Found." in result.text
    assert "No linked PRs." in result.text


async def test_get_task_shows_the_last_error(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.messages = []
    result = await tools.call("get_task", {"task": "docs"})
    assert "stopped with an error" in result.text
    assert "Last error: Agent crashed: out of memory" in result.text
    assert "No updates are waiting." in result.text


def test_queued_updates_match_the_ui_rule() -> None:
    rows = [
        {"kind": "input", "payload": {"title": "a"}},
        {"kind": "prompt", "payload": {"text": "hi"}},
        {"kind": "input", "payload": {"title": "b"}},
        {"kind": "prompt", "payload": {"text": "/cost"}},
        {"kind": "input", "payload": {"title": "c"}},
        {"kind": "prompt", "payload": {"text": "taken back", "queued": "removed"}},
        {"kind": "input", "payload": {"title": "d", "dismissed_at": "2026-09-27T12:00:00.000Z"}},
    ]
    assert [u["title"] for u in queued_updates(rows)] == ["b", "c"]


async def test_start_can_ask_to_hear_when_the_turn_ends(tools: EaTools, fake_seti: FakeSeti) -> None:
    started = await tools.call("start_task", {"prompt": "Fix the flaky test", "notify_when_done": True})
    assert started.text.endswith("You will hear in your inbox when that turn ends.")
    body = {"prompt": "Fix the flaky test", "notify_when_done": True}
    assert fake_seti.posts() == [("/api/tasks/start", body)]


async def test_stop_task(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("stop_task", {"task": "login"})
    assert result.ok
    assert result.text == "Stopped Fix the login redirect bug. It is now stopped."
    assert fake_seti.posts() == [(f"/api/tasks/{TASK_LOGIN}/stop", {})]
    idle = await tools.call("stop_task", {"task": "logout"})
    assert not idle.ok
    assert "is not running; it is idle" in idle.text


async def test_hand_over_updates(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("hand_over_updates", {"task": "logout"})
    assert result.ok
    assert result.text == "Handed 2 updates to Fix the logout button; its agent is working on them."
    assert fake_seti.posts() == [(f"/api/tasks/{TASK_LOGOUT}/inputs/deliver", {})]
    running = await tools.call("hand_over_updates", {"task": "login"})
    assert not running.ok
    fake_seti.messages = []
    nothing = await tools.call("hand_over_updates", {"task": "logout"})
    assert nothing.text == "No updates are waiting for Fix the logout button."


async def test_start_task_pins_the_repos_the_user_named(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call(
        "start_task",
        {
            "title": "Add dark mode",
            "prompt": "Add a dark theme",
            "repos": ["seti", "octocat/web"],
            "worktree": True,
        },
    )
    assert result.ok
    assert result.text == "Started task Add dark mode in seti, web in a worktree. It is running."
    assert fake_seti.posts() == [
        (
            "/api/tasks/start",
            {
                "title": "Add dark mode",
                "prompt": "Add a dark theme",
                "repo_ids": [REPO_SETI, REPO_WEB],
                "worktree": True,
            },
        )
    ]


async def test_start_task_leaves_title_and_repos_to_the_planner(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("start_task", {"prompt": "Speed up the seti test suite, and check AWS costs"})
    assert fake_seti.posts() == [
        ("/api/tasks/start", {"prompt": "Speed up the seti test suite, and check AWS costs"})
    ]
    assert result.text == (
        "Started task Planned: Speed up the seti test s in seti in a worktree. It is running. "
        "Seti linked the context packs Style. AWS stays off; the user turns it on in the agent's details."
    )
    assert result.summary == "Started agent Planned: Speed up the seti test s"


async def test_start_task_rejects_unknown_and_ambiguous_repos(tools: EaTools, fake_seti: FakeSeti) -> None:
    unknown = await tools.call("start_task", {"title": "t", "prompt": "p", "repos": ["infra"]})
    assert not unknown.ok
    assert "Registered repos: Octocat/seti, Octocat/web, Octocat/web-admin" in unknown.text
    ambiguous = await tools.call("start_task", {"title": "t", "prompt": "p", "repos": ["we"]})
    assert not ambiguous.ok
    assert "matches several repos: Octocat/web, Octocat/web-admin" in ambiguous.text
    assert not fake_seti.posts()


async def test_start_task_without_repos_gets_a_fresh_folder(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("start_task", {"title": "Scratch", "prompt": "Explore", "worktree": True})
    assert result.text == (
        "Started task Scratch in a fresh folder, /home/u/work/scratch-44444444, with no repo. It is running."
    )
    assert fake_seti.posts()[0][1] == {"title": "Scratch", "prompt": "Explore"}


async def test_start_task_in_an_existing_directory(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("start_task", {"title": "Notes", "prompt": "Tidy", "directory": "~/notes"})
    assert result.text == "Started task Notes in ~/notes. It is running."
    assert fake_seti.posts()[0][1]["cwd"] == "~/notes"
    with_repo = await tools.call(
        "start_task", {"title": "Code", "prompt": "Fix", "repos": ["seti"], "directory": "~/notes"}
    )
    assert with_repo.ok
    assert "cwd" not in fake_seti.posts()[1][1]


async def test_list_prs(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("list_prs", {"scope": "all"})
    assert result.ok
    lines = result.text.splitlines()
    assert lines[0] == "1 open PR in total."
    assert lines[1] == "Could not load web: gh failed"
    assert lines[2] == (
        "- seti PR 28, fix: login redirect: CI failing (e2e), changes requested, preview out of date; "
        "task Fix the login redirect bug (running)"
    )
    assert fake_seti.requests[-1].url.params["scope"] == "all"


async def test_list_prs_counts_unresolved_review_threads(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.prs["repos"][0]["prs"][0]["unresolved_threads"] = 1
    result = await tools.call("list_prs", {"scope": "all"})
    assert "CI failing (e2e), 1 unresolved review thread, changes requested" in result.text


async def test_list_prs_without_github_login(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.prs = {"viewer": None, "scope": "mine", "repos": [], "clusters": []}
    result = await tools.call("list_prs", {})
    assert result.text.startswith("0 open PRs of yours.\nThe GitHub CLI is not logged in")


async def test_list_repos(tools: EaTools) -> None:
    result = await tools.call("list_repos", {})
    assert result.text.splitlines() == [
        "3 repos registered:",
        "- Octocat/seti, base branch main",
        "- Octocat/web, base branch dev",
        "- Octocat/web-admin, base branch main",
    ]


async def test_seti_errors_become_readable_failures(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.fail[("POST", f"/api/tasks/{TASK_LOGIN}/stop")] = (
        409,
        {"error": {"title": "Task is already running", "detail": "Task is already running"}},
    )
    result = await tools.call("stop_task", {"task": "login"})
    assert not result.ok
    assert result.text == "The Seti call failed: Task is already running."
    assert result.summary == "Failed: Task is already running"


async def test_unreachable_seti() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    tools = EaTools(SetiClient("http://127.0.0.1:1", transport=httpx.MockTransport(refuse)))
    result = await tools.call("list_tasks", {})
    assert not result.ok
    assert result.text == "The Seti call failed: Seti is not reachable. ConnectError"


async def test_unknown_tool(tools: EaTools) -> None:
    result = await tools.call("merge_pr", {})
    assert not result.ok


async def test_many_tasks_are_capped(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks = [make_task(f"id-{i}", f"Task number {i}", "idle") for i in range(20)]
    result = await tools.call("list_tasks", {})
    assert result.text.splitlines()[-1] == "And 8 older ones not listed."


async def test_tool_specs_are_valid_json_schema(tools: EaTools) -> None:
    names = [spec.name for spec in TOOL_SPECS]
    tail = [spec.name for spec in [*ACTION_SPECS, *SETTINGS_SPECS]]
    assert names[len(names) - len(tail) :] == tail
    assert len(set(names)) == len(names)
    assert SLEEP_SPEC.name not in names
    assert len([*names, SLEEP_SPEC.name]) <= 128, "a call adds go_to_sleep; the API takes 128 tools"
    assert names[: len(names) - len(tail)] == [
        "list_tasks",
        "list_workspaces",
        "seti_overview",
        "get_task",
        "search_seti",
        "list_subtasks",
        "get_subtask",
        "list_waiting_updates",
        "list_prs",
        "get_pr",
        "search_audit",
        "stop_task",
        "hand_over_updates",
        "start_task",
        "list_repos",
        "get_repo",
        "list_context_packs",
        "get_context_pack",
        "list_my_context_packs",
        "list_context_files",
        "read_context_file",
        "list_mcp_servers",
        "agent_access",
        "ssh_hosts",
        "list_processes",
        "list_plugins",
        "account_status",
        "schedule_followup",
        "list_followups",
        "cancel_followup",
        "watch_task",
        "list_watches",
        "read_team_chat",
        "find_in_team_chat",
        "find_in_transcript",
        "post_team_chat",
        "reply_team_chat",
        "confirm_asked",
    ]
    for spec in TOOL_SPECS:
        result = await tools.call(spec.name, {})
        assert not result.summary.startswith("Unknown tool")
        assert set(spec.required) <= set(spec.properties)
        for prop in spec.properties.values():
            assert prop["type"] in {"string", "boolean", "array", "integer"}
            assert prop["description"]
