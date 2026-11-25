from typing import Any

from fakes import TASK_LOGOUT, FakeSeti

from seti_ea.tools import EaTools


def followed(n: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": n,
        "service": "slack",
        "channel": "C0PROJ1234",
        "thread": f"1700000000.00000{n}",
        "url": f"https://acme.slack.com/archives/C0PROJ1234/p170000000000000{n}",
        "replies": n - 1,
        "last_activity_at": "2026-01-01T00:00:00Z",
        "stopped_at": None,
        **extra,
    }


async def test_get_task_lists_the_threads_the_agent_follows(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.task_threads[TASK_LOGOUT] = [
        followed(1),
        followed(2),
        followed(3, stopped_at="2026-01-02T00:00:00Z"),
    ]
    text = (await tools.call("get_task", {"task": "logout"})).text
    assert "It follows 2 threads it posted in outside Seti, for replies:" in text
    assert "- slack C0PROJ1234 thread 1700000000.000001: 0 replies, last activity" in text
    assert "https://acme.slack.com/archives/C0PROJ1234/p1700000000000002" in text
    assert "000003" not in text


async def test_get_task_says_nothing_of_threads_when_there_are_none(tools: EaTools) -> None:
    assert "threads it posted in" not in (await tools.call("get_task", {"task": "logout"})).text


async def test_get_task_counts_threads_beyond_the_first_five(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.task_threads[TASK_LOGOUT] = [followed(n) for n in range(1, 8)]
    assert "- and 2 more threads." in (await tools.call("get_task", {"task": "logout"})).text
