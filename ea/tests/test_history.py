import asyncio
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from fakes import FakeSeti
from pipecat.frames.frames import LLMFullResponseStartFrame
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from pipecat.processors.aggregators.llm_context_summarizer import LLMContextSummarizer
from pipecat.processors.frame_processor import FrameProcessorSetup
from pipecat.services.llm_service import LLMService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.utils.asyncio.task_manager import TaskManager

from seti_ea.history import (
    SUMMARY_PREFIX,
    HistorySync,
    is_summary,
    summarization_config,
    valid_tool_pairs,
    wire_message,
)
from seti_ea.seti import SetiClient

Message = dict[str, Any]


def say(text: str) -> Message:
    return {"role": "user", "content": text}


def reply(text: str) -> Message:
    return {"role": "assistant", "content": text}


def call(call_id: str, name: str = "list_tasks") -> Message:
    return {
        "role": "assistant",
        "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}],
    }


def result(call_id: str, content: str = '"Two tasks running."') -> Message:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def messages_of(items: list[tuple[int, Message]]) -> list[Message]:
    return [message for _, message in items]


def keyed(messages: list[Message]) -> list[tuple[int, Message]]:
    return list(enumerate(messages))


@pytest.fixture
def seti(fake_seti: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))


def add(context: LLMContext, *messages: Message) -> None:
    for message in messages:
        context.add_message(cast(LLMContextMessage, message))


def stored(fake: FakeSeti) -> list[tuple[str, Message]]:
    return [(entry["kind"], entry["message"]) for entry in fake.ea_history]


def test_valid_tool_pairs_keeps_answered_calls_and_drops_the_rest() -> None:
    conversation = [
        say("How many tasks?"),
        call("a"),
        result("a"),
        {**call("b"), "content": "Let me look."},
        result("b", "IN_PROGRESS"),
        result("zzz"),
        call("c"),
        say("never mind"),
        result("c"),
        reply("Two running."),
    ]
    assert messages_of(valid_tool_pairs(keyed(conversation))) == [
        say("How many tasks?"),
        call("a"),
        result("a"),
        {"role": "assistant", "content": "Let me look."},
        say("never mind"),
        reply("Two running."),
    ]
    whole = [say("q"), call("a"), result("a"), call("b"), result("b"), reply("done")]
    assert valid_tool_pairs(keyed(whole)) == keyed(whole)


def test_wire_message_keeps_only_what_seti_stores() -> None:
    assert wire_message({**call("a"), "extra": 1}) == {"content": None, **call("a")}
    assert wire_message({"role": "assistant", "content": ""}) is None
    assert wire_message({"role": "system", "content": "x"}) is None
    parts = {"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url"}]}
    assert wire_message(parts) == say("hi")


async def test_load_puts_the_stored_conversation_in_the_context(
    fake_seti: FakeSeti, seti: SetiClient
) -> None:
    fake_seti.ea_append("message", say("one"))
    fake_seti.ea_append("message", reply("two"))
    fake_seti.ea_append("summary", say(f"{SUMMARY_PREFIX} They counted."), through_id=2)
    fake_seti.ea_append("message", say("three"))
    fake_seti.ea_append("message", call("x"))
    context = LLMContext()
    sync = HistorySync(seti, context)
    assert await sync.load() is True
    assert context.messages == [say(f"{SUMMARY_PREFIX} They counted."), say("three")]

    await sync.flush()
    assert len(fake_seti.ea_history) == 5

    assert await HistorySync(seti, LLMContext()).load() is True
    fake_seti.ea_history.clear()
    assert await HistorySync(seti, LLMContext()).load() is False


async def test_a_seti_that_is_down_starts_a_fresh_conversation(fake_seti: FakeSeti, seti: SetiClient) -> None:
    fake_seti.fail[("GET", "/api/ea/history")] = (503, {"error": {"title": "Down", "detail": "x"}})
    context = LLMContext()
    assert await HistorySync(seti, context).load() is False
    assert context.messages == []


