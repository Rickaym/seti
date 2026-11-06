from datetime import UTC, datetime, timedelta

import pytest
from fakes import (
    NOW,
    PR_SETI,
    REPO_WEB,
    SUB_EXPLORE,
    SUB_TESTS,
    TASK_DOCS,
    TASK_LOGIN,
    TASK_LOGOUT,
    FakeSeti,
    audit_event,
    pr,
)

from seti_ea.toolkit import ToolError
from seti_ea.tools import EaTools, audit_kind, parse_window

UPDATE = {"id": 1, "kind": "input", "payload": {"source": "pr", "kind": "review", "title": "Review on web#3"}}


def gets(fake: FakeSeti, path: str) -> list[dict[str, str]]:
    return [dict(r.url.params) for r in fake.requests if r.method == "GET" and r.url.path == path]


async def test_overview_covers_every_area(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1]["pr_urls"] = [PR_SETI]
    result = await tools.call("seti_overview", {})
    assert result.ok
    assert result.text.splitlines() == [
        "Tasks: 3 tasks, 1 running (Fix the login redirect bug), 1 idle, 1 stopped with an error "
        "(Write deploy docs). 1 subagent running.",
        "Updates waiting: Fix the login redirect bug (2), Fix the logout button (2).",
        "Your PRs: 1 open, 1 failing CI, 0 with conflicts, 0 approved. Failing: seti PR 28 "
        "(task Fix the login redirect bug).",
        'Notable in the last hour: Sign-in failed for MCP server "linear": token expired '
        '(20 minutes ago); Stopped task "Write deploy docs" (30 minutes ago).',
        "Agents made 1 outward call in the last hour.",
    ]
    assert result.summary == "Read the Seti overview"
    assert gets(fake_seti, "/api/prs") == [{"scope": "mine"}]
    assert not fake_seti.posts()


async def test_overview_names_agents_asking_the_user(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1]["asking"] = True
    result = await tools.call("seti_overview", {})
    assert result.text.splitlines()[0].startswith(
        "Tasks: 3 tasks, 1 running (Fix the login redirect bug), 0 idle, "
        "1 asking you (Fix the logout button), "
    )


