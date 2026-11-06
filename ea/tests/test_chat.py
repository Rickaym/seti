import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, cast

import httpx
import pytest
from fakes import NOW, SETI_TOKEN, TASK_LOGIN, FakeSeti, settings
from openai import AsyncStream
from openai.types import CompletionUsage
from openai.types.chat import ChatCompletionChunk
from openai.types.chat.chat_completion_chunk import (
    Choice,
    ChoiceDelta,
    ChoiceDeltaToolCall,
    ChoiceDeltaToolCallFunction,
)
from openai.types.completion_usage import PromptTokensDetails
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.openai.llm import OpenAILLMService

from seti_ea import server
from seti_ea.announce import ACTION_LINES, PHRASES
from seti_ea.chat import TextChat
from seti_ea.clock import parse_user_clock
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.history import SUMMARY_PREFIX, HistorySync
from seti_ea.prompt import CHAT_NOTE_PREFIX, CONFIRM_QUESTION, SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools

CLOCK = parse_user_clock({"timezone": "Europe/Berlin"})

Call = tuple[str, str, dict[str, Any]]
Step = str | Call | asyncio.Event


@dataclass
class Script:
    """What the fake model answers, one list of steps per completion, and what it was sent."""

    replies: list[list[Step]]
    summary: str = "They talked about the login task."
    seen: list[list[dict[str, Any]]] = field(default_factory=list)
    systems: list[str] = field(default_factory=list)
    summarised: list[str] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    fail: bool = False
    usage: CompletionUsage | None = None


def chunk(delta: ChoiceDelta) -> ChatCompletionChunk:
    return ChatCompletionChunk(
        id="chunk",
        choices=[Choice(index=0, delta=delta, finish_reason=None)],
        created=0,
        model="gpt-test",
        object="chat.completion.chunk",
    )


def delta_of(step: str | Call, index: int) -> ChoiceDelta:
    if isinstance(step, str):
        return ChoiceDelta(content=step)
    call_id, name, arguments = step
    function = ChoiceDeltaToolCallFunction(name=name, arguments=json.dumps(arguments))
    return ChoiceDelta(tool_calls=[ChoiceDeltaToolCall(index=index, id=call_id, function=function)])


class ScriptedLLM(OpenAILLMService):
    """The voice EA's OpenAI service with the network swapped for a script."""

    def __init__(self, script: Script, model: str, system: str = SYSTEM_PROMPT) -> None:
        super().__init__(
            api_key="test",
            settings=OpenAILLMService.Settings(model=model, system_instruction=system),
        )
        self._system = system
        self._script = script
        script.models.append(model)

    async def get_chat_completions(self, context: LLMContext) -> AsyncStream[ChatCompletionChunk]:
        params = await self.get_llm_adapter().get_llm_invocation_params(
            context, system_instruction=self._system, convert_developer_to_user=False
        )
        messages = [dict(m) for m in cast(list[Any], params["messages"])]
        self._script.systems.append(str(messages[0]["content"]))
        self._script.seen.append(messages[1:])
        if self._script.fail:
            raise RuntimeError("model unavailable")
        steps = self._script.replies.pop(0)

        async def stream() -> AsyncIterator[ChatCompletionChunk]:
            calls = 0
            for step in steps:
                if isinstance(step, asyncio.Event):
                    await step.wait()
                    continue
                yield chunk(delta_of(step, calls))
                if not isinstance(step, str):
                    calls += 1
            if self._script.usage is not None:
                yield ChatCompletionChunk(
                    id="chunk",
                    choices=[],
                    created=0,
                    model="gpt-test",
                    object="chat.completion.chunk",
                    usage=self._script.usage,
                )

        return cast(AsyncStream[ChatCompletionChunk], stream())

    async def run_inference(
        self,
        context: LLMContext,
        max_tokens: int | None = None,
        system_instruction: str | None = None,
        response_schema: dict[str, Any] | None = None,
    ) -> str | None:
        first = cast(dict[str, Any], context.messages[0])
        self._script.summarised.append(str(first.get("content")))
        return self._script.summary


def factory(script: Script) -> Any:
    def build(settings: Settings, system: str) -> OpenAILLMService:
        return ScriptedLLM(script, settings.chat_model, system)

    return build


def make_chat(fake_seti: FakeSeti, script: Script, conversation: Conversation, **overrides: Any) -> TextChat:
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    config = settings(openai_api_key="op", **overrides)
    return TextChat(
        config, EaTools(seti, now=lambda: NOW), conversation, llm=factory(script), now=lambda: NOW
    )


