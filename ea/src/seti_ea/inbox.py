"""The EA inbox: follow-ups, reminders and events Seti queues, told on a call or in the chat."""

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, cast

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
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
from pipecat.observers.base_observer import BaseObserver, FramePushed

from seti_ea.actions import CHANGE_TOOLS
from seti_ea.asks import AnsweredAsk, parse_answered
from seti_ea.history import Entry, parse_entries
from seti_ea.seti import SetiClient, SetiError
from seti_ea.settle import Settle
from seti_ea.toolkit import ToolResult

if TYPE_CHECKING:
    from seti_ea.conversation import Conversation

Via = Literal["voice", "chat"]

MENTION_KIND = "team_mention"
WATCH_KIND = "watch_event"
NEEDS_YOU_EVENT = "needs_you"
CHANNEL_KIND = "channel_event"
# Follow-ups and reminders wait for the model; without one, events and mentions go out as they are.
CHECKED_KINDS = frozenset({"followup", "reminder"})
# Channel alerts need triage, so the model reports on them; task watch events speak for themselves.
MODEL_KINDS = CHECKED_KINDS | {MENTION_KIND, CHANNEL_KIND}
# Tools that act on tasks or change anything; an inbox report never uses them unasked.
ACTION_TOOLS = (
    frozenset({"start_task", "stop_task", "hand_over_updates", "post_team_chat", "confirm_asked"})
    | CHANGE_TOOLS
)
# An alert from a channel the user set to act may go to an existing agent as a direct message;
# a public post and starting an agent still ask.
ACT_TOOLS = frozenset({"post_team_chat"})
REPLY_TOOL = "reply_team_chat"
# On a call the user hears a mention first and answers it; the EA does not reply on its own.
VOICE_HELD_TOOLS = ACTION_TOOLS | {REPLY_TOOL}

# On a call only a needs-you item speaks on its own, and only after this much complete silence.
URGENT_SILENCE_SECS = 30.0
REPLY_WAIT_SECS = 20.0
CHECK_SECS = 0.5
DEFAULT_POLL_SECS = 5.0
CALL_POLL_SECS = 2.0


@dataclass(frozen=True)
class InboxItem:
    """One item Seti holds for the EA."""

    id: int
    kind: str
    event: str
    title: str
    source: str
    severity: str
    task_id: str | None
    timezone: str | None
    due_at: str
    urgent: bool = False
    message_id: int | None = None
    act: bool = False
    # The one surface Seti's attention router picked once delivered: toast, push, digest and so on.
    route: str | None = None

    @property
    def needs_you(self) -> bool:
        """An agent asks the user or waits on them; only this may speak up after a long silence."""
        return self.kind == WATCH_KIND and self.event == NEEDS_YOU_EVENT


def is_direct(arguments: Mapping[str, Any] | None) -> bool:
    """Whether a post_team_chat call names one recipient, which makes it a direct message."""
    to = (arguments or {}).get("to")
    return isinstance(to, str) and to.strip() != ""


def split_act(items: Sequence[InboxItem]) -> list[list[InboxItem]]:
    """Items in report turns of their own: act items apart, so only they can open ACT_TOOLS."""
    groups = [[item for item in items if not item.act], [item for item in items if item.act]]
    return [group for group in groups if group]


def parse_items(data: object) -> list[InboxItem]:
    """Items from a Seti answer, skipping anything malformed."""
    if not isinstance(data, list):
        return []
    items: list[InboxItem] = []
    for raw in cast(list[object], data):
        if not isinstance(raw, dict):
            continue
        fields = cast(Mapping[str, Any], raw)
        item_id = fields.get("id")
        if not isinstance(item_id, int):
            continue
        task_id = fields.get("task_id")
        zone = fields.get("timezone")
        message_id = fields.get("message_id")
        route = fields.get("route")
        items.append(
            InboxItem(
                id=item_id,
                kind=str(fields.get("kind", "")),
                event=str(fields.get("event", "")),
                title=str(fields.get("title", "")),
                source=str(fields.get("source", "")),
                severity=str(fields.get("severity", "info")),
                task_id=task_id if isinstance(task_id, str) else None,
                timezone=zone if isinstance(zone, str) else None,
                due_at=str(fields.get("due_at", "")),
                urgent=fields.get("urgent") is True,
                message_id=message_id if isinstance(message_id, int) else None,
                act=fields.get("act") is True,
                route=route if isinstance(route, str) else None,
            )
        )
    return items


@dataclass(frozen=True)
class Delivered:
    """What Seti marked delivered in one call, and the history entries that carry it."""

    items: list[InboxItem]
    entries: list[Entry]

    @property
    def for_model(self) -> list[InboxItem]:
        return [item for item in self.items if item.kind in MODEL_KINDS]

    @property
    def act(self) -> bool:
        """Every item the model reports on came from a channel the user set to act."""
        items = self.for_model
        return bool(items) and all(item.act for item in items)

    @property
    def toast(self) -> bool:
        """Seti's router sent an item the model reports on to a toast, so the report waits unseen."""
        return any(item.route in (None, "toast") for item in self.for_model)

    @property
    def mentions(self) -> list[InboxItem]:
        return [item for item in self.items if item.kind == MENTION_KIND]


