import asyncio
import json
from collections.abc import Sequence
from typing import cast

import pytest
from pipecat.frames.frames import Frame, TextFrame, TranscriptionFrame
from pipecat.observers.base_observer import FramePushed
from pipecat.transcriptions.language import Language

from seti_ea.announce import SLEEP_LINE, ToolAnnouncer, ToolCall
from seti_ea.phrasebook import CallLanguage, Phrasebook, parse_lines, spoken_lines
from seti_ea.think_speech import STARTED_LINE, STEP_LINES, step_line


class Translator:
    """Stands in for the model: marks each line with its language, or fails."""

    def __init__(self) -> None:
        self.asked: list[str] = []
        self.release = asyncio.Event()
        self.release.set()
        self.fail = False

    async def __call__(self, language: str, lines: Sequence[str]) -> list[str]:
        self.asked.append(language)
        await self.release.wait()
        if self.fail:
            raise ValueError("0 of 3 lines came back")
        return [f"{language}: {line}" for line in lines]


def pushed(frame: Frame) -> FramePushed:
    return cast(FramePushed, type("Pushed", (), {"frame": frame})())


def heard(text: str, language: Language | None) -> FramePushed:
    return pushed(TranscriptionFrame(text, "user", "now", language))


def test_every_line_a_tool_can_announce_is_in_the_set() -> None:
    lines = spoken_lines()
    assert len(lines) == len(set(lines))
    assert all("{" not in line for line in lines)
    announcer = ToolAnnouncer(cooldown_secs=0)
    calls = (
        [],
        [ToolCall("go_to_sleep", {})],
        [ToolCall("think", {})],
        [ToolCall("start_task", {})],
        [ToolCall("post_team_chat", {"to": "Fix login"})],
        [ToolCall("set_agent_group_chat", {"muted": True})],
    )
    assert all(announcer.phrase(call) in lines for call in calls)
    assert STARTED_LINE in lines
    assert step_line("list_tasks", {}) in lines
    assert step_line("get_task", {"task": "Fix login"}) not in lines
    assert "{task}" in STEP_LINES["get_task"]


def test_the_models_lines_are_read_by_id() -> None:
    answer = {"lines": [{"id": 1, "text": " iki "}, {"id": 0, "text": "bir"}]}
    assert parse_lines(json.dumps(answer), 2) == ["bir", "iki"]
    for bad in (
        {"lines": [{"id": 0, "text": "bir"}]},
        {"lines": [{"id": 0, "text": "bir"}, {"id": 1, "text": " "}]},
        {"lines": [{"id": 0, "text": "bir"}, {"id": 2, "text": "iki"}]},
        {"lines": "bir"},
        ["bir", "iki"],
    ):
        with pytest.raises(ValueError, match="lines came back"):
            parse_lines(json.dumps(bad), 2)
    with pytest.raises(ValueError, match="Expecting value"):
        parse_lines("not json", 2)


async def test_english_is_said_as_written_and_never_translated() -> None:
    translator = Translator()
    speaking = CallLanguage("en", Phrasebook(translator, {}))
    assert speaking.line(SLEEP_LINE) == SLEEP_LINE
    assert speaking.line("Anything at all.") == "Anything at all."
    assert translator.asked == []


async def test_a_line_stays_unsaid_until_its_translation_is_in() -> None:
    translator = Translator()
    translator.release.clear()
    books: dict[str, dict[str, str]] = {}
    phrasebook = Phrasebook(translator, books)
    speaking = CallLanguage("tr", phrasebook)
    phrasebook.prepare("tr")
    await asyncio.sleep(0)
    assert speaking.line(SLEEP_LINE) is None
    translator.release.set()
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) == f"Turkish: {SLEEP_LINE}"
    assert speaking.line("I'm reading Fix login.") is None
    assert translator.asked == ["Turkish"]
    again = CallLanguage("tr", Phrasebook(translator, books))
    assert again.line(SLEEP_LINE) == f"Turkish: {SLEEP_LINE}"
    assert translator.asked == ["Turkish"]


async def test_a_failed_translation_keeps_the_line_unsaid_and_is_tried_again() -> None:
    translator = Translator()
    translator.fail = True
    phrasebook = Phrasebook(translator, {})
    speaking = CallLanguage("de", phrasebook)
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) is None
    translator.fail = False
    assert speaking.change("de") is False
    phrasebook.prepare("de")
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) == f"German: {SLEEP_LINE}"


async def test_a_call_changes_language_when_the_setting_does() -> None:
    translator = Translator()
    phrasebook = Phrasebook(translator, {})
    speaking = CallLanguage("en", phrasebook)
    assert speaking.change("en") is False
    assert speaking.change("fr") is True
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) == f"French: {SLEEP_LINE}"
    assert speaking.change("en") is True
    assert speaking.line(SLEEP_LINE) == SLEEP_LINE


async def test_multilingual_says_lines_in_the_language_last_heard() -> None:
    translator = Translator()
    phrasebook = Phrasebook(translator, {})
    speaking = CallLanguage("multi", phrasebook)
    assert translator.asked == []
    assert speaking.line(SLEEP_LINE) == SLEEP_LINE
    await speaking.on_push_frame(heard("Merhaba", Language.TR))
    assert speaking.line(SLEEP_LINE) is None
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) == f"Turkish: {SLEEP_LINE}"
    await speaking.on_push_frame(heard("Sawasdee", Language.TH))
    await speaking.on_push_frame(heard("Hm", None))
    await speaking.on_push_frame(pushed(TextFrame("Merhaba")))
    assert speaking.line(SLEEP_LINE) == f"Turkish: {SLEEP_LINE}"
    await speaking.on_push_frame(heard("Kumusta", Language.TL))
    await phrasebook.wait()
    assert speaking.line(SLEEP_LINE) == f"Filipino: {SLEEP_LINE}"
    await speaking.on_push_frame(heard("Hello", Language.EN_US))
    assert speaking.line(SLEEP_LINE) == SLEEP_LINE


async def test_one_language_ignores_what_speech_to_text_detects() -> None:
    translator = Translator()
    phrasebook = Phrasebook(translator, {})
    speaking = CallLanguage("tr", phrasebook)
    await phrasebook.wait()
    await speaking.on_push_frame(heard("Hello", Language.EN))
    assert speaking.line(SLEEP_LINE) == f"Turkish: {SLEEP_LINE}"
