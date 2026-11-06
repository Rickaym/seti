from typing import Any

import httpx
import pytest
from fakes import NOW, err, ok
from test_settings_tools import HOOK, SettingsFake, confirm, writes

from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools

POLLER = "p" * 24
SCRIPT = "export default async ({ fetch }) => []"


def poller_channel(**poller: Any) -> dict[str, Any]:
    return {
        "id": POLLER,
        "name": "Release feed",
        "source": "poller",
        "preset": "poller",
        "created_at": "2026-09-26T12:00:00.000Z",
        "updated_at": "2026-09-26T12:00:00.000Z",
        "subscriptions": [{"id": 3, "target": "ea", "task_id": None, "events": None}],
        "recent": [{"title": "v1.2.0", "severity": "info", "created_at": "2026-09-27T11:40:00.000Z"}],
        "deliveries": [],
        "poller": {
            "script": SCRIPT,
            "preset": "poller-templates.feed",
            "interval_s": 300,
            "timeout_s": 30,
            "extra_hosts": ["api.example.com"],
            "secrets": ["feed_token"],
            "fingerprint_fields": [],
            "detect_gone": False,
            "enabled": True,
            "status": "ok",
            "failures": 0,
            "last_run_at": "2026-09-27T11:55:00.000Z",
            "next_run_at": "2026-09-27T12:05:00.000Z",
            "baseline_at": "2026-09-26T12:05:00.000Z",
            "keys": 12,
            "runs": [
                {
                    "id": 9,
                    "trigger": "schedule",
                    "started_at": "2026-09-27T11:55:00.000Z",
                    "duration_ms": 800,
                    "ok": True,
                    "items": 12,
                    "emitted": 1,
                    "invalid": [],
                    "error": None,
                    "logs": ["fetched 12"],
                },
                {
                    "id": 8,
                    "trigger": "manual",
                    "started_at": "2026-09-27T11:45:00.000Z",
                    "duration_ms": 300,
                    "ok": False,
                    "items": 0,
                    "emitted": 0,
                    "invalid": [],
                    "error": "https://example.com/feed.xml answered 503",
                    "logs": [],
                },
            ],
            **poller,
        },
    }


class PollerFake(SettingsFake):
    """SettingsFake plus the poller routes."""

    def __init__(self) -> None:
        super().__init__()
        self.channels.append(poller_channel())
        self.test_result: dict[str, Any] = {
            "ok": True,
            "error": None,
            "items": [{"key": "v1.3.0", "title": "Version 1.3.0", "kind": "release"}],
            "invalid": ["Item 2: no key"],
            "logs": ["fetched 1"],
            "duration_ms": 1200,
            "state": None,
        }

    def _settings(
        self, method: str, parts: list[str], body: dict[str, Any], params: httpx.QueryParams
    ) -> httpx.Response | None:
        match method, parts:
            case "POST", ["channels", "pollers"]:
                if body.get("extra_hosts"):
                    return err(403, "Forbidden", "The EA cannot change a poller's extra hosts or secrets")
                return ok(poller_channel() | {"id": "n" * 24, "name": body["name"]})
            case "POST", ["channels", "pollers", "test"]:
                if body.get("secrets") and body.get("script") != SCRIPT:
                    return err(
                        403, "Forbidden", "The EA cannot change the script of a poller that uses secrets"
                    )
                return ok(self.test_result)
            case "PUT", ["channels", "pollers", channel_id]:
                return ok(poller_channel() | {"id": channel_id})
            case "GET", ["channels", "pollers", _channel_id, "runs"]:
                return ok(poller_channel()["poller"]["runs"])
            case "POST", ["channels", "pollers", channel_id, "poll"]:
                return ok(poller_channel() | {"id": channel_id})
            case _:
                return super()._settings(method, parts, body, params)


@pytest.fixture
def fake() -> PollerFake:
    return PollerFake()


@pytest.fixture
def tools(fake: PollerFake) -> EaTools:
    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    return EaTools(client, now=lambda: NOW)


async def test_pollers_are_listed_with_webhooks_and_explained(tools: EaTools) -> None:
    listed = await tools.call("list_channels", {})
    assert listed.text.splitlines()[0] == "2 channels:"
    assert listed.text.splitlines()[2] == (
        "- Release feed (Poller): reports to you; every 5 minutes, working; last ran 5 minutes ago: "
        '12 items, 1 event; last event 20 minutes ago: "v1.2.0"'
    )
    detail = await tools.call("get_channel", {"channel": "release feed"})
    assert detail.text.startswith(
        "Release feed is a poller, working; it runs every 5 minutes with a 30 second timeout, counts an "
        "item changed when anything in it changes and does not report gone items."
    )
    assert (
        "It reaches the sandbox allowlist plus api.example.com and sends the secrets feed_token"
        in detail.text
    )
    assert "failed 15 minutes ago by hand: [link] answered 503" in detail.text
    assert detail.text.endswith(f"Script:\n{SCRIPT}")


