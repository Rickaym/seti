"""A search of one agent's evidence ledger: the source items it read, with their exact text."""

import re
from collections.abc import Mapping
from typing import Any

from seti_ea.format import plural
from seti_ea.seti import SetiClient
from seti_ea.toolkit import ToolResult, arg_str, dicts, title_of

SOURCE_LIMIT = 8
SOURCE_TEXT_CHARS = 600
SOURCE_ARGS = ("kind", "container", "since", "until")
CLOSING_TAG = re.compile(r"</?\s*(source_items|item)\b", re.IGNORECASE)

SOURCE_KIND = {
    "type": "string",
    "enum": ["slack", "linear", "github", "file"],
    "description": "With where=sources: only items of this source.",
}
SOURCE_CONTAINER = {
    "type": "string",
    "description": "With where=sources: a Slack channel (#name or id), owner/repo or Linear team key.",
}
SOURCE_SINCE = {"type": "string", "description": "With where=sources: from this date or ISO time."}
SOURCE_UNTIL = {"type": "string", "description": "With where=sources: up to this date or ISO time."}


def _inert(text: str) -> str:
    """Item text that cannot close or open the frame around it."""
    return CLOSING_TAG.sub(lambda m: m.group(0).replace("<", "[", 1), text)


def _cut(text: str) -> str:
    """The exact text, cut at the limit with a marker, never reworded."""
    return text if len(text) <= SOURCE_TEXT_CHARS else f"{text[:SOURCE_TEXT_CHARS]} [cut]"


def _attribute(value: object) -> str:
    return re.sub(r'["<>\n]', " ", str(value or ""))


def _item(n: int, item: Mapping[str, Any]) -> list[str]:
    fields = {key: _attribute(item.get(key)) for key in ("kind", "place", "at", "permalink")}
    head = " ".join(f'{key}="{value}"' for key, value in fields.items() if value)
    return [f'<item n="{n}" {head}>', _inert(_cut(str(item.get("text", "")))), "</item>"]


async def find_sources(seti: SetiClient, task: Mapping[str, Any], args: Mapping[str, Any]) -> ToolResult:
    """The source items a task read that match, newest first, framed as data."""
    params: dict[str, str | int] = {"limit": SOURCE_LIMIT}
    query = arg_str(args, "query", required=False)
    if query:
        params["q"] = query
    params |= {name: value for name in SOURCE_ARGS if (value := arg_str(args, name, required=False))}
    data = await seti.get(f"/tasks/{task.get('id')}/sources", params)
    found = data if isinstance(data, dict) else {}
    items = dicts(found.get("items"))
    title = title_of(task)
    if not items:
        return ToolResult(f"No source item {title} read matches.", "Found no sources")
    more = " More match; narrow the search to reach them." if found.get("more") is True else ""
    lines = [
        f"{plural(len(items), 'source item')} {title} read, newest first.{more}",
        str(found.get("note", "")),
    ]
    lines.append("<source_items>")
    for n, item in enumerate(items, 1):
        lines.extend(_item(n, item))
    lines.append("</source_items>")
    return ToolResult("\n".join(lines), f"Found {plural(len(items), 'source item')}")
