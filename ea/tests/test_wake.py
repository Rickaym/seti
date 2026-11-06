import asyncio
from types import SimpleNamespace
from typing import Any, cast

import httpx
from fakes import FakeSeti
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    DataFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    UserSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregatorParams
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor, FrameProcessorSetup
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_stop import BaseUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.utils.asyncio.task_manager import TaskManager

from seti_ea.seti import SetiClient
from seti_ea.wake import (
    WakeSettings,
    WakeStrategy,
    WakeUserAggregator,
    fetch_wake_settings,
    normalise_transcript,
    parse_wake_settings,
    strip_wake_phrase,
    turn_start_strategies,
    wake_message,
)

ON = WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=0.6)
# Room for scheduling jitter across several simulated turns.
SLOW_ON = WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=5.0)


def test_settings_parse_with_defaults() -> None:
    assert parse_wake_settings(None) == WakeSettings(enabled=False, phrase="Hey Seti", keep_awake_secs=30.0)
    data = {"wake_enabled": True, "wake_phrase": " Computer ", "keep_awake_seconds": 45}
    assert parse_wake_settings(data) == WakeSettings(enabled=True, phrase="Computer", keep_awake_secs=45.0)
    bad = {"wake_enabled": "yes", "wake_phrase": "", "keep_awake_seconds": -1}
    assert parse_wake_settings(bad) == WakeSettings()


async def test_settings_come_from_seti_and_fall_back_to_off(fake_seti: FakeSeti) -> None:
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    assert await fetch_wake_settings(seti) == WakeSettings()
    fake_seti.ea_settings = {"wake_enabled": True, "wake_phrase": "Hey Seti", "keep_awake_seconds": 20}
    assert await fetch_wake_settings(seti) == WakeSettings(enabled=True, keep_awake_secs=20.0)
    assert [r.url.path for r in fake_seti.requests] == ["/api/ea/settings", "/api/ea/settings"]


def test_the_phrase_is_not_sent_as_the_request() -> None:
    assert (
        strip_wake_phrase("Hey Seti, how many tasks are running?", "Hey Seti")
        == "how many tasks are running?"
    )
    assert strip_wake_phrase("Um, hey seti. What failed?", "Hey Seti") == "What failed?"
    assert strip_wake_phrase("Hey, Seti!", "Hey Seti") == "Hey, Seti!"
    assert strip_wake_phrase("What is running?", "Hey Seti") == "What is running?"
    assert strip_wake_phrase("OK computer stop it", "OK Computer") == "stop it"
    assert strip_wake_phrase("Hey Setting up", "Hey Seti") == "Hey Setting up"
    assert strip_wake_phrase("Hey Setty, what failed?", "Hey Seti") == "what failed?"


def test_common_mishearings_of_seti_count_as_seti() -> None:
    for heard in ("Setty", "Seddy", "Sethi", "Setti", "Set E", "set-e", "Settee", "city", "Sitty", "SETI"):
        assert normalise_transcript(f"Hey {heard}, what is running?") == "Hey Seti, what is running?", heard
        assert strip_wake_phrase(f"Hey {heard}, what is running?", "Hey Seti") == "what is running?", heard
    for word in ("setting", "settle", "set everything", "cities", "Sadie"):
        assert normalise_transcript(f"Hey {word}") == f"Hey {word}", word


async def started(strategy: WakeStrategy) -> TaskManager:
    manager = TaskManager()
    await strategy.setup(cast(FrameProcessorSetup, SimpleNamespace(task_manager=manager)))
    await asyncio.sleep(0)
    return manager


def transcript(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="", timestamp="now")


async def test_the_strategy_sleeps_wakes_and_times_out() -> None:
    strategy = WakeStrategy(ON)
    events: list[str] = []

    @strategy.event_handler("on_wake_phrase_detected")
    async def on_detected(_strategy: WakeStrategy, phrase: str) -> None:
        events.append(f"awake {phrase}")

    @strategy.event_handler("on_wake_phrase_timeout")
    async def on_timeout(_strategy: WakeStrategy) -> None:
        events.append("asleep")

    await started(strategy)
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.STOP
    assert not strategy.awake
    assert await strategy.process_frame(transcript("Hey, Setty!")) == ProcessFrameResult.STOP
    assert strategy.awake
    assert wake_message(strategy) == {
        "type": "ea-wake",
        "enabled": True,
        "awake": True,
        "phrase": "Hey Seti",
        "local": False,
    }
    for _ in range(3):
        await asyncio.sleep(0.3)
        assert await strategy.process_frame(UserSpeakingFrame()) == ProcessFrameResult.CONTINUE
    assert strategy.awake
    await asyncio.sleep(0.9)
    assert not strategy.awake
    assert events == ["awake Hey Seti", "asleep"]
    await strategy.cleanup()


