"""The voice pipeline for one EA session over a SmallWebRTC connection."""

import asyncio
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    FunctionCallResultProperties,
    LLMRunFrame,
    OutputTransportMessageUrgentFrame,
    STTUpdateSettingsFrame,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    AssistantTurnStoppedMessage,
    LLMAssistantAggregator,
    LLMAssistantAggregatorParams,
    LLMUserAggregator,
    LLMUserAggregatorParams,
)
from pipecat.processors.frameworks.rtvi import (
    RTVIFunctionCallReportLevel,
    RTVIObserverParams,
    RTVIProcessor,
)
from pipecat.processors.frameworks.rtvi.models import ClientMessage
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.turns.user_stop import BaseUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from pipecat.workers.runner import WorkerRunner
from pydantic import BaseModel

from seti_ea.announce import ToolAnnouncer, ToolCall
from seti_ea.brief import brief_note, fetch_brief, greeting
from seti_ea.call import CallRequest
from seti_ea.clock import CURRENT_CLOCK, TimeNotes
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.held import HeldUpdates
from seti_ea.history import HistorySync, summarization_config
from seti_ea.inbox import (
    VOICE_HELD_TOOLS,
    CallInbox,
    Delivered,
    InboxGuard,
    SilenceGate,
    SilenceObserver,
    VoiceDelivery,
    deliver,
)
from seti_ea.live_context import LiveContext, LiveContextInjector
from seti_ea.local_wake import PausableDeepgramSTT, SleepControl
from seti_ea.packs import VOICE_TIMEOUT_SECS, PackPrompt, SystemPromptUpdates
from seti_ea.promises import PromiseCheck
from seti_ea.prompt import (
    SYSTEM_PROMPT,
    VOICE_NOTE,
    voice_urgent_note,
    with_act,
)
from seti_ea.redact import scrub_value, secrets_of
from seti_ea.spotter import LOCAL_SPOTTER
from seti_ea.toolkit import ToolResult, ToolSpec
from seti_ea.tools import TOOL_SPECS, EaTools
from seti_ea.usage import UsageObserver, UsageRecorder
from seti_ea.wake import (
    SETI,
    SLEEP_SPEC,
    WakeSettings,
    WakeStrategy,
    WakeUserAggregator,
    fetch_wake_settings,
    turn_start_strategies,
    wake_message,
)

IDLE_TIMEOUT_SECS = 1800
# Smart Turn ends a turn it judges unfinished after this much silence; pipecat's default is 3.
UNFINISHED_TURN_SECS = 4.0
SETTINGS_CHANGED = "ea-settings-changed"
SETTINGS_TOOL = "update_ea_settings"
HISTORY_CLEARED = "ea-history-cleared"
SLEEP_REQUESTED = "ea-sleep"
WAKE_REQUESTED = "ea-wake-up"
Report = Callable[[str, ToolResult, str], Awaitable[None]]
Announce = Callable[[], Awaitable[None]]
Retune = Callable[[list[str]], Awaitable[None]]


class RedactingRTVIProcessor(RTVIProcessor):
    """Scrubs key values from every RTVI message; service errors can quote request headers."""

    def __init__(self, secrets: list[str]) -> None:
        super().__init__()
        self._secrets = secrets

    async def push_transport_message(self, model: BaseModel, exclude_none: bool = True) -> None:
        message = scrub_value(model.model_dump(exclude_none=exclude_none), self._secrets)
        await self.push_frame(OutputTransportMessageUrgentFrame(message=message))


def filler_frame(text: str) -> TTSSpeakFrame:
    """Speech that covers a tool call; kept out of the LLM context so the model never echoes it."""
    return TTSSpeakFrame(text, append_to_context=False)


def action_message(tool: str, result: ToolResult) -> dict[str, Any]:
    """The RTVI server message the UI receives after every tool call."""
    return {"type": "ea-action", "tool": tool, "summary": result.summary, "ok": result.ok}


def keyterms(wake: WakeSettings) -> list[str]:
    """Deepgram keyterms: always Seti, and the wake phrase while the wake word is on."""
    terms = [SETI]
    if wake.enabled and wake.phrase.casefold() != SETI.casefold():
        terms.append(wake.phrase)
    return terms


