from datetime import UTC, datetime
from pathlib import Path

import httpx
from fakes import FakeSeti, settings
from test_server import client_for, idle_bot

from seti_ea import server
from seti_ea.conversation import Conversation
from seti_ea.packs import CHAT_TIMEOUT_SECS, PackPrompt
from seti_ea.prompt import CHAT_NOTE_PREFIX, LIVE_NOTE_PREFIX, VOICE_NOTE
from seti_ea.prompt_view import NO_LIVE_NOTE, PromptView, running_commit
from seti_ea.redact import REDACTED
from seti_ea.seti import SetiClient

KEY = "sk-proj-" + "k" * 30
AT = datetime(2026, 11, 27, 9, 30, tzinfo=UTC)


def seti_for(fake_seti: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))


async def test_the_base_part_is_the_system_prompt_the_bot_uses(fake_seti: FakeSeti) -> None:
    fake_seti.form_of_address = "sir"
    fake_seti.language = "de"
    view = PromptView(settings(), seti_for(fake_seti), Conversation())
    answer = await view.answer(AT)
    bot_prompt = await PackPrompt(seti_for(fake_seti), timeout_secs=CHAT_TIMEOUT_SECS).system_prompt()
    parts = {part["key"]: part for part in answer["parts"]}
    assert [part["key"] for part in answer["parts"]] == ["base", "call", "chat", "inbox", "live"]
    assert parts["base"]["text"] == bot_prompt
    assert '"sir"' in parts["base"]["text"]
    assert not parts["base"]["per_turn"]
    assert all(part["label"] and part["about"] for part in answer["parts"])
    assert all(part["chars"] == len(part["text"]) for part in answer["parts"])
    assert all(part["per_turn"] for part in answer["parts"] if part["key"] != "base")


async def test_the_turn_notes_are_the_ones_each_channel_sends(fake_seti: FakeSeti) -> None:
    parts = {
        p["key"]: p
        for p in (await PromptView(settings(), seti_for(fake_seti), Conversation()).answer(AT))["parts"]
    }
    assert parts["call"]["text"].startswith("A new call started. It is Friday 27 November 2026, 09:30 UTC")
    assert parts["call"]["text"].endswith(VOICE_NOTE)
    assert parts["chat"]["text"].startswith(CHAT_NOTE_PREFIX)
    assert "inbox notes above arrived while no call was on" in parts["inbox"]["text"]


async def test_the_live_context_is_the_last_one_sent_and_never_built_for_the_view(
    fake_seti: FakeSeti,
) -> None:
    conversation = Conversation()
    view = PromptView(settings(openai_api_key=KEY), seti_for(fake_seti), conversation)
    live = (await view.answer(AT))["parts"][-1]
    assert live["text"] == ""
    assert live["about"] == NO_LIVE_NOTE
    assert live["built_at"] is None
    assert not [r for r in fake_seti.requests if r.url.path in ("/api/ea/context", "/api/ea/search")]

    conversation.live_note.text = (
        f"{LIVE_NOTE_PREFIX}, 3 seconds old.\n- Atlas pasted {KEY} and api_key=hunter22hunter"
    )
    conversation.live_note.at = AT
    live = (await view.answer(AT))["parts"][-1]
    assert live["built_at"] == AT.isoformat()
    assert KEY not in live["text"]
    assert "hunter22hunter" not in live["text"]
    assert live["text"].count(REDACTED) == 2
    assert live["chars"] == len(live["text"])
    assert not [r for r in fake_seti.requests if r.url.path in ("/api/ea/context", "/api/ea/search")]


async def test_prompt_answers_over_http_with_its_commit_and_needs_the_seti_token() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with client_for(app) as client:
        response = await client.get("/prompt")
    assert response.status_code == 200
    body = response.json()
    assert body["commit"] == running_commit()
    assert [part["key"] for part in body["parts"]] == ["base", "call", "chat", "inbox", "live"]
    async with client_for(app, token="") as client:
        assert (await client.get("/prompt")).status_code == 401


def test_the_commit_is_none_outside_a_checkout(tmp_path: Path) -> None:
    assert running_commit(tmp_path) is None
