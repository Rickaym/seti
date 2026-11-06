"""Short spoken renderings of Seti objects."""

import re
from datetime import UTC, datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

STATUS_WORDS = {
    "running": "running",
    "idle": "idle",
    "asking": "asking you a question",
    "blocked": "waiting on you",
    "error": "stopped with an error",
    "stopped": "stopped",
    "interrupted": "interrupted",
}

CI_WORDS = {
    "success": "CI passing",
    "failure": "CI failing",
    "pending": "CI running",
    "neutral": "CI neutral",
}

REVIEW_WORDS = {
    "approved": "approved",
    "changes_requested": "changes requested",
    "review_required": "awaiting review",
}

PREVIEW_WORDS = {
    "ready": "preview ready",
    "stale": "preview out of date",
    "expired": "preview expired",
}

PR_URL = re.compile(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)")
SPACES = re.compile(r"\s+")
MARKDOWN = re.compile(r"`+|\*+|\||^\s*#{1,6}\s+|^\s*>\s?", re.MULTILINE)
URL = re.compile(r"https?://\S+")


def clip(text: str, limit: int) -> str:
    """One line of plain text, cut at a word boundary near the limit."""
    flat = SPACES.sub(" ", URL.sub("[link]", MARKDOWN.sub("", text))).strip()
    if len(flat) <= limit:
        return flat
    cut = flat[:limit].rsplit(" ", 1)[0]
    return f"{cut}..."


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or value == "":
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def ago(value: Any, now: datetime) -> str:
    """How long ago an ISO time was, in rounded spoken units."""
    when = parse_time(value)
    if when is None:
        return "at an unknown time"
    secs = max(0, int((now - when).total_seconds()))
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if secs >= size:
            count = secs // size
            return f"{count} {unit}{'' if count == 1 else 's'} ago"
    return "just now"


def money(usd: Any) -> str:
    """A rounded dollar amount for speech."""
    amount = float(usd) if isinstance(usd, int | float) else 0.0
    if amount < 0.01:
        return "nothing yet"
    if amount < 1:
        return f"{round(amount * 100)} cents"
    if amount < 10:
        return f"{amount:.1f} dollars".replace(".0 ", " ")
    return f"{round(amount)} dollars"


def plural(count: int, noun: str, many: str | None = None) -> str:
    return f"{count} {noun if count == 1 else (many or noun + 's')}"


def repo_name(slug: str) -> str:
    return slug.rsplit("/", 1)[-1]


def pr_label(url: str) -> str:
    """`seti PR 28` for a GitHub pull request URL."""
    match = PR_URL.search(url)
    if match is None:
        return "a pull request"
    return f"{match.group(2)} PR {match.group(3)}"


def status_word(status: Any) -> str:
    return STATUS_WORDS.get(str(status), str(status))


def status_note(task: dict[str, Any]) -> str:
    """`, "waiting on CI"` for a task showing a status line, else nothing."""
    line = task.get("status_line")
    return f', "{line}"' if isinstance(line, str) and line else ""


def task_repos(task: dict[str, Any]) -> str:
    repos = task.get("repos")
    names = (
        [repo_name(str(r.get("slug", ""))) for r in repos if isinstance(r, dict)]
        if isinstance(repos, list)
        else []
    )
    names = [n for n in names if n != ""]
    return ", ".join(names) if names else "no repo"


def preview_word(preview: Any) -> str:
    if not isinstance(preview, dict):
        return ""
    state = preview.get("state")
    key = "stale" if state == "ready" and preview.get("stale") is True else str(state)
    return PREVIEW_WORDS.get(key, "")


def threads_word(pr: dict[str, Any]) -> str:
    """Unresolved review threads of an open PR in words; empty when there are none."""
    count = pr.get("unresolved_threads")
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        return ""
    return plural(count, "unresolved review thread")


