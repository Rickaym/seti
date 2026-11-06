"""Records the EA's token use and latency in Seti: numbers and labels only, never message text."""

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Literal

from loguru import logger
from pipecat.frames.frames import (
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    MetricsFrame,
)
from pipecat.metrics.metrics import LLMUsageMetricsData, TTFBMetricsData
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService

from seti_ea.seti import SetiClient, SetiError

Channel = Literal["voice", "chat", "inbox"]
USAGE_PATH = "/ea/usage"
BATCH_MAX = 200
FLUSH_AT = 20
LABEL_MAX = 100
LATENCY_MAX_MS = 10 * 60 * 1000
UNNAMED = "unknown"


def label(name: str | None) -> str | None:
    """A model name Seti accepts: word characters, dots, colons, slashes and dashes."""
    if not name:
        return None
    return re.sub(r"[^\w.:/-]", "-", name.strip())[:LABEL_MAX] or None


def millis(seconds: float) -> int:
    return min(LATENCY_MAX_MS, max(0, round(seconds * 1000)))


class UsageRecorder:
    """Holds usage records and sends them to Seti in batches; a failed send drops its batch."""

    def __init__(self, seti: SetiClient) -> None:
        self._seti = seti
        self._records: list[dict[str, Any]] = []
        self._sending = asyncio.Lock()

    async def add(self, record: dict[str, Any]) -> None:
        self._records.append(record)
        if len(self._records) >= FLUSH_AT:
            await self.flush()

    async def flush(self) -> None:
        async with self._sending:
            while self._records:
                batch, self._records = self._records[:BATCH_MAX], self._records[BATCH_MAX:]
                try:
                    await self._seti.post(USAGE_PATH, {"records": batch})
                except SetiError as e:
                    logger.warning(f"EA usage not recorded: {e.title}")


@dataclass
class _Call:
    """One model call while it streams."""

    ttfb_ms: int | None = None
    usage: LLMUsageMetricsData | None = None
    tool_calls: int = 0


def _speech_kind(source: FrameProcessor) -> Literal["stt", "tts"] | None:
    if isinstance(source, STTService):
        return "stt"
    if isinstance(source, TTSService):
        return "tts"
    return None


class UsageObserver(BaseObserver):
    """Turns each model call's metrics into one record, and speech services' time to first byte."""

    def __init__(self, recorder: UsageRecorder, channel: Channel) -> None:
        super().__init__(observe_every_push=False)
        self._recorder = recorder
        self._channel: Channel = channel
        self._call: _Call | None = None

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if isinstance(frame, MetricsFrame):
            await self._metrics(frame, data.source)
        elif not isinstance(data.source, LLMService) or data.direction != FrameDirection.DOWNSTREAM:
            return
        elif isinstance(frame, LLMFullResponseStartFrame):
            self._call = _Call()
        elif isinstance(frame, FunctionCallsStartedFrame) and self._call is not None:
            self._call.tool_calls += len(frame.function_calls)
        elif isinstance(frame, LLMFullResponseEndFrame):
            await self._finish()

    async def _metrics(self, frame: MetricsFrame, source: FrameProcessor) -> None:
        for metric in frame.data:
            if isinstance(source, LLMService) and self._call is not None:
                if isinstance(metric, TTFBMetricsData) and self._call.ttfb_ms is None:
                    self._call.ttfb_ms = millis(metric.value)
                elif isinstance(metric, LLMUsageMetricsData):
                    self._call.usage = metric
                continue
            kind = _speech_kind(source)
            if kind is not None and isinstance(metric, TTFBMetricsData) and metric.value > 0:
                await self._recorder.add(
                    {
                        "kind": kind,
                        "channel": "voice",
                        "model": label(metric.model),
                        "ttfb_ms": millis(metric.value),
                    }
                )

    async def _finish(self) -> None:
        call, self._call = self._call, None
        if call is None or call.usage is None:
            return
        tokens = call.usage.value
        await self._recorder.add(
            {
                "kind": "llm",
                "channel": self._channel,
                "model": label(call.usage.model) or UNNAMED,
                "ttfb_ms": call.ttfb_ms,
                "prompt_tokens": tokens.prompt_tokens,
                "cached_tokens": tokens.cache_read_input_tokens or 0,
                "completion_tokens": tokens.completion_tokens,
                "tool_calls": call.tool_calls,
            }
        )
