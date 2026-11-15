"""The think tool as a pipecat function: it runs in the background, can be cancelled and is audited.

Unlike the other tools it is not shielded: it only reads, so a cancel or a hang-up loses nothing.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Literal, cast

from loguru import logger
from pipecat.adapters.schemas.direct_function import tool_options
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.processors.aggregators.llm_context import LLMContextMessage, LLMSpecificMessage
from pipecat.services.llm_service import FunctionCallParams

from seti_ea.format import clip
from seti_ea.history import is_summary
from seti_ea.live_context import is_live_note
from seti_ea.seti import SetiClient, SetiError
from seti_ea.think import THINK_SPEC, THINK_TOOL, Thinker, ThinkStats, Thought
from seti_ea.think_speech import ThinkWatcher, step_line
from seti_ea.toolkit import ToolResult

THINK_TIMEOUT_SECS = 90.0
# Pipecat's own deadline is only a backstop; the handler's timeout answers first, in plain words.
BACKSTOP_SECS = THINK_TIMEOUT_SECS + 10.0
THOUGHTS_PATH = "/ea/thoughts"
QUESTION_MAX = 2000
RECENT_MESSAGES = 12
LINE_MAX = 400
SUMMARY_MAX = 1500
LIVE_MAX = 8000

Outcome = Literal["answered", "cancelled", "timed_out", "failed"]
Channel = Literal["voice", "chat"]
Report = Callable[[str, ToolResult, str], Awaitable[None]]
Handler = Callable[[FunctionCallParams], Awaitable[None]]

THOUGHT_NOTE = (
    "Your think came back. Tell the user the spoken answer below in your own words, once, opening "
    "naturally, such as \"Right, here's what I'd do:\". In the chat, add the longer version when there "
    "is one. What it recommends is a suggestion: put any action to the user and act only on their yes, "
    "through your usual tools."
)
TIMED_OUT = (
    f"The think ran out of time after {int(THINK_TIMEOUT_SECS)} seconds without an answer. Tell the user "
    "plainly you could not finish thinking it through, and offer a narrower question or to hand it to "
    "an agent. Do not guess the answer."
)
FAILED = (
    "The think failed before it could answer. Tell the user in one sentence, and offer to try again or "
    "to answer from what you can read yourself. Do not guess the answer."
)
NO_QUESTION = "Call think with the question to think through."


def _text(content: object) -> str:
    return content if isinstance(content, str) else ""


def background(messages: Sequence[LLMContextMessage]) -> str:
    """The recent conversation and the latest live context note, for the thinker to start from."""
    lines: list[str] = []
    summary = ""
    live = ""
    for raw in messages:
        if isinstance(raw, LLMSpecificMessage):
            continue
        message = cast(Mapping[str, Any], raw)
        content = _text(message.get("content"))
        role = message.get("role")
        if is_live_note(message):
            live = content[:LIVE_MAX]
        elif is_summary(message):
            summary = clip(content, SUMMARY_MAX)
        elif role == "user" and content.strip():
            lines.append(f"User: {clip(content, LINE_MAX)}")
        elif role == "assistant" and content.strip():
            lines.append(f"EA: {clip(content, LINE_MAX)}")
    parts = []
    if summary:
        parts.append(summary)
    recent = "\n".join(lines[-RECENT_MESSAGES:])
    parts.append(f"The recent conversation, oldest first:\n{recent or '(nothing yet)'}")
    if live:
        parts.append(live)
    return "\n\n".join(parts)


def thought_text(thought: Thought) -> str:
    """What the EA's model reads back when the think answers."""
    text = f"{THOUGHT_NOTE}\n\nSpoken answer: {thought.spoken}"
    return f"{text}\n\nLonger version for the chat:\n{thought.detail}" if thought.detail else text


class ThinkTool:
    """One channel's think tool; it reports each outcome like any tool and audits it in Seti."""

    def __init__(
        self,
        thinker: Thinker,
        seti: SetiClient,
        channel: Channel,
        report: Report,
        watcher: ThinkWatcher,
        *,
        timeout_secs: float = THINK_TIMEOUT_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._thinker = thinker
        self._seti = seti
        self._channel: Channel = channel
        self._report = report
        self._watcher = watcher
        self._timeout = timeout_secs
        self._clock = clock
        self._audits: set[asyncio.Task[None]] = set()

    def schema(self) -> FunctionSchema:
        """The think tool; async, so the user can talk on while it works, and the LLM may cancel it."""

        async def handle(params: FunctionCallParams) -> None:
            result = await self.run(params.tool_call_id, params.arguments, params.context.messages)
            await params.result_callback(result.text)

        options = cast(
            Callable[[Handler], Handler],
            tool_options(cancel_on_interruption=False, timeout_secs=BACKSTOP_SECS, cancellable_by_llm=True),
        )
        return FunctionSchema(
            name=THINK_SPEC.name,
            description=THINK_SPEC.description,
            properties=THINK_SPEC.properties,
            required=THINK_SPEC.required,
            handler=options(handle),
        )

    async def run(
        self, call_id: str, arguments: Mapping[str, Any], messages: Sequence[LLMContextMessage]
    ) -> ToolResult:
        """Thinks the question through and reports the result; a cancel propagates after the audit."""
        question = _text(arguments.get("question")).strip()[:QUESTION_MAX]
        if not question:
            result = ToolResult(NO_QUESTION, "No question", False)
            await self._report(THINK_TOOL, result, call_id)
            return result
        stats = ThinkStats()
        started = self._clock()
        outcome: Outcome = "failed"

        async def step(tool: str, args: Mapping[str, Any]) -> None:
            await self._watcher.step(call_id, step_line(tool, args))

        await self._watcher.started(call_id)
        try:
            async with asyncio.timeout(self._timeout):
                thought = await self._thinker.think(question, background(messages), step, stats)
            outcome = "answered"
            result = ToolResult(thought_text(thought), clip(thought.spoken, 80))
        except TimeoutError:
            outcome = "timed_out"
            result = ToolResult(TIMED_OUT, "Ran out of time", False)
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except Exception as e:
            logger.warning(f"EA think failed: {type(e).__name__}")
            result = ToolResult(FAILED, "Thinking failed", False)
        finally:
            await self._watcher.finished(call_id)
            self._audit(outcome, len(question), self._clock() - started, stats.rounds)
        await self._report(THINK_TOOL, result, call_id)
        return result

    def _audit(self, outcome: Outcome, chars: int, secs: float, rounds: int) -> None:
        """Records the think in Seti on its own task, so a cancelled think is still recorded."""
        body = {
            "channel": self._channel,
            "outcome": outcome,
            "question_chars": chars,
            "duration_ms": max(0, round(secs * 1000)),
            "tool_rounds": rounds,
        }
        task = asyncio.get_running_loop().create_task(self._post(body))
        self._audits.add(task)
        task.add_done_callback(self._audits.discard)

    async def _post(self, body: dict[str, Any]) -> None:
        try:
            await self._seti.post(THOUGHTS_PATH, body)
        except SetiError as e:
            logger.warning(f"EA think not audited: {e.title}")

    async def settle(self) -> None:
        """Waits for the audits still being sent."""
        if self._audits:
            await asyncio.gather(*self._audits, return_exceptions=True)
