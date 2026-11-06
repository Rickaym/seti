import io
from typing import Any

import pytest
from fakes import settings
from loguru import logger
from pipecat.frames.frames import Frame, OutputTransportMessageUrgentFrame
from pipecat.processors.frameworks.rtvi.models import Error, ErrorData

from seti_ea.bot import RedactingRTVIProcessor
from seti_ea.redact import REDACTED, scrub, scrub_value, scrubbing_sink, secrets_of

OPENAI_KEY = "sk-proj-Abc123Def456Ghi789Jkl012"
ELEVENLABS_KEY = "sk_0123456789abcdef0123456789abcdef0123456789abcdef"
OPENAI_ERROR = (
    "Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-proj-************"
    "*****************l012. You can find your API key at https://platform.openai.com/account/api-keys.', "
    "'type': 'invalid_request_error', 'code': 'invalid_api_key'}}"
)
DEEPGRAM_ERROR = (
    "Deepgram rejected the connection (status 401): headers: {'User-Agent': 'deepgram-sdk/7.10.0', "
    "'Authorization': 'Token dg-0123456789abcdef'}, status_code: 401"
)


def test_secrets_of_skips_blank_and_short_values() -> None:
    found = secrets_of(settings(deepgram_api_key="dg-0123456789abcdef", openai_api_key="short"))
    assert found == ["dg-0123456789abcdef"]


def test_secrets_of_covers_every_service_key() -> None:
    found = secrets_of(
        settings(
            deepgram_api_key="dg-0123456789abcdef",
            openai_api_key=OPENAI_KEY,
            elevenlabs_api_key=ELEVENLABS_KEY,
            turn_api_token="turn-0123456789",
        )
    )
    assert set(found) == {"dg-0123456789abcdef", OPENAI_KEY, ELEVENLABS_KEY, "turn-0123456789"}


def test_scrub_replaces_known_keys_and_auth_headers() -> None:
    assert scrub("key sk-ant-abcdefgh used", ["sk-ant-abcdefgh"]) == f"key {REDACTED} used"
    scrubbed = scrub(DEEPGRAM_ERROR, [])
    assert "dg-0123456789abcdef" not in scrubbed
    assert f"'Authorization': 'Token {REDACTED}'" in scrubbed
    assert scrub('{"x-api-key": "abc"}', []) == f'{{"x-api-key": "{REDACTED}"}}'
    assert scrub("Authorization: Bearer abc.def", []) == f"Authorization: Bearer {REDACTED}"


def test_scrub_hides_openai_and_elevenlabs_headers() -> None:
    headers = f"{{'Authorization': 'Bearer {OPENAI_KEY}', 'xi-api-key': '{ELEVENLABS_KEY}'}}"
    scrubbed = scrub(headers, [])
    assert OPENAI_KEY not in scrubbed
    assert ELEVENLABS_KEY not in scrubbed
    assert f"'Authorization': 'Bearer {REDACTED}'" in scrubbed
    assert f"'xi-api-key': '{REDACTED}'" in scrubbed
    assert scrub("xi-api-key: abc123", []) == f"xi-api-key: {REDACTED}"
    assert scrub('{"authorization": "Bearer abc.def"}', []) == f'{{"authorization": "Bearer {REDACTED}"}}'


def test_scrub_hides_key_shaped_values_and_masked_keys() -> None:
    assert scrub(f"key {OPENAI_KEY} and {ELEVENLABS_KEY}", []) == f"key {REDACTED} and {REDACTED}"
    scrubbed = scrub(OPENAI_ERROR, [OPENAI_KEY])
    assert "l012" not in scrubbed
    assert "sk-proj" not in scrubbed
    assert f"Incorrect API key provided: {REDACTED}" in scrubbed
    assert "invalid_api_key" in scrubbed
    assert scrub("a task-list and desk-lamp", []) == "a task-list and desk-lamp"


def test_scrub_value_walks_json() -> None:
    value = {"data": {"error": "bad sk-secret-1234", "list": ["sk-secret-1234", 3]}}
    assert scrub_value(value, ["sk-secret-1234"]) == {
        "data": {"error": f"bad {REDACTED}", "list": [REDACTED, 3]}
    }


def test_log_sink_scrubs_messages_and_tracebacks() -> None:
    stream = io.StringIO()
    sink_id = logger.add(scrubbing_sink(stream, ["sk-secret-1234"]), level="INFO", colorize=False)
    try:
        logger.info("calling with sk-secret-1234")
        try:
            raise RuntimeError(DEEPGRAM_ERROR)
        except RuntimeError:
            logger.exception("service failed")
    finally:
        logger.remove(sink_id)
    output = stream.getvalue()
    assert "sk-secret-1234" not in output
    assert "dg-0123456789abcdef" not in output
    assert "service failed" in output


async def test_rtvi_messages_to_the_browser_are_scrubbed(monkeypatch: pytest.MonkeyPatch) -> None:
    pushed: list[Frame] = []
    rtvi = RedactingRTVIProcessor(["dg-0123456789abcdef"])

    async def capture(frame: Frame, *_args: Any) -> None:
        pushed.append(frame)

    monkeypatch.setattr(rtvi, "push_frame", capture)
    await rtvi.push_transport_message(Error(data=ErrorData(error=DEEPGRAM_ERROR, fatal=False)))
    assert len(pushed) == 1
    frame = pushed[0]
    assert isinstance(frame, OutputTransportMessageUrgentFrame)
    assert "dg-0123456789abcdef" not in str(frame.message)
    assert frame.message["type"] == "error"


async def test_openai_auth_errors_reach_the_browser_without_key_material(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pushed: list[Frame] = []
    rtvi = RedactingRTVIProcessor([OPENAI_KEY])

    async def capture(frame: Frame, *_args: Any) -> None:
        pushed.append(frame)

    monkeypatch.setattr(rtvi, "push_frame", capture)
    await rtvi.push_transport_message(Error(data=ErrorData(error=OPENAI_ERROR, fatal=False)))
    frame = pushed[0]
    assert isinstance(frame, OutputTransportMessageUrgentFrame)
    text = str(frame.message)
    assert "sk-proj" not in text
    assert "l012" not in text
    assert "invalid_api_key" in text
