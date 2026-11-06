import httpx
from fakes import FakeSeti

from seti_ea.brief import brief_note, fetch_brief, greeting, parse_brief
from seti_ea.conversation import Conversation
from seti_ea.inbox import CallInbox, Delivered, InboxItem, InboxPump
from seti_ea.prompt import GREETING, RETURNING_GREETING
from seti_ea.seti import SetiClient

BRIEF = {
    "id": "b1",
    "summary": "One agent finished and one needs you.",
    "needs_you": [{"task_id": "t1", "title": "Voicemail", "text": "Asks: merge it?", "url": "/#agents/t1"}],
    "changed": [{"task_id": "t2", "title": "Speech", "text": "Opened PR #12", "url": "/#agents/t2"}],
    "more": 2,
}


def seti_of(fake: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))


async def test_a_call_takes_the_brief_once_and_says_it_in_one_sentence(fake_seti: FakeSeti) -> None:
    fake_seti.brief = BRIEF
    brief = await fetch_brief(seti_of(fake_seti))
    assert brief is not None
    assert await fetch_brief(seti_of(fake_seti)) is None
    said = greeting(True, brief)
    assert '"One agent finished and one needs you."' in said
    assert "only when they ask" in said
    assert brief_note(brief).splitlines() == [
        "Since the user left (each line is the agent's or the notice's own words):",
        "Needs the user now:",
        "- Voicemail: Asks: merge it?",
        "Changed:",
        "- Speech: Opened PR #12",
        "- and 2 more in Seti",
    ]


def test_without_a_brief_the_greeting_has_no_recap() -> None:
    assert greeting(True, None) == RETURNING_GREETING
    assert greeting(False, None) == GREETING
    assert parse_brief({"brief": None}) is None
    assert parse_brief({"brief": {"summary": " "}}) is None
    assert parse_brief("nonsense") is None


def make_item(route: str | None) -> InboxItem:
    return InboxItem(
        1, "channel_event", "event", "api is down", "Sentry", "warning", None, None, "t1", route=route
    )


def test_a_report_waits_unseen_only_when_the_router_sent_it_to_a_toast() -> None:
    assert Delivered([make_item("toast")], []).toast
    assert Delivered([make_item(None)], []).toast
    assert not Delivered([make_item("push")], []).toast
    assert not Delivered([make_item("digest")], []).toast


async def test_the_inbox_poll_tells_seti_a_call_is_live(fake_seti: FakeSeti) -> None:
    conversation = Conversation()
    pump = InboxPump(seti_of(fake_seti), conversation, None)
    await pump.tick()
    conversation.call = CallInbox()
    await pump.tick()
    polls = [dict(r.url.params) for r in fake_seti.requests if r.url.path == "/api/ea/inbox/due"]
    assert polls == [{}, {"call": "1"}]
