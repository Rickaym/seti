"""The EA's fixed call lines in the language it is set to, translated once by its model.

announce.py and think_speech.py hold the lines in English. A call in another language says a
line only once its translation is in, so English never plays inside it; until then the line is
skipped. One model call translates the whole set, and it stays in memory while the EA runs.
"""

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, cast

from loguru import logger
from openai import AsyncOpenAI, OpenAIError
from pipecat.frames.frames import TranscriptionFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed

from seti_ea.announce import ACTION_LINES, DIRECT_LINE, GROUP_CHAT_LINES, PHRASES, SLEEP_LINE, THINK_LINES
from seti_ea.config import Settings
from seti_ea.language import DEFAULT, LANGUAGES, MULTI, heard_language
from seti_ea.seti import SetiClient
from seti_ea.think_speech import OTHER_STEP, STARTED_LINE, STEP_LINES, STILL_LINES
from seti_ea.usage import UsageRecorder, response_record

Translate = Callable[[str, Sequence[str]], Awaitable[Sequence[str]]]

TRANSLATOR_PROMPT = """\
You translate the short lines a voice assistant says aloud while it works for its user. Translate \
each line into {language}: brief, natural spoken {language}, in the polite and calm manner of the \
English line. Keep Seti, PR, CI, MCP and other product words as they are. Give every line back \
under its own id, and nothing else."""
LINES_FORMAT = {
    "type": "json_schema",
    "name": "lines",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "lines": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {"id": {"type": "integer"}, "text": {"type": "string"}},
                    "required": ["id", "text"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["lines"],
        "additionalProperties": False,
    },
}

_BOOKS: dict[str, dict[str, str]] = {}


def spoken_lines() -> tuple[str, ...]:
    """Every fixed line a call can say that names no agent or PR, each once."""
    steps = (line for line in STEP_LINES.values() if "{" not in line)
    lines = (
        *PHRASES,
        *ACTION_LINES.values(),
        *THINK_LINES,
        *GROUP_CHAT_LINES.values(),
        SLEEP_LINE,
        DIRECT_LINE,
        STARTED_LINE,
        *STILL_LINES,
        *steps,
        OTHER_STEP,
    )
    return tuple(dict.fromkeys(lines))


def parse_lines(text: str, count: int) -> list[str]:
    """The translated lines in order; a ValueError unless each line came back once with words."""
    parsed = json.loads(text)
    items = cast(Mapping[str, Any], parsed).get("lines") if isinstance(parsed, dict) else None
    found: dict[int, str] = {}
    for item in cast(list[Any], items) if isinstance(items, list) else []:
        fields = cast(Mapping[str, Any], item) if isinstance(item, dict) else {}
        number, words = fields.get("id"), fields.get("text")
        if isinstance(number, int) and isinstance(words, str) and words.strip():
            found[number] = words.strip()
    if sorted(found) != list(range(count)):
        raise ValueError(f"{len(found)} of {count} lines came back")
    return [found[number] for number in range(count)]


def responses_translate(settings: Settings, seti: SetiClient) -> Translate:
    """Translates with the think model on the Responses API, storing nothing."""
    client = AsyncOpenAI(api_key=settings.openai_api_key)

    async def translate(language: str, lines: Sequence[str]) -> list[str]:
        numbered = [{"id": number, "text": line} for number, line in enumerate(lines)]
        response = await client.responses.create(
            model=settings.think_model,
            instructions=TRANSLATOR_PROMPT.format(language=language),
            input=json.dumps(numbered),
            text={"format": cast(Any, LINES_FORMAT)},
            store=False,
        )
        record = response_record(response, "voice")
        if record is not None:
            usage = UsageRecorder(seti)
            await usage.add(record)
            await usage.flush()
        return parse_lines(response.output_text, len(lines))

    return translate


class Phrasebook:
    """The fixed lines by language; a language's lines are translated the first time it is used."""

    def __init__(self, translate: Translate, books: dict[str, dict[str, str]] | None = None) -> None:
        self._translate = translate
        self._books = _BOOKS if books is None else books
        self._pending: dict[str, asyncio.Task[None]] = {}

    def prepare(self, code: str) -> None:
        """Starts translating the lines into a language, once; English needs none."""
        if code in (DEFAULT, MULTI) or code not in LANGUAGES:
            return
        if code not in self._books and code not in self._pending:
            self._pending[code] = asyncio.create_task(self._fill(code))

    async def wait(self) -> None:
        """Returns once no translation is running."""
        await asyncio.gather(*self._pending.values())

    def line(self, text: str, code: str) -> str | None:
        """A fixed line in a language; None while it has no translation there."""
        return text if code == DEFAULT else self._books.get(code, {}).get(text)

    async def _fill(self, code: str) -> None:
        lines = spoken_lines()
        try:
            translated = await self._translate(LANGUAGES[code], lines)
            self._books[code] = dict(zip(lines, translated, strict=True))
        except (OpenAIError, ValueError) as e:
            logger.warning(f"EA call lines not translated to {LANGUAGES[code]}, staying quiet: {e}")
        finally:
            self._pending.pop(code, None)


class CallLanguage(BaseObserver):
    """One call's language: the one in the EA's settings and, in Multilingual, the one last heard."""

    def __init__(self, code: str, phrasebook: Phrasebook) -> None:
        super().__init__(observe_every_push=False)
        self.code = code
        self._heard = DEFAULT
        self._phrasebook = phrasebook
        phrasebook.prepare(code)

    def change(self, code: str) -> bool:
        """Takes the language in the settings; True when the call must change to it."""
        if code == self.code:
            return False
        self.code = code
        self._phrasebook.prepare(code)
        return True

    @property
    def now(self) -> str:
        """The language the call speaks now."""
        return self._heard if self.code == MULTI else self.code

    def line(self, text: str) -> str | None:
        """A fixed line in the language the call speaks now; None while it has no translation."""
        return self._phrasebook.line(text, self.now)

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if self.code != MULTI or not isinstance(frame, TranscriptionFrame) or frame.language is None:
            return
        heard = heard_language(frame.language.value)
        if heard is not None and heard != self._heard:
            self._heard = heard
            self._phrasebook.prepare(heard)
