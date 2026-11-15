import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any

import httpx
import pytest
from fakes import NOW, FakeSeti
from openai.types.responses import (
    Response,
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseUsage,
)
from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

from seti_ea.actions import CONFIRM_TOOLS
from seti_ea.announce import THINK_LINES, ToolAnnouncer, ToolCall
from seti_ea.inbox import ACTION_TOOLS, VOICE_HELD_TOOLS
from seti_ea.seti import SetiClient
from seti_ea.think import (
    THINK_SPECS,
    THINK_TOOLS,
    Round,
    Thinker,
    ThinkStats,
    function_tool,
    parse_thought,
)
from seti_ea.think_speech import (
    EVERY_SECS,
    FIRST_SECS,
    MAX_LINES,
    STILL_LINES,
    SpokenProgress,
    ThinkWatcher,
    step_line,
)
from seti_ea.think_tool import FAILED, THOUGHT_NOTE, TIMED_OUT, ThinkTool, background
from seti_ea.toolkit import ToolResult
from seti_ea.tools import TOOL_SPECS, EaTools
from seti_ea.usage import UsageRecorder

Next = Response | asyncio.Event | Exception


def usage() -> ResponseUsage:
    return ResponseUsage(
        input_tokens=900,
        input_tokens_details=InputTokensDetails(cached_tokens=300, cache_write_tokens=0),
        output_tokens=60,
        output_tokens_details=OutputTokensDetails(reasoning_tokens=40),
        total_tokens=960,
    )


def reads(*calls: tuple[str, dict[str, Any]]) -> Response:
    output = [
        ResponseFunctionToolCall(
            type="function_call", call_id=f"fc{i}", name=name, arguments=json.dumps(args)
        )
        for i, (name, args) in enumerate(calls)
    ]
    return Response.model_construct(id="resp", model="gpt-6-sol", output=output, usage=usage())


def answer(spoken: str, detail: str = "") -> Response:
    text = ResponseOutputText(
        type="output_text", text=json.dumps({"spoken": spoken, "detail": detail}), annotations=[]
    )
    message = ResponseOutputMessage(
        id="msg", type="message", role="assistant", status="completed", content=[text]
    )
    return Response.model_construct(id="resp", model="gpt-6-sol", output=[message], usage=usage())


class FakeAsk:
    """The reasoning model: answers from a script, waiting on an event or failing where it says."""

    def __init__(self, script: list[Next]) -> None:
        self.script = script
        self.rounds: list[Round] = []
        self.asked = asyncio.Event()

    async def __call__(self, request: Round) -> Response:
        self.rounds.append(request)
        self.asked.set()
        step = self.script.pop(0)
        if isinstance(step, asyncio.Event):
            await step.wait()
            step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        assert isinstance(step, Response)
        return step


class Watched(ThinkWatcher):
    def __init__(self) -> None:
        self.seen: list[tuple[str, str]] = []

    async def started(self, call_id: str) -> None:
        self.seen.append(("started", call_id))

    async def step(self, call_id: str, line: str) -> None:
        self.seen.append(("step", line))

    async def finished(self, call_id: str) -> None:
        self.seen.append(("finished", call_id))


def client(fake_seti: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))


async def nothing(_tool: str, _args: Mapping[str, Any]) -> None:
    return None


def writes(fake_seti: FakeSeti) -> list[str]:
    """Requests that could change Seti, beyond the usage and audit records the EA always sends."""
    kept = {"/api/ea/usage", "/api/ea/thoughts"}
    return [
        f"{r.method} {r.url.path}" for r in fake_seti.requests if r.method != "GET" and r.url.path not in kept
    ]


def test_the_thinker_gets_read_tools_only() -> None:
    names = {spec.name for spec in TOOL_SPECS}
    assert names >= THINK_TOOLS
    assert not THINK_TOOLS & (ACTION_TOOLS | VOICE_HELD_TOOLS | CONFIRM_TOOLS)
    side_effects = {"schedule_followup", "cancel_followup", "watch_task", "test_channel_script"}
    assert not THINK_TOOLS & (side_effects | {"reconnect_mcp_server", "get_security_settings"})
    assert {spec.name for spec in THINK_SPECS} == THINK_TOOLS
    for spec in THINK_SPECS:
        parameters = function_tool(spec)["parameters"] or {}
        assert "refresh" not in json.dumps(parameters)


