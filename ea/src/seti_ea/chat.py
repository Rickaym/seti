"""Typed chat with the EA: the voice EA's prompt, tools and history through pipecat, without audio."""

import asyncio
import contextlib
import json
from collections.abc import AsyncGenerator, Callable, Mapping
from datetime import UTC, datetime
from typing import Any, cast

from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    FunctionCallFromLLM,
    LLMContextFrame,
    LLMTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage, LLMSpecificMessage
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMAssistantAggregator,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.utils.context.llm_context_summarization import LLMContextSummarizationUtil
from pipecat.workers.runner import WorkerRunner

from seti_ea.asks import ASKED, AnsweredAsk, open_asks_note
from seti_ea.bot import openai_llm, tool_schemas
from seti_ea.clock import (
    CALL_NOTE_PREFIX,
    CURRENT_CLOCK,
    NOTE_INTERVAL,
    UserClock,
    clock_for_zone,
    time_note,
)
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.history import HistorySync, summarization_config
from seti_ea.inbox import ACT_TOOLS, ACTION_TOOLS, Delivered, InboxItem
from seti_ea.live_context import LiveContext
from seti_ea.packs import CHAT_TIMEOUT_SECS, PackPrompt
from seti_ea.promises import PromiseCheck
from seti_ea.prompt import CHAT_NOTE_PREFIX, VOICE_NOTE, chat_inbox_note, chat_note
from seti_ea.seti import SetiError
from seti_ea.toolkit import ToolResult
from seti_ea.tools import DIRECT_ONLY, INBOX_ORIGIN, TOOL_SPECS, EaTools
from seti_ea.usage import Channel, UsageObserver, UsageRecorder

# A report the EA writes on its own reads state and may schedule another check, never acts on tasks.
INBOX_TOOLS = frozenset(spec.name for spec in TOOL_SPECS) - ACTION_TOOLS

REPLY_TIMEOUT_SECS = 300.0
PING_SECS = 10.0

Event = dict[str, Any]
Emit = Callable[[Event], None]

ANSWER_NOTE = (
    "The user answered your question with a button in a Seti notification. Allow ran exactly the "
    "call you asked about, and its result follows; Deny leaves it undone. Say what happened in one "
    "short sentence and do nothing more unless the user asks."
)


async def _ignore(_tool: str, _result: ToolResult, _call_id: str) -> None:
    return None


LlmFactory = Callable[[Settings, str], OpenAILLMService]


def chat_llm(settings: Settings, system: str) -> OpenAILLMService:
    """The voice EA's LLM service with the chat model and this turn's system prompt."""
    return openai_llm(settings, settings.chat_model, system)


def channel_of(messages: list[LLMContextMessage]) -> str | None:
    """The channel the latest developer note put the user on: voice, chat, or None when unmarked."""
    for raw in reversed(messages):
        if isinstance(raw, LLMSpecificMessage):
            continue
        message = cast(Mapping[str, Any], raw)
        content = message.get("content")
        if message.get("role") != "developer" or not isinstance(content, str):
            continue
        if content.startswith(CHAT_NOTE_PREFIX):
            return "chat"
        if content.startswith((CALL_NOTE_PREFIX, VOICE_NOTE)):
            return "voice"
    return None


class TextTap(FrameProcessor):
    """Sits between the LLM and the assistant aggregator and reports the answer as it streams."""

    def __init__(self, emit: Emit) -> None:
        super().__init__()
        self._emit = emit

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMTextFrame) and frame.text:
            self._emit({"type": "text", "delta": frame.text})
        await self.push_frame(frame, direction)


async def run_reply(
    context: LLMContext,
    llm: OpenAILLMService,
    emit: Emit,
    usage: UsageObserver,
    add_note: Callable[[str], None],
) -> str | None:
    """Runs the LLM with its tools until it answers without calling one; the error text, if any.

    A reply that promised to pass something on without the tool call gets one more run to do it.
    """
    assistant = LLMAssistantAggregator(context)
    worker = PipelineWorker(
        Pipeline([llm, TextTap(emit), assistant]),
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        idle_timeout_secs=None,
        enable_rtvi=False,
        observers=[usage],
    )
    finished = asyncio.Event()
    failures: list[str] = []

    async def rerun() -> None:
        emit({"type": "text", "delta": "\n\n"})
        await worker.queue_frames([LLMContextFrame(context)])

    promises = PromiseCheck(context, add_note, rerun)

    @worker.event_handler("on_pipeline_started")
    async def on_pipeline_started(_worker: PipelineWorker, _frame: Frame) -> None:
        await worker.queue_frames([LLMContextFrame(context)])

    @worker.event_handler("on_pipeline_error")
    async def on_pipeline_error(_worker: PipelineWorker, frame: ErrorFrame) -> None:
        failures.append(frame.error)
        finished.set()

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(_llm: OpenAILLMService, calls: list[FunctionCallFromLLM]) -> None:
        for call in calls:
            arguments = call.arguments if isinstance(call.arguments, dict) else {}
            emit(
                {"type": "tool", "id": call.tool_call_id, "name": call.function_name, "arguments": arguments}
            )

    @assistant.event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(
        _aggregator: LLMAssistantAggregator, _message: AssistantTurnStoppedMessage
    ) -> None:
        # Calls start before the response ends, so pending ones mean another completion follows.
        if not assistant.has_function_calls_in_progress and not await promises.reply_ended():
            finished.set()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await asyncio.wait_for(finished.wait(), REPLY_TIMEOUT_SECS)
    except TimeoutError:
        failures.append(f"no answer within {int(REPLY_TIMEOUT_SECS)} s")
    finally:
        await worker.cancel()
        with contextlib.suppress(Exception):
            await running
    return failures[0] if failures else None


