"""Scrubbing of key values from logs and from messages sent to the browser."""

import re
from collections.abc import Callable, Iterable
from typing import Any, TextIO

from seti_ea.config import Settings

REDACTED = "[redacted]"
MIN_SECRET_LENGTH = 8
AUTH_HEADER = re.compile(
    r"""((?:authorization|(?:xi?-)?api[_-]key)['"]?\s*[:=]\s*['"]?)(?:(token|bearer)\s+)?[^'"\s,}]+""",
    re.IGNORECASE,
)
# OpenAI echoes a masked key ("sk-proj-****abcd") in auth errors; its ends are still key material.
KEY_LIKE = re.compile(r"(api key provided:\s*)[^\s,]+|\bsk[-_][A-Za-z0-9_*.-]{6,}", re.IGNORECASE)


def secrets_of(settings: Settings) -> list[str]:
    """Key values worth scrubbing; very short values would redact ordinary words."""
    values = [
        settings.deepgram_api_key,
        settings.openai_api_key,
        settings.elevenlabs_api_key,
        settings.turn_api_token,
    ]
    return sorted({v for v in values if len(v) >= MIN_SECRET_LENGTH}, key=len, reverse=True)


def scrub(text: str, secrets: Iterable[str]) -> str:
    """The text with known key values and credential-looking header values replaced."""
    for secret in secrets:
        text = text.replace(secret, REDACTED)
    text = AUTH_HEADER.sub(lambda m: f"{m.group(1)}{m.group(2) + ' ' if m.group(2) else ''}{REDACTED}", text)
    return KEY_LIKE.sub(lambda m: f"{m.group(1) or ''}{REDACTED}", text)


def scrub_value(value: Any, secrets: list[str]) -> Any:
    """A copy of a JSON-like value with every string scrubbed."""
    if isinstance(value, str):
        return scrub(value, secrets)
    if isinstance(value, dict):
        return {k: scrub_value(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_value(v, secrets) for v in value]
    return value


def scrubbing_sink(stream: TextIO, secrets: list[str]) -> Callable[[str], None]:
    """A loguru sink that scrubs each formatted record, traceback included."""

    def write(message: str) -> None:
        stream.write(scrub(message, secrets))
        stream.flush()

    return write
