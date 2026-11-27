from typing import Any

import httpx
import pytest
from fakes import NOW, ok
from test_settings_tools import HOOK, SettingsFake, writes

from seti_ea.seti import SetiClient
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

DROP_DEPLOYS = "export default (e) => e.event !== 'deploy'"


class FilterFake(SettingsFake):
    """SettingsFake plus a webhook filter and its routes."""

    def __init__(self) -> None:
        super().__init__()
        self.channels[0]["filter"] = None
        self.tested: list[dict[str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.removeprefix("/api/").split("/")
        if parts[:1] == ["channels"] and parts[2:3] == ["filter"]:
            if parts[3:] != ["test"]:
                self.requests.append(request)
            return self._filter(parts, httpx.Response(200, content=request.content).json())
        return super().handle(request)

    def _filter(self, parts: list[str], body: dict[str, Any]) -> httpx.Response:
        hook = self.channels[0]
        if parts[3:] == ["test"]:
            self.tested.append(body)
            row = {"source": "sample", "event": "deploy", "title": "Shipped", "outcome": "dropped"}
            return ok({"rows": [row, {**row, "source": "delivery", "outcome": "kept"}], "sample_error": None})
        hook["filter"] = (
            None if body["script"] == "" else {"failures": 0, "last_error": None, "day": {"kept": 0}, **body}
        )
        return ok(hook)


@pytest.fixture
def fake() -> FilterFake:
    return FilterFake()


@pytest.fixture
def tools(fake: FilterFake) -> EaTools:
    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    return EaTools(client, now=lambda: NOW)


async def confirm(tools: EaTools, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call("update_channel", args)
    tools.user_turn("yes")
    done = await tools.call("update_channel", {**args, "confirmed": True})
    return asked, done


async def test_the_ea_sets_a_filter_after_a_yes_that_shows_the_code_in_full(
    tools: EaTools, fake: FilterFake
) -> None:
    asked, done = await confirm(tools, {"channel": "uptime", "filter": DROP_DEPLOYS})
    assert asked.summary.startswith("Asked first")
    assert f"Filter code:\n{DROP_DEPLOYS}" in asked.text
    assert done.text == "Updated the webhook Uptime: it gives it new filter code, on."
    path = f"/api/channels/{HOOK}/filter"
    assert writes(fake) == [("PUT", path, {"script": DROP_DEPLOYS, "enabled": True})]

    read = await tools.call("get_channel", {"channel": "uptime"})
    assert f"Filter code:\n{DROP_DEPLOYS}" in read.text
    assert "Its filter is on; in the last 24 hours: 0 kept, 0 changed, 0 dropped, 0 failed." in read.text

    _, off = await confirm(tools, {"channel": "uptime", "filter_enabled": False})
    assert off.text == "Updated the webhook Uptime: it turns its filter off."
    assert writes(fake)[-1] == ("PUT", path, {"script": DROP_DEPLOYS, "enabled": False})
    same = await tools.call("update_channel", {"channel": "uptime", "filter_enabled": False})
    assert same.text == "That changes nothing in the webhook Uptime."

    _, removed = await confirm(tools, {"channel": "uptime", "filter": ""})
    assert removed.text == "Updated the webhook Uptime: it removes its filter."
    assert writes(fake)[-1] == ("PUT", path, {"script": "", "enabled": False})


async def test_a_filter_needs_code_and_a_webhook(tools: EaTools, fake: FilterFake) -> None:
    missing = await tools.call("update_channel", {"channel": "uptime", "filter_enabled": True})
    assert missing.text == "Uptime has no filter yet: give its code with filter."
    assert writes(fake) == []


async def test_the_ea_tests_a_draft_filter_on_recent_deliveries_and_a_sample(
    tools: EaTools, fake: FilterFake
) -> None:
    nothing = await tools.call("test_channel_script", {"channel": "uptime"})
    assert nothing.text == "Uptime has no filter: give the code to test as script."
    tested = await tools.call(
        "test_channel_script", {"channel": "uptime", "script": DROP_DEPLOYS, "sample": '{"kind":"deploy"}'}
    )
    assert fake.tested == [{"script": DROP_DEPLOYS, "sample": {"headers": "", "body": '{"kind":"deploy"}'}}]
    assert tested.text.splitlines() == [
        "The filter on Uptime, tried without storing or sending anything:",
        '- It drops the sample: "Shipped"',
        '- It keeps the delivery deploy: "Shipped"',
    ]
    assert writes(fake) == []