async def test_flush_appends_in_order_and_waits_for_tool_results(
    fake_seti: FakeSeti, seti: SetiClient
) -> None:
    context = LLMContext()
    sync = HistorySync(seti, context)
    await sync.load()
    sync.add_call("A new call started.")
    sync.add_unstored("Greet the user.")
    add(context, reply("Evening."), say("How many tasks?"), call("a"), result("a", "IN_PROGRESS"))
    await sync.flush()
    assert stored(fake_seti) == [
        ("call", {"role": "developer", "content": "A new call started."}),
        ("message", reply("Evening.")),
        ("message", say("How many tasks?")),
    ]

    cast(Message, context.messages[-1])["content"] = '"Two tasks running."'
    add(context, reply("Two running."))
    await sync.flush()
    await sync.flush()
    assert stored(fake_seti)[3:] == [
        ("message", {"content": None, **call("a")}),
        ("message", result("a")),
        ("message", reply("Two running.")),
    ]


async def test_the_last_flush_drops_unfinished_tool_calls(fake_seti: FakeSeti, seti: SetiClient) -> None:
    context = LLMContext()
    sync = HistorySync(seti, context)
    add(
        context,
        say("Stop the login task."),
        call("s", "stop_task"),
        result("s", "IN_PROGRESS"),
        say("Hello?"),
    )
    await sync.flush()
    assert stored(fake_seti) == [("message", say("Stop the login task."))]
    await sync.flush(final=True)
    assert stored(fake_seti) == [("message", say("Stop the login task.")), ("message", say("Hello?"))]
    loaded = LLMContext()
    await HistorySync(seti, loaded).load()
    assert messages_of(valid_tool_pairs(keyed(cast(list[Message], loaded.messages)))) == loaded.messages


async def test_a_failed_save_is_retried_on_the_next_flush(fake_seti: FakeSeti, seti: SetiClient) -> None:
    context = LLMContext()
    sync = HistorySync(seti, context)
    add(context, say("one"))
    fake_seti.fail[("POST", "/api/ea/history/messages")] = (500, {"error": {"title": "Boom", "detail": "x"}})
    await sync.flush()
    assert fake_seti.ea_history == []
    del fake_seti.fail[("POST", "/api/ea/history/messages")]
    add(context, reply("two"))
    await sync.flush()
    assert stored(fake_seti) == [("message", say("one")), ("message", reply("two"))]


async def test_reset_forgets_the_conversation(fake_seti: FakeSeti, seti: SetiClient) -> None:
    fake_seti.ea_append("message", say("old"))
    context = LLMContext()
    sync = HistorySync(seti, context)
    await sync.load()
    fake_seti.ea_history.clear()
    await sync.reset()
    assert context.messages == []
    add(context, say("new"))
    await sync.flush()
    assert stored(fake_seti) == [("message", say("new"))]


def long(text: str) -> str:
    return f"{text} " + "and so on " * 40


