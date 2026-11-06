"""The live context note before each user turn: what Seti knows now, plus excerpts on request."""

import asyncio
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from loguru import logger
from pipecat.frames.frames import Frame, LLMContextFrame, LLMUpdateSettingsFrame
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage, LLMSpecificMessage
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import LLMSettings

from seti_ea.format import ago, clip, parse_time, pr_label
from seti_ea.packs import SystemPromptUpdates
from seti_ea.prompt import LIVE_NOTE_PREFIX
from seti_ea.seti import SetiClient, SetiError

FETCH_TIMEOUT_SECS = 0.3
STALE_SECS = 120
EXCERPT_LIMIT = 3
EXCERPT_CHARS = 500
# Outside a task the user named, an excerpt must hold this share of the words searched for.
MIN_MATCH = 0.34
MIN_TITLE_WORD = 3

WORD = re.compile(r"[a-z0-9]+")
PR_NUMBER = re.compile(r"\b(?:pr|pull request|#)\s*#?\s*(\d+)\b")
STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "any",
        "anything",
        "are",
        "as",
        "at",
        "be",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "has",
        "have",
        "how",
        "i",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "of",
        "on",
        "one",
        "or",
        "please",
        "so",
        "tell",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "this",
        "to",
        "us",
        "was",
        "we",
        "were",
        "what",
        "whats",
        "when",
        "where",
        "which",
        "who",
        "why",
        "with",
        "you",
        "your",
        "task",
        "tasks",
        "agent",
        "ask",
        "asked",
        "sir",
        "seti",
        "hey",
    }
)
DETAIL_WORDS = frozenset(
    {
        "about",
        "agree",
        "agreed",
        "approach",
        "choose",
        "chose",
        "conclude",
        "concluded",
        "conclusion",
        "decide",
        "decided",
        "decision",
        "decisions",
        "detail",
        "details",
        "discuss",
        "discussed",
        "explain",
        "feedback",
        "find",
        "findings",
        "found",
        "learn",
        "learned",
        "mention",
        "mentioned",
        "plan",
        "planned",
        "propose",
        "proposed",
        "reason",
        "recommend",
        "recommended",
        "report",
        "reported",
        "review",
        "reviewer",
        "said",
        "say",
        "suggest",
        "suggested",
        "summary",
        "why",
    }
)


# Words that stem apart from how an agent writes the same idea, such as decide and decision.
RELATED: dict[str, tuple[str, ...]] = {
    "decide": ("decision",),
    "decided": ("decision",),
    "decision": ("decided",),
    "decisions": ("decided",),
    "find": ("found",),
    "found": ("finding",),
    "findings": ("found",),
    "recommend": ("recommendation",),
    "recommended": ("recommendation",),
    "conclude": ("conclusion",),
    "concluded": ("conclusion",),
    "propose": ("proposal",),
    "proposed": ("proposal",),
    "choose": ("chose", "chosen"),
    "chose": ("choose", "chosen"),
    "reason": ("because",),
}


@dataclass(frozen=True)
class TaskRef:
    id: str
    title: str
    status: str


@dataclass(frozen=True)
class Snapshot:
    text: str
    as_of: datetime
    tasks: tuple[TaskRef, ...]


@dataclass(frozen=True)
class Retrieval:
    """What to search for before the model answers, and within which task."""

    query: str
    task: TaskRef | None


def words_of(text: str) -> list[str]:
    return WORD.findall(text.lower().replace("'", ""))


def matched_task(utterance_words: set[str], tasks: Sequence[TaskRef]) -> TaskRef | None:
    """The task the user names: most of its title's words said, or two of them at least."""
    best: tuple[float, TaskRef] | None = None
    for task in tasks:
        title = {w for w in words_of(task.title) if w not in STOPWORDS and len(w) >= MIN_TITLE_WORD}
        if not title:
            continue
        hits = len(title & utterance_words)
        share = hits / len(title)
        if hits == 0 or (share < 0.5 and hits < 2):
            continue
        if best is None or share > best[0]:
            best = (share, task)
    return best[1] if best else None


