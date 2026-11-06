from typing import Any

import httpx
from fakes import FakeSeti, team_message
from test_chat import Script, make_chat, settle, stored
from test_inbox import Voice, item

from seti_ea.bot import wake_up
from seti_ea.chat import INBOX_TOOLS
from seti_ea.conversation import Conversation
from seti_ea.inbox import (
    ACTION_TOOLS,
    REPLY_TOOL,
    URGENT_SILENCE_SECS,
    VOICE_HELD_TOOLS,
    Delivered,
    InboxGuard,
    InboxItem,
    InboxPump,
    deliver,
    parse_items,
)
from seti_ea.prompt import SYSTEM_PROMPT, VOICE_URGENT_NOTE, voice_urgent_note
from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools
from seti_ea.wake import WakeSettings, WakeStrategy, wake_message


def seti_of(fake: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))


def urgent(item_id: int) -> InboxItem:
    title = "@voicemail mentioned you"
    return InboxItem(
        item_id, "team_mention", "mention", title, "@voicemail", "info", None, None, f"t{item_id}", True
    )


def ci_failed(item_id: int) -> InboxItem:
    title = "CI failed on acme/web#7"
    return InboxItem(
        item_id, "watch_event", "ci_failed", title, "Voicemail", "critical", None, None, f"t{item_id}", True
    )


def needs_you(item_id: int) -> InboxItem:
    title = "Voicemail is asking you"
    return InboxItem(
        item_id, "watch_event", "needs_you", title, "Voicemail", "warning", None, None, f"t{item_id}", True
    )


def test_items_carry_urgency_and_the_message_they_answer() -> None:
    [parsed] = parse_items([{"id": 1, "kind": "team_mention", "urgent": True, "message_id": 42}])
    assert (parsed.urgent, parsed.message_id) == (True, 42)
    [plain] = parse_items([{"id": 2, "kind": "channel_event", "urgent": "yes", "message_id": "x"}])
    assert (plain.urgent, plain.message_id) == (False, None)


def test_only_an_agent_asking_or_waiting_on_the_user_needs_them() -> None:
    assert needs_you(1).needs_you
    assert not urgent(1).needs_you
    assert not ci_failed(1).needs_you
    [parsed] = parse_items([{"id": 1, "kind": "watch_event", "event": "needs_you", "urgent": True}])
    assert parsed.needs_you


async def test_an_urgent_mention_or_ci_failure_never_speaks_on_its_own() -> None:
    voice = Voice()
    voice.sleeping = True
    voice.inbox.offer([urgent(1), ci_failed(2)])
    voice.clock.now += 3600
    assert not await voice.delivery.step()
    assert voice.taken == []
    assert voice.woken == 0
    assert [i.id for i in voice.inbox.take()] == [1, 2]


async def test_a_needs_you_item_speaks_alone_after_thirty_seconds_of_complete_silence() -> None:
    voice = Voice()
    voice.inbox.offer([item(1), urgent(3), ci_failed(4), needs_you(2)])
    voice.clock.now += URGENT_SILENCE_SECS - 1
    assert not await voice.delivery.step()
    voice.clock.now += 1
    assert await voice.delivery.step()
    assert voice.taken == [[2]]
    assert voice.woke == [False]
    assert voice.inbox.waiting
    assert not voice.inbox.needs_you_waiting
    voice.gate.replying(True)
    voice.gate.replying(False)
    voice.clock.now += 3600
    assert not await voice.delivery.step()
    assert voice.taken == [[2]]


async def test_no_fallback_fires_while_the_user_speaks_or_soon_after() -> None:
    voice = Voice()
    voice.inbox.offer([needs_you(1)])
    voice.gate.user_turn(True)
    voice.gate.user_voice(True)
    voice.clock.now += 120
    assert not await voice.delivery.step()
    voice.gate.user_voice(False)
    voice.clock.now += 60
    assert not await voice.delivery.step()
    voice.gate.user_voice(True)
    voice.gate.user_voice(False)
    voice.gate.user_turn(False)
    voice.gate.expect_reply()
    voice.clock.now += 5
    assert not await voice.delivery.step()
    voice.gate.replying(True)
    voice.gate.bot_speaking(True)
    voice.gate.replying(False)
    voice.clock.now += 40
    assert not await voice.delivery.step()
    voice.gate.bot_speaking(False)
    voice.clock.now += URGENT_SILENCE_SECS - 1
    assert not await voice.delivery.step()
    assert voice.taken == []
    voice.clock.now += 1
    assert await voice.delivery.step()
    assert voice.taken == [[1]]


async def test_after_a_long_silence_a_needs_you_item_wakes_a_sleeping_ea() -> None:
    voice = Voice()
    voice.sleeping = True
    voice.inbox.offer([item(1), needs_you(2)])
    voice.clock.now += URGENT_SILENCE_SECS
    assert await voice.delivery.step()
    assert voice.woken == 1
    assert voice.taken == [[2]]
    assert voice.woke == [True]
    assert voice.inbox.waiting


async def test_a_failed_needs_you_delivery_does_not_wake_the_ea() -> None:
    voice = Voice(fail=True)
    voice.sleeping = True
    voice.inbox.offer([needs_you(1)])
    voice.clock.now += URGENT_SILENCE_SECS
    assert not await voice.delivery.step()
    assert voice.woken == 0
    assert voice.inbox.needs_you_waiting


