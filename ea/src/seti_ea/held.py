"""On a call, updates wait for the user's next turn and join the context after the user's words."""

from collections.abc import Awaitable, Callable

from pipecat.frames.frames import Frame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from seti_ea.history import HistorySync, ends_with_user
from seti_ea.inbox import CallInbox, Take, take_items
from seti_ea.prompt import voice_held_note
from seti_ea.relays import act_note


class HeldUpdates(FrameProcessor):
    """Adds what waited in the call's inbox after the user's turn, with a note to answer them first.

    The user's words are stored first, so the stored history keeps the same order as the context.
    Notes from a channel the user set to act come with the assign rules; `assign_on` says whether
    they may start agents too.
    """

    def __init__(
        self,
        inbox: CallInbox,
        take: Take,
        history: HistorySync,
        assign_on: Callable[[], Awaitable[bool]] | None = None,
    ) -> None:
        super().__init__()
        self._inbox = inbox
        self._take = take
        self._history = history
        self._assign_on = assign_on

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMContextFrame):
            await self.add(frame)
        await self.push_frame(frame, direction)

    async def add(self, frame: LLMContextFrame) -> bool:
        """Adds what waits when the frame answers a user turn; True when it added any."""
        if frame.speculation or not self._inbox.waiting or not ends_with_user(frame.context.messages):
            return False
        await self._history.flush()
        delivered = await take_items(self._inbox, self._inbox.take(), self._take)
        if delivered is None or not await self._history.merge(delivered.entries):
            return False
        rules = None
        if delivered.act:
            starts = self._assign_on is not None and await self._assign_on()
            rules = act_note(delivered.for_model, starts=starts, voice=True)
        self._history.add_unstored(voice_held_note(rules))
        return True
