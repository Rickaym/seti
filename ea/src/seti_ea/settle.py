"""The settle window: a burst of events waits until it stops, so Seti folds repeats in first."""

import time
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from seti_ea.inbox import InboxItem

SETTLE_SECS = 45.0
# A steady stream of events still goes out this long after the first of them arrived.
SETTLE_MAX_SECS = 180.0
# Events come in bursts; follow-ups, reminders and mentions are addressed to the EA and go at once.
SETTLED_KINDS = frozenset({"watch_event", "channel_event"})

Signature = tuple[str, str, str]


class Settle:
    """Holds ordinary events until none has arrived or changed for a quiet spell."""

    def __init__(
        self,
        quiet_secs: float = SETTLE_SECS,
        max_secs: float = SETTLE_MAX_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._quiet = quiet_secs
        self._max = max_secs
        self._clock = clock
        self._seen: dict[int, Signature] = {}
        self._first: float | None = None
        self._last: float | None = None

    def _settled(self, seen: dict[int, Signature]) -> bool:
        now = self._clock()
        if not seen:
            self._first = self._last = None
            return False
        first = now if self._first is None else self._first
        changed = any(self._seen.get(item_id) != signature for item_id, signature in seen.items())
        last = now if self._last is None or changed else self._last
        if now - last >= self._quiet or now - first >= self._max:
            self._first = self._last = None
            return True
        self._first, self._last = first, last
        return False

    def ready(self, items: Sequence["InboxItem"]) -> list["InboxItem"]:
        """What goes out now, in order: urgent items and other kinds always, events once settled."""
        held = {item.id for item in items if item.kind in SETTLED_KINDS and not item.urgent}
        seen = {item.id: (item.event, item.title, item.severity) for item in items if item.id in held}
        settled = self._settled(seen)
        self._seen = seen
        return [item for item in items if settled or item.id not in held]
