"""What the user hears and sees while the think tool works, so a long answer never means silence.

On a call the first progress line comes FIRST_SECS after the think starts and another every
EVERY_SECS, at most MAX_LINES, each only while nobody speaks and no reply is under way; a line
held up past SKIP_AFTER_SECS is dropped. A line
says what the thinker is reading when that is new, else a line from STILL_LINES, never one it
already said for this think. None of it enters the EA's context, so the model never answers it.
"""

import asyncio
import contextlib
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

FIRST_SECS = 6.0
EVERY_SECS = 11.0
MAX_LINES = 4
# A line the user or a reply held up for this long is dropped, not said late.
SKIP_AFTER_SECS = 3.0
CHECK_SECS = 0.5
# How long nobody must have spoken before a progress line, so it never jumps in on a reply.
QUIET_SECS = 1.5

STARTED_LINE = "Weighing it up."
STILL_LINES = (
    "Still working through it.",
    "Bear with me; there's a fair bit to weigh up.",
    "Still on it, nearly there.",
    "Just pulling it together now.",
)
STEP_LINES = {
    "list_tasks": "I'm looking over the agents.",
    "list_workspaces": "I'm looking over the workspaces.",
    "seti_overview": "I'm looking over the whole picture.",
    "get_task": "I'm checking {task}'s latest turn.",
    "search_seti": "I'm searching Seti for what's been said about it.",
    "list_subtasks": "I'm checking {task}'s subagents.",
    "get_subtask": "I'm reading a subagent's report.",
    "list_waiting_updates": "I'm going through the updates that are waiting.",
    "list_prs": "I'm going through the open PRs.",
    "get_pr": "I'm reading {pr} in detail.",
    "search_audit": "I'm checking the audit log.",
    "read_team_chat": "I'm reading the group chat.",
    "find_in_team_chat": "I'm searching the group chat.",
    "find_in_transcript": "I'm searching {task}'s transcript.",
    "account_status": "I'm checking the account's usage.",
    "resource_usage": "I'm checking the machine's resources.",
}
OTHER_STEP = "I'm checking a few more details in Seti."
GENERIC_REF = {"task": "an agent", "pr": "a PR"}
SPOKEN_REF = re.compile(r"^[A-Za-z][\w '.-]{0,40}$")
PR_NUMBER = re.compile(r"(?:#|pull/|pr\s*)?(\d{1,6})$", re.IGNORECASE)


def _ref(kind: str, value: object) -> str:
    """A name that can be said aloud, or a generic one for ids and URLs."""
    text = value.strip() if isinstance(value, str) else ""
    if kind == "pr":
        number = PR_NUMBER.search(text)
        return f"PR {number.group(1)}" if number else GENERIC_REF[kind]
    if SPOKEN_REF.match(text) and not any(ch.isdigit() for ch in text):
        return text
    return GENERIC_REF[kind]


def step_line(tool: str, arguments: Mapping[str, Any]) -> str:
    """What the thinker is doing, as a line to say or show: "I'm going through the open PRs."."""
    line = STEP_LINES.get(tool, OTHER_STEP)
    return line.format(task=_ref("task", arguments.get("task")), pr=_ref("pr", arguments.get("pr")))


class ThinkWatcher:
    """Hears a think start, each step of it and its end; the default does nothing."""

    async def started(self, call_id: str) -> None:
        return None

    async def step(self, call_id: str, line: str) -> None:
        return None

    async def finished(self, call_id: str) -> None:
        return None


@dataclass
class _Run:
    due: float
    lines: int = 0
    said: set[str] = field(default_factory=set[str])
    steps: list[str] = field(default_factory=list[str])


Say = Callable[[str], Awaitable[None]]


class SpokenProgress(ThinkWatcher):
    """Speaks progress lines on a call while thinks run, never over the user or a reply."""

    def __init__(
        self,
        say: Say,
        floor_free: Callable[[], bool],
        *,
        show: Say | None = None,
        clock: Callable[[], float] = time.monotonic,
        check_secs: float = CHECK_SECS,
    ) -> None:
        self._say = say
        self._show = show
        self._floor_free = floor_free
        self._clock = clock
        self._check = check_secs
        self._runs: dict[str, _Run] = {}
        self._last: float | None = None
        self._rotation = 0
        self._loop: asyncio.Task[None] | None = None

    @property
    def active(self) -> bool:
        return bool(self._runs)

    async def started(self, call_id: str) -> None:
        now = self._clock()
        self._runs[call_id] = _Run(due=now + FIRST_SECS)
        if self._loop is None or self._loop.done():
            self._loop = asyncio.get_running_loop().create_task(self._speak())
        if self._show is not None:
            await self._show(STARTED_LINE)

    async def step(self, call_id: str, line: str) -> None:
        run = self._runs.get(call_id)
        if run is not None:
            run.steps.append(line)
        if self._show is not None:
            await self._show(line)

    async def finished(self, call_id: str) -> None:
        self._runs.pop(call_id, None)

    async def stop(self) -> None:
        """Ends the loop, as the call ends."""
        self._runs.clear()
        if self._loop is not None:
            self._loop.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop

    def due(self) -> str | None:
        """The line to say now, or None; a line it returns counts as said."""
        now = self._clock()
        if self._last is not None and now - self._last < EVERY_SECS:
            return None
        run = next((r for r in self._runs.values() if r.lines < MAX_LINES and now >= r.due), None)
        if run is None:
            return None
        if not self._floor_free():
            if now - run.due > SKIP_AFTER_SECS:
                run.lines += 1
                run.due = now + EVERY_SECS
            return None
        line = self._fresh_step(run) or self._still(run)
        if line is None:
            return None
        run.lines += 1
        run.said.add(line)
        run.due = now + EVERY_SECS
        self._last = now
        return line

    def _fresh_step(self, run: _Run) -> str | None:
        latest = run.steps[-1] if run.steps else None
        return latest if latest is not None and latest not in run.said else None

    def _still(self, run: _Run) -> str | None:
        count = len(STILL_LINES)
        for offset in range(count):
            line = STILL_LINES[(self._rotation + offset) % count]
            if line not in run.said:
                self._rotation += 1
                return line
        return None

    async def _speak(self) -> None:
        while self._runs:
            await asyncio.sleep(self._check)
            line = self.due()
            if line is not None:
                await self._say(line)


Emit = Callable[[dict[str, Any]], None]


class ShownProgress(ThinkWatcher):
    """Shows the same progress as a Thinking status line in the typed chat."""

    def __init__(self, emit: Emit) -> None:
        self._emit = emit

    async def started(self, call_id: str) -> None:
        self._emit({"type": "thinking", "text": STARTED_LINE})

    async def step(self, call_id: str, line: str) -> None:
        self._emit({"type": "thinking", "text": line})

    async def finished(self, call_id: str) -> None:
        self._emit({"type": "thinking", "text": None})
