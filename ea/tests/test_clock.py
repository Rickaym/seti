from datetime import UTC, datetime, timedelta

import pytest

from seti_ea.clock import UNKNOWN_CLOCK, TimeNotes, parse_user_clock, part_of_day, time_note

AT = datetime(2026, 9, 27, 14, 30, tzinfo=UTC)


def test_the_iana_timezone_wins() -> None:
    clock = parse_user_clock({"timezone": "Asia/Singapore", "localTime": "2026-09-27T09:30:00-05:00"})
    assert clock.known
    assert clock.label == "Asia/Singapore"
    assert clock.local(AT).hour == 22


def test_a_bad_timezone_falls_back_to_the_offset_of_the_local_time() -> None:
    clock = parse_user_clock({"timezone": "Mars/Olympus", "localTime": "2026-09-27T20:00:00+05:30"})
    assert clock.known
    assert clock.label == "UTC+05:30"
    assert clock.local(AT).strftime("%H:%M") == "20:00"


@pytest.mark.parametrize(
    "data",
    [
        None,
        "Asia/Singapore",
        [],
        {},
        {"timezone": 8},
        {"timezone": "../../etc/passwd"},
        {"timezone": "/usr/share/zoneinfo/UTC"},
        {"timezone": "Asia/" + "x" * 80},
        {"localTime": "2026-09-27T20:00:00"},
        {"localTime": "yesterday"},
        {"localTime": "2026-09-27T20:00:00+15:00"},
        {"localTime": "2026-09-27T20:00:00+05:30" + " " * 80},
    ],
)
def test_anything_else_is_unknown_utc(data: object) -> None:
    assert parse_user_clock(data) == UNKNOWN_CLOCK


@pytest.mark.parametrize(
    ("hour", "part"),
    [
        (0, "night"),
        (4, "night"),
        (5, "morning"),
        (11, "morning"),
        (12, "afternoon"),
        (17, "evening"),
        (22, "late evening"),
        (23, "late evening"),
    ],
)
def test_part_of_day(hour: int, part: str) -> None:
    assert part_of_day(hour) == part


def test_the_note_names_the_local_date_time_zone_and_part_of_day() -> None:
    clock = parse_user_clock({"timezone": "Asia/Singapore"})
    assert time_note(clock, AT) == (
        "The user's local time is Sunday 27 September 2026, 22:30 (Asia/Singapore), late evening for them."
    )
    london = parse_user_clock({"timezone": "Europe/London"})
    assert time_note(london, AT) == (
        "The user's local time is Sunday 27 September 2026, 15:30 (Europe/London), afternoon for them."
    )


def test_an_unknown_zone_says_so_and_avoids_the_time_of_day() -> None:
    assert time_note(UNKNOWN_CLOCK, AT) == (
        "It is Sunday 27 September 2026, 14:30 UTC; the user's timezone is unknown, "
        "so avoid naming the time of day."
    )


def test_notes_open_the_call_then_refresh_only_after_a_gap() -> None:
    notes = TimeNotes(parse_user_clock({"timezone": "Asia/Singapore"}))
    assert notes.call_started(AT) == (
        "A new call started. The user's local time is Sunday 27 September 2026, 22:30 (Asia/Singapore), "
        "late evening for them."
    )
    assert notes.refresh(AT + timedelta(minutes=4)) is None
    later = notes.refresh(AT + timedelta(minutes=6))
    assert later == (
        "The user's local time is Sunday 27 September 2026, 22:36 (Asia/Singapore), late evening for them."
    )
    assert notes.refresh(AT + timedelta(minutes=10)) is None


def test_a_session_without_a_greeting_notes_the_first_turn() -> None:
    notes = TimeNotes(UNKNOWN_CLOCK)
    assert notes.refresh(AT) is not None
