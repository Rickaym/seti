"""What agents did in a time window: the activity list_tasks shows and the transcript get_task reads."""

from datetime import datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

from seti_ea.format import clip, plural, pr_label
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolResult, dicts

ACTIVE_LIMIT = 12
WINDOW_LINES = 30
LINE_CHARS = 240
REPLY_CHARS = 200

HISTORY_WINDOW = {
    "type": "string",
    "description": "A time window: today, yesterday, this week, last 3 hours, or a date such as "
    "2026-10-27, read in the user's timezone.",
}


def _zone_name(zone: tzinfo, at: datetime) -> str:
    """An IANA name, or the offset at `at` as +06:30, which Seti reads either way."""
    if isinstance(zone, ZoneInfo):
        return zone.key
    minutes = int((at.utcoffset() or timedelta(0)).total_seconds() // 60)
    sign = "+" if minutes >= 0 else "-"
    return f"{sign}{abs(minutes) // 60:02d}:{abs(minutes) % 60:02d}"


def _params(start: datetime, end: datetime | None, zone: tzinfo) -> dict[str, str | int]:
    params: dict[str, str | int] = {"since": start.isoformat(), "timezone": _zone_name(zone, start)}
    if end is not None:
        params["until"] = end.isoformat()
    return params


def _span(agent: dict[str, Any]) -> str:
    first, last = str(agent.get("first_at", "")), str(agent.get("last_at", ""))
    if first[:10] == last[:10]:
        return f"{first[11:16]} to {last[11:16]}"
    return f"{first} to {last}"


def _activity_line(agent: dict[str, Any]) -> str:
    prompts = plural(int(agent.get("prompts") or 0), "prompt")
    replies = plural(int(agent.get("replies") or 0), "reply", "replies")
    prs = [pr_label(str(url)) for url in agent.get("prs_linked") or []]
    linked = f", linked {', '.join(prs)}" if prs else ""
    reply = agent.get("last_reply")
    last = f" Last reply: {clip(str(reply), REPLY_CHARS)}" if reply else ""
    return f"- {agent.get('title')}: {prompts}, {replies}, {_span(agent)}{linked}.{last}"


async def activity_result(
    seti: SetiClient, start: datetime, end: datetime | None, zone: tzinfo, label: str
) -> ToolResult:
    """Every agent with turns in the window, most active first."""
    data = await seti.get("/history/activity", {**_params(start, end, zone), "limit": ACTIVE_LIMIT})
    found = data if isinstance(data, dict) else {}
    agents = dicts(found.get("agents"))
    more = int(found.get("more") or 0)
    archived = [str(a.get("title")) for a in dicts(found.get("archived_since"))]
    if not agents:
        return ToolResult(f"No agent had turns {label}.", "No agent activity")
    lines = [f"{plural(len(agents) + more, 'agent')} had turns {label}, most active first:"]
    lines.extend(_activity_line(agent) for agent in agents)
    if more:
        lines.append(f"And {more} less active ones not listed.")
    if archived:
        lines.append(f"Archived since then, so not counted: {', '.join(archived)}.")
    return ToolResult("\n".join(lines), f"Listed {plural(len(agents), 'active agent')}")


async def window_transcript(
    seti: SetiClient, task_id: str, start: datetime, end: datetime | None, zone: tzinfo, label: str
) -> list[str]:
    """One agent's prompts and replies in the window, oldest first, the newest kept."""
    try:
        data = await seti.get(
            f"/history/tasks/{task_id}", {**_params(start, end, zone), "limit": WINDOW_LINES}
        )
    except SetiError as e:
        return [f"Its transcript {label} is unavailable: {e.title}."]
    found = data if isinstance(data, dict) else {}
    lines = [str(line) for line in found.get("lines") or []]
    if not lines:
        return [f"It had no prompts or replies {label}."]
    earlier = ", the latest part" if found.get("older_cursor") is not None else ""
    return [
        f"Its prompts and replies {label}{earlier}, oldest first:",
        *(f"- {clip(line, LINE_CHARS)}" for line in lines),
    ]
