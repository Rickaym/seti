import asyncio
from typing import Any, cast

import httpx
import pytest
from fakes import NOW, PR_SETI, TASK_DOCS, TASK_LOGIN, FakeSeti, live_context, search_hit
from pipecat.frames.frames import LLMContextFrame
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from pipecat.tests.utils import run_test
from test_chat import Script, events_of, make_chat, stored

from seti_ea.conversation import Conversation
from seti_ea.history import HistorySync
from seti_ea.live_context import (
    LiveContext,
    LiveContextInjector,
    TaskRef,
    is_live_note,
    matched_task,
    retrieval_for,
)
from seti_ea.prompt import LIVE_NOTE_PREFIX, SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools

TASKS = [
    TaskRef(TASK_LOGIN, "Fix the login redirect bug", "running"),
    TaskRef(TASK_DOCS, "PII redaction in transcripts", "idle"),
    TaskRef("t-voice", "Voicemail detection", "idle"),
]


def client(fake: FakeSeti, handler: Any = None) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(handler or fake.handle))


def notes(context: LLMContext) -> list[str]:
    return [str(cast(dict[str, Any], m)["content"]) for m in context.messages if is_live_note(m)]


def messages(*items: tuple[str, str]) -> list[LLMContextMessage]:
    return [cast(LLMContextMessage, {"role": role, "content": content}) for role, content in items]


@pytest.mark.parametrize(
    "utterance",
    [
        "What's running?",
        "Is the voicemail PR green?",
        "Did the login task finish?",
        "Anything failing?",
    ],
)
def test_status_questions_need_no_search(utterance: str) -> None:
    assert retrieval_for(utterance, TASKS) is None


def test_a_question_about_a_decision_searches_within_the_named_task() -> None:
    plan = retrieval_for("What did the PII task decide about redaction?", TASKS)
    assert plan is not None
    assert plan.task == TASKS[1]
    assert plan.query == "decide about decision"


def test_a_question_without_a_task_searches_everywhere_and_keeps_pr_numbers() -> None:
    plan = retrieval_for("Why did the reviewer ask for changes on PR 28?", TASKS)
    assert plan is not None
    assert plan.task is None
    assert plan.query.split() == ["reviewer", "changes", "pr", "28"]


def test_a_task_is_named_by_most_of_its_title_or_two_words_of_it() -> None:
    assert matched_task({"voicemail"}, TASKS) == TASKS[2]
    assert matched_task({"login", "redirect"}, TASKS) == TASKS[0]
    assert matched_task({"login"}, TASKS) is None
    assert matched_task({"weather"}, TASKS) is None


