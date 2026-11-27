from collections import Counter

from fakes import settings
from test_server import client_for, idle_bot

from seti_ea import server
from seti_ea.actions import CONFIRM_TOOLS
from seti_ea.gate import ON_WORD_TOOLS
from seti_ea.tool_list import OTHER_AREA, SUMMARY_CHARS, area_of, summary_of, tool_list
from seti_ea.tools import TOOL_SPECS


async def test_tools_lists_every_tool_once_with_its_gate() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with client_for(app) as client:
        response = await client.get("/tools")
    assert response.status_code == 200
    tools = response.json()["tools"]
    names = [tool["name"] for tool in tools]
    assert names == [spec.name for spec in TOOL_SPECS]
    assert not [name for name, count in Counter(names).items() if count > 1]
    assert {t["name"] for t in tools if t["gate"] == "word"} == set(ON_WORD_TOOLS)
    assert {t["name"] for t in tools if t["gate"] == "asks"} == set(CONFIRM_TOOLS) - ON_WORD_TOOLS
    assert {t["name"] for t in tools if t["gate"] == "runs"} == set(names) - CONFIRM_TOOLS
    assert all(set(tool) == {"name", "area", "summary", "gate"} for tool in tools)


async def test_tools_needs_seti_token() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with client_for(app, token="") as client:
        response = await client.get("/tools")
    assert response.status_code == 401


def test_every_summary_is_one_bounded_line() -> None:
    for tool in tool_list():
        assert tool["summary"]
        assert "\n" not in tool["summary"]
        assert len(tool["summary"]) <= SUMMARY_CHARS + 3


def test_summary_is_the_first_sentence() -> None:
    assert summary_of("Stop a task. It ends the turn.") == "Stop a task."
    assert summary_of("One line only") == "One line only"


def test_area_reads_whole_words_of_the_name() -> None:
    assert area_of("list_prs") == "PRs and repos"
    assert area_of("list_processes") == "Agents"
    assert area_of("watch_task") == "Follow-ups"
    assert area_of("set_update_mode") == "Agents"
    assert area_of("update_ea_settings") == OTHER_AREA
