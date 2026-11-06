"""The confirmation gate: a tool that changes something acts only once the user said yes to it.

Seti keeps every question the EA asks, so a yes still counts after the EA restarts. A question
records the EA process and the user turn it was asked in, and only a later turn's yes covers it.
"""

import json
import secrets
import unicodedata
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from seti_ea.format import clip
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolResult, arg_bool

CONFIRMED = {
    "type": "boolean",
    "description": "Leave out: the tool then says exactly what will happen and gives a question id, "
    "for you to put to the user. After their yes, call confirm_asked with that id.",
}


@dataclass
class UserAnswer:
    """The user's Allow for one exact recorded call; it covers a single gate check."""

    used: bool = False


@dataclass
class GateCall:
    """What the gate saw during one tool call: the key it asked about, or the question a yes took."""

    asked_key: str | None = None
    taken: int | None = None


ANSWER: ContextVar[UserAnswer | None] = ContextVar("ea_user_answer", default=None)
GATE_CALL: ContextVar[GateCall | None] = ContextVar("ea_gate_call", default=None)


@dataclass
class Confirmations:
    """Holds a destructive tool back until the user answered the question Seti recorded for it."""

    seti: SetiClient
    epoch: str = field(default_factory=lambda: secrets.token_hex(8))
    turn: int = 0

    def user_turn(self) -> None:
        """The user said or typed something; questions asked before now may be answered."""
        self.turn += 1

    @property
    def asked_in(self) -> dict[str, Any]:
        """This EA process and the user's current turn, as Seti records when a question was asked."""
        return {"epoch": self.epoch, "turn": self.turn}

    async def cleared(self, key: str, confirmed: bool) -> bool:
        """True when the user allowed this exact change, in a notification or by a later yes."""
        answer = ANSWER.get()
        if answer is not None and not answer.used:
            answer.used = True
            return True
        call = GATE_CALL.get()
        if confirmed and self.turn > 0:
            taken = await self.confirm(key=key)
            if taken:
                if call is not None:
                    call.taken = int(taken[0]["id"])
                return True
        if call is not None:
            call.asked_key = key
        return False

    async def confirm(self, *, key: str | None = None, ids: list[int] | None = None) -> list[dict[str, Any]]:
        """Takes the user's yes for the open questions named; those Seti handed back, with their calls."""
        body: dict[str, Any] = {**self.asked_in}
        if key:
            body["key"] = key
        if ids:
            body["ids"] = ids
        try:
            data = await self.seti.post("/ea/asks/confirm", body)
        except SetiError as e:
            logger.warning(f"EA could not take the user's yes: {e}")
            return []
        rows: list[Any] = data if isinstance(data, list) else []
        return [row for row in rows if isinstance(row, dict) and isinstance(row.get("id"), int)]


def _canonical(value: Any) -> Any:
    """Strings in a gate key compare in one Unicode form, without surrounding spaces."""
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value).strip()
    if isinstance(value, Mapping):
        return {str(k): _canonical(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_canonical(v) for v in value]
    return value


def gate_key(tool: str, *parts: Any) -> str:
    """What a yes covers: the tool with exactly the target and change it was asked about."""
    return f"{tool}:{json.dumps(_canonical(list(parts)), sort_keys=True, default=str)}"


def ask(tool: str, args: Mapping[str, Any], effect: str, what: str) -> ToolResult:
    """The question to put to the user before `tool` acts; the EA's tool call adds its id."""
    early = "You had not put this to the user yet. " if arg_bool(args, "confirmed") else ""
    return ToolResult(
        f"{early}Not done yet: this needs the user's explicit yes. What it would do: {effect} Tell "
        "the user that plainly, in your own words, and ask whether to go ahead. Once they say yes, "
        "call confirm_asked with this question's id, together with the ids of any other questions "
        "the same yes answers. If they say no or change it, do not.",
        clip(f"Asked first: {what}", 70),
        asked=what,
    )
