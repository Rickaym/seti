import httpx
from fakes import FakeSeti, team_message

from seti_ea.announce import ToolAnnouncer, ToolCall
from seti_ea.chat import INBOX_TOOLS
from seti_ea.conversation import Conversation
from seti_ea.inbox import ACTION_TOOLS, InboxGuard, InboxPump
from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.tools import DIRECT_ONLY, EaTools, reply_outcome, team_author, team_outcome


def delivery(handle: str, mode: str, reason: str | None = None) -> dict[str, object]:
    return {"task_id": f"id-{handle}", "handle": handle, "mode": mode, "reason": reason}


async def test_read_lists_recent_messages_by_author(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.team = [
        team_message(1, "user", "@all please rebase on main"),
        team_message(
            2, "task", "Done, pushed.", author_handle="voicemail", created_at="2026-09-27T11:48:00Z"
        ),
        team_message(3, "ea", "Noted for the user."),
    ]
    result = await tools.call("read_team_chat", {"limit": 5})
    assert result.ok
    assert result.text.splitlines() == [
        "The last 3 group chat messages, oldest first:",
        "- the user (10 minutes ago): @all please rebase on main",
        "- @voicemail (12 minutes ago): Done, pushed.",
        "- you (10 minutes ago): Noted for the user.",
    ]
    assert result.summary == "Read 3 group chat messages"
    request = fake_seti.requests[-1]
    assert (request.method, request.url.path, dict(request.url.params)) == (
        "GET",
        "/api/team/messages",
        {"limit": "5"},
    )


async def test_read_caps_the_limit_and_reports_an_empty_chat(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("read_team_chat", {"limit": 500})
    assert result.text == "The group chat is empty."
    assert dict(fake_seti.requests[-1].url.params) == {"limit": "30"}
    await tools.call("read_team_chat", {})
    assert dict(fake_seti.requests[-1].url.params) == {"limit": "12"}


async def test_read_clips_long_messages(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.team = [team_message(1, "user", "word " * 200)]
    line = (await tools.call("read_team_chat", {})).text.splitlines()[1]
    assert line.endswith("...")
    assert len(line) < 300


async def test_post_sends_the_text_and_says_what_it_reached(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.team_deliveries = [
        delivery("voicemail", "now"),
        delivery("dashboard", "next"),
        delivery("docs", "held", "idle"),
        delivery("login", "skipped", "muted"),
    ]
    result = await tools.call("post_team_chat", {"text": "@voicemail the release is at 3pm @nobody"})
    assert result.ok
    assert fake_seti.posts() == [("/api/team/messages", {"text": "@voicemail the release is at 3pm @nobody"})]
    assert result.text == (
        "Posted to the group chat. Reached mid-turn: @voicemail; reached at the next step: @dashboard; "
        "waiting for the next turn: @docs; muted, so not told: @login. No task has the handle @nobody."
    )
    assert result.summary == "Posted to the group chat, 3 agents"


async def test_post_with_no_task_reached(tools: EaTools) -> None:
    result = await tools.call("post_team_chat", {"text": "Anyone around?"})
    assert result.text == "Posted to the group chat. No active task was reached."


async def test_post_needs_text_and_reports_seti_errors(tools: EaTools, fake_seti: FakeSeti) -> None:
    missing = await tools.call("post_team_chat", {})
    assert not missing.ok
    assert fake_seti.posts() == []
    fake_seti.fail[("POST", "/api/team/messages")] = (
        400,
        {"error": {"title": "Invalid request", "detail": "too long"}},
    )
    failed = await tools.call("post_team_chat", {"text": "hello"})
    assert not failed.ok
    assert failed.text == "The Seti call failed: Invalid request. too long"


def test_authors_and_outcomes_read_plainly() -> None:
    assert team_author({"author_kind": "ea"}) == "you"
    assert team_author({"author_kind": "user"}) == "the user"
    assert team_author({"author_kind": "task", "author_handle": "docs"}) == "@docs"
    assert team_outcome([delivery("a", "start"), delivery("b", "start")], []) == (
        "Posted to the group chat. Started: @a and @b."
    )
    assert team_outcome([delivery("a", "start")], [], ["old"]) == (
        "Posted to the group chat. Started: @a. @old is archived and got nothing until restored."
    )
    assert reply_outcome([], ["old"]) == (
        "Replied in the group chat. @old is archived and got nothing until restored."
    )


def test_posting_waits_for_the_user_in_inbox_reports() -> None:
    assert "post_team_chat" in ACTION_TOOLS
    assert "post_team_chat" not in INBOX_TOOLS
    assert "read_team_chat" in INBOX_TOOLS
    guard = InboxGuard()
    guard.active = True
    refused = guard.check("post_team_chat")
    assert refused is not None
    assert not refused.ok
    assert guard.check("read_team_chat") is None


def test_posting_says_what_it_does() -> None:
    announcer = ToolAnnouncer()
    assert announcer.phrase([ToolCall("post_team_chat", {"text": "x"})]) == "Very good. Posting it now."


def test_the_prompt_asks_for_a_yes_before_posting() -> None:
    assert "# Group chat" in SYSTEM_PROMPT
    assert "stop_task or a public post_team_chat, say" in SYSTEM_PROMPT
    assert "You never write into an agent's conversation as the user" in SYSTEM_PROMPT
    assert SYSTEM_PROMPT.isascii()


async def test_team_mentions_are_events_posted_as_they_are(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("team_mention", "@voicemail mentioned you in the group chat", event="mention")
    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    pump = InboxPump(client, Conversation(), None)
    assert await pump.tick() == 1
    assert fake_seti.posts()[-1] == ("/api/ea/inbox/deliver", {"ids": [1], "via": "chat", "notify": [1]})
    assert fake_seti.inbox[0]["delivered_via"] == "chat"


async def test_a_direct_message_finds_the_agent_by_title_and_names_who_sees_it(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.team_deliveries = [delivery("button", "now")]
    result = await tools.call("post_team_chat", {"to": "logout button", "text": "Also add a test"})
    assert result.ok
    assert fake_seti.posts() == [("/api/team/messages", {"text": "Also add a test", "to": "button"})]
    assert result.text == (
        "Sent @button a direct message; it joined its running turn. Only you, @button and the user see it."
    )
    by_handle = await tools.call("post_team_chat", {"to": "@button", "text": "Thanks"})
    assert by_handle.summary == "Sent @button a direct message"


async def test_an_act_report_may_only_send_direct_messages(tools: EaTools, fake_seti: FakeSeti) -> None:
    token = DIRECT_ONLY.set(True)
    try:
        refused = await tools.call("post_team_chat", {"text": "@all heads up"})
    finally:
        DIRECT_ONLY.reset(token)
    assert not refused.ok
    assert "direct message" in refused.text
    assert fake_seti.posts() == []


def test_direct_messages_read_with_their_recipient() -> None:
    to_agent = {"author_kind": "ea", "to_kind": "task", "to_handle": "docs"}
    assert team_author(to_agent) == "you, directly to @docs"
    to_ea = {"author_kind": "task", "author_handle": "docs", "to_kind": "ea"}
    assert team_author(to_ea) == "@docs, directly to you"
