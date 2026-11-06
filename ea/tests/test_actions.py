import re
from typing import Any

import pytest
from fakes import (
    PACK_TRIAGE,
    PR_GONE,
    PR_SETI,
    REPO_SETI,
    REPO_WEB,
    SUB_EXPLORE,
    SUB_TESTS,
    TASK_DOCS,
    TASK_LOGIN,
    TASK_LOGOUT,
    FakeSeti,
    listed_subtasks,
    make_task,
    subtask,
)

from seti_ea.actions import ACTION_SPECS, CHANGE_TOOLS, CONFIRM_TOOLS
from seti_ea.announce import PHRASES, ToolAnnouncer, ToolCall, action_line
from seti_ea.chat import INBOX_TOOLS
from seti_ea.inbox import ACTION_TOOLS, VOICE_HELD_TOOLS, InboxGuard
from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.settings_tools import SETTINGS_SPECS, SETTINGS_WRITES
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

LOGOUT = f"/api/tasks/{TASK_LOGOUT}"
LOGIN = f"/api/tasks/{TASK_LOGIN}"


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    """Asks, lets the user answer, then calls again with confirmed; both results."""
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


def test_every_confirm_tool_takes_confirmed_and_every_action_is_held_in_inbox_reports() -> None:
    assert {
        "delete_agent",
        "archive_agent",
        "rewind_agent",
        "dismiss_updates",
        "stop_background_work",
        "restart_agent_session",
        "stop_subagent",
        "stop_process",
        "unlink_pr",
        "start_agent_from_pr",
        "request_preview",
        "unlink_context_pack",
        "update_context_pack",
        "delete_context_pack",
        "update_repo",
        "remove_repo",
        "add_agent_repo",
        "add_agent_directory",
        "remove_from_agent",
        "set_agent_working_directory",
        "set_agent_role",
        "change_my_context_packs",
        "set_mcp_default",
        "set_agent_access",
        "set_agent_profile",
        "change_workspace",
    } | SETTINGS_WRITES == CONFIRM_TOOLS
    assert {spec.name for spec in ACTION_SPECS} | SETTINGS_WRITES == CHANGE_TOOLS
    assert CHANGE_TOOLS <= ACTION_TOOLS
    assert CHANGE_TOOLS <= VOICE_HELD_TOOLS
    assert CHANGE_TOOLS.isdisjoint(INBOX_TOOLS)
    guard = InboxGuard()
    guard.active = True
    for name in CHANGE_TOOLS:
        refused = guard.check(name)
        assert refused is not None
        assert not refused.ok


