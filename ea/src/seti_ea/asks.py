"""Questions the EA asks before a tool acts, kept in Seti so a yes, typed, spoken or tapped, answers them."""

from collections.abc import Callable, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, cast

from loguru import logger

from seti_ea.format import ago, clip
from seti_ea.gate import Confirmations
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolResult, ToolSpec

CONFIRM_ASKED = "confirm_asked"

CONFIRM_ASKED_SPEC = ToolSpec(
    CONFIRM_ASKED,
    "Carry out the changes the user just said yes to: the questions you asked with a tool that "
    "takes confirmed, by the ids those tools gave. One yes may cover several questions you put to "
    "the user together; list each. Only after the user's yes in their latest message, never before.",
    {
        "ids": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "The ids of the questions the user's yes answers.",
        }
    },
    ["ids"],
)

# The questions asked in this chat turn, so the stored reply carries them to its notification.
ASKED: ContextVar[list[int] | None] = ContextVar("ea_asked", default=None)


@dataclass(frozen=True)
class AnsweredAsk:
    """A question the user answered, with the exact call an Allow runs."""

    id: int
    tool: str
    args: Mapping[str, Any]
    summary: str
    allow: bool


def parse_answered(data: Any) -> list[AnsweredAsk]:
    rows: list[Any] = data if isinstance(data, list) else []
    asks: list[AnsweredAsk] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        row = cast(Mapping[str, Any], raw)
        args = row.get("args")
        if isinstance(row.get("id"), int) and isinstance(row.get("tool"), str) and isinstance(args, dict):
            asks.append(
                AnsweredAsk(
                    int(row["id"]),
                    str(row["tool"]),
                    cast(Mapping[str, Any], args),
                    str(row.get("summary") or ""),
                    row.get("decision") == "allow",
                )
            )
    return asks


async def record_ask(
    gate: Confirmations, tool: str, args: Mapping[str, Any], result: ToolResult, key: str
) -> ToolResult:
    """Records the question a gated tool asked and gives the model its id."""
    body = {
        "tool": tool,
        "args": {k: v for k, v in args.items() if k != "confirmed"},
        "summary": clip(result.asked or tool, 300),
        "key": key,
        **gate.asked_in,
    }
    try:
        data = await gate.seti.post("/ea/asks", body)
    except SetiError as e:
        logger.warning(f"EA question not recorded: {e}")
        return ToolResult(
            "Not done: Seti could not record the question, so a yes cannot be taken now. Tell the user "
            "and try again in a moment.",
            "Question not recorded",
            False,
        )
    ask_id = cast(Mapping[str, Any], data).get("id") if isinstance(data, dict) else None
    if not isinstance(ask_id, int):
        return result
    asked = ASKED.get()
    if asked is not None and ask_id not in asked:
        asked.append(ask_id)
    return replace(result, text=f"{result.text} Question id: {ask_id}.")


async def report_outcome(seti: SetiClient, ask_id: int, result: ToolResult) -> None:
    """Tells Seti what came of a call the user allowed, for its notification."""
    done = result.ok and result.asked is None
    body = {"outcome": "done" if done else "failed", "detail": clip(result.summary, 500)}
    try:
        await seti.post(f"/ea/asks/{ask_id}/outcome", body)
    except SetiError as e:
        logger.warning(f"EA question {ask_id} outcome not recorded: {e}")


async def open_asks_note(seti: SetiClient, now: Callable[[], datetime]) -> str | None:
    """A note listing the questions still waiting for the user, so a yes finds their ids."""
    try:
        data = await seti.get("/ea/asks/open")
    except SetiError as e:
        logger.warning(f"EA could not list its open questions: {e}")
        return None
    rows: list[Any] = data if isinstance(data, list) else []
    if not rows:
        return None
    at = now()
    lines = [
        f"- {row['id']}: {row.get('summary')}, asked {ago(row.get('created_at'), at)}"
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("id"), int)
    ]
    if not lines:
        return None
    return (
        "Questions you asked that still wait for the user's answer, by id:\n"
        + "\n".join(lines)
        + "\nIf the user's message says yes to some of them, call confirm_asked with those ids."
    )


def confirm_text(done: Sequence[tuple[AnsweredAsk, ToolResult]], missing: Sequence[int]) -> ToolResult:
    """What confirm_asked tells the model: each call's result, and the ids it could not take."""
    lines = [f"Question {ask.id} ({ask.summary}): {result.text}" for ask, result in done]
    if missing:
        ids = ", ".join(str(i) for i in missing)
        lines.append(
            f"Not taken: {ids}. Each expired, was already answered, or was asked in this same "
            "turn, after the user's last message; ask again if it is still wanted."
        )
    ok = bool(done) and all(result.ok and result.asked is None for _, result in done)
    summary = f"Did {len(done)} of {len(done) + len(missing)} confirmed changes"
    return ToolResult("\n".join(lines), summary, ok)