async def test_waking_for_the_inbox_switches_the_ea_awake_and_tells_the_ui() -> None:
    wake = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=30))
    sent: list[dict[str, Any]] = []

    async def announce() -> None:
        sent.append(wake_message(wake))

    assert not wake.awake
    assert await wake_up(wake, announce)
    assert wake.awake
    assert sent == [{"type": "ea-wake", "enabled": True, "awake": True, "phrase": "Hey Seti", "local": False}]
    assert not await wake_up(wake, announce)
    assert len(sent) == 1
    off = WakeStrategy(WakeSettings())
    assert not await wake_up(off, announce)
    assert len(sent) == 1


def test_the_spoken_note_says_who_asked_what_in_one_sentence_and_opens_politely() -> None:
    plain = voice_urgent_note(woke=False)
    assert plain == VOICE_URGENT_NOTE
    assert "one short spoken sentence" in plain
    assert "The voicemail agent is asking whether it can merge its PR" in plain
    assert "wait for the user's answer" in plain
    assert "Pardon" not in plain
    assert "Pardon the interruption" in voice_urgent_note(woke=True)


def test_on_a_call_the_ea_waits_for_the_user_before_replying_to_a_mention() -> None:
    guard = InboxGuard(VOICE_HELD_TOOLS)
    guard.active = True
    assert guard.check(REPLY_TOOL) is not None
    assert guard.check("stop_task") is not None
    assert InboxGuard().check(REPLY_TOOL) is None
    assert REPLY_TOOL in INBOX_TOOLS
    assert ACTION_TOOLS.isdisjoint(INBOX_TOOLS)


def test_the_prompt_has_rules_for_answering_mentions() -> None:
    assert "reply_team_chat answers that message" in SYSTEM_PROMPT
    assert "Never commit the user to a decision" in SYSTEM_PROMPT
    assert "Reply that you have asked the user, then ask them." in SYSTEM_PROMPT


async def test_the_reply_tool_answers_only_the_agent_that_asked(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.team_deliveries = [
        {"task_id": "id-voicemail", "handle": "voicemail", "mode": "next", "reason": None}
    ]
    result = await tools.call("reply_team_chat", {"message_id": 42, "text": "Yes, CI is green."})
    assert result.ok
    assert fake_seti.posts() == [("/api/team/messages", {"text": "Yes, CI is green.", "reply_to": 42})]
    assert result.text == "Replied in the group chat. It reaches @voicemail at its next step."
    assert result.summary == "Replied to @voicemail in the group chat"
    missing = await tools.call("reply_team_chat", {"text": "hi"})
    assert not missing.ok
    fake_seti.fail[("POST", "/api/team/messages")] = (
        400,
        {"error": {"title": "Bad request", "detail": "A reply reaches only the agent that asked"}},
    )
    refused = await tools.call("reply_team_chat", {"message_id": 42, "text": "@all heads up"})
    assert not refused.ok
    assert "only the agent that asked" in refused.text


def mention_chat(fake_seti: FakeSeti) -> None:
    fake_seti.team = [
        team_message(40, "user", "@voicemail please finish the retry logic"),
        team_message(41, "task", "Retry logic done, CI is green.", author_handle="voicemail"),
        team_message(42, "task", "@ea may I merge my PR?", author_handle="voicemail"),
    ]
    fake_seti.inbox_item(
        "team_mention",
        "@voicemail mentioned you in the group chat",
        event="mention",
        source="@voicemail",
        urgent=True,
        message_id=42,
    )


async def test_with_no_call_a_mention_goes_to_the_chat_model(fake_seti: FakeSeti) -> None:
    mention_chat(fake_seti)
    answered: list[Delivered] = []

    async def follow_up(delivered: Delivered) -> None:
        answered.append(delivered)

    assert await InboxPump(seti_of(fake_seti), Conversation(), follow_up).tick() == 1
    assert [[i.message_id for i in d.for_model] for d in answered] == [[42]]
    assert fake_seti.inbox[0]["delivered_via"] == "chat"


async def test_a_headless_mention_is_answered_in_the_group_chat_and_noted_for_the_user(
    fake_seti: FakeSeti,
) -> None:
    mention_chat(fake_seti)
    note = "The voicemail agent asked whether it may merge; I told it merges wait for you."
    script = Script(
        [
            [("call-1", REPLY_TOOL, {"message_id": 42, "text": "Merges wait for the user; I have asked."})],
            [note],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())
    delivered = await deliver(seti_of(fake_seti), [1], "chat")

    await chat.follow_up(delivered)
    await settle(chat)

    opening = script.seen[0][1]["content"]
    assert opening.startswith("The inbox notes above arrived while no call was on")
    assert "answer the one who asked with reply_team_chat" in opening
    assert "- #41 @voicemail (10 minutes ago): Retry logic done, CI is green." in opening
    assert "- #42 @voicemail (10 minutes ago): @ea may I merge my PR?" in opening
    reply = ("/api/team/messages", {"text": "Merges wait for the user; I have asked.", "reply_to": 42})
    assert reply in fake_seti.posts()
    assert stored(fake_seti)[-1][1] == {"role": "assistant", "content": note}


async def test_a_mention_that_needs_an_action_is_put_to_the_user(fake_seti: FakeSeti) -> None:
    mention_chat(fake_seti)
    question = "The voicemail agent wants to merge its PR; shall I tell it to go ahead? Shall I go ahead?"
    script = Script([[question]])
    chat = make_chat(fake_seti, script, Conversation())
    delivered = await deliver(seti_of(fake_seti), [1], "chat")

    await chat.follow_up(delivered)
    await settle(chat)

    assert not [body for path, body in fake_seti.posts() if path == "/api/team/messages"]
    assert stored(fake_seti)[-1][1] == {"role": "assistant", "content": question}
    assert "ask them here" in script.seen[0][1]["content"]