Guard = Callable[[str, Mapping[str, Any]], ToolResult | None]


def tool_schemas(
    tools: EaTools,
    report: Report,
    *,
    only: Collection[str] | None = None,
    guard: Guard | None = None,
) -> list[FunctionSchema]:
    """FunctionSchemas whose handlers run the EA tools and report each outcome.

    `only` limits the tools the model sees; `guard` may refuse a call with the result it returns.
    """

    def handler_for(spec: ToolSpec) -> Callable[[FunctionCallParams], Awaitable[None]]:
        async def run(arguments: dict[str, Any], call_id: str) -> ToolResult:
            refused = guard(spec.name, arguments) if guard is not None else None
            try:
                result = refused or await tools.call(spec.name, arguments)
            except Exception:
                logger.exception(f"EA tool {spec.name} failed")
                result = ToolResult("The tool failed unexpectedly.", f"{spec.name} failed", False)
            await report(spec.name, result, call_id)
            return result

        async def handle(params: FunctionCallParams) -> None:
            # Shielded so a barge-in cannot abandon a write that Seti may already have applied.
            result = await asyncio.shield(run(dict(params.arguments), params.tool_call_id))
            await params.result_callback(result.text)

        return handle

    return [
        FunctionSchema(
            name=spec.name,
            description=spec.description,
            properties=spec.properties,
            required=spec.required,
            handler=handler_for(spec),
        )
        for spec in TOOL_SPECS
        if only is None or spec.name in only
    ]


def openai_llm(settings: Settings, model: str, system: str = SYSTEM_PROMPT) -> OpenAILLMService:
    """The EA's OpenAI service for `model`, with the system prompt and reasoning effort."""
    return OpenAILLMService(
        api_key=settings.openai_api_key,
        settings=OpenAILLMService.Settings(model=model, system_instruction=system, extra=settings.llm_params),
    )


def voice_text_filter() -> MarkdownTextFilter:
    """Strips markdown, code and tables from speech, in case a reply is written for the chat."""
    return MarkdownTextFilter(MarkdownTextFilter.InputParams(filter_code=True, filter_tables=True))


async def publish_wake(wake: WakeStrategy, before: WakeSettings, announce: Announce, retune: Retune) -> None:
    """Retunes speech to text if the keyterms changed, then announces the wake state."""
    if keyterms(before) != keyterms(wake.settings):
        await retune(keyterms(wake.settings))
    await announce()


async def put_to_sleep(wake: WakeStrategy, announce: Announce, retune: Retune) -> ToolResult:
    """Sends the EA to sleep and announces it; the result is what the LLM reads back."""
    before = wake.settings
    result = wake.sleep()
    await publish_wake(wake, before, announce, retune)
    return result


async def wake_up(wake: WakeStrategy, announce: Announce) -> bool:
    """Wakes a sleeping EA as if its phrase was said, for the inbox or the UI, and announces it."""
    if not wake.wake():
        return False
    await announce()
    return True


def smart_turn() -> LocalSmartTurnAnalyzerV3:
    """Smart Turn, which waits UNFINISHED_TURN_SECS of silence on a turn that sounds unfinished."""
    return LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=UNFINISHED_TURN_SECS))


def turn_stop_strategies() -> list[BaseUserTurnStopStrategy]:
    """Smart Turn decides when the user's turn ends, not VAD silence alone."""
    return [TurnAnalyzerUserTurnStopStrategy(turn_analyzer=smart_turn())]


def sleep_schema(fall_asleep: Callable[[], Awaitable[ToolResult]], report: Report) -> FunctionSchema:
    """The go_to_sleep tool; Seti speaks the goodbye, so the LLM does not run after it."""

    async def handle(params: FunctionCallParams) -> None:
        result = await fall_asleep()
        await report(SLEEP_SPEC.name, result, params.tool_call_id)
        await params.result_callback(result.text, properties=FunctionCallResultProperties(run_llm=False))

    return FunctionSchema(
        name=SLEEP_SPEC.name,
        description=SLEEP_SPEC.description,
        properties=SLEEP_SPEC.properties,
        required=SLEEP_SPEC.required,
        handler=handle,
    )