async def test_create_poller_asks_first_and_leaves_reach_to_the_user(
    tools: EaTools, fake: PollerFake
) -> None:
    args = {"name": "Status page", "script": SCRIPT, "interval_minutes": 10, "fingerprint_fields": ["status"]}
    asked, done = await confirm(tools, "create_poller", args)
    assert (
        "This creates the poller Status page, running its script every 10 minutes and keeping its "
        "events out of your inbox." in (asked.text)
    )
    assert done.ok
    assert "Only the user gives a poller extra hosts" in done.text
    assert writes(fake) == [
        (
            "POST",
            "/api/channels/pollers",
            {
                "name": "Status page",
                "script": SCRIPT,
                "subscribe_ea": False,
                "detect_gone": False,
                "fingerprint_fields": ["status"],
                "interval_s": 600,
            },
        )
    ]


async def test_update_pauses_and_poll_now_reports_the_run(tools: EaTools, fake: PollerFake) -> None:
    nothing = await tools.call("update_poller", {"poller": "release feed"})
    assert nothing.text == "That changes nothing in the poller Release feed."
    asked, done = await confirm(tools, "update_poller", {"poller": "release feed", "active": False})
    assert "This changes the poller Release feed: it pauses it." in asked.text
    assert done.text == "Updated the poller Release feed: it pauses it."
    _, polled = await confirm(tools, "run_channel", {"channel": "release feed"})
    assert polled.text == "Polled Release feed. It ran 5 minutes ago: 12 items, 1 event."
    assert writes(fake) == [
        ("PUT", f"/api/channels/pollers/{POLLER}", {"enabled": False}),
        ("POST", f"/api/channels/pollers/{POLLER}/poll", {}),
    ]


async def test_test_poller_runs_drafts_and_saved_pollers(tools: EaTools, fake: PollerFake) -> None:
    draft = await tools.call("test_channel_script", {"script": SCRIPT, "kind": "poller"})
    assert draft.text == (
        "The test returned 1 item in 1.2 seconds.\n- v1.3.0: Version 1.3.0 (release)\n"
        "Not usable: Item 2: no key.\nLog: fetched 1"
    )
    saved = await tools.call("test_channel_script", {"channel": "release feed"})
    assert saved.ok
    assert fake.requests[-1].url.path == "/api/channels/pollers/test"
    rewritten = await tools.call(
        "test_channel_script", {"channel": "release feed", "script": "export default () => []"}
    )
    assert not rewritten.ok
    assert "script of a poller that uses secrets" in rewritten.text
    fake.test_result = {"ok": False, "error": "SyntaxError: unexpected token (line 1)", "duration_ms": 100}
    failed = await tools.call("test_channel_script", {"script": "export default (", "kind": "poller"})
    assert failed.text == "The test failed after 0.1 seconds: SyntaxError: unexpected token (line 1)"
    assert not (await tools.call("test_channel_script", {})).ok
    assert not (await tools.call("test_channel_script", {"script": SCRIPT})).ok


async def test_webhook_tools_turn_pollers_away_and_delete_says_what_stops(tools: EaTools) -> None:
    update = await tools.call("update_channel", {"channel": "release feed", "name": "x"})
    assert update.text == "Release feed is a poller: change it with update_poller."
    for name in ("test_channel", "rotate_channel_secret"):
        result = await tools.call(name, {"channel": "release feed", "name": "x"})
        assert not result.ok
        assert (
            result.text == "Release feed is a poller, not a webhook: use update_poller, run_channel or "
            "test_channel_script."
        )
    asked, done = await confirm(tools, "delete_channel", {"channel": "release feed"})
    assert "This deletes the poller Release feed: Seti stops running it" in asked.text
    assert done.text == "Deleted the poller Release feed."
    runs = await tools.call("get_channel", {"channel": "release feed", "runs": True})
    assert runs.text.splitlines()[1:3] == [
        "- ran 5 minutes ago: 12 items, 1 event",
        "  log: fetched 12",
    ]
    assert HOOK not in runs.text
