"""The EA's whole prompt as the user reads it in its settings: the system prompt and each turn's notes."""

import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, TypedDict

from seti_ea.clock import TimeNotes, time_note
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.live_context import SentNote
from seti_ea.packs import CHAT_TIMEOUT_SECS, PackPrompt
from seti_ea.prompt import GREETING, VOICE_NOTE, chat_inbox_note, chat_note
from seti_ea.redact import scrub, secrets_of
from seti_ea.seti import SetiClient

PartKey = Literal["base", "call", "chat", "inbox", "live"]

GIT_TIMEOUT_SECS = 2.0

NO_LIVE_NOTE = (
    "No turn has run since the EA started, so there is no live context to show yet. It is built "
    "before each turn from your agents, PRs and requests."
)


class PromptPart(TypedDict):
    key: PartKey
    label: str
    about: str
    text: str
    chars: int
    per_turn: bool
    built_at: str | None


class PromptAnswer(TypedDict):
    commit: str | None
    parts: list[PromptPart]


def running_commit(source: Path = Path(__file__).parent) -> str | None:
    """The commit of the EA's checkout as it starts, or None outside a git checkout."""
    try:
        found = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", "HEAD"],
            cwd=source,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = found.stdout.strip()
    return commit if found.returncode == 0 and commit else None


def _part(
    key: PartKey, label: str, about: str, text: str, *, per_turn: bool = False, at: datetime | None = None
) -> PromptPart:
    return {
        "key": key,
        "label": label,
        "about": about,
        "text": text,
        "chars": len(text),
        "per_turn": per_turn,
        "built_at": at.isoformat() if at is not None else None,
    }


def live_part(sent: SentNote) -> PromptPart:
    """The live context note the last turn was given, or why there is none yet."""
    about = "Changes every turn. This is the one the last turn was given; nothing is built to show it."
    if sent.at is None:
        return _part("live", "Live context", NO_LIVE_NOTE, "", per_turn=True)
    return _part("live", "Live context", about, sent.text, per_turn=True, at=sent.at)


class PromptView:
    """Builds the prompt parts from the same code the call and the chat use, without running a turn."""

    def __init__(self, settings: Settings, seti: SetiClient, conversation: Conversation) -> None:
        self._packs = PackPrompt(seti, timeout_secs=CHAT_TIMEOUT_SECS)
        self._conversation = conversation
        self._secrets = secrets_of(settings)
        self._commit = running_commit()

    async def answer(self, now: datetime | None = None) -> PromptAnswer:
        at = now or datetime.now(UTC)
        clock = self._conversation.last_clock
        time = time_note(clock, at)
        call = "\n\n".join([TimeNotes(clock).call_started(at), GREETING, VOICE_NOTE])
        parts = [
            _part(
                "base",
                "Base prompt",
                "The system prompt of every call and chat, for your form of address and language, "
                "with your linked context packs and mod actions at its end.",
                await self._packs.system_prompt(),
            ),
            _part(
                "call",
                "Call note",
                "Added as a call opens, then the greeting and the note for speaking again after typing.",
                call,
                per_turn=True,
            ),
            _part(
                "chat",
                "Chat note",
                "Opens a typed turn, with your local time.",
                chat_note(time),
                per_turn=True,
            ),
            _part(
                "inbox",
                "Inbox note",
                "Opens a report the EA writes to the chat on its own, about inbox items.",
                chat_inbox_note(time),
                per_turn=True,
            ),
            live_part(self._conversation.live_note),
        ]
        return {"commit": self._commit, "parts": [self._scrubbed(part) for part in parts]}

    def _scrubbed(self, part: PromptPart) -> PromptPart:
        text = scrub(part["text"], self._secrets)
        return {**part, "text": text, "chars": len(text)}
