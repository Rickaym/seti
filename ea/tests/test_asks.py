import json
from typing import Any

import httpx
from fakes import NOW, settings
from test_chat import CLOCK, Script, events_of, factory
from test_settings_tools import SettingsFake, writes

from seti_ea.chat import TextChat
from seti_ea.conversation import Conversation
from seti_ea.inbox import ACTION_TOOLS, InboxPump
from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools

SUBSCRIBE = ("subscribe_channel", {"channel": "uptime", "subscriber": "logout", "events": ["disk"]})
REMIND = ("create_reminder", {"name": "Nudge", "script": "export default () => 'hi'"})
QUESTION = "That routes Uptime to the logout agent and creates the Nudge reminder. Shall I go ahead?"


def ea_process(fake: SettingsFake, script: Script, conversation: Conversation | None = None) -> TextChat:
    """One EA process: its own tools and gate over the same Seti, as after a restart."""
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    tools = EaTools(seti, now=lambda: NOW)
    return TextChat(
        settings(openai_api_key="op"),
        tools,
        conversation or Conversation(),
        llm=factory(script),
        now=lambda: NOW,
    )


def confirmed(call: tuple[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    return call[0], {**call[1], "confirmed": True}


def changes(fake: SettingsFake) -> list[tuple[str, str, Any]]:
    """What the tools changed in Seti, without the EA's own conversation."""
    return [w for w in writes(fake) if not w[1].startswith("/api/ea/")]


def history_posts(fake: SettingsFake) -> list[dict[str, Any]]:
    return [
        json.loads(r.content)
        for r in fake.requests
        if r.method == "POST" and r.url.path == "/api/ea/history/messages"
    ]


async def ask_both(fake: SettingsFake) -> None:
    script = Script([[("c1", *SUBSCRIBE), ("c2", *REMIND)], [QUESTION]])
    await events_of(ea_process(fake, script), "Route uptime to the logout agent and add the Nudge reminder.")
    assert changes(fake) == []


async def test_two_questions_survive_a_restart_and_a_typed_yes_that_asks_again_first() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    script = Script(
        [
            [("c3", *SUBSCRIBE), ("c4", *REMIND)],
            [("c5", *confirmed(SUBSCRIBE)), ("c6", *confirmed(REMIND))],
            ["Done."],
        ]
    )
    events = await events_of(ea_process(fake, script), "yes go")
    results = {e["name"]: e for e in events if e["type"] == "tool_result" and e["id"] in ("c5", "c6")}
    assert all(not r["summary"].startswith("Asked first") for r in results.values()), results
    assert len(changes(fake)) == 2
    assert {a["decision"] for a in fake.asks} == {"allow"}


async def test_one_yes_confirms_every_listed_question_by_id() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    script = Script([[("c3", "confirm_asked", {"ids": [1, 2]})], ["Done."]])
    events = await events_of(ea_process(fake, script), "Yes to both")
    [result] = [e for e in events if e["type"] == "tool_result"]
    assert result["ok"], result["text"]
    assert result["text"].startswith("Question 1 (")
    assert len(changes(fake)) == 2


async def test_a_yes_covers_no_question_asked_in_its_own_turn() -> None:
    fake = SettingsFake()
    script = Script([[("c1", *SUBSCRIBE)], [("c2", "confirm_asked", {"ids": [1]})], [QUESTION]])
    events = await events_of(ea_process(fake, script), "Route uptime to the logout agent, yes, do it.")
    [_, result] = [e for e in events if e["type"] == "tool_result"]
    assert "Not taken: 1." in result["text"]
    assert changes(fake) == []


async def test_the_reply_that_asks_carries_its_questions_unless_a_call_is_live() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    [post] = history_posts(fake)
    assert (post["notify"], post["asks"]) == (True, [1, 2])
    live = Conversation()
    live.attach()
    await events_of(ea_process(fake, Script([["Two agents run."]]), live), "What runs?")
    assert "notify" not in history_posts(fake)[-1]


async def test_a_notification_allow_runs_the_exact_call_once() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    fake.asks[0]["decision"] = "allow"
    chat = ea_process(fake, Script([["Done; Uptime now reaches the logout agent."]]))
    pump = InboxPump(chat._tools.seti, Conversation(), None, answer=chat.answer)  # pyright: ignore[reportPrivateUsage]
    await pump.tick()
    await pump.tick()
    assert len(changes(fake)) == 1
    assert fake.asks[0]["outcome"] == "done"
    said = [e["message"] for e in fake.ea_history if e["message"]["role"] == "user"]
    assert said[-1] == {"role": "user", "content": f"Allow: {fake.asks[0]['summary']}"}


async def test_a_notification_deny_runs_nothing_and_the_question_stays_closed() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    fake.asks[1]["decision"] = "deny"
    chat = ea_process(fake, Script([["Very well; no reminder."], [("c9", *confirmed(REMIND))], ["Hm."]]))
    pump = InboxPump(chat._tools.seti, Conversation(), None, answer=chat.answer)  # pyright: ignore[reportPrivateUsage]
    await pump.tick()
    await events_of(chat, "yes")
    assert changes(fake) == []
    assert fake.asks[1]["outcome"] is None


def test_inbox_reports_cannot_confirm_anything() -> None:
    assert "confirm_asked" in ACTION_TOOLS


async def test_a_typed_yes_waits_for_the_question_and_lists_open_ones() -> None:
    fake = SettingsFake()
    await ask_both(fake)
    script = Script([["Shall I?"]])
    await events_of(ea_process(fake, script), "Remind me what you asked.")
    notes = [m for m in script.seen[0] if m["role"] == "developer" and "still wait" in str(m["content"])]
    assert len(notes) == 1
    assert "- 1: " in notes[0]["content"]
    assert "- 2: " in notes[0]["content"]
    assert CLOCK.zone is not None
