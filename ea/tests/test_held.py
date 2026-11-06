from typing import Any, cast

import httpx
from fakes import FakeSeti
from pipecat.frames.frames import (
    LLMContextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from test_inbox import Clock, push_to

from seti_ea.conversation import Conversation
from seti_ea.held import HeldUpdates
from seti_ea.history import SUMMARY_PREFIX, HistorySync, ends_with_user
from seti_ea.inbox import (
    CallInbox,
    Delivered,
    InboxPump,
    SilenceGate,
    SilenceObserver,
    VoiceDelivery,
    deliver,
)
from seti_ea.prompt import ACT_NOTE, SYSTEM_PROMPT, VOICE_HELD_NOTE
from seti_ea.seti import SetiClient

REQUEST = (
    "And also be on top of the SDLC change agent. I wanna know what it's doing. And let him know "
    "that he should open a PR."
)
MENTION = "@atlas-eng-lead mentioned you in the group chat"


def message(role: str, content: str) -> LLMContextMessage:
    return cast(LLMContextMessage, {"role": role, "content": content})


class Call:
    """One live call: the pump, the silence gate, the urgent fallback and the held updates."""

    def __init__(self, fake: FakeSeti) -> None:
        self.seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
        self.clock = Clock()
        self.gate = SilenceGate(clock=self.clock)
        self.observer = SilenceObserver(self.gate)
        self.inbox = CallInbox()
        self.conversation = Conversation()
        self.conversation.call = self.inbox
        self.context = LLMContext()
        self.history = HistorySync(self.seti, self.context)
        self.spoken: list[Delivered] = []
        self.delivery = VoiceDelivery(
            inbox=self.inbox,
            gate=self.gate,
            asleep=lambda: False,
            take=self.take,
            report=self.report,
            wake=self.wake,
        )
        self.held = HeldUpdates(self.inbox, self.take, self.history)

    async def take(self, ids: Any) -> Delivered:
        return await deliver(self.seti, ids, "voice")

    async def report(self, delivered: Delivered, _woke: bool) -> None:
        self.spoken.append(delivered)

    async def wake(self) -> None:
        pass

    async def hear(self, *frames: Any) -> None:
        for frame in frames:
            await push_to(self.observer, frame)

    async def poll(self) -> int:
        return await InboxPump(self.seti, self.conversation, None).tick()


def delivers(fake: FakeSeti) -> list[Any]:
    return [body for path, body in fake.posts() if path == "/api/ea/inbox/deliver"]


async def test_an_update_mid_sentence_waits_and_follows_the_users_request(fake_seti: FakeSeti) -> None:
    call = Call(fake_seti)
    call.context.add_message(message("assistant", "I've told Atlas."))
    await call.history.flush()
    await call.hear(UserStartedSpeakingFrame(), VADUserStartedSpeakingFrame(), VADUserStoppedSpeakingFrame())
    fake_seti.inbox_item("team_mention", MENTION, event="mention", urgent=True, message_id=906)
    assert await call.poll() == 1
    for pause in (0.5, 2.0, 10.0, 60.0):
        call.clock.now += pause
        assert not await call.delivery.step()
    assert call.spoken == []
    assert delivers(fake_seti) == []

    await call.hear(VADUserStartedSpeakingFrame(), VADUserStoppedSpeakingFrame(), UserStoppedSpeakingFrame())
    call.context.add_message(message("user", REQUEST))
    assert await call.held.add(LLMContextFrame(context=call.context))

    assert call.context.messages[-3:] == [
        message("user", REQUEST),
        message("developer", f"Inbox: {MENTION}."),
        message("developer", VOICE_HELD_NOTE),
    ]
    assert delivers(fake_seti) == [{"ids": [1], "via": "voice"}]
    assert [e["message"]["role"] for e in fake_seti.ea_history] == ["assistant", "user", "developer"]
    assert not call.inbox.waiting
    assert call.spoken == []


def test_the_held_note_puts_the_user_first_and_the_updates_in_one_line_after() -> None:
    assert "Answer the user's words first" in VOICE_HELD_NOTE
    assert 'one short spoken sentence that starts with "Also,"' in VOICE_HELD_NOTE
    assert "newest and most relevant first" in VOICE_HELD_NOTE
    assert "detail only if asked" in VOICE_HELD_NOTE
    assert "On a call, updates never interrupt the user." in SYSTEM_PROMPT


async def test_only_a_reply_to_the_users_turn_takes_the_held_updates(fake_seti: FakeSeti) -> None:
    call = Call(fake_seti)
    assert not await call.held.add(LLMContextFrame(context=call.context))
    assert fake_seti.posts() == []
    fake_seti.inbox_item("watch_event", "Voicemail finished its turn")
    assert await call.poll() == 1
    call.context.add_message(message("user", "What is running?"))
    call.context.add_message(message("assistant", "Two agents."))
    call.context.add_message(message("developer", "Seti checked your last reply: send it."))
    assert not await call.held.add(LLMContextFrame(context=call.context))
    call.context.add_message(message("user", "Thanks."))
    assert not await call.held.add(LLMContextFrame(context=call.context, speculation=True))
    assert delivers(fake_seti) == []
    assert call.inbox.waiting
    assert await call.held.add(LLMContextFrame(context=call.context))
    assert delivers(fake_seti) == [{"ids": [1], "via": "voice"}]


async def test_held_act_alerts_keep_what_act_opens(fake_seti: FakeSeti) -> None:
    call = Call(fake_seti)
    fake_seti.inbox_item("channel_event", "Slack mentions alert: dana in #northwind", act=True)
    assert await call.poll() == 1
    call.context.add_message(message("user", "Anything new?"))
    assert await call.held.add(LLMContextFrame(context=call.context))
    assert call.context.messages[-1] == message("developer", f"{VOICE_HELD_NOTE} {ACT_NOTE}")


def test_a_summary_is_not_the_users_words() -> None:
    summary = message("user", f"{SUMMARY_PREFIX} They asked.")
    assert not ends_with_user([summary])
    assert ends_with_user([message("user", "Hi."), message("developer", "Live note")])
    assert not ends_with_user([message("user", "Hi."), message("assistant", "Hello.")])
    assert not ends_with_user([])