def pr_status(pr: dict[str, Any]) -> str:
    """CI, review, conflicts and preview of an open PR in a few words."""
    parts: list[str] = []
    ci = pr.get("ci")
    ci_text = CI_WORDS.get(str(ci), "no CI") if ci is not None else "no CI"
    if ci == "failure":
        checks = pr.get("checks")
        failing = [
            str(c.get("name"))
            for c in (checks if isinstance(checks, list) else [])
            if isinstance(c, dict) and c.get("state") == "failure"
        ]
        if failing:
            ci_text += f" ({', '.join(failing[:3])})"
    parts.append(ci_text)
    threads = threads_word(pr)
    if threads:
        parts.append(threads)
    review = REVIEW_WORDS.get(str(pr.get("review_decision")))
    if review:
        parts.append(review)
    if pr.get("draft") is True:
        parts.append("draft")
    if pr.get("mergeable") == "conflicting":
        parts.append("has merge conflicts")
    preview = preview_word(pr.get("preview"))
    if preview:
        parts.append(preview)
    return ", ".join(parts)


def pr_line(pr: dict[str, Any]) -> str:
    label = pr_label(str(pr.get("url", "")))
    title = clip(str(pr.get("title", "")), 80)
    return f"{label}, {title}: {pr_status(pr)}"


WEEKDAYS = ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
UTC_OFFSET = re.compile(r"^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$")
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")
LIST_MARKER = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
MAX_OFFSET = timedelta(hours=14)


def until(value: Any, now: datetime) -> str:
    """How far ahead an ISO time is, in rounded spoken units."""
    when = parse_time(value)
    if when is None:
        return "at an unknown time"
    secs = int((when - now).total_seconds())
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if secs >= size:
            count = secs // size
            return f"in {count} {unit}{'' if count == 1 else 's'}"
    return "any moment now"


def duration(secs: float) -> str:
    """A span of time in its largest one or two units."""
    total = max(0, int(secs))
    if total < 60:
        return plural(total, "second")
    minutes = total // 60
    if minutes < 60:
        return plural(minutes, "minute")
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return plural(hours, "hour") + (f" {plural(minutes, 'minute')}" if minutes else "")
    days, hours = divmod(hours, 24)
    return plural(days, "day") + (f" {plural(hours, 'hour')}" if hours else "")


def size_words(size: Any) -> str:
    """A size for speech: bytes, or the largest of KB, MB and GB, to one decimal."""
    count = int(size) if isinstance(size, int | float) else 0
    if count < 1000:
        return plural(count, "byte")
    for unit, scale in (("GB", 1e9), ("MB", 1e6)):
        if count >= scale:
            return f"{count / scale:.1f} {unit}".replace(".0 ", " ")
    return f"{count / 1000:.1f} KB".replace(".0 ", " ")


def zone_of(name: str) -> tzinfo | None:
    """A timezone from an IANA name, UTC, or an offset such as UTC+06:30; None when unknown."""
    text = name.strip()
    if text.upper() in ("UTC", "GMT", "Z"):
        return UTC
    match = UTC_OFFSET.match(text.lower().replace(" ", ""))
    if match is not None:
        sign, hours, minutes = match.groups()
        offset = timedelta(hours=int(hours), minutes=int(minutes or 0))
        if offset > MAX_OFFSET:
            return None
        return timezone(-offset if sign == "-" else offset)
    try:
        return ZoneInfo(text)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def local_time(value: Any, zone: str) -> str:
    """Weekday and 24-hour clock time of an ISO time in the named zone."""
    when = parse_time(value)
    if when is None:
        return "an unknown time"
    local = when.astimezone(zone_of(zone) or UTC)
    return f"{local:%A} {local:%H:%M}"


def _ordinal(day: int) -> str:
    suffix = "th" if 10 <= day % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day}{suffix}"


def and_list(items: list[str]) -> str:
    """Items joined as speech: a, b and c."""
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} and {items[-1]}"