async def deliver(seti: SetiClient, ids: Sequence[int], via: Via, notify: Sequence[int] = ()) -> Delivered:
    """Takes the items; any another caller took first are left out of the answer.

    The items in `notify` wait for the user as unseen messages, since no report follows them.
    """
    body: dict[str, Any] = {"ids": list(ids), "via": via}
    if notify:
        body["notify"] = list(notify)
    data = await seti.post("/ea/inbox/deliver", body)
    fields = cast(Mapping[str, Any], data) if isinstance(data, dict) else {}
    return Delivered(parse_items(fields.get("items")), parse_entries({"entries": fields.get("entries")}))


class SilenceGate:
    """How long a call has been fully silent: no turn open, nobody speaking, no reply due."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._last = clock()
        self._turn = False
        self._voice = False
        self._bot = False
        self._replying = False
        self._tools: set[str] = set()
        self._awaiting_until: float | None = None

    def _touch(self) -> None:
        self._last = self._clock()

    def user_turn(self, open_: bool) -> None:
        """The user's turn opened or closed; a pause inside an open turn is still the user's."""
        self._turn = open_
        self._touch()

    def user_voice(self, speaking: bool) -> None:
        self._voice = speaking
        self._touch()

    def bot_speaking(self, speaking: bool) -> None:
        self._bot = speaking
        self._touch()

    def interrupted(self) -> None:
        """The EA's reply was cut short, so no reply is in flight any more."""
        self._replying = False
        self._bot = False
        self._touch()

    def replying(self, replying: bool) -> None:
        self._replying = replying
        if replying:
            self._awaiting_until = None
        self._touch()

    def tool(self, call_id: str, running: bool) -> None:
        if running:
            self._tools.add(call_id)
        else:
            self._tools.discard(call_id)
        self._touch()

    def expect_reply(self) -> None:
        """The user finished a turn; the reply to it has not started yet."""
        self._awaiting_until = self._clock() + REPLY_WAIT_SECS
        self._touch()

    def silent(self, secs: float) -> bool:
        """Nobody has spoken, replied or run a tool for `secs`, and no reply is due."""
        now = self._clock()
        awaiting = self._awaiting_until is not None and now < self._awaiting_until
        busy = self._turn or self._voice or self._bot or self._replying or bool(self._tools) or awaiting
        return not busy and now - self._last >= secs


class SilenceObserver(BaseObserver):
    """Feeds the silence gate from the frames that move through the call's pipeline."""

    def __init__(self, gate: SilenceGate) -> None:
        super().__init__()
        self._gate = gate

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        match frame:
            case UserStartedSpeakingFrame():
                self._gate.user_turn(True)
            case UserStoppedSpeakingFrame():
                self._gate.user_turn(False)
            case VADUserStartedSpeakingFrame():
                self._gate.user_voice(True)
            case VADUserStoppedSpeakingFrame():
                self._gate.user_voice(False)
            case BotStartedSpeakingFrame():
                self._gate.bot_speaking(True)
            case BotStoppedSpeakingFrame():
                self._gate.bot_speaking(False)
            case LLMFullResponseStartFrame():
                self._gate.replying(True)
            case LLMFullResponseEndFrame():
                self._gate.replying(False)
            case FunctionCallInProgressFrame():
                self._gate.tool(frame.tool_call_id, True)
            case FunctionCallResultFrame():
                self._gate.tool(frame.tool_call_id, False)
            case InterruptionFrame():
                self._gate.interrupted()
            case _:
                pass


class InboxGuard:
    """While the EA reports from its inbox unasked, tools that act on tasks wait for the user.

    A report on act items alone may also use ACT_TOOLS.
    """

    def __init__(self, held: frozenset[str] = ACTION_TOOLS) -> None:
        self.active = False
        self.acting = False
        self._held = held

    def report(self, delivered: "Delivered") -> None:
        """Holds actions for a report on these items, opening ACT_TOOLS when all of them act."""
        self.active = True
        self.acting = delivered.act

    def check(self, tool: str, arguments: Mapping[str, Any] | None = None) -> ToolResult | None:
        if not self.active or tool not in self._held:
            return None
        if self.acting and tool in ACT_TOOLS and is_direct(arguments):
            return None
        return ToolResult(
            "The user has not asked for this; you are reporting from your inbox. Tell the user what "
            "you suggest and wait for their yes before acting.",
            "Waiting for the user's yes",
            False,
        )


