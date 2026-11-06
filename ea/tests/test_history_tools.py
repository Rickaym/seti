from collections.abc import Iterator

import pytest
from fakes import TASK_LOGIN, FakeSeti

from seti_ea.clock import CURRENT_CLOCK, parse_user_clock
from seti_ea.tools import TOOL_SPECS, EaTools


@pytest.fixture(autouse=True)
def half_hour_clock() -> Iterator[None]:
    token = CURRENT_CLOCK.set(parse_user_clock({"timezone": "Indian/Cocos"}))
    yield
    CURRENT_CLOCK.reset(token)


def history_params(fake_seti: FakeSeti, path: str) -> dict[str, str]:
    request = next(r for r in reversed(fake_seti.requests) if r.url.path.endswith(path))
    return dict(request.url.params)


async def test_list_tasks_active_skims_who_had_turns_yesterday(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.activity = {
        "agents": [
            {
                "title": "Orion",
                "prompts": 4,
                "replies": 5,
                "first_at": "2026-09-26 09:30",
                "last_at": "2026-09-26 19:21",
                "prs_linked": ["https://github.com/acme/app/pull/30"],
                "last_reply": "The **drill** report is done.",
            },
            {
                "title": "Quiet",
                "prompts": 1,
                "replies": 0,
                "first_at": "2026-09-26 23:30",
                "last_at": "2026-09-26 23:30",
            },
        ],
        "more": 2,
        "archived_since": [{"id": "x", "title": "Old", "archived_at": "2026-09-27"}],
    }
    result = await tools.call("list_tasks", {"active": "yesterday"})
    assert result.ok
    assert result.text.splitlines() == [
        "4 agents had turns yesterday, most active first:",
        "- Orion: 4 prompts, 5 replies, 09:30 to 19:21, linked app PR 30. "
        "Last reply: The drill report is done.",
        "- Quiet: 1 prompt, 0 replies, 23:30 to 23:30.",
        "And 2 less active ones not listed.",
        "Archived since then, so not counted: Old.",
    ]
    assert history_params(fake_seti, "/history/activity") == {
        "since": "2026-09-26T00:00:00+06:30",
        "until": "2026-09-27T00:00:00+06:30",
        "timezone": "Indian/Cocos",
        "limit": "12",
    }


async def test_list_tasks_active_says_when_nothing_happened(tools: EaTools) -> None:
    result = await tools.call("list_tasks", {"active": "2026-09-20"})
    assert result.text == "No agent had turns on 2026-09-20."


async def test_get_task_window_reads_that_day_instead_of_the_recent_transcript(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.history = {
        "lines": ["2026-09-25 10:00 user: ship it", "2026-09-25 10:05 agent: Shipped."],
        "older_cursor": 9,
    }
    result = await tools.call("get_task", {"task": "login", "window": "2026-09-25"})
    assert result.ok
    assert "Recent transcript" not in result.text
    assert result.text.splitlines()[-3:] == [
        "Its prompts and replies on 2026-09-25, the latest part, oldest first:",
        "- 2026-09-25 10:00 user: ship it",
        "- 2026-09-25 10:05 agent: Shipped.",
    ]
    assert history_params(fake_seti, f"/history/tasks/{TASK_LOGIN}") == {
        "since": "2026-09-25T00:00:00+06:30",
        "until": "2026-09-26T00:00:00+06:30",
        "timezone": "Indian/Cocos",
        "limit": "30",
    }


async def test_get_task_window_refuses_a_date_that_does_not_exist(tools: EaTools) -> None:
    result = await tools.call("get_task", {"task": "login", "window": "2026-02-30"})
    assert not result.ok
    assert result.text == "2026-02-30 is not a date."


def test_get_task_takes_no_side_question() -> None:
    spec = next(spec for spec in TOOL_SPECS if spec.name == "get_task")
    assert set(spec.properties) == {"task", "window"}
    assert "run_mod_action" in spec.description