def _days_of_week(field: str) -> str | None:
    """Spoken days for a cron day-of-week field, or None when it is not a simple one."""
    if field == "*":
        return "every day"
    if field == "1-5":
        return "every weekday"
    if field in ("0,6", "6,0", "6-7"):
        return "every weekend day"
    days: list[str] = []
    for part in field.split(","):
        bounds = part.split("-")
        if len(bounds) > 2 or not all(b.isdigit() and int(b) <= 7 for b in bounds):
            return None
        names = [WEEKDAYS[int(b) % 7] for b in bounds]
        days.append(" to ".join(names))
    return f"every {and_list(days)}"


def cron_words(schedule: str) -> str:
    """A 5-field cron schedule in plain words; unusual ones are read out as they are."""
    fields = schedule.split()
    fallback = f"on the cron schedule {schedule.strip()}"
    if len(fields) != 5 or fields[3] != "*":
        return fallback
    minute, hour, dom, _month, dow = fields
    daily = dom == "*" and dow == "*"
    if minute.startswith("*/") and minute[2:].isdigit() and hour == "*" and daily:
        return f"every {plural(int(minute[2:]), 'minute')}"
    if not minute.isdigit():
        return fallback
    if hour == "*" and daily:
        return "every hour, on the hour" if int(minute) == 0 else f"every hour at minute {int(minute)}"
    if hour.startswith("*/") and hour[2:].isdigit() and daily:
        return f"every {plural(int(hour[2:]), 'hour')} at minute {int(minute)}"
    hours = hour.split(",")
    if not all(h.isdigit() for h in hours):
        return fallback
    times = and_list([f"{int(h):02d}:{int(minute):02d}" for h in hours])
    if dom == "*":
        days = _days_of_week(dow)
        return f"{days} at {times}" if days else fallback
    if dom.isdigit() and dow == "*":
        return f"on the {_ordinal(int(dom))} of every month at {times}"
    return fallback


def headings(text: str, limit: int) -> list[str]:
    """Markdown heading titles in order, at most limit of them."""
    found: list[str] = []
    for line in text.splitlines():
        match = HEADING.match(line)
        if match is not None:
            found.append(clip(match.group(1), 60))
            if len(found) >= limit:
                break
    return found


def matching_lines(text: str, query: str, limit: int) -> list[str]:
    """Non-empty lines containing every word of query, ignoring case."""
    words = query.lower().split()
    found: list[str] = []
    for line in text.splitlines():
        low = line.lower()
        if words and line.strip() and all(w in low for w in words):
            found.append(clip(LIST_MARKER.sub("", line), 160))
            if len(found) >= limit:
                break
    return found


def _seconds(ms: Any) -> str:
    value = float(ms) / 1000 if isinstance(ms, int | float) else 0.0
    return f"{value:.0f} seconds" if value >= 10 else f"{value:.1f} seconds"


def schedule_health(health: Any) -> str:
    """How a poller or reminder kept its schedule this week; empty when Seti sent no health."""
    if not isinstance(health, dict):
        return ""
    windows = [w for w in health.get("windows") or [] if isinstance(w, dict)]
    stale = health.get("stale") is True
    overdue = int(health.get("overdue_s") or 0)
    lead = (
        f"It is overdue by {plural(overdue // 60, 'minute')}; Seti re-arms it within a minute. "
        if stale
        else ""
    )
    if not windows or not windows[0].get("runs"):
        return f"{lead}It has no scheduled run in the last 7 days."
    week = windows[0]
    expected = week.get("expected")
    of = f" of {expected}" if isinstance(expected, int) else ""
    parts = [f"In the last 7 days it ran {week.get('runs')}{of} scheduled times"]
    if week.get("on_time_pct") is not None:
        parts.append(f"{week.get('on_time_pct')}% on time, p95 {_seconds(week.get('late_p95_ms'))} late")
    missed = int(week.get("missed") or 0)
    if missed:
        parts.append(f"{plural(missed, 'missed run')}")
    if week.get("ok_pct") is not None:
        parts.append(f"{week.get('ok_pct')}% worked")
    return f"{lead}{', '.join(parts)}."
