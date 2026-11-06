from datetime import UTC, datetime, timedelta, timezone

import pytest
from fakes import NOW

from seti_ea.format import (
    and_list,
    cron_words,
    duration,
    headings,
    local_time,
    matching_lines,
    schedule_health,
    size_words,
    until,
    zone_of,
)


@pytest.mark.parametrize(
    ("schedule", "words"),
    [
        ("0 9 * * *", "every day at 09:00"),
        ("0 9 * * 1", "every Monday at 09:00"),
        ("30 8 * * 1-5", "every weekday at 08:30"),
        ("0 10 * * 0,6", "every weekend day at 10:00"),
        ("0 9 * * 1,3,5", "every Monday, Wednesday and Friday at 09:00"),
        ("0 9 * * 2-4", "every Tuesday to Thursday at 09:00"),
        ("0 9,17 * * *", "every day at 09:00 and 17:00"),
        ("*/15 * * * *", "every 15 minutes"),
        ("0 * * * *", "every hour, on the hour"),
        ("5 * * * *", "every hour at minute 5"),
        ("0 */6 * * *", "every 6 hours at minute 0"),
        ("0 7 1 * *", "on the 1st of every month at 07:00"),
        ("0 7 22 * *", "on the 22nd of every month at 07:00"),
        ("0 7 13 * *", "on the 13th of every month at 07:00"),
        ("0 9 * 1 *", "on the cron schedule 0 9 * 1 *"),
        ("0 9 1 * 1", "on the cron schedule 0 9 1 * 1"),
        ("0 9 * * MON", "on the cron schedule 0 9 * * MON"),
        ("nonsense", "on the cron schedule nonsense"),
    ],
)
def test_cron_words(schedule: str, words: str) -> None:
    assert cron_words(schedule) == words


def test_until_and_duration() -> None:
    assert until("2026-09-27T14:30:00Z", NOW) == "in 2 hours"
    assert until("2026-09-27T12:00:30Z", NOW) == "any moment now"
    assert until("2026-09-29T12:00:00Z", NOW) == "in 2 days"
    assert until(None, NOW) == "at an unknown time"
    assert duration(42) == "42 seconds"
    assert duration(270) == "4 minutes"
    assert duration(3900) == "1 hour 5 minutes"
    assert duration(7200) == "2 hours"
    assert duration(90000) == "1 day 1 hour"


def test_size_words() -> None:
    assert size_words(300) == "300 bytes"
    assert size_words(1) == "1 byte"
    assert size_words(5717) == "5.7 KB"
    assert size_words(2000) == "2 KB"
    assert size_words(None) == "0 bytes"


def test_zone_of_reads_names_and_offsets() -> None:
    assert zone_of("UTC") is UTC
    assert zone_of("Asia/Rangoon") is not None
    assert zone_of("UTC+06:30") == timezone(timedelta(hours=6, minutes=30))
    assert zone_of("-05:00") == timezone(timedelta(hours=-5))
    assert zone_of("UTC+5") == timezone(timedelta(hours=5))
    assert zone_of("UTC+15") is None
    assert zone_of("Mars/Olympus") is None
    assert zone_of("../etc/passwd") is None


def test_local_time_uses_the_zone() -> None:
    assert local_time("2026-09-28T02:30:00Z", "Asia/Rangoon") == "Monday 09:00"
    assert local_time("2026-09-28T02:30:00Z", "nowhere") == "Monday 02:30"
    assert local_time(None, "UTC") == "an unknown time"


def test_and_list() -> None:
    assert and_list([]) == ""
    assert and_list(["a"]) == "a"
    assert and_list(["a", "b", "c"]) == "a, b and c"


def test_headings_and_matching_lines() -> None:
    text = "# Title\n\nIntro line\n## Commits ##\n- Push a branch early\n1. Never on main branch\n"
    assert headings(text, 5) == ["Title", "Commits"]
    assert headings(text, 1) == ["Title"]
    assert matching_lines(text, "branch", 5) == ["Push a branch early", "Never on main branch"]
    assert matching_lines(text, "main BRANCH", 5) == ["Never on main branch"]
    assert matching_lines(text, "branch", 1) == ["Push a branch early"]
    assert matching_lines(text, "   ", 5) == []


def test_local_time_accepts_aware_values() -> None:
    at = datetime(2026, 9, 27, 23, 0, tzinfo=UTC).isoformat()
    assert local_time(at, "UTC+01:00") == "Monday 00:00"


def test_schedule_health_says_how_the_week_went_and_when_it_is_overdue() -> None:
    week = {
        "runs": 160,
        "expected": 168,
        "on_time_pct": 92.5,
        "late_p95_ms": 45_000,
        "missed": 8,
        "ok_pct": 100,
    }
    assert schedule_health({"stale": False, "overdue_s": 0, "windows": [week]}) == (
        "In the last 7 days it ran 160 of 168 scheduled times, 92.5% on time, p95 45 seconds late, "
        "8 missed runs, 100% worked."
    )
    stale = schedule_health({"stale": True, "overdue_s": 600, "windows": [{"runs": 0}]})
    assert stale == (
        "It is overdue by 10 minutes; Seti re-arms it within a minute. "
        "It has no scheduled run in the last 7 days."
    )
    assert schedule_health(None) == ""