async def test_the_note_goes_before_the_user_message_and_replaces_the_last_one(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context("Tasks: 3 in all; 1 running.")
    live = LiveContext(client(fake_seti), now=lambda: NOW)
    context = LLMContext(messages=messages(("user", "What's running?")))

    await live.refresh(context)
    fake_seti.live_context = live_context("Tasks: 3 in all; 2 running.")
    context.add_message(cast(LLMContextMessage, {"role": "assistant", "content": "One."}))
    context.add_message(cast(LLMContextMessage, {"role": "user", "content": "And now?"}))
    await live.refresh(context)

    roles = [cast(dict[str, Any], m)["role"] for m in context.messages]
    assert roles == ["user", "assistant", "developer", "user"]
    [note] = notes(context)
    assert note.startswith(f"{LIVE_NOTE_PREFIX}, 10 seconds old; it replaces any earlier one. ")
    assert "never in its style" in note.split("\n")[0]
    assert note.endswith("Tasks: 3 in all; 2 running.")
    assert "search index" not in note


async def test_a_detail_question_brings_excerpts_from_the_named_task(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = {
        **live_context(),
        "tasks": [{"id": TASK_DOCS, "title": "PII redaction", "status": "idle"}],
    }
    fake_seti.search_hits = [
        search_hit("We decided to redact phone numbers before storing.", task_id=TASK_DOCS, task_title="PII"),
        search_hit("Unrelated login detail."),
    ]
    live = LiveContext(client(fake_seti), now=lambda: NOW)
    context = LLMContext(messages=messages(("user", "What did the PII task decide about redaction?")))

    await live.refresh(context)

    [note] = notes(context)
    assert 'From task "PII", agent, 2 hours ago: "We decided to redact phone numbers before storing."' in note
    assert "Unrelated login detail." not in note
    search = next(r for r in fake_seti.requests if r.url.path == "/api/ea/search")
    assert search.url.params["task"] == TASK_DOCS
    assert search.url.params["mode"] == "text"
    assert "min_match" not in search.url.params
    assert live.last_excerpts == 1


async def test_excerpts_outside_a_named_task_must_match_enough_words(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context()
    live = LiveContext(client(fake_seti), now=lambda: NOW)

    await live.refresh(LLMContext(messages=messages(("user", "Why did the reviewer want changes on PR 28?"))))

    search = next(r for r in fake_seti.requests if r.url.path == "/api/ea/search")
    assert "task" not in search.url.params
    assert search.url.params["min_match"] == "0.34"


async def test_a_slow_or_failing_seti_keeps_the_last_snapshot_and_ages_it(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context("Tasks: 1 running.")
    clock = [NOW]
    working = client(fake_seti)
    live = LiveContext(working, now=lambda: clock[0], timeout_secs=0.05)
    await live.refresh(LLMContext(messages=messages(("user", "hi"))))

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return fake_seti.handle(request)

    live._seti = client(fake_seti, slow)  # pyright: ignore[reportPrivateUsage]
    clock[0] = NOW.replace(minute=5)
    context = LLMContext(messages=messages(("user", "Still running?")))
    await live.refresh(context)

    [note] = notes(context)
    assert "310 seconds old" in note
    assert "It is stale, so check with a tool before relying on it." in note
    assert note.endswith("Tasks: 1 running.")


async def test_no_note_before_seti_ever_answered(fake_seti: FakeSeti) -> None:
    context = LLMContext(messages=messages(("user", "What's running?")))
    await LiveContext(client(fake_seti), now=lambda: NOW).refresh(context)
    assert notes(context) == []


async def test_the_note_is_never_stored(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context()
    seti = client(fake_seti)
    context = LLMContext()
    history = HistorySync(seti, context)
    context.add_message(cast(LLMContextMessage, {"role": "user", "content": "What's running?"}))
    await LiveContext(seti, now=lambda: NOW).refresh(context)
    context.add_message(cast(LLMContextMessage, {"role": "assistant", "content": "One task."}))

    await history.flush(final=True)

    assert [e["message"]["role"] for e in fake_seti.ea_history] == ["user", "assistant"]
    assert len(notes(context)) == 1


async def test_the_voice_pipeline_refreshes_the_note_on_every_turn(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context()
    context = LLMContext(messages=messages(("user", "What's running?")))
    injector = LiveContextInjector(LiveContext(client(fake_seti), now=lambda: NOW))

    down, _ = await run_test(
        injector,
        frames_to_send=[LLMContextFrame(context), LLMContextFrame(context)],
        expected_down_frames=[LLMContextFrame, LLMContextFrame],
    )

    assert all(cast(LLMContextFrame, frame).context is context for frame in down)
    assert len(notes(context)) == 1
    assert [r.url.path for r in fake_seti.requests].count("/api/ea/context") == 2


async def test_a_chat_turn_carries_the_note_and_stores_none_of_it(fake_seti: FakeSeti) -> None:
    fake_seti.live_context = live_context("Tasks: 3 in all; 1 running: Fix the login redirect bug.")
    script = Script([["One task is running: the login fix."], ["Still just the one."]])
    chat = make_chat(fake_seti, script, Conversation())

    await events_of(chat, "What is running right now?")
    await events_of(chat, "And now?")

    for seen in script.seen:
        live_notes = [m for m in seen if str(m.get("content", "")).startswith(LIVE_NOTE_PREFIX)]
        assert len(live_notes) == 1
        assert seen[-2] is live_notes[0]
        assert seen[-1]["role"] == "user"
    assert not any(LIVE_NOTE_PREFIX in str(message.get("content")) for _, message in stored(fake_seti))


async def test_search_seti_cites_tasks_and_prs(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.search_hits = [
        search_hit("Decided to keep the email domain.", task_id=TASK_DOCS, task_title="Write deploy docs"),
        search_hit(
            "Please add a test for the redirect.",
            kind="pr_update",
            task_id=None,
            task_title=None,
            pr_url=PR_SETI,
            pr_title="fix: login redirect",
        ),
    ]

    result = await tools.call("search_seti", {"query": "email domain"})

    assert result.ok
    assert result.summary == "Found 2 excerpts"
    assert result.text.splitlines() == [
        "2 excerpts for email domain, best first:",
        f'1. From task "Write deploy docs" (link #agents/{TASK_DOCS}), agent, 2 hours ago: '
        '"Decided to keep the email domain."',
        f'2. From seti PR 28 "fix: login redirect" (link {PR_SETI}), pr update, 2 hours ago: '
        '"Please add a test for the redirect."',
    ]


async def test_search_seti_marks_archived_tasks(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.search_hits = [
        search_hit("Chose Postgres.", task_id=TASK_DOCS, task_title="Write deploy docs", archived=True),
    ]

    result = await tools.call("search_seti", {"query": "postgres"})

    assert (
        f'1. From task "Write deploy docs" (archived) (link #agents/{TASK_DOCS}), agent, 2 hours ago: '
        in result.text
    )


async def test_search_seti_within_a_task_and_with_nothing_found(tools: EaTools, fake_seti: FakeSeti) -> None:
    result = await tools.call("search_seti", {"query": "redaction", "task": "deploy docs"})
    search = next(r for r in fake_seti.requests if r.url.path == "/api/ea/search")
    assert search.url.params["task"] == TASK_DOCS
    assert result.text == "Nothing in Seti's index matches redaction in Write deploy docs."


def test_the_prompt_answers_status_from_the_live_context() -> None:
    assert "Live Seti context" in SYSTEM_PROMPT
    assert "search_seti" in SYSTEM_PROMPT