async def test_delete_asks_first_and_acts_only_after_the_users_next_turn(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.tasks[1]["pr_urls"] = [PR_SETI]
    fake_seti.tasks[1]["worktree"] = True
    asked = await tools.call("delete_agent", {"task": "logout button"})
    assert asked.ok
    assert asked.summary == "Asked first: delete agent Fix the logout button"
    assert (
        'This permanently deletes the agent "Fix the logout button" with its transcript, its worktree, '
        "the folders Seti made for it and "
        "its session; it cannot be undone. Its linked PR stays as it is on GitHub."
    ) in asked.text
    assert "call confirm_asked with this question's id" in asked.text
    assert asked.text.endswith("Question id: 1.")
    assert fake_seti.writes() == []

    same_turn = await tools.call("delete_agent", {"task": "logout button", "confirmed": True})
    assert same_turn.summary.startswith("Asked first")
    assert fake_seti.writes() == []

    tools.user_turn()
    done = await tools.call("delete_agent", {"task": "logout button", "confirmed": True})
    assert done.ok
    assert done.text == 'Deleted the agent "Fix the logout button" and its transcript.'
    assert done.summary == "Deleted agent Fix the logout button"
    assert fake_seti.writes() == [("DELETE", LOGOUT, {}, None)]


async def test_confirmed_without_asking_first_only_asks(tools: EaTools, fake_seti: FakeSeti) -> None:
    tools.user_turn()
    result = await tools.call("delete_agent", {"task": "deploy docs", "confirmed": True})
    assert result.text.startswith("You had not put this to the user yet.")
    assert fake_seti.writes() == []


async def test_a_yes_covers_only_the_target_it_was_asked_about(tools: EaTools, fake_seti: FakeSeti) -> None:
    await tools.call("delete_agent", {"task": "logout"})
    tools.user_turn()
    other = await tools.call("delete_agent", {"task": "deploy docs", "confirmed": True})
    assert other.summary.startswith("Asked first")
    assert fake_seti.writes() == []


async def test_a_question_goes_stale_after_a_while(tools: EaTools, fake_seti: FakeSeti) -> None:
    await tools.call("delete_agent", {"task": "logout"})
    fake_seti.expire_asks()
    tools.user_turn()
    stale = await tools.call("delete_agent", {"task": "logout", "confirmed": True})
    assert stale.summary.startswith("Asked first")
    tools.user_turn()
    done = await tools.call("delete_agent", {"task": "logout", "confirmed": True})
    assert done.summary == "Deleted agent Fix the logout button"
    again = await tools.call("delete_agent", {"task": "logout", "confirmed": True})
    assert again.summary.startswith("Asked first")


async def test_ambiguous_and_unknown_agents_are_asked_about(tools: EaTools, fake_seti: FakeSeti) -> None:
    for name in ("delete_agent", "rename_agent", "link_pr", "set_update_mode"):
        result = await tools.call(name, {"task": "fix", "title": "x", "pr": "seti PR 28", "mode": "off"})
        assert not result.ok
        assert '"fix" matches 2 tasks' in result.text
        assert "Ask the user which one" in result.text
    missing = await tools.call("delete_agent", {"task": "database migration"})
    assert 'No task matches "database migration"' in missing.text
    assert fake_seti.writes() == []


async def test_pin_patches_the_flag_once(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("pin_agent", {"task": "logout", "pinned": True})
    assert result.ok
    assert result.text.startswith('Pinned "Fix the logout button"')
    assert fake_seti.writes() == [("PATCH", LOGOUT, {}, {"pinned": True})]


async def test_rename_patches_the_title(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("rename_agent", {"task": "logout", "title": "Voicemail retry"})
    assert result.ok
    assert result.text == (
        'Renamed the agent "Fix the logout button" to "Voicemail retry". '
        "Its group chat handle stays as it was."
    )
    assert result.summary == "Renamed agent to Voicemail retry"
    assert fake_seti.writes() == [("PATCH", LOGOUT, {}, {"title": "Voicemail retry"})]
    same = await tools.call("rename_agent", {"task": "logout", "title": "Fix the logout button"})
    assert same.ok
    assert len(fake_seti.writes()) == 1
    missing = await tools.call("rename_agent", {"task": "logout"})
    assert not missing.ok
    assert missing.text == "The title argument is missing."


async def test_update_mode_takes_aliases_and_refuses_unknown_ones(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    result = await tools.call("set_update_mode", {"task": "login", "mode": "ignore"})
    assert result.text == "Done: for Fix the login redirect bug, PR updates are ignored."
    assert result.summary == "PR updates of Fix the login redirect bug: off"
    assert fake_seti.writes() == [("PATCH", LOGIN, {}, {"input_mode": "off"})]
    unchanged = await tools.call("set_update_mode", {"task": "logout", "mode": "queue"})
    assert "already has that setting" in unchanged.text
    no_prs = await tools.call("set_update_mode", {"task": "logout", "mode": "wake"})
    assert no_prs.text.endswith("It has no linked PRs yet, so this applies once one is.")
    bad = await tools.call("set_update_mode", {"task": "login", "mode": "sometimes"})
    assert not bad.ok
    assert bad.text == "Unknown update mode sometimes. Use wake, queue or off."


def targets() -> list[dict[str, Any]]:
    return [
        {
            "message_id": 40,
            "text": "Now add retries",
            "created_at": "2026-09-27T11:30:00.000Z",
            "message_count": 6,
        },
        {
            "message_id": 12,
            "text": "Fix the logout",
            "created_at": "2026-09-27T10:00:00.000Z",
            "message_count": 20,
        },
    ]


async def test_rewind_names_what_goes_and_posts_the_prompt(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.rewind_targets[TASK_LOGOUT] = targets()
    asked, done = await confirm(tools, "rewind_agent", {"task": "logout", "prompt": "latest"})
    assert (
        'This rewinds Fix the logout button to just before the prompt "Now add retries" from 30 minutes ago. '
        "The agent forgets the 6 messages since; the transcript keeps them, marked as rewound."
    ) in asked.text
    assert done.ok
    assert 'the prompt was: "Now add retries"' in done.text
    assert done.summary == "Rewound agent Fix the logout button"
    assert fake_seti.writes() == [
        ("POST", f"{LOGOUT}/rewind", {}, {"message_id": 40, "restore": "conversation"})
    ]


async def test_rewinding_code_lists_the_files_or_says_why_not(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.rewind_targets[TASK_LOGOUT] = targets()
    fake_seti.rewind_files = {"can_rewind": True, "error": None, "files": ["/w/src/a.ts", "/w/src/b.ts"]}
    asked = await tools.call(
        "rewind_agent", {"task": "logout", "prompt": "fix the logout", "restore": "both"}
    )
    assert "It puts back 2 files as they were then: a.ts and b.ts." in asked.text
    fake_seti.rewind_files = {"can_rewind": False, "error": "No checkpoint", "files": []}
    refused = await tools.call(
        "rewind_agent", {"task": "logout", "prompt": "fix the logout", "restore": "code"}
    )
    assert not refused.ok
    assert refused.text == "The files cannot be restored to that point: No checkpoint."
    running = await tools.call("rewind_agent", {"task": "login", "prompt": "latest"})
    assert not running.ok
    assert "is running" in running.text
    none = await tools.call("rewind_agent", {"task": "deploy docs", "prompt": "latest"})
    assert none.text == "Write deploy docs has no earlier prompt to go back to."
    assert fake_seti.writes() == []


async def test_take_back_finds_the_queued_message(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.task_messages[TASK_LOGIN] = [
        {"id": 7, "kind": "prompt", "payload": {"text": "Also bump the version", "queued": "waiting"}},
        {"id": 8, "kind": "prompt", "payload": {"text": "And update the changelog", "queued": "waiting"}},
        {"id": 9, "kind": "prompt", "payload": {"text": "Old one", "queued": "removed"}},
    ]
    several = await tools.call("take_back_message", {"task": "login"})
    assert not several.ok
    assert "Ask the user which one" in several.text
    result = await tools.call("take_back_message", {"task": "login", "message": "changelog"})
    assert (
        result.text
        == 'Took back the message "And update the changelog" before Fix the login redirect bug read it.'
    )
    assert fake_seti.writes() == [("DELETE", f"{LOGIN}/queue/8", {}, None)]
    nothing = await tools.call("take_back_message", {"task": "logout"})
    assert nothing.text == "No message is queued for Fix the logout button."


async def test_dismiss_updates_asks_with_the_count_then_dismisses_up_to_the_newest(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.task_messages[TASK_LOGOUT] = [
        {"id": 1, "kind": "prompt", "payload": {"text": "Fix it"}},
        {"id": 2, "kind": "input", "payload": {"source": "pr", "kind": "ci_failed", "title": "CI failed"}},
        {"id": 3, "kind": "input", "payload": {"source": "pr", "kind": "review", "title": "Review"}},
        {"id": 4, "kind": "input", "payload": {"source": "team", "kind": "mention", "title": "Chat"}},
    ]
    asked, done = await confirm(tools, "dismiss_updates", {"task": "logout"})
    assert (
        "This dismisses 3 updates waiting for Fix the logout button (2 PR updates, 1 group chat message): "
        "its agent never gets them, and they stay in its transcript marked dismissed."
    ) in asked.text
    assert asked.summary == "Asked first: dismiss updates for Fix the logout button"
    assert done.ok
    assert done.text == "Dismissed 3 updates for Fix the logout button; its agent never gets them."
    assert fake_seti.writes() == [("POST", f"{LOGOUT}/inputs/dismiss", {}, {"up_to": 4})]
    nothing = await tools.call("dismiss_updates", {"task": "logout", "confirmed": True})
    assert not nothing.ok
    assert nothing.text == "No updates are waiting for Fix the logout button."
    waiting = await tools.call("list_waiting_updates", {})
    assert "Fix the logout button" not in waiting.text


async def test_dismiss_updates_asks_again_when_another_update_arrived(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    rows = [{"id": 2, "kind": "input", "payload": {"source": "pr", "kind": "review", "title": "Review"}}]
    fake_seti.task_messages[TASK_LOGOUT] = rows
    await tools.call("dismiss_updates", {"task": "logout"})
    tools.user_turn()
    rows.append({"id": 3, "kind": "input", "payload": {"source": "channel", "kind": "", "title": "Alert"}})
    again = await tools.call("dismiss_updates", {"task": "logout", "confirmed": True})
    assert again.summary.startswith("Asked first")
    assert "(1 PR update, 1 channel event)" in again.text
    assert fake_seti.writes() == []


async def test_background_work_and_subagents_stop_after_a_yes(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1].update(listed_subtasks([]))
    asked, done = await confirm(tools, "stop_subagent", {"task": "login", "subagent": "explore"})
    assert 'This stops the subagent "Explore the auth flow" of Fix the login redirect bug' in asked.text
    assert done.text == 'Stopped the subagent "Explore the auth flow" of Fix the login redirect bug.'
    assert fake_seti.writes() == [("POST", f"{LOGIN}/subtasks/{SUB_EXPLORE}/stop", {}, {})]
    finished = await tools.call("stop_subagent", {"task": "login", "subagent": "redirect tests"})
    assert finished.text == 'The subagent "Write the redirect tests" is not running; it is completed.'

    asked, done = await confirm(tools, "stop_background_work", {"task": "login"})
    assert "(1 subagent running)" in asked.text
    assert not done.ok
    assert done.text == "Fix the login redirect bug has no background work running."


async def test_session_restarts_keep_the_conversation_after_a_yes(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    asked, done = await confirm(tools, "restart_agent_session", {"task": "logout"})
    assert (
        "This restarts the Claude Code session of Fix the logout button: the conversation is kept"
        in asked.text
    )
    assert "background shells, processes and subagents end." in asked.text
    assert "running turn" not in asked.text
    assert asked.summary == "Asked first: restart the session of Fix the logout button"
    assert done.text == "Restarted the session of Fix the logout button; the conversation continues."
    assert fake_seti.writes() == [
        ("POST", f"{LOGOUT}/session/restart", {}, {"interrupt": False, "fresh": False}),
    ]


async def test_session_restart_stops_a_running_turn_and_can_start_fresh(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    asked, done = await confirm(tools, "restart_agent_session", {"task": "login", "fresh": True})
    assert "fresh Claude Code session: the agent forgets the conversation so far" in asked.text
    assert "Its running turn stops first." in asked.text
    assert done.text == (
        "Started Fix the login redirect bug in a fresh session; it no longer has the earlier conversation."
    )
    assert fake_seti.writes() == [
        ("POST", f"{LOGIN}/session/restart", {}, {"interrupt": True, "fresh": True}),
    ]


async def test_session_restart_reports_a_refusal(tools: EaTools, fake_seti: FakeSeti) -> None:
    detail = {"error": {"title": "Archived", "detail": "Restore the agent first"}}
    fake_seti.fail[("POST", f"{LOGOUT}/session/restart")] = (409, detail)
    _asked, done = await confirm(tools, "restart_agent_session", {"task": "logout"})
    assert not done.ok
    assert done.text == "Could not restart the session of Fix the logout button: Restore the agent first"


async def test_retry_sends_the_last_message_again(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("retry_agent_turn", {"task": "logout"})
    assert result.ok
    assert result.text == "Sent the last message of Fix the logout button again."
    assert fake_seti.writes() == [("POST", f"{LOGOUT}/retry", {}, {})]


async def test_retry_reports_a_refusal(tools: EaTools, fake_seti: FakeSeti) -> None:
    detail = {"error": {"title": "Conflict", "detail": "The agent is working"}}
    fake_seti.fail[("POST", f"{LOGOUT}/retry")] = (409, detail)
    result = await tools.call("retry_agent_turn", {"task": "logout"})
    assert not result.ok
    assert result.text == "Could not retry Fix the logout button: The agent is working"


async def test_group_chat_mute_and_handle(tools: EaTools, fake_seti: FakeSeti) -> None:
    muted = await tools.call("set_agent_group_chat", {"task": "login", "muted": True})
    assert "it is muted" in muted.text
    assert muted.summary == "Muted Fix the login redirect bug in the group chat"
    handle = await tools.call("set_agent_group_chat", {"task": "login", "handle": "@Redirect"})
    assert "its handle is now @redirect" in handle.text
    assert fake_seti.writes() == [
        ("PATCH", f"/api/team/members/{TASK_LOGIN}", {}, {"muted": True}),
        ("PATCH", f"/api/team/members/{TASK_LOGIN}", {}, {"handle": "redirect"}),
    ]
    taken = await tools.call("set_agent_group_chat", {"task": "login", "handle": "taken"})
    assert not taken.ok
    assert taken.text == "The Seti call failed: Conflict. @taken is taken by another agent"
    nothing = await tools.call("set_agent_group_chat", {"task": "login"})
    assert not nothing.ok


async def test_set_notifications_mutes_an_agent_and_changes_where_tiers_go(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    muted = await tools.call("set_notifications", {"task": "login", "muted": True})
    assert muted.text.startswith("Fix the login redirect bug is muted: its turns no longer notify;")
    assert muted.text.endswith("1 device gets push notifications.")
    assert muted.summary == "Muted Fix the login redirect bug"
    quiet = await tools.call("set_notifications", {"active": "brief"})
    assert quiet.text == (
        "Urgent goes to push, active goes to brief, digest goes to brief, passive goes to off; "
        "1 device gets push notifications."
    )
    assert quiet.summary == "Changed notification tiers"
    assert fake_seti.writes() == [
        ("PATCH", LOGIN, {}, {"notifications_muted": True}),
        ("PUT", "/api/notifications/settings", {}, {"active": "brief"}),
    ]
    nothing = await tools.call("set_notifications", {})
    assert not nothing.ok
    half = await tools.call("set_notifications", {"task": "login"})
    assert not half.ok
    assert len(fake_seti.writes()) == 2


async def test_link_pr_by_name_url_or_to_a_subagent(tools: EaTools, fake_seti: FakeSeti) -> None:
    linked = await tools.call("link_pr", {"task": "logout", "pr": "seti PR 28"})
    assert linked.text.startswith("Linked seti PR 28 to Fix the logout button.")
    assert "PR updates wait for the user's next message" in linked.text
    closed = "https://github.com/Octocat/web/pull/3"
    await tools.call("link_pr", {"task": "logout", "pr": f"see {closed}"})
    already = await tools.call("link_pr", {"task": "login", "pr": "PR 28"})
    assert already.text == "seti PR 28 is already linked to Fix the login redirect bug."
    to_sub = await tools.call("link_pr", {"task": "login", "pr": closed, "subagent": "redirect tests"})
    assert to_sub.summary == "Linked web PR 3 to subagent Write the redirect tests"
    assert fake_seti.writes() == [
        ("POST", f"{LOGOUT}/prs", {}, {"url": PR_SETI}),
        ("POST", f"{LOGOUT}/prs", {}, {"url": closed}),
        ("POST", f"{LOGIN}/subtasks/{SUB_TESTS}/prs", {}, {"url": closed}),
    ]


async def test_unlink_pr_resolves_among_linked_prs_and_asks(tools: EaTools, fake_seti: FakeSeti) -> None:
    generic = await tools.call("unlink_pr", {"task": "login", "pr": "its PR"})
    assert not generic.ok
    assert '"its PR" matches 2 linked PRs' in generic.text
    asked, done = await confirm(tools, "unlink_pr", {"task": "login", "pr": "PR 7"})
    assert "This unlinks seti PR 7 from Fix the login redirect bug" in asked.text
    assert "The PR itself stays as it is on GitHub." in asked.text
    assert done.text == "Unlinked seti PR 7 from Fix the login redirect bug."
    assert fake_seti.writes() == [("DELETE", f"{LOGIN}/prs", {"url": PR_GONE}, None)]
    none = await tools.call("unlink_pr", {"task": "logout", "pr": "PR 7"})
    assert none.text == "Fix the logout button has no linked PRs."


async def test_unlink_pr_from_a_subagent(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.subtasks[TASK_LOGIN][0]["pr_urls"] = [PR_SETI]
    args = {"task": "login", "pr": "the PR", "subagent": "redirect tests"}
    asked, done = await confirm(tools, "unlink_pr", args)
    assert 'from the subagent "Write the redirect tests" of Fix the login redirect bug' in asked.text
    assert done.ok
    assert fake_seti.writes() == [("DELETE", f"{LOGIN}/subtasks/{SUB_TESTS}/prs", {"url": PR_SETI}, None)]


async def test_start_agent_from_pr_sends_what_the_pr_page_sends(tools: EaTools, fake_seti: FakeSeti) -> None:
    args = {"pr": "seti PR 28", "instructions": "Fix the failing e2e test"}
    asked, done = await confirm(tools, "start_agent_from_pr", args)
    assert (
        'This starts a new agent "PR #28: fix: login redirect" in a worktree of seti PR 28\'s branch feat/x'
    ) in asked.text
    assert done.ok
    [(method, path, _, body)] = fake_seti.writes()
    assert (method, path) == ("POST", "/api/tasks/start")
    assert body["title"] == "PR #28: fix: login redirect"
    assert body["repo_ids"] == [REPO_SETI]
    assert body["worktree"] is True
    assert body["ref"] == "feat/x"
    assert body["pr_urls"] == [PR_SETI]
    assert body["prompt"].startswith("Work on pull request #28 in Octocat/seti: fix: login redirect")
    assert "git push origin HEAD:feat/x" in body["prompt"]
    assert body["prompt"].endswith("Task: Fix the failing e2e test")


async def test_preview_label_needs_a_yes_and_previews_on_the_repo(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    asked, done = await confirm(tools, "request_preview", {"pr": "seti PR 28"})
    assert "This adds the preview label to seti PR 28 on GitHub as the user's account" in asked.text
    assert done.text == "Added the preview label on seti PR 28. The preview updates in a few minutes."
    assert fake_seti.writes() == [("POST", "/api/prs/Octocat/seti/28/redeploy", {}, {})]
    fake_seti.prs["repos"][0]["prs"][0]["labels"] = ["preview"]
    relabel = await tools.call("request_preview", {"pr": "seti PR 28"})
    assert "removes the preview label from seti PR 28 and adds it again" in relabel.text
    fake_seti.prs["repos"][0]["previews"] = False
    off = await tools.call("request_preview", {"pr": "seti PR 28"})
    assert not off.ok
    assert off.text.startswith("Seti has no previews for seti")
    fake_seti.prs["previews_on"] = False
    mod_off = await tools.call("request_preview", {"pr": "seti PR 28"})
    assert not mod_off.ok
    assert mod_off.text.startswith("PR previews are off in Seti")
    assert len(fake_seti.writes()) == 1


async def test_context_packs_link_and_unlink(tools: EaTools, fake_seti: FakeSeti) -> None:
    linked = await tools.call("link_context_pack", {"task": "logout", "pack": "triage"})
    assert (
        linked.text
        == "Linked the context pack Triage sources to Fix the logout button; it applies from its next turn."
    )
    again = await tools.call("link_context_pack", {"task": "logout", "pack": "triage"})
    assert again.summary == "Already linked"
    asked, done = await confirm(tools, "unlink_context_pack", {"task": "logout", "pack": "triage sources"})
    assert "no longer gets those instructions" in asked.text
    assert done.ok
    assert fake_seti.writes() == [
        ("PUT", f"{LOGOUT}/context-packs", {}, {"pack_ids": [PACK_TRIAGE]}),
        ("PUT", f"{LOGOUT}/context-packs", {}, {"pack_ids": []}),
    ]
    none = await tools.call("unlink_context_pack", {"task": "logout", "pack": "triage"})
    assert none.text == "Fix the logout button includes no context packs."


async def test_the_built_in_guide_takes_only_its_default(tools: EaTools, fake_seti: FakeSeti) -> None:
    guide_id = "5e710000-0000-4000-8000-000000000001"
    fake_seti.packs.append(
        {
            "id": guide_id,
            "name": "Seti guide",
            "description": "How Seti runs agents",
            "body": "# Seti guide",
            "builtin": True,
            "linked_by_default": True,
            "created_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-01T00:00:00.000Z",
        }
    )
    listed = await tools.call("list_context_packs", {})
    assert "built into Seti, read-only, linked to new agents by default" in listed.text
    edit = await tools.call("update_context_pack", {"pack": "seti guide", "append": "More."})
    assert not edit.ok
    assert edit.text.startswith("Seti guide is built into Seti and its text cannot change.")
    gone = await tools.call("delete_context_pack", {"pack": "seti guide", "confirmed": True})
    assert not gone.ok
    asked, done = await confirm(
        tools, "update_context_pack", {"pack": "seti guide", "linked_by_default": False}
    )
    assert "stops linking it to new agents by default" in asked.text
    assert done.ok
    assert fake_seti.writes() == [
        ("PUT", f"/api/context/packs/{guide_id}/default", {}, {"linked_by_default": False})
    ]


async def test_context_pack_create_append_and_delete(tools: EaTools, fake_seti: FakeSeti) -> None:
    created = await tools.call("create_context_pack", {"name": "Release", "body": "Cut from dev."})
    assert created.ok
    asked, done = await confirm(tools, "update_context_pack", {"pack": "triage", "append": "- Sentry too."})
    assert done.ok
    assert 'adds at its end: "- Sentry too."' in asked.text
    assert "It reaches any agent that includes it" in asked.text
    asked, gone = await confirm(tools, "delete_context_pack", {"pack": "release checklist"})
    assert "permanently deletes the context pack Release checklist" in asked.text
    assert "Its instructions leave every agent that includes it." in asked.text
    assert gone.text == "Deleted the context pack Release checklist."
    writes = fake_seti.writes()
    assert writes[0] == (
        "POST",
        "/api/context/packs",
        {},
        {"name": "Release", "description": "", "body": "Cut from dev."},
    )
    assert writes[1][1] == f"/api/context/packs/{PACK_TRIAGE}"
    assert writes[1][3]["body"].endswith("Group findings by severity.\n\n- Sentry too.\n")
    assert writes[2][:2] == ("DELETE", "/api/context/packs/3785dbaf-4f57-4752-ba91-9b95f4c6fc19")


async def test_repos_add_update_and_remove(tools: EaTools, fake_seti: FakeSeti) -> None:
    bad = await tools.call("add_repo", {"slug": "Octocat/x", "path": "/tmp/x", "base_branch": "main"})
    assert not bad.ok
    assert bad.text == "Seti did not add it: path must be a local git checkout"
    added = await tools.call("add_repo", {"slug": "Octocat/x", "path": "/home/u/x", "base_branch": "main"})
    assert added.text == "Registered Octocat/x at /home/u/x, base branch main."
    asked, done = await confirm(tools, "update_repo", {"repo": "web", "base_branch": "main"})
    assert "its base branch from dev to main" in asked.text
    assert done.ok
    asked, gone = await confirm(tools, "remove_repo", {"repo": "Octocat/seti"})
    assert gone.text == "Removed Octocat/seti from Seti; its checkout stays on disk."
    assert "The checkout on disk stays." in asked.text
    assert [(m, p) for m, p, _, _ in fake_seti.writes()] == [
        ("POST", "/api/repos"),
        ("POST", "/api/repos"),
        ("PUT", f"/api/repos/{REPO_WEB}"),
        ("DELETE", f"/api/repos/{REPO_SETI}"),
    ]


async def test_seti_errors_come_back_plainly(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.fail[("PATCH", LOGOUT)] = (409, {"error": {"title": "Archived", "detail": "restore it first"}})
    result = await tools.call("rename_agent", {"task": "logout", "title": "New"})
    assert not result.ok
    assert result.text == "The Seti call failed: Archived. restore it first"
    assert result.summary == "Failed: Archived"


def test_announcements_do_not_claim_an_action_that_only_asks() -> None:
    assert action_line(ToolCall("delete_agent", {"task": "x"})) is None
    assert (
        action_line(ToolCall("delete_agent", {"task": "x", "confirmed": True}))
        == "Very good. Deleting it now."
    )
    assert action_line(ToolCall("link_pr", {"task": "x", "pr": "y"})) == "Of course. Linking the PR."
    assert (
        action_line(ToolCall("set_agent_group_chat", {"task": "x", "muted": True}))
        == "Certainly. Muting it in the group chat."
    )
    for spec in [*ACTION_SPECS, *(s for s in SETTINGS_SPECS if s.name in SETTINGS_WRITES)]:
        line = action_line(ToolCall(spec.name, {"confirmed": True}))
        assert line is not None
        assert line.endswith(".")
        assert not re.search(r"\bsir\b", line, re.IGNORECASE)
    announcer = ToolAnnouncer()
    assert announcer.phrase([ToolCall("delete_agent", {"task": "x"})]) == PHRASES[0]


@pytest.mark.parametrize("name", sorted(CHANGE_TOOLS))
async def test_every_action_tool_reports_missing_arguments_plainly(
    tools: EaTools, fake_seti: FakeSeti, name: str
) -> None:
    result = await tools.call(name, {})
    assert not result.ok
    assert result.text.startswith("The ")
    assert fake_seti.writes() == []


async def test_a_subagent_of_another_agent_and_a_vanished_agent(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.subtasks[TASK_LOGOUT] = [subtask("toolu_x", "Scan", "running")]
    result = await tools.call("stop_subagent", {"task": "logout", "subagent": "scan"})
    assert result.summary == "Asked first: stop subagent Scan"
    assert fake_seti.writes() == []
    fake_seti.fail[("GET", f"{LOGOUT}/rewind/targets")] = (404, {"error": {"title": "Task not found"}})
    gone = await tools.call("rewind_agent", {"task": "logout", "prompt": "latest"})
    assert gone.text == "The Seti call failed: Task not found."


def test_the_prompt_explains_the_new_abilities_and_how_to_ask() -> None:
    assert "Tools that take a confirmed argument" in SYSTEM_PROMPT
    assert "call confirm_asked with the ids of every question that yes answers" in SYSTEM_PROMPT
    assert "Small changes that are easy to undo need no yes" in SYSTEM_PROMPT
    assert "never guess" in SYSTEM_PROMPT
    assert "change you make there is the preview label" in SYSTEM_PROMPT
    assert "# How you sound" in SYSTEM_PROMPT
    assert SYSTEM_PROMPT.isascii()


async def test_archive_asks_then_reports_what_it_saved(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.tasks[1]["worktree"] = True
    busy = await tools.call("archive_agent", {"task": "login"})
    assert not busy.ok
    assert (
        busy.text
        == "Fix the login redirect bug is working; it can be archived once it is stopped or finished."
    )
    asked, done = await confirm(tools, "archive_agent", {"task": "logout"})
    assert (
        'This archives the agent "Fix the logout button": its transcript is compressed, and it leaves the '
        "agent list, PR updates and the group chat until it is restored."
    ) in asked.text
    assert (
        "packed into a bundle until then. Its worktree is removed if it is clean; its branch stays."
        in asked.text
    )
    assert done.text == (
        "Archived Fix the logout button: 120 transcript messages compressed to 5.3 KB. "
        "Its seti worktree was removed, freeing 2 KB."
    )
    assert done.summary == "Archived agent Fix the logout button"
    kept = await confirm(tools, "archive_agent", {"task": "deploy docs", "keep_worktree": True})
    assert "Its seti worktree stays: kept as asked." in kept[1].text
    assert fake_seti.writes() == [
        ("POST", f"{LOGOUT}/archive", {}, {"remove_worktree": True}),
        ("POST", f"/api/tasks/{TASK_DOCS}/archive", {}, {"remove_worktree": False}),
    ]


async def test_restore_finds_archived_agents_only(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.archived = [make_task("archived-1", "Voicemail retry", "idle")]
    restored = await tools.call("restore_agent", {"task": "voicemail"})
    assert restored.ok
    assert restored.text == (
        "Restored Voicemail retry with 120 transcript messages; it is back in the agent list. "
        "Its seti worktree was checked out again."
    )
    assert fake_seti.writes() == [("POST", "/api/tasks/archived-1/unarchive", {}, {})]
    missing = await tools.call("restore_agent", {"task": "logout"})
    assert not missing.ok
    assert 'No archived agent matches "logout"' in missing.text


async def test_delete_reaches_archived_agents_when_no_active_one_matches(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.archived = [make_task("archived-1", "Voicemail retry", "idle")]
    asked, done = await confirm(tools, "delete_agent", {"task": "voicemail"})
    assert 'This permanently deletes the archived agent "Voicemail retry"' in asked.text
    assert done.ok
    assert fake_seti.writes() == [("DELETE", "/api/tasks/archived-1", {}, None)]
    fake_seti.archived.append(make_task("archived-2", "Fix the logout flow", "idle"))
    active_first = await tools.call("delete_agent", {"task": "logout"})
    assert "Fix the logout button" in active_first.text


async def test_set_agent_color_patches_a_preset_or_hex_and_none_clears_it(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    result = await tools.call("set_agent_color", {"task": "logout", "color": "Purple"})
    assert result.ok
    assert result.text.startswith('Coloured "Fix the logout button" violet')
    assert fake_seti.writes() == [("PATCH", LOGOUT, {}, {"color": "#b066da"})]
    fake_seti.tasks[1]["color"] = "#b066da"
    same = await tools.call("set_agent_color", {"task": "logout", "color": "violet"})
    assert same.text == '"Fix the logout button" is already violet.'
    assert len(fake_seti.writes()) == 1
    red = await tools.call("set_agent_color", {"task": "logout", "color": "crimson"})
    assert red.text.startswith('Coloured "Fix the logout button" red')
    assert fake_seti.writes()[-1] == ("PATCH", LOGOUT, {}, {"color": "#e8605b"})
    custom = await tools.call("set_agent_color", {"task": "logout", "color": "#38F"})
    assert custom.text.startswith('Coloured "Fix the logout button" a custom colour (#3388ff)')
    assert fake_seti.writes()[-1] == ("PATCH", LOGOUT, {}, {"color": "#3388ff"})
    for value in ("sunset", "#12345", "3b82f6"):
        bad = await tools.call("set_agent_color", {"task": "logout", "color": value})
        assert not bad.ok
        assert f"no {value} agent colour" in bad.text
    cleared = await tools.call("set_agent_color", {"task": "logout", "color": "none"})
    assert cleared.text == 'Cleared the colour of "Fix the logout button".'
    assert fake_seti.writes()[-1] == ("PATCH", LOGOUT, {}, {"color": None})