class CallInbox:
    """Items that reached a live call and wait for the user's next turn."""

    def __init__(self) -> None:
        self._pending: dict[int, InboxItem] = {}

    def offer(self, items: Sequence[InboxItem]) -> None:
        """Adds what waits; an item Seti updated in place replaces the copy held here."""
        for item in items:
            self._pending[item.id] = item

    @property
    def waiting(self) -> bool:
        return bool(self._pending)

    @property
    def needs_you_waiting(self) -> bool:
        return any(item.needs_you for item in self._pending.values())

    def take(self, *, needs_you_only: bool = False) -> list[InboxItem]:
        """Everything that waits, oldest first; with needs_you_only, only the needs-you items."""
        picked = [item for item in self._pending.values() if item.needs_you or not needs_you_only]
        for item in picked:
            del self._pending[item.id]
        return sorted(picked, key=lambda item: (item.due_at, item.id))


Take = Callable[[Sequence[int]], Awaitable[Delivered]]


async def take_items(inbox: CallInbox, items: list[InboxItem], take: Take) -> Delivered | None:
    """Delivers items taken from the call's inbox; when Seti fails they wait there again."""
    if not items:
        return None
    try:
        delivered = await take([item.id for item in items])
    except SetiError as e:
        logger.warning(f"EA inbox not delivered on the call: {e}")
        inbox.offer(items)
        return None
    return delivered if delivered.items else None


@dataclass
class VoiceDelivery:
    """Speaks a needs-you item on its own once the call has been silent for URGENT_SILENCE_SECS.

    Everything else, urgent mentions, failed CI and critical alerts included, waits for the user's
    next turn, and so does a needs-you item until then.
    """

    inbox: CallInbox
    gate: SilenceGate
    asleep: Callable[[], bool]
    take: Take
    report: Callable[[Delivered, bool], Awaitable[None]]
    wake: Callable[[], Awaitable[None]]

    async def step(self) -> bool:
        """Speaks what needs the user once the call has been silent long enough; True when it did."""
        if not self.inbox.needs_you_waiting or not self.gate.silent(URGENT_SILENCE_SECS):
            return False
        delivered = await take_items(self.inbox, self.inbox.take(needs_you_only=True), self.take)
        if delivered is None:
            return False
        woke = self.asleep()
        if woke:
            await self.wake()
        self.gate.expect_reply()
        await self.report(delivered, woke)
        return True

    async def run(self) -> None:
        while True:
            await asyncio.sleep(CHECK_SECS)
            try:
                await self.step()
            except Exception:
                logger.exception("EA inbox delivery on the call failed")


FollowUp = Callable[[Delivered], Awaitable[None]]
Answer = Callable[[AnsweredAsk], Awaitable[None]]


class InboxPump:
    """Asks Seti for what is due: a live call holds it for the user's next turn, else the chat takes it.

    Off a call, ordinary events wait for their burst to settle, so Seti can fold repeats first.
    """

    def __init__(
        self,
        seti: SetiClient,
        conversation: "Conversation",
        follow_up: FollowUp | None,
        poll_secs: float = DEFAULT_POLL_SECS,
        answer: Answer | None = None,
        settle: Settle | None = None,
    ) -> None:
        self._seti = seti
        self._settle = settle or Settle()
        self._conversation = conversation
        self._follow_up = follow_up
        self._poll = poll_secs
        self._answer = answer
        self._last_error = ""

    async def _answers(self) -> None:
        """Hands each question the user answered in a notification to the EA, once."""
        if self._answer is None:
            return
        for ask in parse_answered(await self._seti.post("/ea/asks/claim", {})):
            await self._answer(ask)

    async def tick(self) -> int:
        """One round; returns how many items it handed on."""
        await self._answers()
        call = self._conversation.call
        live: dict[str, str | int] | None = {"call": "1"} if call is not None else None
        items = parse_items(await self._seti.get("/ea/inbox/due", live))
        if call is not None:
            call.offer(items)
            return len(items)
        items = self._settle.ready(items)
        if self._follow_up is None:
            items = [item for item in items if item.kind not in CHECKED_KINDS]
        count = 0
        for group in split_act(items):
            told = [item.id for item in group if self._follow_up is None or item.kind not in MODEL_KINDS]
            delivered = await deliver(self._seti, [item.id for item in group], "chat", told)
            if delivered.for_model and self._follow_up is not None:
                await self._follow_up(delivered)
            count += len(delivered.items)
        return count

    async def run(self) -> None:
        while True:
            try:
                await self.tick()
                self._last_error = ""
            except SetiError as e:
                if str(e) != self._last_error:
                    logger.warning(f"EA inbox: {e}")
                self._last_error = str(e)
            except Exception:
                logger.exception("EA inbox round failed")
            live = self._conversation.call is not None
            await asyncio.sleep(min(self._poll, CALL_POLL_SECS) if live else self._poll)