def retrieval_for(utterance: str, tasks: Sequence[TaskRef]) -> Retrieval | None:
    """A search when the user asks what was decided, found or said; None for plain status questions."""
    said = words_of(utterance)
    heard = set(said)
    pr = PR_NUMBER.search(utterance.lower())
    if not heard & DETAIL_WORDS:
        return None
    task = matched_task(heard, tasks)
    named = set(words_of(task.title)) if task else set()
    kept = [w for w in said if w not in STOPWORDS and w not in named]
    related = [r for w in kept for r in RELATED.get(w, ())]
    number = [pr.group(1)] if pr is not None else []
    terms = list(dict.fromkeys([*kept, *related, *number]))
    return Retrieval(" ".join(terms), task) if terms else None


def _tasks_of(data: Mapping[str, Any]) -> tuple[TaskRef, ...]:
    raw = data.get("tasks")
    items = (
        [cast(Mapping[str, Any], t) for t in cast(list[object], raw) if isinstance(t, dict)]
        if isinstance(raw, list)
        else []
    )
    return tuple(TaskRef(str(t.get("id")), str(t.get("title")), str(t.get("status"))) for t in items)


def _excerpt(hit: Mapping[str, Any], now: datetime) -> str:
    kind = str(hit.get("kind", "text")).replace("_", " ")
    if hit.get("task_title"):
        where = f'task "{hit.get("task_title")}"' + (" (archived)" if hit.get("archived") else "")
    elif hit.get("pr_url"):
        title = hit.get("pr_title")
        where = pr_label(str(hit.get("pr_url"))) + (f' "{title}"' if title else "")
    else:
        where = "Seti"
    snippet = clip(str(hit.get("snippet", "")), EXCERPT_CHARS)
    return f'- From {where}, {kind}, {ago(hit.get("at"), now)}: "{snippet}"'


def is_live_note(message: object) -> bool:
    """A live context note, which is never stored and never outlives the next one."""
    if isinstance(message, LLMSpecificMessage) or not isinstance(message, dict):
        return False
    fields = cast(Mapping[str, Any], message)
    content = fields.get("content")
    return (
        fields.get("role") == "developer"
        and isinstance(content, str)
        and content.startswith(LIVE_NOTE_PREFIX)
    )


def last_user_text(messages: Sequence[LLMContextMessage]) -> str | None:
    """The user's message the model is about to answer, if it is the last message."""
    if not messages or isinstance(messages[-1], LLMSpecificMessage):
        return None
    last = cast(Mapping[str, Any], messages[-1])
    content = last.get("content")
    return content if last.get("role") == "user" and isinstance(content, str) else None