async def compact(context: LLMContext, history: HistorySync, llm: OpenAILLMService, max_tokens: int) -> None:
    """Past `max_tokens`, folds the older turns into one summary the way a call does."""
    if LLMContextSummarizationUtil.estimate_context_tokens(context) < max_tokens:
        return
    config = summarization_config(max_tokens).summary_config
    picked = LLMContextSummarizationUtil.get_messages_to_summarize(context, config.min_messages_after_summary)
    if not picked.messages:
        return
    transcript = LLMContextSummarizationUtil.format_messages_for_summary(picked.messages)
    request = LLMContext(messages=[{"role": "user", "content": f"Conversation history:\n{transcript}"}])
    try:
        summary = await asyncio.wait_for(
            llm.run_inference(
                request, max_tokens=config.target_context_tokens, system_instruction=config.summary_prompt
            ),
            config.summarization_timeout,
        )
    except Exception as e:
        logger.warning(f"EA chat history not compacted: {type(e).__name__}: {e}")
        return
    if not summary or not summary.strip():
        return
    recent = context.messages[picked.last_summarized_index + 1 :]
    message = cast(
        LLMContextMessage,
        {"role": "user", "content": config.summary_message_template.format(summary=summary.strip())},
    )
    context.set_messages([message, *recent])
    await history.summary_applied()


