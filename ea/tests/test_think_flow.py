import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any, cast

import httpx
from fakes import NOW, FakeSeti, settings
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import LLMContextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from pipecat.processors.aggregators.llm_response_universal import LLMAssistantAggregator
from pipecat.workers.runner import WorkerRunner
from test_chat import CLOCK, Script, ScriptedLLM, factory, stored, texts
from test_think import FakeAsk, answer, reads

from seti_ea.chat import TextChat
from seti_ea.conversation import Conversation
from seti_ea.history import HistorySync
from seti_ea.seti import SetiClient
from seti_ea.think import Thinker
from seti_ea.think_speech import STARTED_LINE, ThinkWatcher
from seti_ea.think_tool import ThinkTool
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools
from seti_ea.usage import UsageRecorder

ANSWER = "Right, here's what I'd do: merge PR 12 first."


def client(fake_seti: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))


def contents(context: LLMContext) -> list[str]:
    return [str(cast(Mapping[str, Any], m).get("content")) for m in context.messages]


def said(context: LLMContext) -> list[str]:
    messages = [cast(Mapping[str, Any], m) for m in context.messages]
    return [str(m.get("content")) for m in messages if m.get("role") == "assistant" and m.get("content")]


async def until(check: Callable[[], bool]) -> None:
    for _ in range(500):
        if check():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting")


async def test_the_answer_comes_once_after_a_question_asked_meanwhile(fake_seti: FakeSeti) -> None:
    seti = client(fake_seti)
    release = asyncio.Event()
    ask = FakeAsk([release, answer("Merge PR 12 first.")])

    async def report(_tool: str, _result: ToolResult, _call_id: str) -> None:
        return None

    tools = EaTools(seti, now=lambda: NOW)
    tool = ThinkTool(Thinker(tools, ask, UsageRecorder(seti)), seti, "voice", report, ThinkWatcher())
    script = Script(
        [[("c1", "think", {"question": "Which PR should go first?"})], ["Atlas is idle."], [ANSWER]]
    )
    first: LLMContextMessage = {"role": "user", "content": "Which PR should go first?"}
    context = LLMContext(messages=[first], tools=ToolsSchema(standard_tools=[tool.schema()]))
    history = HistorySync(seti, context)
    worker = PipelineWorker(
        Pipeline([ScriptedLLM(script, "gpt-test"), LLMAssistantAggregator(context)]),
        params=PipelineParams(),
        idle_timeout_secs=None,
        enable_rtvi=False,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    running = asyncio.create_task(runner.run())
    try:
        await worker.queue_frames([LLMContextFrame(context)])
        async with asyncio.timeout(5):
            await ask.asked.wait()
        await until(lambda: any('"status": "running"' in text for text in contents(context)))
        await history.flush()
        held = [entry["message"]["role"] for entry in fake_seti.ea_history]
        assert held == ["user"], "the call waits to be stored until the think settles"
        context.add_message({"role": "user", "content": "Is Atlas idle?"})
        await worker.queue_frames([LLMContextFrame(context)])
        await until(lambda: "Atlas is idle." in said(context))
        release.set()
        await until(lambda: ANSWER in said(context))
        await asyncio.sleep(0.3)
    finally:
        await worker.cancel()
        await running

    assert len(script.seen) == 3, "one run for each question and one for the answer, no more"
    assert said(context) == ["Atlas is idle.", ANSWER]
    finals = [text for text in contents(context) if '"status": "finished"' in text]
    assert len(finals) == 1
    assert "Merge PR 12 first." in finals[0]
    assert any("Merge PR 12 first." in json.dumps(message) for message in script.seen[2])
    await history.flush()
    roles = [entry["message"]["role"] for entry in fake_seti.ea_history]
    assert roles == ["user", "assistant", "tool", "user", "assistant", "developer", "assistant"]


async def test_a_typed_think_shows_thinking_then_the_answer(fake_seti: FakeSeti) -> None:
    ask = FakeAsk([reads(("list_prs", {})), answer("Merge PR 12 first.", "- **PR 12** is green")])
    script = Script([[("c1", "think", {"question": "Which PR should I merge first?"})], [ANSWER]])
    chat = TextChat(
        settings(openai_api_key="op"),
        EaTools(client(fake_seti), now=lambda: NOW),
        Conversation(),
        llm=factory(script),
        think=lambda _settings: ask,
        now=lambda: NOW,
    )

    events = [event async for event in chat.reply("Which PR should I merge first?", CLOCK)]

    thinking = [event["text"] for event in events if event["type"] == "thinking"]
    assert thinking == [STARTED_LINE, "I'm going through the open PRs.", None]
    kinds = [event["type"] for event in events if event["type"] != "thinking"]
    assert kinds[:2] == ["tool", "tool_result"]
    assert kinds[-1] == "done"
    result = next(event for event in events if event["type"] == "tool_result")
    assert result["name"] == "think"
    assert "Spoken answer: Merge PR 12 first." in result["text"]
    assert texts(events) == ANSWER
    assert [a["channel"] for a in fake_seti.thoughts] == ["chat"]
    assert [r["channel"] for r in fake_seti.usage_records].count("think") == 2
    messages = [message for _, message in stored(fake_seti)]
    assert messages[-1] == {"role": "assistant", "content": ANSWER}
    assert "Spoken answer" in messages[-2]["content"]
