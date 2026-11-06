import json
from collections.abc import Sequence
from dataclasses import replace
from types import SimpleNamespace
from typing import cast

import httpx
import pytest
from fakes import TASK_LOGIN, TASK_LOGOUT, FakeSeti
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams
from test_chat import Script, Step, make_chat, settle, stored

from seti_ea.bot import tool_schemas
from seti_ea.chat import INBOX_TOOLS
from seti_ea.clock import CURRENT_CLOCK, parse_user_clock
from seti_ea.conversation import Conversation
from seti_ea.inbox import (
    ACT_TOOLS,
    ACTION_TOOLS,
    URGENT_SILENCE_SECS,
    CallInbox,
    Delivered,
    InboxGuard,
    InboxItem,
    InboxPump,
    SilenceGate,
    SilenceObserver,
    VoiceDelivery,
    deliver,
    parse_items,
    split_act,
)
from seti_ea.prompt import ACT_NOTE
from seti_ea.seti import SetiClient, SetiError
from seti_ea.settle import Settle
from seti_ea.toolkit import ToolResult
from seti_ea.tools import INBOX_ORIGIN, EaTools


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def seti_of(fake: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))


def item(
    item_id: int, kind: str = "watch_event", title: str = "Voicemail finished its turn", *, act: bool = False
) -> InboxItem:
    return InboxItem(
        item_id, kind, "turn_finished", title, "Voicemail", "success", None, None, f"t{item_id}", act=act
    )