async def test_the_strategy_can_be_switched_during_a_call() -> None:
    strategy = WakeStrategy(WakeSettings())
    await started(strategy)
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.CONTINUE
    assert wake_message(strategy)["enabled"] is False

    assert strategy.configure(WakeSettings(enabled=True, phrase="OK Computer", keep_awake_secs=5)) is True
    assert strategy.configure(WakeSettings(enabled=True, phrase="OK Computer", keep_awake_secs=5)) is False
    assert await strategy.process_frame(transcript("hey seti")) == ProcessFrameResult.STOP
    assert not strategy.awake
    await strategy.process_frame(transcript("ok computer"))
    assert strategy.awake

    strategy.configure(WakeSettings())
    strategy.configure(WakeSettings(enabled=True, phrase="OK Computer", keep_awake_secs=5))
    await asyncio.sleep(0)
    assert not strategy.awake
    await strategy.cleanup()


class StopOnSilence(BaseUserTurnStopStrategy):
    """Ends the turn as VAD reports silence, so no timer races the next simulated turn."""

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            await self.trigger_user_turn_stopped()
        return ProcessFrameResult.CONTINUE


class SleepNow(DataFrame):
    """Puts the EA to sleep at this point of a simulated call."""


class Sleeper(FrameProcessor):
    def __init__(self, wake: WakeStrategy) -> None:
        super().__init__()
        self._wake = wake

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, SleepNow):
            self._wake.sleep()
        else:
            await self.push_frame(frame, direction)


def turn(text: str) -> list[Frame]:
    return [VADUserStartedSpeakingFrame(), transcript(text), SleepFrame(), VADUserStoppedSpeakingFrame()]


def user_texts(context: LLMContext) -> list[Any]:
    messages = [cast(dict[str, Any], m) for m in context.messages]
    return [m["content"] for m in messages if m.get("role") == "user"]


async def run_turns(settings: WakeSettings, frames: list[Frame], *, slept: bool = False) -> LLMContext:
    context = LLMContext()
    wake = WakeStrategy(settings)
    if slept:
        wake.sleep()
    aggregator = WakeUserAggregator(
        context,
        params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(start=turn_start_strategies(wake), stop=[StopOnSilence()])
        ),
        wake=wake,
    )
    await run_test(Pipeline([Sleeper(wake), aggregator]), frames_to_send=frames, start_timeout=10.0)
    return context


async def test_asleep_speech_is_ignored_and_the_phrase_wakes_the_ea() -> None:
    frames = [
        *turn("How many tasks are running?"),
        *turn("Hey city. How many tasks are running?"),
        *turn("And the PRs?"),
        SleepFrame(sleep=7.0),
        *turn("Anything failing?"),
        *turn("Hey Seti."),
    ]
    context = await run_turns(SLOW_ON, frames)
    assert user_texts(context) == ["How many tasks are running?", "And the PRs?", "Hey Seti."]


async def test_a_turn_cut_short_by_sleep_gets_no_reply() -> None:
    frames = [
        *turn("Hey Seti, how many tasks are running?"),
        VADUserStartedSpeakingFrame(),
        InterimTranscriptionFrame(text="And the", user_id="", timestamp="now"),
        SleepFrame(),
        SleepNow(),
        transcript("And the PRs?"),
        SleepFrame(),
        VADUserStoppedSpeakingFrame(),
    ]
    context = await run_turns(SLOW_ON, frames)
    messages = [cast(dict[str, Any], m) for m in context.messages]
    assert messages == [{"role": "user", "content": "how many tasks are running?"}]