class TextChat:
    """One typed reply at a time over the conversation the voice EA keeps."""

    def __init__(
        self,
        settings: Settings,
        tools: EaTools,
        conversation: Conversation,
        *,
        llm: LlmFactory = chat_llm,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._tools = tools
        self._conversation = conversation
        self._llm = llm
        self._now = now or (lambda: datetime.now(UTC))
        self._turn = asyncio.Lock()
        self._noted: datetime | None = None
        self._live = LiveContext(tools.seti, now=self._now)
        self._packs = PackPrompt(tools.seti, timeout_secs=CHAT_TIMEOUT_SECS)

    def _note(self, context: LLMContext, clock: UserClock) -> None:
        """Marks the switch to typing, and the time again once the last note is a while old."""
        at = self._now()
        fresh = self._noted is not None and at - self._noted < NOTE_INTERVAL
        if channel_of(context.messages) == "chat" and fresh:
            return
        self._noted = at
        context.add_message({"role": "developer", "content": chat_note(time_note(clock, at))})

    async def reply(self, text: str, clock: UserClock) -> AsyncGenerator[Event]:
        """Streams the EA's answer to `text`; leaving early stops the reply and keeps what is done."""
        events: asyncio.Queue[Event] = asyncio.Queue()
        await self._turn.acquire()
        task = asyncio.create_task(self._exchange(text, clock, events.put_nowait))
        ended = False
        try:
            while not ended:
                try:
                    event = await asyncio.wait_for(events.get(), PING_SECS)
                except TimeoutError:
                    yield {"type": "ping"}
                    continue
                ended = event["type"] in ("done", "error")
                yield event
        finally:
            if not ended:
                task.cancel()

    async def _group_chat(self, mentions: list[InboxItem]) -> str | None:
        """The group chat around the first mention, or None when there is no mention."""
        if not mentions:
            return None
        ids = [item.message_id for item in mentions if item.message_id is not None]
        try:
            excerpt = await self._tools.team_excerpt(min(ids)) if ids else ""
        except SetiError as e:
            logger.warning(f"EA could not read the group chat for a mention: {e}")
            excerpt = ""
        return excerpt or "(The group chat could not be read; call read_team_chat.)"

    async def follow_up(self, delivered: Delivered) -> None:
        """Checks due follow-ups, triages channel alerts and answers mentions, then reports in the chat.

        Only read-only tools and a reply to the agent that asked are open to it, and for alerts
        from a channel the user set to act, a direct message to an existing agent.
        """
        items = delivered.for_model
        if not items:
            return
        clock = next(
            (clock_for_zone(item.timezone) for item in items if item.timezone is not None),
            self._conversation.last_clock,
        )
        group_chat = await self._group_chat(delivered.mentions)
        origin = next((item.id for item in items if item.kind == "followup"), None)

        async def report(_tool: str, _result: ToolResult, _call_id: str) -> None:
            return None

        schemas = tool_schemas(
            self._tools, report, only=INBOX_TOOLS | ACT_TOOLS if delivered.act else INBOX_TOOLS
        )
        context = LLMContext(tools=ToolsSchema(standard_tools=schemas))
        async with self._turn:
            history = HistorySync(self._tools.seti, context, lock=self._conversation.lock, kind="chat")
            clock_token = CURRENT_CLOCK.set(clock)
            origin_token = INBOX_ORIGIN.set(origin)
            direct_token = DIRECT_ONLY.set(True)
            try:
                await history.load()
                history.add_unstored(
                    chat_inbox_note(time_note(clock, self._now()), group_chat, act=delivered.act)
                )
                await self._live.refresh(context)
                system = await self._packs.system_prompt()
                error = await self._run(context, history, system, lambda _event: None, "inbox")
                if error is not None:
                    logger.warning(f"EA inbox report failed: {error}")
                notify = self._notify and delivered.toast
                stored = await history.flush(final=error is not None, notify=notify)
                self._conversation.publish(stored)
            finally:
                DIRECT_ONLY.reset(direct_token)
                INBOX_ORIGIN.reset(origin_token)
                CURRENT_CLOCK.reset(clock_token)

    async def _run(
        self, context: LLMContext, history: HistorySync, system: str, emit: Emit, channel: Channel
    ) -> str | None:
        """Runs one reply and records its model calls' tokens and latency."""
        recorder = UsageRecorder(self._tools.seti)
        try:
            return await run_reply(
                context,
                self._llm(self._settings, system),
                emit,
                UsageObserver(recorder, channel),
                history.add_unstored,
            )
        finally:
            await recorder.flush()

    @property
    def _notify(self) -> bool:
        """A reply waits for the user as a notification unless a call is live, where it was spoken."""
        return not self._conversation.call_live

    async def _open_asks(self, history: HistorySync) -> None:
        note = await open_asks_note(self._tools.seti, self._now)
        if note is not None:
            history.add_unstored(note)

    async def answer(self, ask: AnsweredAsk) -> None:
        """Carries out the user's Allow or Deny from a notification, then replies in the chat."""
        async with self._turn:
            clock = self._conversation.last_clock
            clock_token = CURRENT_CLOCK.set(clock)
            asked: list[int] = []
            asked_token = ASKED.set(None)
            context = LLMContext(tools=ToolsSchema(standard_tools=tool_schemas(self._tools, _ignore)))
            history = HistorySync(self._tools.seti, context, lock=self._conversation.lock, kind="chat")
            try:
                await history.load()
                self._note(context, clock)
                verb = "Allow" if ask.allow else "Deny"
                history.add_unstored(ANSWER_NOTE)
                context.add_message({"role": "user", "content": f"{verb}: {ask.summary}"})
                result = await self._tools.answer(ask)
                if ask.allow:
                    call_id = f"ask_{ask.id}"
                    arguments = json.dumps({**ask.args, "confirmed": True})
                    function = {"name": ask.tool, "arguments": arguments}
                    call = {"id": call_id, "type": "function", "function": function}
                    context.add_message(cast(LLMContextMessage, {"role": "assistant", "tool_calls": [call]}))
                    context.add_message({"role": "tool", "tool_call_id": call_id, "content": result.text})
                ASKED.set(asked)
                if not self._settings.chat_missing:
                    system = await self._packs.system_prompt()
                    error = await self._run(context, history, system, lambda _event: None, "chat")
                    if error is not None:
                        logger.warning(f"EA reply to an answered question failed: {error}")
                stored = await history.flush(final=True, notify=self._notify, asks=asked)
                self._conversation.publish(stored)
            finally:
                ASKED.reset(asked_token)
                CURRENT_CLOCK.reset(clock_token)

    async def _exchange(self, text: str, clock: UserClock, emit: Emit) -> None:
        async def report(tool: str, result: ToolResult, call_id: str) -> None:
            emit(
                {
                    "type": "tool_result",
                    "id": call_id,
                    "name": tool,
                    "summary": result.summary,
                    "ok": result.ok,
                    "text": result.text,
                }
            )

        CURRENT_CLOCK.set(clock)
        self._conversation.last_clock = clock
        self._tools.user_turn()
        asked: list[int] = []
        ASKED.set(asked)
        context = LLMContext(tools=ToolsSchema(standard_tools=tool_schemas(self._tools, report)))
        history = HistorySync(self._tools.seti, context, lock=self._conversation.lock, kind="chat")
        try:
            await history.load()
            self._note(context, clock)
            await self._open_asks(history)
            context.add_message({"role": "user", "content": text})
            _, system = await asyncio.gather(self._live.refresh(context), self._packs.system_prompt())
            error = await self._run(context, history, system, emit, "chat")
            if error is not None:
                logger.warning(f"EA chat reply failed: {error}")
                emit({"type": "error", "title": "The EA could not answer", "detail": error})
                return
            stored = await history.flush(notify=self._notify, asks=asked)
            self._conversation.publish(stored)
            emit({"type": "done", "ids": [entry.id for entry in stored]})
            await compact(
                context, history, self._llm(self._settings, system), self._settings.history_max_tokens
            )
        except asyncio.CancelledError:
            self._conversation.publish(await history.flush(final=True))
            raise
        except Exception as e:
            logger.exception("EA chat failed")
            emit({"type": "error", "title": "The EA could not answer", "detail": str(e) or type(e).__name__})
        finally:
            self._turn.release()