async def test_the_thinker_reads_then_answers_and_refuses_a_write(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    ask = FakeAsk(
        [
            reads(("list_prs", {}), ("stop_task", {"task": "login"})),
            answer("Merge PR 12 first; it unblocks the dashboard.", "- **PR 12**: green"),
        ]
    )
    recorder = UsageRecorder(tools.seti)
    steps: list[str] = []

    async def step(tool: str, _args: Mapping[str, Any]) -> None:
        steps.append(tool)

    stats = ThinkStats()
    thought = await Thinker(tools, ask, recorder).think(
        "Which PR first?", "The recent conversation", step, stats
    )
    await recorder.flush()

    assert thought.spoken == "Merge PR 12 first; it unblocks the dashboard."
    assert thought.detail == "- **PR 12**: green"
    assert stats.rounds == 1
    assert steps == ["list_prs", "stop_task"]
    outputs = [item for item in ask.rounds[1].input if item.get("type") == "function_call_output"]
    assert "stop_task is not open to you" in outputs[1]["output"]
    assert outputs[0]["output"]
    assert writes(fake_seti) == []
    assert ask.rounds[0].input[:2] == [
        {"role": "developer", "content": "The recent conversation"},
        {"role": "user", "content": "Which PR first?"},
    ]
    assert [(r["channel"], r["tool_calls"]) for r in fake_seti.usage_records] == [("think", 2), ("think", 0)]
    assert all(r["prompt_tokens"] == 900 and r["cached_tokens"] == 300 for r in fake_seti.usage_records)


async def test_the_thinker_never_asks_seti_to_probe_again(tools: EaTools, fake_seti: FakeSeti) -> None:
    ask = FakeAsk([reads(("account_status", {"refresh": True})), answer("The account is fine.")])
    await Thinker(tools, ask, UsageRecorder(tools.seti)).think("Usage?", "", nothing, ThinkStats())
    assert writes(fake_seti) == []


async def test_the_last_round_must_answer_without_tools(tools: EaTools) -> None:
    ask = FakeAsk([reads(("list_tasks", {})), reads(("list_prs", {})), answer("Done weighing.")])
    stats = ThinkStats()
    thought = await Thinker(tools, ask, UsageRecorder(tools.seti), max_rounds=2).think(
        "Q", "", nothing, stats
    )
    assert thought.spoken == "Done weighing."
    assert [r.last for r in ask.rounds] == [False, False, True]
    assert stats.rounds == 2


def test_a_plain_answer_still_reads_as_spoken() -> None:
    assert parse_thought("Merge PR 12 first.").spoken == "Merge PR 12 first."
    assert parse_thought('{"spoken": "", "detail": ""}').spoken == '{"spoken": "", "detail": ""}'
    assert parse_thought("").spoken.startswith("I thought it over")


def test_step_lines_say_what_the_thinker_reads_without_ids() -> None:
    assert step_line("list_prs", {}) == "I'm going through the open PRs."
    assert step_line("get_task", {"task": "Gilgamesh"}) == "I'm checking Gilgamesh's latest turn."
    assert step_line("get_task", {"task": "3f2a9c1e-77"}) == "I'm checking an agent's latest turn."
    assert step_line("get_pr", {"pr": "#2249"}) == "I'm reading PR 2249 in detail."
    assert step_line("get_pr", {"pr": "https://github.com/o/r/pull/12"}) == "I'm reading PR 12 in detail."
    assert step_line("list_channels", {}) == "I'm checking a few more details in Seti."


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def progress(clock: Clock, floor: Callable[[], bool] = lambda: True) -> tuple[SpokenProgress, list[str]]:
    said: list[str] = []

    async def say(text: str) -> None:
        said.append(text)

    return SpokenProgress(say, floor, clock=clock, check_secs=3600), said


async def test_progress_lines_follow_the_schedule_and_never_repeat() -> None:
    clock = Clock()
    speech, _said = progress(clock)
    await speech.started("c1")
    await speech.step("c1", "I'm going through the open PRs.")
    lines: list[tuple[float, str]] = []
    for tick in range(700):
        clock.now = tick / 10
        line = speech.due()
        if line is not None:
            lines.append((clock.now, line))
    await speech.stop()

    assert [at for at, _ in lines] == [FIRST_SECS + i * EVERY_SECS for i in range(MAX_LINES)]
    assert lines[0][1] == "I'm going through the open PRs."
    texts = [text for _, text in lines]
    assert len(set(texts)) == len(texts)
    assert set(texts[1:]) <= set(STILL_LINES)


async def test_a_fresh_step_beats_a_still_line() -> None:
    clock = Clock()
    speech, _ = progress(clock)
    await speech.started("c1")
    clock.now = FIRST_SECS
    assert speech.due() in STILL_LINES
    await speech.step("c1", "I'm checking Gilgamesh's latest turn.")
    clock.now = FIRST_SECS + EVERY_SECS
    assert speech.due() == "I'm checking Gilgamesh's latest turn."
    await speech.stop()


async def test_progress_waits_for_the_user_and_drops_a_line_held_up_too_long() -> None:
    clock = Clock()
    talking = [True]
    speech, _ = progress(clock, lambda: not talking[0])
    await speech.started("c1")
    clock.now = FIRST_SECS
    assert speech.due() is None
    clock.now = FIRST_SECS + 2
    talking[0] = False
    assert speech.due() is not None
    talking[0] = True
    clock.now = FIRST_SECS + 2 + EVERY_SECS + 4
    assert speech.due() is None
    talking[0] = False
    clock.now += 1
    assert speech.due() is None, "the held-up line is dropped, and the next waits its turn"
    clock.now += EVERY_SECS
    assert speech.due() is not None
    await speech.finished("c1")
    clock.now += EVERY_SECS
    assert speech.due() is None
    await speech.stop()


async def test_progress_lines_are_spoken_by_the_loop() -> None:
    said: list[str] = []
    done = asyncio.Event()

    async def say(text: str) -> None:
        said.append(text)
        done.set()

    clock = Clock()
    speech = SpokenProgress(say, lambda: True, clock=clock, check_secs=0.01)
    await speech.started("c1")
    clock.now = FIRST_SECS
    async with asyncio.timeout(2):
        await done.wait()
    await speech.stop()
    assert said == [STILL_LINES[0]]
    assert not speech.active


def think_tool(
    fake_seti: FakeSeti, ask: FakeAsk, watcher: ThinkWatcher, reported: list[ToolResult], **kwargs: Any
) -> ThinkTool:
    seti = client(fake_seti)
    tools = EaTools(seti, now=lambda: NOW)

    async def report(_tool: str, result: ToolResult, _call_id: str) -> None:
        reported.append(result)

    thinker = Thinker(tools, ask, UsageRecorder(seti))
    return ThinkTool(thinker, seti, "voice", report, watcher, **kwargs)


async def test_an_answer_is_reported_and_audited_without_the_question(fake_seti: FakeSeti) -> None:
    ask = FakeAsk([reads(("list_prs", {})), answer("Merge PR 12 first.", "Longer.")])
    watcher = Watched()
    reported: list[ToolResult] = []
    tool = think_tool(fake_seti, ask, watcher, reported)

    result = await tool.run("c1", {"question": "Which PR goes first?"}, [])
    await tool.settle()

    assert result.ok
    assert result.text.startswith(THOUGHT_NOTE)
    assert "Spoken answer: Merge PR 12 first." in result.text
    assert "Longer." in result.text
    assert reported == [result]
    assert watcher.seen == [
        ("started", "c1"),
        ("step", "I'm going through the open PRs."),
        ("finished", "c1"),
    ]
    [audit] = fake_seti.thoughts
    assert audit["outcome"] == "answered"
    assert audit["question_chars"] == len("Which PR goes first?")
    assert audit["tool_rounds"] == 1
    assert audit["channel"] == "voice"
    assert "Which PR" not in json.dumps(audit)


async def test_a_think_that_runs_too_long_says_so(fake_seti: FakeSeti) -> None:
    ask = FakeAsk([asyncio.Event()])
    watcher = Watched()
    reported: list[ToolResult] = []
    tool = think_tool(fake_seti, ask, watcher, reported, timeout_secs=0.05)

    result = await tool.run("c1", {"question": "Which?"}, [])
    await tool.settle()

    assert not result.ok
    assert result.text == TIMED_OUT
    assert reported == [result]
    assert watcher.seen[-1] == ("finished", "c1")
    assert [a["outcome"] for a in fake_seti.thoughts] == ["timed_out"]


async def test_a_cancelled_think_stops_and_is_still_audited(fake_seti: FakeSeti) -> None:
    ask = FakeAsk([asyncio.Event()])
    watcher = Watched()
    reported: list[ToolResult] = []
    tool = think_tool(fake_seti, ask, watcher, reported)

    running = asyncio.create_task(tool.run("c1", {"question": "Which?"}, []))
    async with asyncio.timeout(2):
        await ask.asked.wait()
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    await tool.settle()

    assert reported == []
    assert watcher.seen == [("started", "c1"), ("finished", "c1")]
    assert [a["outcome"] for a in fake_seti.thoughts] == ["cancelled"]


async def test_a_failed_think_says_so_plainly(fake_seti: FakeSeti) -> None:
    ask = FakeAsk([RuntimeError("upstream said no")])
    reported: list[ToolResult] = []
    tool = think_tool(fake_seti, ask, Watched(), reported)

    result = await tool.run("c1", {"question": "Which?"}, [])
    await tool.settle()

    assert (result.ok, result.text) == (False, FAILED)
    assert [a["outcome"] for a in fake_seti.thoughts] == ["failed"]


def test_the_thinker_starts_from_the_recent_conversation_and_live_context() -> None:
    messages: list[Any] = [
        {"role": "user", "content": "Summary of the earlier conversation with the user: they planned."},
        {"role": "developer", "content": "Live Seti context (fresh): 2 running"},
        {"role": "user", "content": "Which PR should go first?"},
        {"role": "assistant", "content": None, "tool_calls": []},
        {"role": "tool", "tool_call_id": "c1", "content": "raw tool output"},
        {"role": "assistant", "content": "Let me see."},
    ]
    text = background(messages)
    assert text.startswith("Summary of the earlier conversation")
    assert "User: Which PR should go first?\nEA: Let me see." in text
    assert "Live Seti context (fresh): 2 running" in text
    assert "raw tool output" not in text


def test_a_think_is_always_acknowledged_in_varied_words() -> None:
    clock = Clock()
    announcer = ToolAnnouncer(clock=clock)
    first = announcer.phrase([ToolCall("list_prs", {})])
    second = announcer.phrase([ToolCall("think", {"question": "Which?"})])
    third = announcer.phrase([ToolCall("think", {"question": "And then?"})])
    assert first is not None
    assert second == THINK_LINES[0]
    assert third == THINK_LINES[1]