async def test_with_the_wake_word_off_every_turn_counts() -> None:
    context = await run_turns(WakeSettings(), [*turn("Hey Seti, hello"), *turn("What is running?")])
    assert user_texts(context) == ["Hey Seti, hello", "What is running?"]


async def test_sleep_ends_the_keep_awake_window_when_the_wake_word_is_on() -> None:
    strategy = WakeStrategy(SLOW_ON)
    events: list[str] = []

    @strategy.event_handler("on_wake_phrase_timeout")
    async def on_timeout(_strategy: WakeStrategy) -> None:
        events.append("asleep")

    await started(strategy)
    await strategy.process_frame(transcript("Hey Seti"))
    assert strategy.awake
    result = strategy.sleep()
    assert not strategy.awake
    assert result.text == "The EA is asleep until the user says Hey Seti. The user heard the goodbye."
    assert result.summary == "Asleep until Hey Seti"
    assert not strategy.temporary
    assert strategy.settings == SLOW_ON
    assert wake_message(strategy, local=True) == {
        "type": "ea-wake",
        "enabled": True,
        "awake": False,
        "phrase": "Hey Seti",
        "local": True,
    }
    await asyncio.sleep(0.05)
    assert events == ["asleep"]
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.STOP
    await strategy.process_frame(transcript("hey seti, how many tasks"))
    assert strategy.awake
    await strategy.cleanup()


async def test_sleep_with_the_wake_word_off_lasts_for_this_call_only() -> None:
    stored = WakeSettings(phrase="OK Computer", keep_awake_secs=5)
    strategy = WakeStrategy(stored)
    await started(strategy)
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.CONTINUE
    result = strategy.sleep()
    assert strategy.temporary
    assert strategy.settings == WakeSettings(enabled=True, phrase="OK Computer", keep_awake_secs=5)
    assert result.summary == "Asleep for this call until OK Computer"
    assert "rest of this call" in result.text
    assert "setting itself stays off" in result.text
    assert wake_message(strategy) == {
        "type": "ea-wake",
        "enabled": True,
        "awake": False,
        "phrase": "OK Computer",
        "local": False,
    }
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.STOP
    await strategy.process_frame(transcript("OK computer, how many tasks"))
    assert strategy.awake
    assert strategy.temporary
    await strategy.cleanup()

    next_call = WakeStrategy(stored)
    assert not next_call.temporary
    assert next_call.settings == stored
    await started(next_call)
    assert await next_call.process_frame(transcript("how many tasks")) == ProcessFrameResult.CONTINUE
    await next_call.cleanup()


async def test_switching_the_setting_ends_the_call_only_sleep() -> None:
    strategy = WakeStrategy(WakeSettings())
    await started(strategy)
    strategy.sleep()
    assert strategy.configure(WakeSettings(phrase="OK Computer")) is True
    assert strategy.temporary
    assert strategy.settings.phrase == "OK Computer"
    strategy.configure(WakeSettings(enabled=True))
    assert not strategy.temporary
    strategy.configure(WakeSettings())
    assert not strategy.settings.enabled
    assert await strategy.process_frame(transcript("how many tasks")) == ProcessFrameResult.CONTINUE
    await strategy.cleanup()


async def test_after_sleep_speech_is_ignored_until_the_phrase() -> None:
    frames = [*turn("How many tasks are running?"), *turn("Hey Seti, how many tasks are running?")]
    context = await run_turns(WakeSettings(keep_awake_secs=2.0), frames, slept=True)
    assert user_texts(context) == ["how many tasks are running?"]


async def test_interrupting_the_ea_mid_reply_takes_two_words() -> None:
    start = turn_start_strategies(WakeStrategy(WakeSettings()))[1]
    turns: list[str] = []

    @start.event_handler("on_user_turn_started")
    async def on_started(_strategy: object, _params: object) -> None:
        turns.append("started")

    await start.process_frame(BotStartedSpeakingFrame())
    assert await start.process_frame(transcript("okay")) == ProcessFrameResult.CONTINUE
    assert turns == []
    assert await start.process_frame(transcript("hold on")) == ProcessFrameResult.STOP
    assert turns == ["started"]
    await start.process_frame(BotStoppedSpeakingFrame())
    assert await start.process_frame(transcript("yes")) == ProcessFrameResult.STOP
