"""Wake word: with it on, the EA ignores speech until it hears the phrase."""

import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, cast

from loguru import logger
from pipecat.frames.frames import Frame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMUserAggregator,
    LLMUserAggregatorParams,
)
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.turns.user_start.min_words_user_turn_start_strategy import MinWordsUserTurnStartStrategy
from pipecat.turns.user_start.wake_phrase_user_turn_start_strategy import (
    WakePhraseUserTurnStartStrategy,
)

from seti_ea.announce import SLEEP_TOOL
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolResult, ToolSpec

DEFAULT_PHRASE = "Hey Seti"
DEFAULT_KEEP_AWAKE_SECS = 30.0
SETI = "Seti"
# Ways speech to text spells "Seti": Setty, Seddy, Sethi, Set E, city and the like.
SETI_HEARD = re.compile(
    r"\b(?:se(?:t|tt|d|dd|th)(?:i|ie|y|ee|ey)|set[\s-]+e{1,2}|s[ie]tt?y|city)\b", re.IGNORECASE
)


@dataclass(frozen=True)
class WakeSettings:
    """The wake word setting as Seti stores it."""

    enabled: bool = False
    phrase: str = DEFAULT_PHRASE
    keep_awake_secs: float = DEFAULT_KEEP_AWAKE_SECS


def parse_wake_settings(data: object) -> WakeSettings:
    """Settings from Seti's EA settings, with defaults for anything missing or malformed."""
    if not isinstance(data, dict):
        return WakeSettings()
    fields = cast(Mapping[str, Any], data)
    phrase = fields.get("wake_phrase")
    seconds = fields.get("keep_awake_seconds")
    return WakeSettings(
        enabled=fields.get("wake_enabled") is True,
        phrase=phrase.strip() if isinstance(phrase, str) and phrase.strip() != "" else DEFAULT_PHRASE,
        keep_awake_secs=float(seconds)
        if isinstance(seconds, int) and seconds > 0
        else DEFAULT_KEEP_AWAKE_SECS,
    )


async def fetch_wake_settings(seti: SetiClient) -> WakeSettings:
    """The current setting; off when Seti cannot say."""
    try:
        return parse_wake_settings(await seti.get("/ea/settings"))
    except SetiError as e:
        logger.warning(f"EA settings not loaded, wake word off: {e}")
        return WakeSettings()


def _words(phrase: str) -> list[str]:
    return re.sub(r"[^\w\s]", " ", phrase).split()


def normalise_transcript(text: str) -> str:
    """The transcript with every likely mishearing of Seti spelled as Seti."""
    return SETI_HEARD.sub(SETI, text)


def _word(word: str) -> str:
    return f"(?:{SETI_HEARD.pattern})" if SETI_HEARD.fullmatch(word) else re.escape(word)


def phrase_pattern(phrase: str) -> re.Pattern[str]:
    """The phrase's words in order with anything but letters between them, ignoring case."""
    return re.compile(r"\b" + r"\W*".join(_word(word) for word in _words(phrase)) + r"\b", re.IGNORECASE)


def strip_wake_phrase(text: str, phrase: str) -> str:
    """The request after the wake phrase; the phrase alone stays so the EA can answer it."""
    if not _words(phrase):
        return text
    match = phrase_pattern(phrase).search(text)
    if match is None:
        return text
    rest = text[match.end() :].lstrip(" ,.!?;:-").strip()
    return rest if rest != "" else text.strip()


SLEEP_SPEC = ToolSpec(
    SLEEP_TOOL,
    "Put the EA to sleep: it ignores speech until the user says the wake phrase. With the wake "
    "word off, it sleeps for the rest of this call only. Seti says the goodbye; add nothing.",
)