async def test_compaction_stores_a_summary_and_keeps_tool_pairs_valid(
    fake_seti: FakeSeti, seti: SetiClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    requests: list[dict[str, Any]] = []

    async def run_inference(
        context: LLMContext, max_tokens: int | None = None, system_instruction: str | None = None
    ) -> str:
        requests.append(
            {"messages": context.messages, "max_tokens": max_tokens, "prompt": system_instruction}
        )
        return "The user checked on tasks twice; two were running."

    llm = OpenAILLMService(api_key="test")
    monkeypatch.setattr(llm, "run_inference", run_inference)

    context = LLMContext()
    sync = HistorySync(seti, context)
    sync.add_call("A new call started.")
    add(
        context,
        say(long("How many tasks?")),
        call("a"),
        result("a", '"' + long("Two running") + '"'),
        reply(long("Two running.")),
        say("And PRs?"),
        call("b", "list_prs"),
        result("b"),
        reply("One open."),
        say("Thanks."),
        reply("Any time."),
    )
    await sync.flush()
    ids = [entry["id"] for entry in fake_seti.ea_history]

    config = summarization_config(200)
    config.summary_config.llm = cast(LLMService, llm)
    summarizer = LLMContextSummarizer(context=context, config=config)
    task_manager = TaskManager()
    await summarizer.setup(cast(FrameProcessorSetup, SimpleNamespace(task_manager=task_manager)))
    applied = asyncio.Event()

    @summarizer.event_handler("on_summary_applied")
    async def on_summary_applied(_summarizer: LLMContextSummarizer, _event: Any) -> None:
        await sync.summary_applied()
        applied.set()

    await summarizer.process_frame(LLMFullResponseStartFrame())
    await asyncio.wait_for(applied.wait(), timeout=5)

    assert requests[0]["max_tokens"] == config.summary_config.target_context_tokens == 160
    assert "Conversation history" in str(requests[0]["messages"][0]["content"])
    kept = list(cast(list[Message], context.messages))
    assert is_summary(kept[0])
    assert kept[1:] == [
        say("And PRs?"),
        call("b", "list_prs"),
        result("b"),
        reply("One open."),
        say("Thanks."),
        reply("Any time."),
    ]
    assert valid_tool_pairs(keyed(kept)) == keyed(kept)

    summary = fake_seti.ea_history[-1]
    assert summary["kind"] == "summary"
    assert summary["through_id"] == ids[4]
    assert summary["message"]["content"].endswith("two were running.")

    add(context, say("Bye."))
    await sync.flush()
    assert stored(fake_seti)[-1] == ("message", say("Bye."))
    assert sum(1 for kind, _ in stored(fake_seti) if kind == "summary") == 1

    loaded = LLMContext()
    await HistorySync(seti, loaded).load()
    wired = [wire_message(m) for m in cast(list[Message], loaded.messages)]
    assert wired == [wire_message(m) for m in [*kept, say("Bye.")]]
    await summarizer.cleanup()


async def compact(context: LLMContext, sync: HistorySync, monkeypatch: pytest.MonkeyPatch, text: str) -> None:
    async def run_inference(
        _context: LLMContext, max_tokens: int | None = None, system_instruction: str | None = None
    ) -> str:
        return text

    llm = OpenAILLMService(api_key="test")
    monkeypatch.setattr(llm, "run_inference", run_inference)
    config = summarization_config(200)
    config.summary_config.llm = cast(LLMService, llm)
    summarizer = LLMContextSummarizer(context=context, config=config)
    await summarizer.setup(cast(FrameProcessorSetup, SimpleNamespace(task_manager=TaskManager())))
    applied = asyncio.Event()

    @summarizer.event_handler("on_summary_applied")
    async def on_summary_applied(_summarizer: LLMContextSummarizer, _event: Any) -> None:
        await sync.summary_applied()
        applied.set()

    await summarizer.process_frame(LLMFullResponseStartFrame())
    await asyncio.wait_for(applied.wait(), timeout=5)
    await summarizer.cleanup()


async def test_a_later_compaction_over_a_summary_keeps_what_follows_it(
    fake_seti: FakeSeti, seti: SetiClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = LLMContext()
    sync = HistorySync(seti, context)
    add(context, *[say(long(f"Question {n}")) for n in range(8)])
    await sync.flush()
    await compact(context, sync, monkeypatch, "First summary.")
    assert fake_seti.ea_history[-1]["through_id"] == 2

    later = LLMContext()
    later_sync = HistorySync(seti, later)
    await later_sync.load()
    later_sync.add_call("A new call started.")
    add(later, reply(long("Welcome back")))
    await later_sync.flush()
    await compact(later, later_sync, monkeypatch, "Second summary.")

    second = fake_seti.ea_history[-1]
    assert second["kind"] == "summary"
    assert second["through_id"] == 4
    reloaded = LLMContext()
    await HistorySync(seti, reloaded).load()
    wired = [wire_message(m) for m in cast(list[Message], reloaded.messages)]
    assert wired == [wire_message(m) for m in cast(list[Message], later.messages)]
