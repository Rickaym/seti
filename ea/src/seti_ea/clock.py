"""The user's local time, from the timezone and clock the browser sends with its offer."""

import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from typing import cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_FIELD_CHARS = 64
MAX_OFFSET = timedelta(hours=14)
NOTE_INTERVAL = timedelta(minutes=5)
CALL_NOTE_PREFIX = "A new call started."
ZONE_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,3}")


@dataclass(frozen=True)
class UserClock:
    """Where the user is in time; `known` is False when only UTC is left to go on."""

    zone: tzinfo
    label: str
    known: bool

    def local(self, at: datetime) -> datetime:
        return at.astimezone(self.zone)


UNKNOWN_CLOCK = UserClock(UTC, "UTC", known=False)

# The clock of the call or chat turn a tool runs in, so times the EA schedules are the user's.
CURRENT_CLOCK: ContextVar[UserClock] = ContextVar("current_clock", default=UNKNOWN_CLOCK)


def _zone(value: object) -> ZoneInfo | None:
    if not isinstance(value, str) or len(value) > MAX_FIELD_CHARS or not ZONE_NAME.fullmatch(value):
        return None
    try:
        return ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def _offset(value: object) -> timezone | None:
    if not isinstance(value, str) or len(value) > MAX_FIELD_CHARS:
        return None
    try:
        offset = datetime.fromisoformat(value).utcoffset()
    except ValueError:
        return None
    if offset is None or abs(offset) > MAX_OFFSET:
        return None
    return timezone(offset)


def parse_user_clock(request_data: object) -> UserClock:
    """The clock from an offer's requestData: its IANA timezone, else its UTC offset, else UTC."""
    if not isinstance(request_data, dict):
        return UNKNOWN_CLOCK
    data = cast(dict[str, object], request_data)
    zone = _zone(data.get("timezone"))
    if zone is not None:
        return UserClock(zone, zone.key, known=True)
    offset = _offset(data.get("localTime"))
    if offset is not None:
        return UserClock(offset, str(offset), known=True)
    return UNKNOWN_CLOCK


def clock_for_zone(name: str | None) -> UserClock:
    """The clock of a timezone Seti stored, such as Europe/Berlin or +02:00; UTC when unknown."""
    if name is None:
        return UNKNOWN_CLOCK
    zone = _zone(name)
    if zone is not None:
        return UserClock(zone, zone.key, known=True)
    offset = _offset(f"2000-01-01T00:00:00{name}")
    return UserClock(offset, str(offset), known=True) if offset is not None else UNKNOWN_CLOCK


def zone_label(clock: UserClock) -> str:
    """The timezone Seti reads times in for this clock."""
    return clock.label if clock.known else "UTC"


def part_of_day(hour: int) -> str:
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 22:
        return "evening"
    if hour >= 22:
        return "late evening"
    return "night"


def time_note(clock: UserClock, at: datetime) -> str:
    """One sentence with the user's local date and time, for a developer message."""
    local = clock.local(at)
    when = f"{local:%A} {local.day} {local:%B %Y}, {local:%H:%M}"
    if not clock.known:
        return f"It is {when} UTC; the user's timezone is unknown, so avoid naming the time of day."
    return f"The user's local time is {when} ({clock.label}), {part_of_day(local.hour)} for them."


@dataclass
class TimeNotes:
    """Keeps the model on the user's clock: once as the call starts, then again after a gap."""

    clock: UserClock
    interval: timedelta = NOTE_INTERVAL
    _last: datetime | None = field(default=None, init=False)

    def call_started(self, at: datetime) -> str:
        """The note that opens a call, which also marks the call in the stored conversation."""
        self._last = at
        return f"{CALL_NOTE_PREFIX} {time_note(self.clock, at)}"

    def refresh(self, at: datetime) -> str | None:
        """A fresh note when the last one is older than the interval, else None."""
        if self._last is not None and at - self._last < self.interval:
            return None
        self._last = at
        return time_note(self.clock, at)
