"""Second opinions, rewinds and recently changed files of one agent, for get_task."""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import ago, and_list, clip, money, plural
from seti_ea.question_tools import DATA_NOTE, data
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolResult, dicts, title_of

REVIEWS_SHOWN = 3
REVIEW_CHARS = 400
FILES_SHOWN = 20
REWINDS_SHOWN = 3
PROMPT_CHARS = 120

FILES_ARG = {
    "type": "boolean",
    "description": "Instead, the files it changed since it started, newest first.",
}


async def opinion_lines(seti: SetiClient, task_id: str, now: datetime) -> list[str]:
    """What an agent's second opinions cost, and the latest light reviews of its PRs."""
    try:
        found = await seti.get(f"/tasks/{task_id}/second-opinions")
    except SetiError:
        return []
    opinions: Mapping[str, Any] = found if isinstance(found, dict) else {}
    lines: list[str] = []
    spend = [
        f"{plural(int(s.get('count') or 0), 'second opinion')} on {s.get('runtime')} costing "
        f"{money(s.get('usd'))}{' (estimated)' if s.get('estimated') else ''}"
        for s in dicts(opinions.get("spend"))
    ]
    if spend:
        lines.append(f"It asked for {and_list(spend)}.")
    reviews = dicts(opinions.get("reviews"))
    for review in reviews[:REVIEWS_SHOWN]:
        answer = data(review.get("answer", ""), "the reviewer", REVIEW_CHARS)
        by = f"{review.get('model')} on {review.get('runtime')}"
        lines.append(
            f"Review of {review.get('pr_url')} by {by}, {ago(review.get('created_at'), now)}: {answer}"
        )
    if reviews:
        lines.append(DATA_NOTE)
    return lines


async def rewind_lines(seti: SetiClient, task_id: str, now: datetime) -> list[str]:
    """The agent's latest rewinds, newest first, so a new rewind is asked about knowing them."""
    try:
        found = dicts(await seti.get(f"/tasks/{task_id}/rewinds"))
    except SetiError:
        return []
    if not found:
        return []
    lines = [f"It was rewound {plural(len(found), 'time')}; the latest:"]
    for rewind in reversed(found[-REWINDS_SHOWN:]):
        prompt = data(rewind.get("prompt_text", ""), "the prompt", PROMPT_CHARS)
        state = str(rewind.get("state"))
        why = f" ({clip(str(rewind.get('reason')), 120)})" if rewind.get("reason") else ""
        when = ago(rewind.get("created_at"), now)
        lines.append(f"- {when}, {rewind.get('restore')}, {state}{why}, to before {prompt}")
    lines.append(DATA_NOTE)
    return lines


async def recent_files(seti: SetiClient, task: Mapping[str, Any], now: datetime) -> ToolResult:
    """The files an agent changed since it started, newest first."""
    found = await seti.get(f"/tasks/{task.get('id')}/files/recent", {"limit": FILES_SHOWN})
    files = dicts(found.get("files")) if isinstance(found, dict) else []
    title = title_of(task)
    if not files:
        return ToolResult(f"{title} has changed no files since it started.", f"No files of {title}")
    lines = [f"Files {title} changed since it started, newest first:"]
    lines += [
        f"- {data(f.get('path'), 'the agent', 200)} in {f.get('root')}, {ago(f.get('mtime'), now)}"
        for f in files
    ]
    if isinstance(found, dict) and found.get("truncated"):
        lines.append("A folder held more than Seti looks at, so older changes may be missing.")
    lines.append(DATA_NOTE)
    return ToolResult("\n".join(lines), f"Read {plural(len(files), 'file')} {title} changed")