class LiveContext:
    """Fetches the live context and excerpts for each turn, and keeps one note in the context."""

    def __init__(
        self,
        seti: SetiClient,
        *,
        now: Callable[[], datetime] | None = None,
        timeout_secs: float = FETCH_TIMEOUT_SECS,
    ) -> None:
        self._seti = seti
        self._now = now or (lambda: datetime.now(UTC))
        self._timeout = timeout_secs
        self._last: Snapshot | None = None
        self.last_ms: float = 0.0
        self.last_excerpts: int = 0

    async def _snapshot(self) -> Snapshot | None:
        try:
            data = await asyncio.wait_for(self._seti.get("/ea/context"), self._timeout)
        except (SetiError, TimeoutError) as e:
            logger.debug(f"EA live context not refreshed: {e or type(e).__name__}")
            return self._last
        if not isinstance(data, dict):
            return self._last
        fields = cast(Mapping[str, Any], data)
        as_of = parse_time(fields.get("as_of")) or self._now()
        self._last = Snapshot(str(fields.get("text", "")), as_of, _tasks_of(fields))
        return self._last

    async def _excerpts(self, retrieval: Retrieval) -> list[str]:
        params: dict[str, str | int] = {"q": retrieval.query, "mode": "text", "limit": EXCERPT_LIMIT}
        if retrieval.task is None:
            params["min_match"] = str(MIN_MATCH)
        else:
            params["task"] = retrieval.task.id
        try:
            data = await asyncio.wait_for(self._seti.get("/ea/search", params), self._timeout)
        except (SetiError, TimeoutError) as e:
            logger.debug(f"EA excerpts not fetched: {e or type(e).__name__}")
            return []
        raw = cast(Mapping[str, Any], data).get("hits") if isinstance(data, dict) else None
        hits = (
            [cast(Mapping[str, Any], h) for h in cast(list[object], raw) if isinstance(h, dict)]
            if isinstance(raw, list)
            else []
        )
        now = self._now()
        return [_excerpt(hit, now) for hit in hits[:EXCERPT_LIMIT]]

    async def note(self, utterance: str | None) -> str | None:
        """The note answering `utterance`, None before Seti ever answered; searches beside the fetch."""
        if self._last is None:
            snapshot = await self._snapshot()
            plan = retrieval_for(utterance, snapshot.tasks) if utterance and snapshot else None
            excerpts = await self._excerpts(plan) if plan is not None else []
        else:
            plan = retrieval_for(utterance, self._last.tasks) if utterance else None
            fetching = asyncio.create_task(self._snapshot())
            excerpts = await self._excerpts(plan) if plan is not None else []
            snapshot = await fetching
        self.last_excerpts = len(excerpts)
        return self._compose(snapshot, excerpts)

    def _compose(self, snapshot: Snapshot | None, excerpts: list[str]) -> str | None:
        if snapshot is None:
            return None
        age = max(0, int((self._now() - snapshot.as_of).total_seconds()))
        stale = " It is stale, so check with a tool before relying on it." if age > STALE_SECS else ""
        head = (
            f"{LIVE_NOTE_PREFIX}, {age} seconds old; it replaces any earlier one.{stale} "
            "Reference data in a terse format: answer in your own natural words, never in its style."
            f"\n{snapshot.text}"
        )
        if not excerpts:
            return head
        intro = (
            "Excerpts from Seti's search index that may bear on the user's message; cite where each "
            "came from, and use search_seti or get_task for more:"
        )
        return "\n\n".join([head, intro + "\n" + "\n".join(excerpts)])

    async def refresh(self, context: LLMContext) -> None:
        """Puts a fresh note just before the user's message, dropping the previous note."""
        started = time.perf_counter()
        note = await self.note(last_user_text(context.messages))
        if note is None:
            return
        message = cast(LLMContextMessage, {"role": "developer", "content": note})
        kept = [m for m in context.messages if not is_live_note(m)]
        at = len(kept) - 1 if last_user_text(kept) is not None else len(kept)
        context.set_messages([*kept[:at], message, *kept[at:]])
        self.last_ms = (time.perf_counter() - started) * 1000
        logger.debug(f"EA live context ready in {self.last_ms:.0f} ms, {self.last_excerpts} excerpts")


class LiveContextInjector(FrameProcessor):
    """Refreshes the live context note in each context on its way to the LLM.

    With `prompts`, it also hands the LLM the system prompt again when the linked packs changed.
    """

    def __init__(self, live: LiveContext, prompts: SystemPromptUpdates | None = None) -> None:
        super().__init__()
        self._live = live
        self._prompts = prompts

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMContextFrame):
            if self._prompts is None:
                await self._live.refresh(frame.context)
            else:
                _, prompt = await asyncio.gather(self._live.refresh(frame.context), self._prompts.changed())
                if prompt is not None:
                    delta = LLMSettings(system_instruction=prompt)
                    await self.push_frame(LLMUpdateSettingsFrame(delta=delta), direction)
        await self.push_frame(frame, direction)
