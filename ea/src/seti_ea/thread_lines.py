"""The threads outside Seti an agent posted in and follows for replies, for get_task."""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import ago, plural
from seti_ea.seti import SetiClient
from seti_ea.toolkit import dicts

THREADS_SHOWN = 5


def _thread_line(thread: Mapping[str, Any], now: datetime) -> str:
    name = thread.get("channel_name")
    channel = f"#{name}" if name else f"channel {thread.get('channel')}, name not known"
    where = f"{thread.get('service')} {channel}, thread {thread.get('thread')}"
    replies = plural(int(thread.get("replies") or 0), "reply", "replies")
    link = f" {thread.get('url')}" if thread.get("url") else ""
    return f"- {where}: {replies}, last activity {ago(thread.get('last_activity_at'), now)}.{link}"


async def thread_lines(seti: SetiClient, task_id: str, now: datetime) -> list[str]:
    """The agent's followed threads, newest activity first; none says nothing."""
    followed = [t for t in dicts(await seti.get(f"/tasks/{task_id}/threads")) if t.get("stopped_at") is None]
    if not followed:
        return []
    shown = followed[:THREADS_SHOWN]
    more = len(followed) - len(shown)
    lines = [f"It follows {plural(len(followed), 'thread')} it posted in outside Seti, for replies:"]
    lines.extend(_thread_line(thread, now) for thread in shown)
    if more > 0:
        lines.append(f"- and {plural(more, 'more thread')}.")
    return lines
