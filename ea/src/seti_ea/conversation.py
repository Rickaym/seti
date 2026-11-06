"""The one EA conversation that voice calls and the typed chat share inside this process."""

import asyncio
from collections.abc import Sequence

from seti_ea.clock import UNKNOWN_CLOCK, UserClock
from seti_ea.history import Entry
from seti_ea.inbox import CallInbox


class Inbox:
    """Entries the other channel stored since the listener last took them."""

    def __init__(self) -> None:
        self._entries: list[Entry] = []

    def put(self, entries: Sequence[Entry]) -> None:
        self._entries.extend(entries)

    def take(self) -> list[Entry]:
        entries, self._entries = self._entries, []
        return entries


class Conversation:
    """One writer at a time for the stored history, and typed turns relayed to a live call.

    Every HistorySync of this process holds `lock` while it appends, so a voice turn and a typed
    reply never interleave their entries. A live call listens for what the chat stored and folds
    it into its context at the start of the user's next spoken turn. `call` holds the live call's
    inbox items until a pause, and `last_clock` is the user's clock as last seen.
    """

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self._inboxes: list[Inbox] = []
        self.call: CallInbox | None = None
        self.last_clock: UserClock = UNKNOWN_CLOCK

    def attach(self) -> Inbox:
        """An inbox for a call that starts listening; detach it when the call ends."""
        inbox = Inbox()
        self._inboxes.append(inbox)
        return inbox

    def detach(self, inbox: Inbox) -> None:
        if inbox in self._inboxes:
            self._inboxes.remove(inbox)

    @property
    def call_live(self) -> bool:
        """True while a voice call listens."""
        return bool(self._inboxes)

    def publish(self, entries: Sequence[Entry]) -> None:
        if not entries:
            return
        for inbox in self._inboxes:
            inbox.put(entries)
