from typing import Any
from unittest.mock import MagicMock

import httpx
from fakes import FakeSeti
from pipecat.frames.frames import (
    FunctionCallFromLLM,
    FunctionCallsStartedFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    MetricsFrame,
)
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, TTFBMetricsData
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService
from pipecat.services.tts_service import TTSService

from seti_ea.metrics_tools import ea_usage_lines
from seti_ea.seti import SetiClient
from seti_ea.usage import FLUSH_AT, UsageObserver, UsageRecorder, label

DOWN = FrameDirection.DOWNSTREAM


def recorder_for(fake_seti: FakeSeti) -> UsageRecorder:
    return UsageRecorder(SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle)))


def pushed(source: FrameProcessor, frame: Any, direction: FrameDirection = DOWN) -> FramePushed:
    return FramePushed(source=source, destination=MagicMock(), frame=frame, direction=direction, timestamp=0)


def usage(prompt: int, cached: int | None, completion: int) -> MetricsFrame:
    tokens = LLMTokenUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=prompt + completion,
        cache_read_input_tokens=cached,
    )
    return MetricsFrame(data=[LLMUsageMetricsData(processor="llm", model="gpt-4.1", value=tokens)])


def ttfb(seconds: float, model: str | None = None) -> MetricsFrame:
    return MetricsFrame(data=[TTFBMetricsData(processor="p", model=model, value=seconds)])


def call(name: str) -> FunctionCallFromLLM:
    return FunctionCallFromLLM(function_name=name, tool_call_id=name, arguments={}, context=LLMContext())


async def test_a_voice_turn_records_the_model_call_and_the_speech_latency(fake_seti: FakeSeti) -> None:
    recorder = recorder_for(fake_seti)
    observer = UsageObserver(recorder, "voice")
    llm, stt, tts = MagicMock(spec=LLMService), MagicMock(spec=STTService), MagicMock(spec=TTSService)
    calls = FunctionCallsStartedFrame(function_calls=[call("list_tasks"), call("get_task")])
    for event in [
        pushed(stt, ttfb(0.31, "nova-3")),
        pushed(llm, LLMFullResponseStartFrame()),
        pushed(llm, ttfb(0.8204)),
        pushed(llm, ttfb(2.0)),
        pushed(llm, usage(16000, 9000, 25)),
        pushed(llm, calls),
        pushed(llm, calls, FrameDirection.UPSTREAM),
        pushed(llm, LLMFullResponseEndFrame()),
        pushed(tts, ttfb(0.25, "eleven flash v2.5")),
        pushed(tts, ttfb(0.0)),
    ]:
        await observer.on_push_frame(event)
    assert fake_seti.usage_records == []

    await recorder.flush()

    assert fake_seti.usage_records == [
        {"kind": "stt", "channel": "voice", "model": "nova-3", "ttfb_ms": 310},
        {
            "kind": "llm",
            "channel": "voice",
            "model": "gpt-4.1",
            "ttfb_ms": 820,
            "prompt_tokens": 16000,
            "cached_tokens": 9000,
            "completion_tokens": 25,
            "tool_calls": 2,
        },
        {"kind": "tts", "channel": "voice", "model": "eleven-flash-v2.5", "ttfb_ms": 250},
    ]


async def test_a_call_without_usage_records_nothing_and_full_batches_send_at_once(
    fake_seti: FakeSeti,
) -> None:
    recorder = recorder_for(fake_seti)
    observer = UsageObserver(recorder, "inbox")
    llm = MagicMock(spec=LLMService)
    await observer.on_push_frame(pushed(llm, LLMFullResponseStartFrame()))
    await observer.on_push_frame(pushed(llm, LLMFullResponseEndFrame()))
    await recorder.flush()
    assert fake_seti.usage_records == []
    assert not fake_seti.posts()

    for _ in range(FLUSH_AT):
        await observer.on_push_frame(pushed(llm, LLMFullResponseStartFrame()))
        await observer.on_push_frame(pushed(llm, usage(100, None, 5)))
        await observer.on_push_frame(pushed(llm, LLMFullResponseEndFrame()))
    assert len(fake_seti.usage_records) == FLUSH_AT
    assert {(r["channel"], r["cached_tokens"], r["ttfb_ms"]) for r in fake_seti.usage_records} == {
        ("inbox", 0, None)
    }


async def test_a_failed_send_is_dropped_without_raising(fake_seti: FakeSeti) -> None:
    fake_seti.fail[("POST", "/api/ea/usage")] = (403, {"error": {"title": "Forbidden"}})
    recorder = recorder_for(fake_seti)
    await recorder.add({"kind": "tts", "channel": "voice", "model": None, "ttfb_ms": 200})
    await recorder.flush()
    await recorder.flush()
    assert len(fake_seti.posts()) == 1


def test_labels_keep_only_safe_characters() -> None:
    assert label("gpt-4.1-2025-04-14") == "gpt-4.1-2025-04-14"
    assert label("models/eleven flash") == "models/eleven-flash"
    assert label("") is None
    assert label(None) is None
    assert label("x" * 300) == "x" * 100


def test_usage_lines_say_when_the_ea_made_no_calls() -> None:
    assert ea_usage_lines({"calls_window": 0}) == ["The EA made no model calls in the last 7 days."]
    assert ea_usage_lines(None) == ["The EA made no model calls in the last 7 days."]