async def test_schedule_followup_sends_the_user_timezone_task_and_origin(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    CURRENT_CLOCK.set(parse_user_clock({"timezone": "Europe/Berlin"}))
    origin = INBOX_ORIGIN.set(7)
    try:
        result = await tools.call(
            "schedule_followup", {"when": "in 20 minutes", "note": "Check the login CI", "task": "login"}
        )
    finally:
        INBOX_ORIGIN.reset(origin)
    assert result.ok
    assert result.text == (
        "Scheduled a follow-up for Sunday 14:20 (Europe/Berlin), in 20 minutes: Check the login CI"
    )
    assert result.summary == "Follow-up Sunday 14:20"
    path, body = fake_seti.posts()[-1]
    assert path == "/api/ea/followups"
    assert body == {
        "kind": "followup",
        "when": "in 20 minutes",
        "note": "Check the login CI",
        "timezone": "Europe/Berlin",
        "task_id": TASK_LOGIN,
        "parent_id": 7,
    }


async def test_reminders_and_unknown_zones_and_bad_times(tools: EaTools, fake_seti: FakeSeti) -> None:
    CURRENT_CLOCK.set(parse_user_clock(None))
    result = await tools.call("schedule_followup", {"when": "at 3pm", "note": "Stretch", "kind": "reminder"})
    assert result.ok
    assert result.text.startswith("Scheduled a reminder for Sunday 14:20 (UTC)")
    assert fake_seti.posts()[-1][1]["timezone"] == "UTC"
    bad = await tools.call("schedule_followup", {"when": "yesterday", "note": "Too late"})
    assert not bad.ok
    assert bad.text == 'Seti could not schedule it: "yesterday" is in the past'


async def test_list_and_cancel_followups(tools: EaTools, fake_seti: FakeSeti) -> None:
    assert (await tools.call("list_followups", {})).text == "Nothing is scheduled."
    await tools.call("schedule_followup", {"when": "in 5 minutes", "note": "Check the deploy"})
    await tools.call("schedule_followup", {"when": "in 9 minutes", "note": "Check the docs build"})
    listed = await tools.call("list_followups", {})
    assert listed.text.splitlines()[0] == "2 items scheduled, soonest first:"
    assert "follow-up: Check the deploy" in listed.text
    ambiguous = await tools.call("cancel_followup", {"followup": "check"})
    assert not ambiguous.ok
    cancelled = await tools.call("cancel_followup", {"followup": "docs build"})
    assert cancelled.ok
    assert cancelled.text.startswith("Cancelled: Check the docs build, which was due Sunday 14:20")
    assert [f["title"] for f in fake_seti.followups] == ["Check the deploy"]


async def test_watch_unwatch_and_list(tools: EaTools, fake_seti: FakeSeti) -> None:
    assert (await tools.call("list_watches", {})).text == "You are not watching any task."
    watched = await tools.call("watch_task", {"task": "login", "note": "tell me when CI is green"})
    assert watched.summary == "Watching Fix the login redirect bug"
    assert fake_seti.posts()[-1] == (
        "/api/ea/watches",
        {"task_id": TASK_LOGIN, "note": "tell me when CI is green"},
    )
    listed = await tools.call("list_watches", {})
    assert listed.text == "Watching 1 task:\n- Fix the login redirect bug: tell me when CI is green"
    assert (await tools.call("watch_task", {"task": "login", "stop": True})).ok
    again = await tools.call("watch_task", {"task": "login", "stop": True})
    assert not again.ok
    assert again.text == "You were not watching Fix the login redirect bug."


async def test_watch_once_waits_for_the_turn_to_end(tools: EaTools, fake_seti: FakeSeti) -> None:
    running = await tools.call("watch_task", {"task": "login", "once": True})
    assert (
        running.text
        == "You will hear once when Fix the login redirect bug ends its current turn, with its final message."
    )
    assert running.summary == "Waiting on Fix the login redirect bug"
    idle = await tools.call("watch_task", {"task": "logout", "once": True})
    assert "ends its next turn" in idle.text
    assert fake_seti.posts()[-2:] == [
        ("/api/ea/watches", {"task_id": TASK_LOGIN, "note": "", "once": True}),
        ("/api/ea/watches", {"task_id": TASK_LOGOUT, "note": "", "once": True}),
    ]


def test_the_gate_counts_silence_only_with_nobody_speaking_and_nothing_due() -> None:
    clock = Clock()
    gate = SilenceGate(clock=clock)
    assert not gate.silent(30)
    clock.now += 30
    assert gate.silent(30)
    for start, stop in (
        (lambda: gate.user_turn(True), lambda: gate.user_turn(False)),
        (lambda: gate.user_voice(True), lambda: gate.user_voice(False)),
        (lambda: gate.bot_speaking(True), lambda: gate.bot_speaking(False)),
        (lambda: gate.replying(True), lambda: gate.replying(False)),
        (lambda: gate.tool("c1", True), lambda: gate.tool("c1", False)),
    ):
        start()
        clock.now += 300
        assert not gate.silent(30)
        stop()
        clock.now += 29
        assert not gate.silent(30)
        clock.now += 1
        assert gate.silent(30)


def test_the_gate_waits_for_the_reply_to_a_finished_turn_but_not_forever() -> None:
    clock = Clock()
    gate = SilenceGate(clock=clock)
    gate.expect_reply()
    clock.now += 5
    assert not gate.silent(2)
    gate.replying(True)
    gate.replying(False)
    clock.now += 2
    assert gate.silent(2)
    gate.expect_reply()
    clock.now += 21
    assert gate.silent(2)


async def push_to(observer: SilenceObserver, frame: Frame) -> None:
    processor = FrameProcessor()
    await observer.on_push_frame(
        FramePushed(
            source=processor,
            destination=processor,
            frame=frame,
            direction=FrameDirection.DOWNSTREAM,
            timestamp=0,
        )
    )


async def test_the_observer_feeds_the_gate_from_pipeline_frames() -> None:
    clock = Clock()
    gate = SilenceGate(clock=clock)
    observer = SilenceObserver(gate)
    call = FunctionCallInProgressFrame(function_name="get_task", tool_call_id="c1", arguments={})
    result = FunctionCallResultFrame(function_name="get_task", tool_call_id="c1", arguments={}, result="ok")
    steps: list[tuple[Frame, bool]] = [
        (UserStartedSpeakingFrame(), False),
        (VADUserStartedSpeakingFrame(), False),
        (VADUserStoppedSpeakingFrame(), False),
        (UserStoppedSpeakingFrame(), True),
        (LLMFullResponseStartFrame(), False),
        (call, False),
        (result, False),
        (LLMFullResponseEndFrame(), True),
        (BotStartedSpeakingFrame(), False),
        (InterruptionFrame(), True),
        (BotStartedSpeakingFrame(), False),
        (BotStoppedSpeakingFrame(), True),
    ]
    for frame, silent in steps:
        await push_to(observer, frame)
        assert gate.silent(0) is silent, type(frame).__name__


class Voice:
    """A call's delivery with a controllable gate, wake state and Seti."""

    def __init__(self, fail: bool = False) -> None:
        self.clock = Clock()
        self.gate = SilenceGate(clock=self.clock)
        self.inbox = CallInbox()
        self.sleeping = False
        self.fail = fail
        self.taken: list[list[int]] = []
        self.reports: list[Delivered] = []
        self.woke: list[bool] = []
        self.woken = 0
        self.delivery = VoiceDelivery(
            inbox=self.inbox,
            gate=self.gate,
            asleep=lambda: self.sleeping,
            take=self.take,
            report=self.report,
            wake=self.wake,
        )

    async def take(self, ids: Sequence[int]) -> Delivered:
        if self.fail:
            raise SetiError("Seti is not reachable")
        self.taken.append(list(ids))
        return Delivered([item(i) for i in ids], [])

    async def report(self, delivered: Delivered, woke: bool) -> None:
        self.reports.append(delivered)
        self.woke.append(woke)

    async def wake(self) -> None:
        self.woken += 1
        self.sleeping = False


@pytest.mark.parametrize("kind", ["followup", "reminder", "channel_event", "watch_event"])
async def test_on_a_call_an_ordinary_item_never_speaks_on_its_own(kind: str) -> None:
    voice = Voice()
    voice.sleeping = True
    voice.inbox.offer([item(2, kind), item(1, kind)])
    voice.clock.now += 3600
    assert not await voice.delivery.step()
    assert voice.taken == []
    assert voice.woken == 0
    assert voice.inbox.take() == [item(1, kind), item(2, kind)]
    assert not voice.inbox.waiting


async def test_a_failed_delivery_puts_items_back() -> None:
    voice = Voice(fail=True)
    voice.inbox.offer([replace(item(1), event="needs_you", urgent=True)])
    voice.clock.now += URGENT_SILENCE_SECS
    assert not await voice.delivery.step()
    assert voice.inbox.needs_you_waiting
    assert voice.reports == []


def test_the_guard_holds_actions_during_an_inbox_report_only() -> None:
    guard = InboxGuard()
    assert guard.check("start_task") is None
    guard.active = True
    refused = guard.check("stop_task")
    assert refused is not None
    assert not refused.ok
    assert guard.check("get_task") is None
    assert ACTION_TOOLS.isdisjoint(INBOX_TOOLS)
    assert {"get_task", "schedule_followup", "list_watches"} <= INBOX_TOOLS


def test_items_parse_and_skip_malformed_ones() -> None:
    parsed = parse_items([{"id": 1, "kind": "followup", "title": "x", "timezone": "UTC"}, {"id": "x"}, 3])
    assert [(i.id, i.kind, i.timezone) for i in parsed] == [(1, "followup", "UTC")]
    assert parse_items({"not": "a list"}) == []


async def test_with_a_call_live_the_pump_holds_items_for_the_next_turn(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("watch_event", "Voicemail finished its turn")
    conversation = Conversation()
    conversation.call = CallInbox()
    pump = InboxPump(seti_of(fake_seti), conversation, None)
    assert await pump.tick() == 1
    assert conversation.call.waiting
    assert fake_seti.posts() == []


async def test_without_a_call_events_are_posted_and_follow_ups_checked(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("watch_event", "Voicemail finished its turn")
    fake_seti.inbox_item("followup", "Check the login CI")
    followed: list[Delivered] = []

    async def follow_up(delivered: Delivered) -> None:
        followed.append(delivered)

    pump = InboxPump(seti_of(fake_seti), Conversation(), follow_up, settle=Settle(0))
    assert await pump.tick() == 2
    assert fake_seti.posts()[-1] == ("/api/ea/inbox/deliver", {"ids": [1, 2], "via": "chat", "notify": [1]})
    assert [[i.title for i in d.for_model] for d in followed] == [["Check the login CI"]]
    assert [e["kind"] for e in fake_seti.ea_history] == ["inbox", "inbox"]
    assert await pump.tick() == 0


async def test_without_a_call_a_channel_alert_is_triaged(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("watch_event", "Voicemail finished its turn")
    fake_seti.inbox_item("channel_event", "Slack mentions alert (info): dana in #northwind")
    followed: list[Delivered] = []

    async def follow_up(delivered: Delivered) -> None:
        followed.append(delivered)

    pump = InboxPump(seti_of(fake_seti), Conversation(), follow_up, settle=Settle(0))
    assert await pump.tick() == 2
    assert [[i.kind for i in d.for_model] for d in followed] == [["channel_event"]]


async def test_without_a_chat_model_follow_ups_wait(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("followup", "Check the login CI")
    fake_seti.inbox_item("channel_event", "api is down")
    pump = InboxPump(seti_of(fake_seti), Conversation(), None, settle=Settle(0))
    assert await pump.tick() == 1
    assert [i["delivered_via"] for i in fake_seti.inbox] == [None, "chat"]


async def test_deliver_reads_items_and_entries(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("reminder", "Review the release")
    delivered = await deliver(seti_of(fake_seti), [1, 1], "voice")
    assert [i.kind for i in delivered.items] == ["reminder"]
    assert [e.kind for e in delivered.entries] == ["inbox"]
    assert (await deliver(seti_of(fake_seti), [1], "voice")).items == []


@pytest.mark.parametrize("zone", ["Europe/Berlin", "+05:30"])
async def test_a_due_follow_up_is_checked_with_tools_and_reported_in_the_chat(
    fake_seti: FakeSeti, zone: str
) -> None:
    fake_seti.inbox_item("followup", "Check the login CI", timezone=zone, task_id=TASK_LOGIN)
    script = Script(
        [
            [
                ("call-1", "get_task", {"task": "login"}),
                ("call-2", "schedule_followup", {"when": "in 10 minutes", "note": "Look again"}),
            ],
            ["The login task is still running; I will look again in ten minutes."],
        ]
    )
    conversation = Conversation()
    chat = make_chat(fake_seti, script, conversation)
    delivered = await deliver(seti_of(fake_seti), [1], "chat")

    await chat.follow_up(delivered)
    await settle(chat)

    seen = script.seen[0]
    assert seen[0] == {"role": "developer", "content": "Inbox: Check the login CI."}
    assert seen[1]["role"] == "developer"
    assert seen[1]["content"].startswith("The inbox notes above arrived while no call was on")
    assert all(message["role"] != "user" for message in seen)
    kinds = [kind for kind, _ in stored(fake_seti)]
    assert kinds == ["inbox"] + ["chat"] * 5
    assert stored(fake_seti)[-1][1] == {
        "role": "assistant",
        "content": "The login task is still running; I will look again in ten minutes.",
    }
    scheduled = json.loads(next(r.content for r in fake_seti.requests if r.url.path == "/api/ea/followups"))
    expected_zone = "Europe/Berlin" if zone == "Europe/Berlin" else "UTC+05:30"
    assert scheduled["parent_id"] == 1
    assert scheduled["timezone"] == expected_zone


async def test_events_alone_need_no_report(fake_seti: FakeSeti) -> None:
    script = Script([])
    chat = make_chat(fake_seti, script, Conversation())
    await chat.follow_up(Delivered([item(1)], []))
    assert script.seen == []


async def test_a_channel_alert_is_reported_in_the_chat_without_acting(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("channel_event", "Slack mentions alert (info): dana in #northwind")
    script = Script([["Dana asks about the Northwind SSO groups. Shall I go ahead?"]])
    chat = make_chat(fake_seti, script, Conversation())
    delivered = await deliver(seti_of(fake_seti), [1], "chat")

    await chat.follow_up(delivered)
    await settle(chat)

    seen = script.seen[0]
    assert seen[0]["content"] == "Inbox: Slack mentions alert (info): dana in #northwind."
    assert "For a channel alert that asks the user for something" in seen[1]["content"]
    assert [kind for kind, _ in stored(fake_seti)] == ["inbox", "chat"]


async def test_a_guarded_report_refuses_actions_without_calling_seti(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    guard = InboxGuard()
    guard.active = True
    results: list[str] = []

    async def report(_tool: str, _result: ToolResult, _call_id: str) -> None:
        return None

    async def result_callback(result: str) -> None:
        results.append(result)

    schemas = {schema.name: schema for schema in tool_schemas(tools, report, guard=guard.check)}
    handler = schemas["stop_task"].handler
    assert handler is not None
    params = SimpleNamespace(arguments={"task": "login"}, tool_call_id="c1", result_callback=result_callback)
    await handler(cast(FunctionCallParams, params))
    assert results[0].startswith("The user has not asked for this")
    assert fake_seti.posts() == []
    only = tool_schemas(tools, report, only=INBOX_TOOLS)
    assert {schema.name for schema in only} == INBOX_TOOLS


def alert(item_id: int, *, act: bool) -> InboxItem:
    return item(item_id, "channel_event", "Slack mentions alert (info): dana in #northwind", act=act)


def test_only_a_report_on_act_items_alone_may_send_a_direct_message() -> None:
    guard = InboxGuard()
    direct = {"to": "login", "text": "Please draft a reply"}
    guard.report(Delivered([alert(1, act=False)], []))
    assert guard.check("post_team_chat", direct) is not None
    guard.report(Delivered([alert(1, act=False), alert(2, act=True)], []))
    assert guard.check("post_team_chat", direct) is not None
    guard.report(Delivered([alert(2, act=True), item(3)], []))
    assert guard.check("post_team_chat", direct) is None
    assert guard.check("post_team_chat", {"text": "@all heads up"}) is not None
    assert guard.check("post_team_chat", {"to": " ", "text": "x"}) is not None
    for held in ("start_task", "stop_task"):
        assert guard.check(held) is not None
    guard.active = False
    assert guard.check("start_task") is None
    assert {"post_team_chat"} == ACT_TOOLS


def test_act_items_split_from_the_rest_and_parse_from_seti() -> None:
    parsed = parse_items([{"id": 1, "kind": "channel_event", "act": True}, {"id": 2, "act": "yes"}])
    assert [(i.id, i.act) for i in parsed] == [(1, True), (2, False)]
    groups = split_act([alert(1, act=True), item(2), alert(3, act=False), alert(4, act=True)])
    assert [[i.id for i in group] for group in groups] == [[2, 3], [1, 4]]
    assert split_act([alert(1, act=True)]) == [[alert(1, act=True)]]
    assert split_act([]) == []


async def test_without_a_call_a_mixed_batch_reports_act_alerts_apart(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("channel_event", "GitHub alert: CI failed on main")
    fake_seti.inbox_item("channel_event", "Slack mentions alert: dana in #northwind", act=True)
    fake_seti.inbox_item("watch_event", "Voicemail finished its turn")
    followed: list[Delivered] = []

    async def follow_up(delivered: Delivered) -> None:
        followed.append(delivered)

    pump = InboxPump(seti_of(fake_seti), Conversation(), follow_up, settle=Settle(0))
    assert await pump.tick() == 3
    delivers = [body for path, body in fake_seti.posts() if path == "/api/ea/inbox/deliver"]
    assert delivers == [{"ids": [1, 3], "via": "chat", "notify": [3]}, {"ids": [2], "via": "chat"}]
    assert [(d.act, [i.id for i in d.for_model]) for d in followed] == [(False, [1]), (True, [2])]


SEND = {"to": "login", "text": "Draft a reply to Dana on the SSO groups; do not send it."}


async def report_alert(fake_seti: FakeSeti, steps: list[Step], *, act: bool) -> Script:
    fake_seti.inbox_item("channel_event", "Slack mentions alert (info): dana in #northwind", act=act)
    script = Script([steps, ["I asked the login agent to draft a reply to Dana."]])
    chat = make_chat(fake_seti, script, Conversation())
    await chat.follow_up(await deliver(seti_of(fake_seti), [1], "chat"))
    await settle(chat)
    return script


def sent_to_agents(fake_seti: FakeSeti) -> list[object]:
    return [body for path, body in fake_seti.posts() if path.startswith(("/api/tasks", "/api/team"))]


async def test_an_act_alert_goes_to_an_existing_agent_as_a_direct_message(fake_seti: FakeSeti) -> None:
    script = await report_alert(fake_seti, [("call-1", "post_team_chat", SEND)], act=True)
    assert ACT_NOTE in script.seen[0][1]["content"]
    assert sent_to_agents(fake_seti) == [{"text": SEND["text"], "to": "bug"}]


async def test_an_act_alert_never_posts_to_everyone(fake_seti: FakeSeti) -> None:
    public = {"text": "@all Dana asked about SSO groups"}
    await report_alert(fake_seti, [("call-1", "post_team_chat", public)], act=True)
    assert sent_to_agents(fake_seti) == []


async def test_a_report_alert_never_reaches_an_agent(fake_seti: FakeSeti) -> None:
    script = await report_alert(fake_seti, [("call-1", "post_team_chat", SEND)], act=False)
    assert ACT_NOTE not in script.seen[0][1]["content"]
    assert sent_to_agents(fake_seti) == []


async def test_an_act_alert_still_cannot_start_a_task(fake_seti: FakeSeti) -> None:
    start = {"title": "Northwind SSO", "prompt": "Answer Dana"}
    await report_alert(fake_seti, [("call-1", "start_task", start)], act=True)
    assert sent_to_agents(fake_seti) == []