async def events_of(chat: TextChat, text: str) -> list[dict[str, Any]]:
    return [event async for event in chat.reply(text, CLOCK)]


def stored(fake: FakeSeti) -> list[tuple[str, dict[str, Any]]]:
    return [(entry["kind"], entry["message"]) for entry in fake.ea_history]


def texts(events: list[dict[str, Any]]) -> str:
    return "".join(event["delta"] for event in events if event["type"] == "text")


async def settle(chat: TextChat) -> None:
    async with asyncio.timeout(5):
        await chat._turn.acquire()  # pyright: ignore[reportPrivateUsage]
    chat._turn.release()  # pyright: ignore[reportPrivateUsage]


async def test_a_typed_question_streams_tools_and_text_and_is_stored_as_chat(fake_seti: FakeSeti) -> None:
    fake_seti.ea_append("call", {"role": "developer", "content": "A new call started. Noon."})
    fake_seti.ea_append("message", {"role": "user", "content": "Anything on fire?"})
    fake_seti.ea_append("message", {"role": "assistant", "content": "Nothing on fire."})
    script = Script([[("call-1", "list_tasks", {"status": "running"})], ["One task ", "is running."]])
    conversation = Conversation()
    chat = make_chat(fake_seti, script, conversation, text_model="gpt-planner")

    events = await events_of(chat, "What is running right now?")

    kinds = [event["type"] for event in events]
    assert kinds[:2] == ["tool", "tool_result"]
    assert kinds[-1] == "done"
    assert events[0] == {
        "type": "tool",
        "id": "call-1",
        "name": "list_tasks",
        "arguments": {"status": "running"},
    }
    assert events[1]["id"] == "call-1"
    assert events[1]["ok"] is True
    assert events[1]["summary"]
    assert "Fix the login redirect bug" in events[1]["text"]
    assert texts(events) == "One task is running."

    assert script.models[0] == "gpt-planner"
    assert "# Chat replies" in script.systems[0]
    first = script.seen[0]
    assert first[:3] == [
        {"role": "developer", "content": "A new call started. Noon."},
        {"role": "user", "content": "Anything on fire?"},
        {"role": "assistant", "content": "Nothing on fire."},
    ]
    assert first[3]["role"] == "developer"
    assert first[3]["content"].startswith(CHAT_NOTE_PREFIX)
    assert "(Europe/Berlin)" in first[3]["content"]
    assert first[4] == {"role": "user", "content": "What is running right now?"}

    new = stored(fake_seti)[3:]
    assert [kind for kind, _ in new] == ["chat"] * 5
    assert [message["role"] for _, message in new] == ["developer", "user", "assistant", "tool", "assistant"]
    assert new[2][1]["tool_calls"][0]["function"] == {
        "name": "list_tasks",
        "arguments": '{"status": "running"}',
    }
    assert new[4][1] == {"role": "assistant", "content": "One task is running."}
    assert events[-1] == {"type": "done", "ids": [4, 5, 6, 7, 8]}


async def test_a_typed_reply_records_each_model_call_without_its_text(fake_seti: FakeSeti) -> None:
    usage = CompletionUsage(
        prompt_tokens=15000,
        completion_tokens=40,
        total_tokens=15040,
        prompt_tokens_details=PromptTokensDetails(cached_tokens=12000),
    )
    script = Script([[("call-1", "list_tasks", {"status": "running"})], ["One is running."]], usage=usage)
    chat = make_chat(fake_seti, script, Conversation())

    await events_of(chat, "What is running right now?")

    records = fake_seti.usage_records
    assert [(r["kind"], r["channel"], r["tool_calls"]) for r in records] == [
        ("llm", "chat", 1),
        ("llm", "chat", 0),
    ]
    assert all(r["prompt_tokens"] == 15000 and r["cached_tokens"] == 12000 for r in records)
    assert all(r["completion_tokens"] == 40 and r["model"] for r in records)
    assert all(isinstance(r["ttfb_ms"], int) for r in records)
    assert set(records[0]) == {
        "kind",
        "channel",
        "model",
        "ttfb_ms",
        "prompt_tokens",
        "cached_tokens",
        "completion_tokens",
        "tool_calls",
    }


async def test_voice_fillers_stay_out_of_the_chat(fake_seti: FakeSeti) -> None:
    script = Script([[("call-1", "stop_task", {"task": "logout"})], ["It was not running."]])
    chat = make_chat(fake_seti, script, Conversation())

    events = await events_of(chat, "Stop the logout one.")

    lines = {*PHRASES, *ACTION_LINES.values()}
    said = texts(events) + json.dumps(fake_seti.ea_history)
    assert not any(line in said for line in lines)
    assert all(event["type"] in {"tool", "tool_result", "text", "done"} for event in events)


