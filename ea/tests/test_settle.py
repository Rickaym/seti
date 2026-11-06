"""The settle window: bursts of events wait for quiet off a call; urgent items never wait."""

from typing import Any

import httpx
from fakes import FakeSeti

from seti_ea.conversation import Conversation
from seti_ea.inbox import CallInbox, Delivered, InboxItem, InboxPump, parse_items
from seti_ea.seti import SetiClient
from seti_ea.settle import Settle


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def event(item_id: int, title: str = "CI failed on acme/web#7", **extra: Any) -> InboxItem:
    fields = {"id": item_id, "kind": "watch_event", "event": "ci_failed", "title": title, **extra}
    return parse_items([fields])[0]


def ids(items: list[InboxItem]) -> list[int]:
    return [item.id for item in items]


def test_events_wait_until_none_arrives_or_changes_for_the_quiet_spell() -> None:
    clock = Clock()
    settle = Settle(quiet_secs=45, max_secs=180, clock=clock)
    assert settle.ready([event(1)]) == []
    clock.now += 30
    assert settle.ready([event(1), event(2, "Voicemail finished its turn")]) == []
    clock.now += 30
    settled = [event(1, "CI passed on acme/web#7"), event(2, "Voicemail finished its turn")]
    assert settle.ready(settled) == []
    clock.now += 44
    assert settle.ready(settled) == []
    clock.now += 1
    assert ids(settle.ready(settled)) == [1, 2]


def test_a_steady_stream_still_goes_out_after_the_longest_hold() -> None:
    clock = Clock()
    settle = Settle(quiet_secs=45, max_secs=180, clock=clock)
    for step in range(6):
        assert settle.ready([event(n) for n in range(1, step + 2)]) == []
        clock.now += 30
    assert ids(settle.ready([event(n) for n in range(1, 8)])) == [1, 2, 3, 4, 5, 6, 7]


def test_urgent_items_follow_ups_and_mentions_never_wait() -> None:
    settle = Settle(quiet_secs=45, clock=Clock())
    items = [
        event(1),
        event(2, "Voicemail is waiting on you", urgent=True),
        event(3, "Check the login CI", kind="followup"),
        event(4, "@voicemail mentioned you", kind="team_mention"),
    ]
    assert ids(settle.ready(items)) == [2, 3, 4]


async def test_off_a_call_the_pump_reports_events_once_they_settle(fake_seti: FakeSeti) -> None:
    fake_seti.inbox_item("watch_event", "CI failed on acme/web#7")
    fake_seti.inbox_item("watch_event", "Voicemail is waiting on you", event="needs_you", urgent=True)
    clock = Clock()
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    followed: list[Delivered] = []

    async def follow_up(delivered: Delivered) -> None:
        followed.append(delivered)

    pump = InboxPump(seti, Conversation(), follow_up, settle=Settle(quiet_secs=45, clock=clock))
    assert await pump.tick() == 1
    assert [i["delivered_via"] for i in fake_seti.inbox] == [None, "chat"]
    fake_seti.inbox[0]["title"] = "CI passed on acme/web#7"
    clock.now += 30
    assert await pump.tick() == 0
    clock.now += 45
    assert await pump.tick() == 1
    assert [i["delivered_via"] for i in fake_seti.inbox] == ["chat", "chat"]


def test_a_call_takes_the_latest_copy_of_an_item_seti_updated_in_place() -> None:
    inbox = CallInbox()
    inbox.offer([event(1, "CI passed on acme/web#7")])
    assert not inbox.needs_you_waiting
    inbox.offer([event(1, "Voicemail is waiting on you", event="needs_you", urgent=True)])
    assert inbox.needs_you_waiting
    assert [item.title for item in inbox.take(needs_you_only=True)] == ["Voicemail is waiting on you"]
