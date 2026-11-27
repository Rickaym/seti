"""The EA's own tools as the user reads them in its settings: name, area, one line and its gate."""

import re
from typing import Literal, TypedDict

from seti_ea.actions import CONFIRM_TOOLS
from seti_ea.format import clip
from seti_ea.gate import ON_WORD_TOOLS
from seti_ea.tools import TOOL_SPECS

Gate = Literal["runs", "asks", "word"]

SUMMARY_CHARS = 160
SENTENCE_END = re.compile(r"(?<=[.!?])\s")

# The first area whose words appear in a tool's name, as whole words, takes the tool.
AREAS: list[tuple[str, tuple[str, ...]]] = [
    ("Follow-ups", ("followup", "followups", "watch", "watches", "reminder", "poller")),
    ("Channels", ("channel", "channels")),
    ("Context", ("context", "knowledge")),
    ("MCP and mods", ("mcp", "plugin", "plugins", "mod")),
    ("PRs and repos", ("pr", "prs", "repo", "repos")),
    ("Messaging", ("chat", "message", "file", "question", "asked")),
    (
        "Agents",
        (
            "agent",
            "agents",
            "task",
            "tasks",
            "subtask",
            "subtasks",
            "subagent",
            "session",
            "sessions",
            "process",
            "processes",
            "updates",
            "update_mode",
            "workspace",
            "workspaces",
            "background",
            "preview",
            "transcript",
        ),
    ),
]
OTHER_AREA = "Seti"


class ToolEntry(TypedDict):
    name: str
    area: str
    summary: str
    gate: Gate


def area_of(name: str) -> str:
    """The area a tool belongs to, read from the words of its name."""
    padded = f"_{name}_"
    for area, words in AREAS:
        if any(f"_{word}_" in padded for word in words):
            return area
    return OTHER_AREA


def gate_of(name: str) -> Gate:
    """Whether a tool runs on the user's request, asks first, or acts only on their own yes."""
    if name in ON_WORD_TOOLS:
        return "word"
    return "asks" if name in CONFIRM_TOOLS else "runs"


def summary_of(description: str) -> str:
    """The first sentence of a tool's description, bounded to one line."""
    first = SENTENCE_END.split(description.strip(), maxsplit=1)[0]
    return clip(first, SUMMARY_CHARS)


def tool_list() -> list[ToolEntry]:
    """Every tool the EA's model is given, in the order it is given them."""
    return [
        ToolEntry(name=spec.name, area=area_of(spec.name), summary=summary_of(spec.description), gate=gate_of(spec.name))
        for spec in TOOL_SPECS
    ]
