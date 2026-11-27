from typing import Any

from fakes import FakeSeti

from seti_ea.tools import EaTools


def item(kind: str, item_id: str, name: str, on: bool) -> dict[str, Any]:
    return {"kind": kind, "id": item_id, "name": name, "detail": None, "default_enabled": on}


async def test_defaults_are_read_without_an_agent_and_changed_only_after_a_yes(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.access_catalog = [
        item("ssh", "prod", "prod", False),
        item("mcp", "linear", "linear", True),
        item("mcp", "sentry", "sentry", False),
    ]
    read = await tools.call("agent_access", {})
    assert read.text == (
        "By default every agent without its own choice gets: SSH hosts on: none; off: prod. "
        "MCP servers on: linear; off: sentry."
    )
    args = {"kind": "mcp", "every_agent": True, "enable": ["sentry"]}
    asked = await tools.call("set_agent_access", args)
    assert asked.summary.startswith("Asked first")
    assert fake_seti.writes() == []
    tools.user_turn()
    done = await tools.call("set_agent_access", {**args, "confirmed": True})
    assert done.ok, done.text
    assert [(m, p, b) for m, p, _q, b in fake_seti.writes()] == [
        ("PUT", "/api/access/defaults", {"kind": "mcp", "id": "sentry", "enabled": True})
    ]
    refused = await tools.call("set_agent_access", {"kind": "ssh", "every_agent": True, "enable": ["prod"]})
    assert not refused.ok
