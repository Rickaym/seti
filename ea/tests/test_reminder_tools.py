from typing import Any

import httpx
import pytest
from fakes import NOW, ok
from test_settings_tools import SettingsFake, confirm, writes

from seti_ea.clock import CURRENT_CLOCK, parse_user_clock
from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools

REMINDER = "r" * 24
SCRIPT = "export default () => 'Check the open pull requests.'"


def run(outcome: str, started_at: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": 1,
        "trigger": "schedule",
        "started_at": started_at,
        "duration_ms": 400,
        "outcome": outcome,
        "message": None,
        "error": None,
        "logs": [],
        **extra,
    }


RUNS = [
    run("ok", "2026-09-27T11:00:00.000Z", message="Check the open pull requests.", logs=["counted 3"]),
    run("timeout", "2026-09-27T10:00:00.000Z", error="The script ran over its 5 s timeout"),
]


def reminder_channel(**reminder: Any) -> dict[str, Any]:
    return {
        "id": REMINDER,
        "name": "PR nudge",
        "source": "reminder",
        "preset": "reminder",
        "created_at": "2026-09-26T12:00:00.000Z",
        "updated_at": "2026-09-26T12:00:00.000Z",
        "subscriptions": [
            {"id": 4, "target": "task", "task_id": "t1", "task_title": "Reviewer", "events": None}
        ],
        "recent": [],
        "deliveries": [],
        "reminder": {
            "script": SCRIPT,
            "interval_s": 3600,
            "enabled": True,
            "status": "ok",
            "failures": 0,
            "last_run_at": "2026-09-27T11:00:00.000Z",
            "next_run_at": "2026-09-27T12:30:00.000Z",
            "last_output": "Check the open pull requests.",
            "runs": RUNS,
            **reminder,
        },
    }


class ReminderFake(SettingsFake):
    """SettingsFake plus the reminder routes."""

    def __init__(self) -> None:
        super().__init__()
        self.channels.append(reminder_channel())
        self.test_result: dict[str, Any] = {
            "outcome": "ok",
            "message": "Check the open pull requests.",
            "error": None,
            "logs": ["counted 3"],
            "duration_ms": 1200,
            "state": {"count": 1},
        }

    def _settings(
        self, method: str, parts: list[str], body: dict[str, Any], params: httpx.QueryParams
    ) -> httpx.Response | None:
        match method, parts:
            case "POST", ["channels", "reminders"]:
                return ok(reminder_channel() | {"id": "n" * 24, "name": body["name"]})
            case "POST", ["channels", "reminders", "test"]:
                return ok(self.test_result)
            case "PUT", ["channels", "reminders", channel_id]:
                return ok(reminder_channel() | {"id": channel_id})
            case "GET", ["channels", "reminders", _channel_id, "runs"]:
                return ok(RUNS)
            case "POST", ["channels", "reminders", channel_id, "run"]:
                return ok(reminder_channel() | {"id": channel_id})
            case _:
                return super()._settings(method, parts, body, params)


@pytest.fixture
def fake() -> ReminderFake:
    return ReminderFake()


@pytest.fixture
def tools(fake: ReminderFake) -> EaTools:
    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    return EaTools(client, now=lambda: NOW)


async def test_reminders_are_listed_and_explained(tools: EaTools) -> None:
    listed = await tools.call("list_channels", {})
    assert listed.text.splitlines()[0] == "2 channels:"
    assert listed.text.splitlines()[2] == (
        "- PR nudge (Reminder): keeps out of your inbox, feeds 1 agent; every 1 hour, working; last "
        'delivered 1 hour ago: "Check the open pull requests."'
    )
    detail = await tools.call("get_channel", {"channel": "pr nudge"})
    assert detail.text.startswith("PR nudge is a reminder, working; it runs every 1 hour.")
    assert "It delivers to Reviewer." in detail.text
    assert "timed out 2 hours ago: The script ran over its 5 s timeout" in detail.text
    assert detail.text.endswith(f"Script:\n{SCRIPT}")
    runs = await tools.call("get_channel", {"channel": "pr nudge", "runs": True})
    assert runs.text.splitlines()[1:3] == [
        '- delivered 1 hour ago: "Check the open pull requests."',
        "  log: counted 3",
    ]


async def test_create_and_update_ask_first(tools: EaTools, fake: ReminderFake) -> None:
    args = {"name": "Standup", "script": SCRIPT, "interval_minutes": 1440, "subscribe_ea": True}
    asked, done = await confirm(tools, "create_reminder", args)
    assert "This creates the reminder Standup, running its script every 1 day and reporting to you." in (
        asked.text
    )
    assert done.ok
    nothing = await tools.call("update_channel", {"channel": "pr nudge", "active": True})
    assert nothing.text == "That changes nothing in the reminder PR nudge."
    asked, done = await confirm(
        tools, "update_channel", {"channel": "pr nudge", "active": False, "interval_minutes": 30}
    )
    assert "This changes the reminder PR nudge: it runs it every 30 minutes and pauses it." in asked.text
    assert done.text == "Updated the reminder PR nudge: it runs it every 30 minutes and pauses it."
    _, ran = await confirm(tools, "run_channel", {"channel": "pr nudge"})
    assert ran.text == 'Ran PR nudge. It delivered 1 hour ago: "Check the open pull requests.".'
    assert writes(fake) == [
        (
            "POST",
            "/api/channels/reminders",
            {"name": "Standup", "script": SCRIPT, "subscribe_ea": True, "interval_s": 86400},
        ),
        ("PUT", f"/api/channels/reminders/{REMINDER}", {"interval_s": 1800, "enabled": False}),
        ("POST", f"/api/channels/reminders/{REMINDER}/run", {}),
    ]