class WakeStrategy(WakePhraseUserTurnStartStrategy):
    """Pipecat's wake phrase gate that can be switched on, off or changed during a call."""

    def __init__(self, settings: WakeSettings) -> None:
        super().__init__(phrases=[settings.phrase], timeout=settings.keep_awake_secs)
        self._settings = settings
        self._slept_this_call = False
        self._patterns = [phrase_pattern(settings.phrase)]

    @property
    def settings(self) -> WakeSettings:
        """The setting in force: Seti's, or on for the rest of the call once put to sleep."""
        if self.temporary:
            return replace(self._settings, enabled=True)
        return self._settings

    @property
    def temporary(self) -> bool:
        """True while the wake word is on only because the EA was put to sleep this call."""
        return self._slept_this_call and not self._settings.enabled

    @property
    def awake(self) -> bool:
        return self.state.value == "awake"

    def sleep(self) -> ToolResult:
        """Stop listening until the wake phrase; with the wake word off, for this call only."""
        if not self._settings.enabled:
            self._slept_this_call = True
        if self.awake:
            self._transition_to_idle()
        phrase = self._settings.phrase
        if self.temporary:
            return ToolResult(
                f"The EA is asleep for the rest of this call and wakes when the user says {phrase}. "
                "The wake word setting itself stays off. The user heard the goodbye.",
                f"Asleep for this call until {phrase}",
            )
        return ToolResult(
            f"The EA is asleep until the user says {phrase}. The user heard the goodbye.",
            f"Asleep until {phrase}",
        )

    def wake(self) -> bool:
        """Wake as if the phrase was heard, with no user turn; False when awake or the word is off."""
        if not self.settings.enabled or self.awake:
            return False
        self._state = type(self.state).AWAKE
        self._accumulated_text = ""
        self._refresh_timeout()
        return True

    def configure(self, settings: WakeSettings) -> bool:
        """Apply a new setting; turning it on puts the EA to sleep. True when anything changed."""
        if settings == self._settings:
            return False
        switched_on = settings.enabled and not self._settings.enabled
        if settings.enabled != self._settings.enabled:
            self._slept_this_call = False
        self._settings = settings
        self._phrases = [settings.phrase]
        self._patterns = [phrase_pattern(settings.phrase)]
        self._timeout = settings.keep_awake_secs
        if switched_on and self.awake:
            self._transition_to_idle()
        self._refresh_timeout()
        return True

    def _check_wake_phrase(self, text: str) -> bool:
        return super()._check_wake_phrase(normalise_transcript(text))

    async def process_frame(self, frame: Frame) -> ProcessFrameResult:
        if not self.settings.enabled:
            return ProcessFrameResult.CONTINUE
        return await super().process_frame(frame)


MIN_INTERRUPTION_WORDS = 2


def turn_start_strategies(wake: WakeStrategy) -> list[BaseUserTurnStartStrategy]:
    """The wake gate, then a turn start that needs two words to cut the EA off mid-reply."""
    return [wake, MinWordsUserTurnStartStrategy(min_words=MIN_INTERRUPTION_WORDS)]


class WakeUserAggregator(LLMUserAggregator):
    """The user aggregator that leaves the wake phrase out of what reaches the LLM."""

    def __init__(self, context: LLMContext, *, params: LLMUserAggregatorParams, wake: WakeStrategy) -> None:
        super().__init__(context, params=params)
        self._wake = wake

    def aggregation_string(self) -> str:
        text = super().aggregation_string()
        settings = self._wake.settings
        return strip_wake_phrase(text, settings.phrase) if settings.enabled else text

    async def _maybe_recover_empty_user_turn(self, interrupted_bot: bool) -> bool:
        # A turn emptied because the EA fell asleep mid-turn must not make it speak.
        if self._wake.settings.enabled and not self._wake.awake:
            return False
        return await super()._maybe_recover_empty_user_turn(interrupted_bot)


def wake_message(strategy: WakeStrategy, *, local: bool = False) -> dict[str, Any]:
    """The RTVI server message that tells the UI whether the EA is listening for its phrase.

    `local` is True while the phrase is heard on this host and nothing goes to speech to text.
    """
    settings = strategy.settings
    return {
        "type": "ea-wake",
        "enabled": settings.enabled,
        "awake": strategy.awake,
        "phrase": settings.phrase,
        "local": local,
    }
