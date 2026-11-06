"""The since-you-left brief Seti builds when the user comes back, as a call opens with it."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast

from loguru import logger

from seti_ea.prompt import GREETING, RETURNING_GREETING
from seti_ea.seti import SetiClient, SetiError


@dataclass(frozen=True)
class BriefLine:
    title: str
    text: str


@dataclass(frozen=True)
class Brief:
    summary: str
    needs_you: list[BriefLine]
    changed: list[BriefLine]
    more: int


def _lines(raw: object) -> list[BriefLine]:
    if not isinstance(raw, list):
        return []
    lines: list[BriefLine] = []
    for entry in cast(Sequence[object], raw):
        if isinstance(entry, dict):
            fields = cast(Mapping[str, Any], entry)
            lines.append(BriefLine(str(fields.get("title", "")), str(fields.get("text", ""))))
    return lines


def parse_brief(data: object) -> Brief | None:
    """The brief in Seti's answer, or None when there is none or it is malformed."""
    raw = cast(Mapping[str, Any], data).get("brief") if isinstance(data, dict) else None
    if not isinstance(raw, dict):
        return None
    fields = cast(Mapping[str, Any], raw)
    summary = fields.get("summary")
    if not isinstance(summary, str) or summary.strip() == "":
        return None
    more = fields.get("more")
    return Brief(
        summary.strip(),
        _lines(fields.get("needs_you")),
        _lines(fields.get("changed")),
        more if isinstance(more, int) else 0,
    )


async def fetch_brief(seti: SetiClient) -> Brief | None:
    """Takes the brief waiting for the user; Seti then drops it from the pages, since the call tells it."""
    try:
        return parse_brief(await seti.get("/ea/brief"))
    except SetiError as e:
        logger.warning(f"EA could not read the brief: {e}")
        return None


def brief_note(brief: Brief) -> str:
    """The developer note with the brief's lines, in each agent's own words, for detail on request."""
    parts = ["Since the user left (each line is the agent's or the notice's own words):"]
    if brief.needs_you:
        parts.append("Needs the user now:")
        parts.extend(f"- {line.title}: {line.text}" for line in brief.needs_you)
    if brief.changed:
        parts.append("Changed:")
        parts.extend(f"- {line.title}: {line.text}" for line in brief.changed)
    if brief.more > 0:
        parts.append(f"- and {brief.more} more in Seti")
    return "\n".join(parts)


def greeting(returning: bool, brief: Brief | None) -> str:
    """How the call opens: a greeting, and with a brief one sentence of it and no more."""
    if brief is None:
        return RETURNING_GREETING if returning else GREETING
    return (
        "The user comes back to this call after being away. Greet them in a few words, then say "
        f'this one sentence in your own voice: "{brief.summary}" Stop there, with no detail, question '
        "or offer of help. Give the detail from the note above only when they ask, quoting each "
        "agent's words rather than paraphrasing them."
    )