async def test_test_reminder_runs_drafts_and_saved_reminders(tools: EaTools, fake: ReminderFake) -> None:
    draft = await tools.call("test_channel_script", {"script": SCRIPT, "kind": "reminder"})
    assert draft.text == (
        "The test would deliver, after 1.2 seconds:\nCheck the open pull requests.\n"
        "State for the next run: {'count': 1}\nLog: counted 3"
    )
    saved = await tools.call("test_channel_script", {"channel": "pr nudge"})
    assert saved.ok
    assert fake.requests[-1].url.path == "/api/channels/reminders/test"
    fake.test_result = {
        "outcome": "timeout",
        "error": "The script ran over its 5 s timeout",
        "duration_ms": 5100,
    }
    failed = await tools.call(
        "test_channel_script",
        {"script": "export default () => { for (;;) {} }", "kind": "reminder"},
    )
    assert failed.text == "The test timed out after 5.1 seconds: The script ran over its 5 s timeout"
    assert not (await tools.call("test_channel_script", {"kind": "reminder"})).ok


async def test_webhook_tools_turn_reminders_away_and_delete_says_what_stops(tools: EaTools) -> None:
    script = await tools.call("update_channel", {"channel": "uptime", "script": SCRIPT})
    assert script.text == "Only reminders take a script, a schedule or active."
    ran = await tools.call("run_channel", {"channel": "uptime"})
    assert ran.text == "Uptime is a webhook: send it a sample with test_channel."
    result = await tools.call("test_channel", {"channel": "pr nudge"})
    assert not result.ok
    assert result.text == (
        "PR nudge is a reminder, not a webhook: use update_channel, run_channel or test_channel_script."
    )
    asked, done = await confirm(tools, "delete_channel", {"channel": "pr nudge"})
    assert "This deletes the reminder PR nudge: Seti stops running it" in asked.text
    assert done.text == "Deleted the reminder PR nudge."


async def test_create_on_a_cron_schedule_in_the_users_timezone(tools: EaTools, fake: ReminderFake) -> None:
    args = {"name": "Standup", "script": SCRIPT, "cron": "0 9 * * 1-5"}
    unknown = await tools.call("create_reminder", args)
    assert not unknown.ok
    assert unknown.summary == "No timezone"
    token = CURRENT_CLOCK.set(parse_user_clock({"timezone": "Europe/Berlin"}))
    try:
        asked, done = await confirm(tools, "create_reminder", args)
    finally:
        CURRENT_CLOCK.reset(token)
    assert "running its script every weekday at 09:00 Europe/Berlin and keeping" in asked.text
    assert done.text.startswith("Created the reminder Standup; its first run is at its next cron time.")
    _, done = await confirm(tools, "create_reminder", {**args, "name": "Late", "timezone": "Asia/Tokyo"})
    assert done.ok
    schedules = [body.get("schedule") for _, _, body in writes(fake)]
    assert schedules == [
        {"cron": "0 9 * * 1-5", "timezone": "Europe/Berlin"},
        {"cron": "0 9 * * 1-5", "timezone": "Asia/Tokyo"},
    ]
    lonely = await tools.call("create_reminder", {"name": "x", "script": SCRIPT, "timezone": "UTC"})
    assert lonely.text == "A timezone goes with a cron schedule; give one too."


async def test_update_switches_between_cron_and_interval(tools: EaTools, fake: ReminderFake) -> None:
    args = {"channel": "pr nudge", "cron": "0 10 * * 1", "timezone": "Europe/Berlin"}
    asked, _ = await confirm(tools, "update_channel", args)
    assert "it runs it every Monday at 10:00 Europe/Berlin." in asked.text
    fake.channels[-1]["reminder"]["schedule"] = {"cron": "0 9 * * 1", "timezone": "Europe/Berlin"}
    listed = await tools.call("list_channels", {})
    assert "every Monday at 09:00 Europe/Berlin, working" in listed.text.splitlines()[2]
    detail = await tools.call("get_channel", {"channel": "pr nudge"})
    assert detail.text.startswith(
        "PR nudge is a reminder, working; it runs every Monday at 09:00 Europe/Berlin."
    )
    asked, _ = await confirm(tools, "update_channel", {"channel": "pr nudge", "timezone": "Asia/Tokyo"})
    assert "it runs it every Monday at 09:00 Asia/Tokyo." in asked.text
    asked, _ = await confirm(tools, "update_channel", {"channel": "pr nudge", "interval_minutes": 30})
    assert "it keeps every 30 minutes for when its cron schedule is cleared." in asked.text
    asked, _ = await confirm(tools, "update_channel", {"channel": "pr nudge", "cron": ""})
    assert "it runs it every 1 hour." in asked.text
    assert [body for _, _, body in writes(fake)] == [
        {"schedule": {"cron": "0 10 * * 1", "timezone": "Europe/Berlin"}},
        {"schedule": {"cron": "0 9 * * 1", "timezone": "Asia/Tokyo"}},
        {"interval_s": 1800},
        {"schedule": None},
    ]
    del fake.channels[-1]["reminder"]["schedule"]
    nothing = await tools.call("update_channel", {"channel": "pr nudge", "cron": ""})
    assert nothing.text == "That changes nothing in the reminder PR nudge."
    lonely = await tools.call("update_channel", {"channel": "pr nudge", "timezone": "UTC"})
    assert lonely.text == "A timezone goes with a cron schedule; give one too."