async def run_bot(
    connection: SmallWebRTCConnection,
    settings: Settings,
    tools: EaTools,
    call: CallRequest,
    conversation: Conversation,
) -> None:
    """Run one voice session until the client leaves or the task is cancelled.

    A call Seti joined on its own starts asleep and says nothing until woken.
    """
    seti = tools.seti
    clock = call.clock
    CURRENT_CLOCK.set(clock)
    conversation.last_clock = clock
    gate = SilenceGate()
    call_inbox = CallInbox()
    conversation.call = call_inbox
    wake = WakeStrategy(await fetch_wake_settings(seti))
    if call.auto:
        wake.sleep()
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    # The default model is Nova-3, which takes keyterm; keywords is for older models.
    stt = PausableDeepgramSTT(
        paused=wake.settings.enabled and LOCAL_SPOTTER.get() is not None,
        api_key=settings.deepgram_api_key,
        settings=DeepgramSTTService.Settings(keyterm=keyterms(wake.settings)),
    )
    control = SleepControl(wake, stt, LOCAL_SPOTTER.get)
    tts = ElevenLabsTTSService(
        api_key=settings.elevenlabs_api_key,
        settings=ElevenLabsTTSService.Settings(
            voice=settings.elevenlabs_voice_id, model=settings.elevenlabs_model
        ),
        text_filters=[voice_text_filter()],
    )
    packs = PackPrompt(seti, timeout_secs=VOICE_TIMEOUT_SECS)
    system = await packs.system_prompt()
    llm = openai_llm(settings, settings.model, system)

    rtvi = RedactingRTVIProcessor(secrets_of(settings))

    async def report(tool: str, result: ToolResult, _call_id: str) -> None:
        await rtvi.send_server_message(action_message(tool, result))
        if tool == SETTINGS_TOOL and result.ok:
            await apply_settings()

    async def retune(terms: list[str]) -> None:
        delta = DeepgramSTTService.Settings(keyterm=terms)
        await worker.queue_frames([STTUpdateSettingsFrame(delta=delta)])

    async def announce_wake() -> None:
        await control.follow()
        await rtvi.send_server_message(wake_message(wake, local=control.listening_locally))

    async def fall_asleep() -> ToolResult:
        return await put_to_sleep(wake, announce_wake, retune)

    guard = InboxGuard(VOICE_HELD_TOOLS)
    schemas = [*tool_schemas(tools, report, guard=guard.check), sleep_schema(fall_asleep, report)]
    context = LLMContext(tools=ToolsSchema(standard_tools=schemas))
    history = HistorySync(seti, context, lock=conversation.lock)
    inbox = conversation.attach()
    returning = await history.load()
    user_aggregator = WakeUserAggregator(
        context,
        params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(),
            user_turn_strategies=UserTurnStrategies(
                start=turn_start_strategies(wake), stop=turn_stop_strategies()
            ),
        ),
        wake=wake,
    )
    assistant_aggregator = LLMAssistantAggregator(
        context,
        params=LLMAssistantAggregatorParams(
            enable_auto_context_summarization=True,
            auto_context_summarization_config=summarization_config(settings.history_max_tokens),
        ),
    )
    usage = UsageRecorder(seti)

    async def take(ids: Sequence[int]) -> Delivered:
        return await deliver(seti, ids, "voice")

    pipeline = Pipeline(
        [
            transport.input(),
            control.local,
            stt,
            user_aggregator,
            HeldUpdates(call_inbox, take, history),
            LiveContextInjector(LiveContext(seti), SystemPromptUpdates(packs, system)),
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        idle_timeout_secs=IDLE_TIMEOUT_SECS,
        cancel_on_idle_timeout=False,
        observers=[SilenceObserver(gate), UsageObserver(usage, "voice")],
        rtvi_processor=rtvi,
        rtvi_observer_params=RTVIObserverParams(
            function_call_report_level={"*": RTVIFunctionCallReportLevel.NAME}
        ),
    )

    notes = TimeNotes(clock)
    announcer = ToolAnnouncer()

    async def apply_settings() -> None:
        before = wake.settings
        if wake.configure(await fetch_wake_settings(seti)):
            await publish_wake(wake, before, announce_wake, retune)

    @worker.event_handler("on_idle_timeout")
    async def on_idle_timeout(_worker: PipelineWorker) -> None:
        # Asleep, a call costs nothing and waits for its phrase; awake and idle, it sleeps or ends.
        if not wake.settings.enabled:
            await worker.cancel()
        elif wake.awake:
            await fall_asleep()

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(_llm: OpenAILLMService, calls: list[Any]) -> None:
        if guard.active:
            return
        text = announcer.phrase([ToolCall(c.function_name, c.arguments or {}) for c in calls])
        if text is not None:
            await tts.queue_frame(filler_frame(text))

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(_rtvi: RTVIProcessor) -> None:
        history.add_call(notes.call_started(datetime.now(UTC)))
        if not call.auto:
            brief = await fetch_brief(seti)
            if brief is not None:
                history.add_unstored(brief_note(brief))
            history.add_unstored(greeting(returning, brief))
            await worker.queue_frames([LLMRunFrame()])
        await announce_wake()
        delivering.append(asyncio.create_task(delivery.run()))

    @rtvi.event_handler("on_client_message")
    async def on_client_message(_rtvi: RTVIProcessor, message: ClientMessage) -> None:
        if message.type == SETTINGS_CHANGED:
            await apply_settings()
        elif message.type == HISTORY_CLEARED:
            inbox.take()
            await history.reset()
        elif message.type == SLEEP_REQUESTED:
            await fall_asleep()
        elif message.type == WAKE_REQUESTED:
            await wake_up(wake, announce_wake)

    @wake.event_handler("on_wake_phrase_detected")
    async def on_wake_phrase_detected(_wake: WakeStrategy, _phrase: str) -> None:
        await announce_wake()

    @wake.event_handler("on_wake_phrase_timeout")
    async def on_wake_phrase_timeout(_wake: WakeStrategy) -> None:
        await announce_wake()

    @user_aggregator.event_handler("on_user_turn_started")
    async def on_user_turn_started(
        _aggregator: LLMUserAggregator, _strategy: BaseUserTurnStartStrategy
    ) -> None:
        guard.active = False
        if await history.merge(inbox.take()):
            context.add_message({"role": "developer", "content": VOICE_NOTE})
        note = notes.refresh(datetime.now(UTC))
        if note is not None:
            context.add_message({"role": "developer", "content": note})

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def on_user_turn_stopped(_aggregator: LLMUserAggregator, *_args: Any) -> None:
        tools.user_turn()
        gate.expect_reply()
        await history.flush()

    promises = PromiseCheck(context, history.add_unstored, lambda: worker.queue_frames([LLMRunFrame()]))

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(
        aggregator: LLMAssistantAggregator, message: AssistantTurnStoppedMessage
    ) -> None:
        await history.flush()
        await usage.flush()
        if not aggregator.has_function_calls_in_progress:
            await promises.reply_ended(interrupted=message.interrupted)

    @assistant_aggregator.event_handler("on_summary_applied")
    async def on_summary_applied(_aggregator: LLMAssistantAggregator, *_args: Any) -> None:
        await history.summary_applied()

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport: SmallWebRTCTransport, _client: Any) -> None:
        logger.info("EA client disconnected")
        await worker.cancel()

    async def report_inbox(delivered: Delivered, woke: bool) -> None:
        await history.merge(delivered.entries)
        note = notes.refresh(datetime.now(UTC))
        if note is not None:
            context.add_message({"role": "developer", "content": note})
        history.add_unstored(with_act(voice_urgent_note(woke=woke), act=delivered.act))
        guard.report(delivered)
        await worker.queue_frames([LLMRunFrame()])

    async def wake_for_inbox() -> None:
        await wake_up(wake, announce_wake)

    delivery = VoiceDelivery(
        inbox=call_inbox,
        gate=gate,
        asleep=lambda: wake.settings.enabled and not wake.awake,
        take=take,
        report=report_inbox,
        wake=wake_for_inbox,
    )
    delivering: list[asyncio.Task[None]] = []

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    try:
        await runner.run()
    finally:
        for task in delivering:
            task.cancel()
        if conversation.call is call_inbox:
            conversation.call = None
        conversation.detach(inbox)
        await history.flush(final=True)
        await usage.flush()