async def test_overview_names_agents_waiting_for_a_permission(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[0]["blocked"] = "Asks to use Bash: make deploy"
    result = await tools.call("seti_overview", {})
    assert result.text.splitlines()[0] == (
        "Tasks: 3 tasks, none running, 1 idle, 1 waiting on the user "
        "(Fix the login redirect bug: Asks to use Bash: make deploy), 1 stopped with an error "
        "(Write deploy docs). 1 subagent running."
    )


async def test_overview_flags_account_limits(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.account["health"] = {"state": "logged_out", "message": "Claude Code is not logged in."}
    fake_seti.account["usage"]["windows"][0]["utilization"] = 91
    result = await tools.call("seti_overview", {})
    assert "Account problem: Claude Code is not logged in." in result.text
    assert "Usage is high: 5-hour window 91 percent used, resets in 1 hour." in result.text


async def test_overview_survives_failing_sections(tools: EaTools, fake_seti: FakeSeti) -> None:
    boom = (500, {"error": {"title": "Server error", "detail": "boom"}})
    fake_seti.fail[("GET", "/api/prs")] = boom
    fake_seti.fail[("GET", "/api/audit")] = boom
    fake_seti.fail[("GET", "/api/account")] = boom
    fake_seti.fail[("GET", f"/api/tasks/{TASK_LOGIN}/messages")] = boom
    result = await tools.call("seti_overview", {})
    assert result.ok
    lines = result.text.splitlines()
    assert lines[0].startswith("Tasks: 3 tasks")
    assert lines[1:] == [
        "No updates waiting.",
        "Could not check updates for 1 task.",
        "PRs unavailable: Server error.",
        "Audit log unavailable: Server error.",
    ]


async def test_overview_changelog_says_what_changed_in_seti(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.ok
    assert result.text.splitlines() == [
        "Seti runs version aaaaaaa, committed 3 hours ago.",
        "An update is available: 3 new commits on main, 1 feature or fix.",
        "To update, run this on the Seti host:",
        "    cd /srv/seti",
        "    scripts/upgrade.sh",
        "This deploy brought 1 feature or fix.",
        "Recent features and fixes, newest first:",
        "- Sun 27 Sep: Feature: grid view, PR 12, new in this deploy",
        "- Sat 26 Sep: Fix (ea): keep tools within the limit, PR 10",
        "- Fri 25 Sep: Speed-up: faster lists",
    ]
    assert result.summary == "Read the Seti changelog"
    assert gets(fake_seti, "/api/mods/whats-new/changelog") == [{"limit": "200"}]
    assert gets(fake_seti, "/api/mods/whats-new/update") == [{}]
    assert gets(fake_seti, "/api/tasks") == []
    assert not fake_seti.posts()


async def test_overview_metrics_reads_what_agents_shipped(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("seti_overview", {"metrics": True})
    assert result.ok
    assert result.text.splitlines() == [
        "Days count in UTC.",
        "PRs merged: 3 in the last 7 days, 9 in the last 30, on a 4-day streak.",
        "Last 7 days: 12 turns, 1 hour 30 minutes running, 4.2 dollars.",
        "Last 30 days: 40 turns, 5 hours running, 31 dollars.",
        "Today: 2 merged, 3 turns, 30 minutes running, 1.2 dollars.",
        "The 7 days before those: 7 merged, 14 turns, 1 hour 10 minutes running, 3.5 dollars.",
        "Latest merges: seti PR 28 by Fix the login redirect bug and an archived agent, 2 hours ago.",
        "Agents by PRs merged in the last 30 days:",
        "- Fix the login redirect bug: 6 merged, 40 turns, 5 hours running, 20 dollars; uses github.",
        "- an archived agent: 3 merged, 40 turns, 5 hours running, 11 dollars.",
        "1 tool call running now.",
        "The EA's own model calls: 4 today, 30 in the last 7 days (18 on calls, 9 in chat, 3 for inbox "
        "reports), with 11 tool calls.",
        "Each call took 16200 input tokens on average, 62% of them cached, and wrote 85.",
        "First token: median 0.8 seconds, 95th percentile 1.9 seconds.",
        "Speech to text: median 0.3 seconds, 95th percentile 0.6 seconds.",
        "Models: gpt-4.1 and gpt-4.1-mini.",
    ]
    assert result.summary == "Read the shipping metrics"
    assert gets(fake_seti, "/api/home") == [{}]
    assert gets(fake_seti, "/api/ea/usage") == [{}]
    assert not fake_seti.posts()


async def test_overview_changelog_says_whether_seti_is_current(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.update = {"state": "current", "branch": "main", "command": "scripts/upgrade.sh"}
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.text.splitlines()[1] == "It is up to date with main."
    fake_seti.update = {
        "state": "unknown",
        "branch": "main",
        "error": "Could not read from remote repository.",
    }
    result = await tools.call("seti_overview", {"changelog": True})
    assert (
        result.text.splitlines()[1]
        == "It could not check for updates: Could not read from remote repository."
    )


async def test_overview_changelog_survives_a_failing_update_check(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.fail[("GET", "/api/mods/whats-new/update")] = (
        500,
        {"error": {"title": "Server error", "detail": "boom"}},
    )
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.text.splitlines()[1] == "It could not check for updates: Server error."


async def test_overview_changelog_says_when_whats_new_is_off(tools: EaTools, fake_seti: FakeSeti) -> None:
    for path in ("/api/mods/whats-new/changelog", "/api/mods/whats-new/update"):
        fake_seti.fail[("GET", path)] = (404, {"error": {"title": "Not found"}})
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.ok
    assert result.text.startswith("What's new is off, so Seti has no changelog")


async def test_overview_changelog_outside_a_checkout(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.changelog = {"version": None, "unseen": 0, "entries": [], "has_more": False}
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.text == "Seti does not run from a git checkout here, so it has no changelog."


async def test_overview_changelog_with_only_upkeep(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.changelog["entries"] = [e for e in fake_seti.changelog["entries"] if not e["notable"]]
    result = await tools.call("seti_overview", {"changelog": True})
    fake_seti.update = {"state": "current", "branch": "main"}
    result = await tools.call("seti_overview", {"changelog": True})
    assert result.text.splitlines()[2:] == ["No features or fixes in the last 2 commits."]


async def test_overview_of_an_empty_seti(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks = []
    fake_seti.audit = []
    fake_seti.prs = {"viewer": None, "scope": "mine", "repos": [], "clusters": []}
    result = await tools.call("seti_overview", {})
    assert result.text.splitlines() == [
        "No tasks.",
        "No updates waiting.",
        "The GitHub CLI is not logged in, so your PRs are unknown.",
    ]


def test_parse_window() -> None:
    rangoon = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)
    start, end, label = parse_window("today", rangoon, UTC)
    assert (start, end, label) == (datetime(2026, 9, 27, tzinfo=UTC), None, "today")
    start, end, label = parse_window("Yesterday", rangoon, UTC)
    assert (start, end, label) == (
        datetime(2026, 9, 26, tzinfo=UTC),
        datetime(2026, 9, 27, tzinfo=UTC),
        "yesterday",
    )
    assert parse_window("this week", rangoon, UTC)[0] == datetime(2026, 9, 21, tzinfo=UTC)
    assert parse_window("last hour", rangoon, UTC) == (rangoon - timedelta(hours=1), None, "in the last hour")
    assert parse_window("the past 30 minutes", rangoon, UTC)[2] == "in the last 30 minutes"
    assert parse_window("2 days", rangoon, UTC)[0] == rangoon - timedelta(days=2)
    assert parse_window("last week", rangoon, UTC)[0] == rangoon - timedelta(weeks=1)
    with pytest.raises(ToolError):
        parse_window("since the dawn of time", rangoon, UTC)


def test_audit_kind() -> None:
    assert audit_kind("") == ""
    assert audit_kind("tasks") == "task"
    assert audit_kind("Pull requests") == "pr"
    assert audit_kind("outward calls") == "agent.outward"
    assert audit_kind("task.created") == "task.created"
    assert audit_kind("mcp.signin failed") == "mcp.signin_failed"
    assert audit_kind("MCP") == "mcp"
    with pytest.raises(ToolError):
        audit_kind("weather")


async def test_search_audit_for_ea_actions_today(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("search_audit", {"actor": "ea", "window": "today", "timezone": "Asia/Rangoon"})
    assert result.ok
    assert result.text.splitlines() == [
        "3 EA actions today: 2 messages sent, 1 task stopped.",
        "Newest first:",
        '- 2 minutes ago, the EA: Sent a message to task "Fix the logout button": "Add a test for it"',
        '- 30 minutes ago, the EA: Stopped task "Write deploy docs"',
        '- 16 hours ago, the EA: Sent a message to task "Write deploy docs": "Start"',
    ]
    assert result.summary == "Audit: 3 EA actions today"
    assert gets(fake_seti, "/api/audit") == [{"limit": "200", "actor": "user"}]


async def test_search_audit_today_defaults_to_utc(tools: EaTools) -> None:
    result = await tools.call("search_audit", {"actor": "ea", "window": "today"})
    assert result.text.splitlines()[0] == "2 EA actions today (UTC): 1 message sent, 1 task stopped."


async def test_search_audit_latest_events_name_agents_tasks(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("search_audit", {"limit": 4})
    lines = result.text.splitlines()
    assert (
        lines[0]
        == "Latest events: 1 message sent, 1 outward call by an agent, 1 failed MCP sign-in, 1 task stopped."
    )
    assert (
        lines[3] == "- 4 minutes ago, agent in Fix the login redirect bug: Bash: git push origin feat/login"
    )
    assert lines[4] == '- 20 minutes ago, Seti: Sign-in failed for MCP server "linear": token expired'
    assert len(lines) == 6
    assert gets(fake_seti, "/api/audit") == [{"limit": "4"}]


async def test_search_audit_filters_pass_through(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call(
        "search_audit", {"area": "mcp", "actor": "system", "query": "linear", "window": "last 2 hours"}
    )
    assert result.text.splitlines()[0] == (
        '1 MCP event by Seti matching "linear" in the last 2 hours: 1 failed MCP sign-in.'
    )
    assert gets(fake_seti, "/api/audit") == [
        {"limit": "200", "kind": "mcp", "actor": "system", "q": "linear"}
    ]
    me = await tools.call("search_audit", {"actor": "me", "area": "task.created"})
    assert me.text.splitlines()[0] == "Latest tasks created by you."
    assert me.summary == "Audit: 1 task created by you"


async def test_search_audit_empty_and_bad_arguments(tools: EaTools, fake_seti: FakeSeti) -> None:
    none = await tools.call("search_audit", {"area": "plugin", "window": "yesterday"})
    assert none.ok
    assert none.text == "No plugin events yesterday (UTC) in the audit log."
    bad_area = await tools.call("search_audit", {"area": "weather"})
    assert not bad_area.ok
    assert bad_area.text.startswith("Unknown area weather. Use one of task, agent, repo")
    bad_actor = await tools.call("search_audit", {"actor": "robot"})
    assert not bad_actor.ok
    bad_window = await tools.call("search_audit", {"window": "at some point"})
    assert not bad_window.ok
    assert bad_window.summary == "Bad time window"


async def test_search_audit_pages_through_a_window(tools: EaTools, fake_seti: FakeSeti) -> None:
    start = NOW - timedelta(minutes=1)
    fake_seti.audit = [
        audit_event(
            1000 - i,
            (start - timedelta(seconds=10 * i)).isoformat().replace("+00:00", "Z"),
            "agent",
            "agent.outward",
            f"Bash: step {i}",
        )
        for i in range(450)
    ]
    result = await tools.call("search_audit", {"area": "outward", "window": "last 2 hours", "limit": 50})
    assert result.text.splitlines()[0] == ("450 outward calls by agents in the last 2 hours.")
    assert result.text.splitlines()[-1] == "And 425 more not listed."
    befores = [p.get("before") for p in gets(fake_seti, "/api/audit")]
    assert befores == [None, "801", "601"]


async def test_search_audit_stops_after_the_page_cap(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.audit = [
        audit_event(5000 - i, NOW.isoformat(), "system", "task.inputs_delivered", "Delivered")
        for i in range(1200)
    ]
    result = await tools.call("search_audit", {"window": "today"})
    assert result.text.splitlines()[0] == "At least 1000 events today (UTC): 1000 update hand-overs."
    assert "Only the latest 1000 events were searched; older ones were not." in result.text
    assert len(gets(fake_seti, "/api/audit")) == 5


async def test_list_subtasks(tools: EaTools) -> None:
    result = await tools.call("list_subtasks", {"task": "login redirect"})
    assert result.ok
    assert result.text.splitlines() == [
        "Fix the login redirect bug has 2 subagents: 1 completed, 1 running.",
        "- Explore the auth flow (Explore): running for 10 minutes, last tool Grep",
        "- Write the redirect tests (general-purpose): completed in 4 minutes: Added 4 tests; all pass",
    ]
    assert result.summary == "Listed 2 subagents of Fix the login redirect bug"


async def test_list_subtasks_empty(tools: EaTools) -> None:
    result = await tools.call("list_subtasks", {"task": "logout"})
    assert result.ok
    assert result.text == "Fix the logout button has started no subagents."


async def test_get_subtask_clips_the_report(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("get_subtask", {"task": "login", "subtask": "redirect tests"})
    assert result.ok
    lines = result.text.splitlines()
    assert lines[0] == (
        'Subagent "Write the redirect tests" (type general-purpose) of Fix the login redirect bug is '
        "completed; started 20 minutes ago, ran 4 minutes."
    )
    assert lines[1] == "23 tool calls, about 48 thousand tokens."
    assert lines[2] == "Its brief: Write tests for the login redirect covering the next param."
    assert lines[3].startswith("Report gist: Report Added 4 tests in auth.test.ts.")
    assert lines[3].endswith("... The full report is in the Seti UI.")
    assert len(lines[3]) < 780
    assert fake_seti.requests[-1].url.path == f"/api/tasks/{TASK_LOGIN}/subtasks/{SUB_TESTS}"


async def test_get_subtask_latest_and_running(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("get_subtask", {"task": "login", "subtask": "latest"})
    assert result.text.splitlines() == [
        'Subagent "Explore the auth flow" (type Explore) of Fix the login redirect bug is running in the '
        "background; started 10 minutes ago, ran 10 minutes.",
        "Its brief: Find where the redirect is decided.",
        "Progress: Reading middleware. Last tool Grep.",
    ]
    by_id = await tools.call("get_subtask", {"task": "login", "subtask": SUB_EXPLORE})
    assert by_id.summary == "Read subagent Explore the auth flow"


async def test_subtasks_without_an_outcome(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.subtasks[TASK_LOGIN][1].update(status="unknown", progress=None, background=False)
    listed = await tools.call("list_subtasks", {"task": "login"})
    assert "- Explore the auth flow (Explore): outcome unknown" in listed.text.splitlines()
    one = await tools.call("get_subtask", {"task": "login", "subtask": "auth flow"})
    assert one.text.splitlines()[0] == (
        'Subagent "Explore the auth flow" (type Explore) of Fix the login redirect bug has no recorded '
        "outcome; it started 10 minutes ago."
    )
    assert one.text.splitlines()[-1] == "It left no report."


async def test_get_subtask_unknown(tools: EaTools) -> None:
    missing = await tools.call("get_subtask", {"task": "login", "subtask": "deploy the database"})
    assert not missing.ok
    assert missing.text == 'No subagent matches "deploy the database". Call list_subtasks to see them.'
    none = await tools.call("get_subtask", {"task": "logout", "subtask": "latest"})
    assert not none.ok
    assert none.text == "Fix the logout button has started no subagents."


@pytest.mark.parametrize(
    "ref",
    ["seti PR 28", "28", "#28", "PR number 28", "login redirect", PR_SETI, "Fix the login redirect bug"],
)
async def test_get_pr_resolves_many_ways(tools: EaTools, ref: str) -> None:
    result = await tools.call("get_pr", {"pr": ref})
    assert result.ok, result.text
    assert result.summary == "Read seti PR 28"


async def test_get_pr_details(tools: EaTools, fake_seti: FakeSeti) -> None:
    seti_prs = fake_seti.prs["repos"][0]["prs"]
    seti_prs[0]["checks"].append({"name": "deploy", "state": "pending", "detail": "", "url": None})
    seti_prs[0]["checks"].append({"name": "docs", "state": "neutral", "detail": "", "url": None})
    seti_prs[0]["labels"] = ["preview", "bug"]
    seti_prs[0]["unresolved_threads"] = 2
    seti_prs[0]["related"] = [
        {
            "url": "https://github.com/Octocat/seti/pull/30",
            "key": "seti-30",
            "label": "seti#30",
            "title": "docs",
            "ci": "failure",
            "reasons": [
                {"type": "mentioned_by", "place": "body"},
                {"type": "same_branch", "branch": "feat/x"},
            ],
        }
    ]
    result = await tools.call("get_pr", {"pr": "seti 28"})
    assert result.text.splitlines() == [
        "seti PR 28, fix: login redirect, by octocat, feat/x into main, updated 1 hour ago.",
        "CI: 1 of 4 checks passing; failing: e2e; still running: deploy; 1 neutral or skipped.",
        "Review: changes requested, 2 unresolved review threads. No merge conflicts. Preview out of date.",
        "Labels: preview, bug.",
        "Linked tasks: Fix the login redirect bug (running).",
        "1 related PR:",
        "- seti PR 30, CI failing: it mentions this PR in its body; same branch feat/x",
    ]
    seti_prs[0]["related"] = seti_prs[0]["related"] * 7
    many = await tools.call("get_pr", {"pr": "seti 28"})
    assert many.text.splitlines()[-1] == "And 2 more not listed."


async def test_get_pr_disambiguates_numbers_by_repo(tools: EaTools, fake_seti: FakeSeti) -> None:
    web = pr(
        "https://github.com/Octocat/web/pull/28", "feat: web thing", repo_id=REPO_WEB, repo_slug="Octocat/web"
    )
    fake_seti.prs["repos"][1] = {**fake_seti.prs["repos"][1], "error": None, "prs": [web]}
    ambiguous = await tools.call("get_pr", {"pr": "PR 28"})
    assert not ambiguous.ok
    assert '"PR 28" matches 2 open PRs' in ambiguous.text
    web_result = await tools.call("get_pr", {"pr": "web PR 28"})
    assert web_result.summary == "Read web PR 28"


async def test_get_pr_closed_or_unknown(tools: EaTools, fake_seti: FakeSeti) -> None:
    closed = await tools.call("get_pr", {"pr": "https://github.com/Octocat/seti/pull/7"})
    assert not closed.ok
    assert closed.text == "seti PR 7 is merged, closed, or not in a registered repo."
    assert gets(fake_seti, "/api/prs/by-url") == [{"url": "https://github.com/Octocat/seti/pull/7"}]
    unknown = await tools.call("get_pr", {"pr": "PR 99"})
    assert not unknown.ok
    assert unknown.text == 'No open PR matches "PR 99". Call list_prs to see the open PRs.'
    no_prs = await tools.call("get_pr", {"pr": "logout button"})
    assert no_prs.text == "Task Fix the logout button has no open PRs."


async def test_list_waiting_updates_across_tasks(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1]["pr_urls"] = [PR_SETI]
    fake_seti.tasks[2]["pr_urls"] = [PR_SETI]
    fake_seti.task_messages = {TASK_LOGOUT: [UPDATE], TASK_DOCS: []}
    result = await tools.call("list_waiting_updates", {})
    assert result.ok
    assert result.text.splitlines() == [
        "3 updates waiting across 2 tasks:",
        "- Fix the login redirect bug (running): 2 updates, latest CI failed on seti#28; Review on seti#28. "
        "The agent gets them when this turn ends.",
        "- Fix the logout button (idle): 1 update, latest Review on web#3. They go with the next message, "
        "or can be handed over now.",
    ]
    assert result.summary == "3 updates waiting"
    assert {r.url.path for r in fake_seti.requests if r.url.path.endswith("/messages")} == {
        f"/api/tasks/{TASK_LOGIN}/messages",
        f"/api/tasks/{TASK_LOGOUT}/messages",
        f"/api/tasks/{TASK_DOCS}/messages",
    }


async def test_list_waiting_updates_empty_and_partial(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.messages = []
    empty = await tools.call("list_waiting_updates", {})
    assert empty.text == "No updates are waiting on any task."
    assert empty.summary == "No updates waiting"
    fake_seti.fail[("GET", f"/api/tasks/{TASK_LOGIN}/messages")] = (
        404,
        {"error": {"title": "Task not found"}},
    )
    partial = await tools.call("list_waiting_updates", {})
    assert partial.text == "No updates are waiting on any task.\nCould not check 1 task."


async def test_context_packs(tools: EaTools, fake_seti: FakeSeti) -> None:
    listed = await tools.call("list_context_packs", {})
    assert listed.text.splitlines() == [
        "2 context packs:",
        "- Triage sources: Where the morning triage looks for problems (about 22 words)",
        "- Release checklist (about 4 words)",
    ]
    pack = await tools.call("get_context_pack", {"pack": "triage"})
    assert pack.text.splitlines() == [
        "Context pack Triage sources. Where the morning triage looks for problems. About 22 words, "
        "updated 3 hours ago.",
        "Sections: Triage sources; Output.",
        "Opening: - Slack: the #problems channel (read only). - PostHog: error tracking for production. "
        "Group findings by severity.",
    ]
    found = await tools.call("get_context_pack", {"pack": "Triage sources", "query": "posthog"})
    assert found.text.splitlines()[1:] == [
        'Lines mentioning "posthog":',
        "- PostHog: error tracking for production.",
    ]
    missing = await tools.call("get_context_pack", {"pack": "security"})
    assert not missing.ok
    fake_seti.packs = []
    assert (await tools.call("list_context_packs", {})).text == "There are no context packs."


async def test_long_packs_are_summarised_not_read_out(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.packs[0]["body"] = "\n".join(f"## Part {i}\nSome words here." for i in range(40))
    result = await tools.call("get_context_pack", {"pack": "triage"})
    assert len(result.text) < 800
    assert "Sections: Part 0; Part 1;" in result.text
    assert "Part 10" not in result.text


async def test_context_files(tools: EaTools, fake_seti: FakeSeti) -> None:
    listed = await tools.call("list_context_files", {})
    assert listed.text.splitlines() == [
        "5 context files, 3 exist:",
        "- user-level CLAUDE.md: 5.7 KB, changed 20 minutes ago",
        "- seti CLAUDE.md: 1.2 KB, changed 20 minutes ago",
        "- seti CLAUDE.local.md: 300 bytes, changed 20 minutes ago",
        "Not created yet: web CLAUDE.md, web CLAUDE.local.md.",
    ]
    user = await tools.call("read_context_file", {"file": "my CLAUDE.md"})
    assert user.text.splitlines() == [
        "user-level CLAUDE.md: 5.7 KB in 11 lines, changed 20 minutes ago.",
        "Sections: Global conventions; Identity; Commits and PRs.",
        "Opening: The user is Ada Lovelace. - Conventional style: feat:, fix:. - Never commit directly to a "
        "default branch. - Push a branch as soon as it is created.",
    ]
    query = await tools.call("read_context_file", {"file": "global", "query": "branch"})
    assert query.text.splitlines()[1:] == [
        'Lines mentioning "branch":',
        "- Never commit directly to a default branch.",
        "- Push a branch as soon as it is created.",
    ]
    none = await tools.call("read_context_file", {"file": "user", "query": "kubernetes"})
    assert none.text.splitlines()[1] == 'No lines mention "kubernetes".'


async def test_context_file_resolution(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.file_contents["repo:aaaaaaaa-1111-4222-8333-000000000001:local"] = "local notes"
    project = await tools.call("read_context_file", {"file": "seti"})
    assert project.summary == "Read seti CLAUDE.md"
    local = await tools.call("read_context_file", {"file": "seti local"})
    assert local.summary == "Read seti CLAUDE.local.md"
    assert local.text.splitlines()[1] == "Opening: local notes"
    missing = await tools.call("read_context_file", {"file": "web"})
    assert missing.ok
    assert missing.text == "web CLAUDE.md has not been created yet."
    unknown = await tools.call("read_context_file", {"file": "infra"})
    assert not unknown.ok
    assert unknown.text == 'No context file matches "infra". Call list_context_files to see which exist.'


async def test_list_mcp_servers(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("list_mcp_servers", {})
    assert result.text.splitlines() == [
        "4 MCP servers: 2 connected, 1 needs sign-in, 1 failed. Checked 10 minutes ago.",
        "- langfuse: failed, user scope: Connection refused at [link]",
        "- posthog: needs sign-in, user scope",
        "- seti: connected, 5 tools",
        "- slack: connected, user scope, 12 tools",
    ]
    assert result.summary == "Listed 4 MCP servers"
    assert not fake_seti.posts()
    fake_seti.capabilities["servers"] = []
    assert (await tools.call("list_mcp_servers", {})).text == "No MCP servers are configured."


async def test_list_plugins(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("list_plugins", {})
    assert result.text.splitlines() == [
        "2 Seti default plugins, 1 enabled:",
        "- acme: enabled, 3 skills",
        "- old-tools: disabled; problem: The folder no longer exists",
        "1 installed Claude Code plugin, 1 enabled:",
        "- posthog (user scope): enabled, 2 skills, 1 MCP server",
    ]
    fake_seti.plugins = {"defaults": [], "installed": [], "installed_error": "claude: command not found"}
    broken = await tools.call("list_plugins", {})
    assert broken.text.splitlines() == [
        "No Seti default plugins.",
        "Installed plugins unavailable: claude: command not found",
    ]


async def test_account_status(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("account_status", {})
    assert result.text.splitlines() == [
        "Login health good: Using the Claude Code login of user@example.com (Claude Max).",
        "Usage: 5-hour window 46 percent used, resets in 1 hour; "
        "7-day window 22 percent used, resets in 6 days.",
    ]
    fake_seti.account["logins"] = {
        "accounts": [{"id": "a", "name": "Personal"}, {"id": "b", "name": "Work"}],
        "active_id": "b",
        "unsaved": None,
    }
    switched = await tools.call("account_status", {})
    assert switched.text.splitlines()[1] == (
        "Claude login in use: Work; also saved: Personal. Only the user switches logins, in Seti."
    )
    fake_seti.account["logins"] = {
        "accounts": [{"id": "a", "name": "Personal"}],
        "active_id": None,
        "unsaved": {"email": "new@example.com", "organization": None},
    }
    unsaved = await tools.call("account_status", {})
    assert unsaved.text.splitlines()[1] == (
        "Claude Code is signed in to new@example.com, which is not a saved login; also saved: Personal."
    )
    del fake_seti.account["logins"]
    fake_seti.account["health"] = {"state": "logged_out", "message": "Run claude login."}
    fake_seti.account["usage"] = None
    fake_seti.account["usage_note"] = "Usage appears after the next turn."
    fake_seti.account["rate_limit_event"]["status"] = "rejected"
    fake_seti.account["task_error"] = {
        "task_id": TASK_DOCS,
        "task_title": "Write deploy docs",
        "at": "2026-09-27T11:00:00.000Z",
        "error": "authentication_failed",
        "message": "Invalid token",
    }
    bad = await tools.call("account_status", {})
    assert bad.text.splitlines() == [
        "Login health logged out: Run claude login.",
        "Usage unavailable: Usage appears after the next turn.",
        "Task Fix the login redirect bug hit a rate limit (rejected) 5 minutes ago.",
        "Task Write deploy docs failed on the login 1 hour ago (authentication_failed): Invalid token",
    ]


async def test_get_repo(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("get_repo", {"repo": "seti"})
    assert result.text.splitlines() == [
        "Octocat/seti, base branch main.",
        "3 tasks: 1 running, 1 idle, 1 stopped with an error.",
        "1 open PR, 1 failing CI, 0 with merge conflicts.",
        "Context files: CLAUDE.md 1.2 KB, CLAUDE.local.md 300 bytes.",
    ]
    web = await tools.call("get_repo", {"repo": "octocat/web"})
    assert web.text.splitlines() == [
        "Octocat/web, base branch dev.",
        "0 tasks.",
        "Open PRs could not be loaded: gh failed",
        "Context files: CLAUDE.md not created, CLAUDE.local.md not created.",
    ]
    ambiguous = await tools.call("get_repo", {"repo": "we"})
    assert not ambiguous.ok


async def test_read_tools_never_write(tools: EaTools, fake_seti: FakeSeti) -> None:
    for name, args in [
        ("seti_overview", {}),
        ("search_audit", {"window": "today"}),
        ("list_subtasks", {"task": "login"}),
        ("get_subtask", {"task": "login", "subtask": "latest"}),
        ("get_pr", {"pr": "28"}),
        ("list_waiting_updates", {}),
        ("list_context_packs", {}),
        ("get_context_pack", {"pack": "triage"}),
        ("list_context_files", {}),
        ("read_context_file", {"file": "user"}),
        ("list_mcp_servers", {}),
        ("list_plugins", {}),
        ("account_status", {}),
        ("get_repo", {"repo": "seti"}),
    ]:
        result = await tools.call(name, args)
        assert result.ok, (name, result.text)
        assert "{" not in result.text
    assert {r.method for r in fake_seti.requests} == {"GET"}