async def test_actions_wait_for_a_typed_yes(fake_seti: FakeSeti) -> None:
    script = Script(
        [
            [f"That stops Fix the login redirect bug mid-turn. {CONFIRM_QUESTION}"],
            [("call-1", "stop_task", {"task": "login"})],
            ["Stopped."],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())
    stop = f"/api/tasks/{TASK_LOGIN}/stop"

    asked = await events_of(chat, "Stop the login task.")
    assert texts(asked).endswith(CONFIRM_QUESTION)
    assert [path for path, _ in fake_seti.posts() if path == stop] == []
    assert "explicit yes" in SYSTEM_PROMPT
    assert f'"{CONFIRM_QUESTION}"' in SYSTEM_PROMPT

    done = await events_of(chat, "Yes")
    assert [event["name"] for event in done if event["type"] == "tool_result"] == ["stop_task"]
    assert [path for path, _ in fake_seti.posts() if path == stop] == [stop]
    assert script.seen[1][-3:] == [
        {"role": "user", "content": "Stop the login task."},
        {
            "role": "assistant",
            "content": f"That stops Fix the login redirect bug mid-turn. {CONFIRM_QUESTION}",
        },
        {"role": "user", "content": "Yes"},
    ]


async def test_a_destructive_tool_acts_only_after_a_later_typed_yes(fake_seti: FakeSeti) -> None:
    delete = ("delete_agent", {"task": "logout"})
    script = Script(
        [
            [("call-1", *delete)],
            [("call-2", delete[0], {**delete[1], "confirmed": True})],
            [f"That permanently deletes Fix the logout button. {CONFIRM_QUESTION}"],
            [("call-3", delete[0], {**delete[1], "confirmed": True})],
            ["Deleted."],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())

    asked = await events_of(chat, "Delete the logout agent.")
    results = [event for event in asked if event["type"] == "tool_result"]
    assert [event["summary"] for event in results] == ["Asked first: delete agent Fix the logout button"] * 2
    assert all(event["ok"] for event in results)
    assert [r.method for r in fake_seti.requests if r.method == "DELETE"] == []

    done = await events_of(chat, "Yes, go ahead.")
    [result] = [event for event in done if event["type"] == "tool_result"]
    assert result["summary"] == "Deleted agent Fix the logout button"
    assert [r.url.path for r in fake_seti.requests if r.method == "DELETE"] == [
        "/api/tasks/22222222-aaaa-4bbb-8ccc-000000000002"
    ]


async def test_the_chat_note_comes_once_per_switch_to_typing(fake_seti: FakeSeti) -> None:
    script = Script([["One."], ["Two."], ["Three."]])
    chat = make_chat(fake_seti, script, Conversation())
    await events_of(chat, "First")
    await events_of(chat, "Second")
    notes = [m for _, m in stored(fake_seti) if m["role"] == "developer"]
    assert len(notes) == 1

    fake_seti.ea_append("call", {"role": "developer", "content": "A new call started. Later."})
    await events_of(chat, "Third")
    notes = [m for _, m in stored(fake_seti) if m["role"] == "developer"]
    assert len(notes) == 3
    assert notes[-1]["content"].startswith(CHAT_NOTE_PREFIX)


async def test_leaving_mid_reply_keeps_the_question_and_what_was_said(fake_seti: FakeSeti) -> None:
    hold = asyncio.Event()
    script = Script([["Two tasks are ", hold, "running."]])
    chat = make_chat(fake_seti, script, Conversation())

    stream = chat.reply("How busy are we?", CLOCK)
    async for event in stream:
        if event["type"] == "text":
            break
    await stream.aclose()
    await settle(chat)

    messages = [m for _, m in stored(fake_seti)]
    assert messages[1:] == [
        {"role": "user", "content": "How busy are we?"},
        {"role": "assistant", "content": "Two tasks are"},
    ]


async def test_a_failed_model_stores_nothing(fake_seti: FakeSeti) -> None:
    script = Script([], fail=True)
    chat = make_chat(fake_seti, script, Conversation())

    events = await events_of(chat, "Hello?")

    assert events[-1]["type"] == "error"
    assert "model unavailable" in events[-1]["detail"]
    assert fake_seti.ea_history == []


async def test_a_live_call_receives_the_typed_turns_once(fake_seti: FakeSeti) -> None:
    conversation = Conversation()
    inbox = conversation.attach()
    script = Script([["Noted."]])
    chat = make_chat(fake_seti, script, conversation)
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    voice = LLMContext()
    call = HistorySync(seti, voice, lock=conversation.lock)
    await call.load()

    await events_of(chat, "Remember the demo at four.")

    entries = inbox.take()
    assert [entry.kind for entry in entries] == ["chat", "chat", "chat"]
    assert await call.merge(entries) is True
    assert voice.messages[1:] == [
        {"role": "user", "content": "Remember the demo at four."},
        {"role": "assistant", "content": "Noted."},
    ]
    assert await call.merge(entries) is False
    await call.flush()
    assert len(fake_seti.ea_history) == 3
    conversation.detach(inbox)
    assert inbox.take() == []


async def test_writes_wait_for_the_shared_history_lock(fake_seti: FakeSeti) -> None:
    conversation = Conversation()
    chat = make_chat(fake_seti, Script([["Done."]]), conversation)

    async with conversation.lock:
        pending = asyncio.create_task(events_of(chat, "Queue this."))
        await asyncio.sleep(0.3)
        assert fake_seti.ea_history == []
        assert not pending.done()
    events = await pending
    assert events[-1]["type"] == "done"
    assert len(fake_seti.ea_history) == 3


async def test_a_long_conversation_is_summarised_after_the_reply(fake_seti: FakeSeti) -> None:
    for n in range(12):
        fake_seti.ea_append("message", {"role": "user", "content": f"Question {n} " + "x" * 200})
        fake_seti.ea_append("message", {"role": "assistant", "content": f"Answer {n} " + "y" * 200})
    script = Script([["Short answer."]])
    chat = make_chat(fake_seti, script, Conversation(), history_max_tokens=200)

    events = await events_of(chat, "And now?")
    assert events[-1]["type"] == "done"
    await settle(chat)

    summaries = [e for e in fake_seti.ea_history if e["kind"] == "summary"]
    assert len(summaries) == 1
    assert summaries[0]["message"]["content"] == f"{SUMMARY_PREFIX} They talked about the login task."
    assert "Question 0" in script.summarised[0]
    context = fake_seti.ea_context()
    assert context[0]["kind"] == "summary"
    assert context[-1]["message"] == {"role": "assistant", "content": "Short answer."}


def client_for(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:3007",
        headers={"Authorization": f"Bearer {SETI_TOKEN}"},
    )


def parse_sse(body: str) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    for block in body.split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if not line.startswith(":"))
        if "event" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events


async def test_the_chat_endpoint_streams_server_sent_events(fake_seti: FakeSeti) -> None:
    script = Script([[("call-1", "list_tasks", {})], ["Three tasks."]])
    app = server.create_app(
        settings(openai_api_key="op"),
        chat_llm=factory(script),
        seti_transport=httpx.MockTransport(fake_seti.handle),
    )
    async with client_for(app) as client:
        response = await client.post(
            "/chat", json={"text": "  What is going on?  ", "requestData": {"timezone": "Asia/Singapore"}}
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(response.text)
    assert [name for name, _ in events][:2] == ["tool", "tool_result"]
    assert events[-1][0] == "done"
    assert script.seen[0][-1] == {"role": "user", "content": "What is going on?"}
    assert "(Asia/Singapore)" in script.seen[0][-2]["content"]


async def test_the_chat_endpoint_needs_the_openai_key_and_a_message(fake_seti: FakeSeti) -> None:
    missing = server.create_app(settings(), chat_llm=factory(Script([])))
    async with client_for(missing) as client:
        response = await client.post("/chat", json={"text": "Hi"})
    assert response.status_code == 503
    assert "OPENAI_API_KEY" in response.json()["error"]["detail"]

    app = server.create_app(settings(openai_api_key="op"), chat_llm=factory(Script([])))
    async with client_for(app) as client:
        for body in ({"text": "   "}, {"text": 3}, {"text": "x" * 8001}, {}):
            response = await client.post("/chat", json=body)
            assert response.status_code == 400


@pytest.mark.parametrize("gap", [timedelta(minutes=1), timedelta(minutes=10)])
async def test_time_notes_refresh_after_a_gap(fake_seti: FakeSeti, gap: timedelta) -> None:
    times = iter([NOW, NOW + gap])
    script = Script([["One."], ["Two."]])
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    chat = TextChat(
        settings(openai_api_key="op"),
        EaTools(seti, now=lambda: NOW),
        Conversation(),
        llm=factory(script),
        now=lambda: next(times),
    )
    await events_of(chat, "First")
    await events_of(chat, "Second")
    notes = [m for _, m in stored(fake_seti) if m["role"] == "developer"]
    assert len(notes) == (1 if gap < timedelta(minutes=5) else 2)
