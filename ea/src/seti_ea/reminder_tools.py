"""Reminder channels: scripts Seti runs on an interval or cron schedule for their subscribers."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from seti_ea.clock import CURRENT_CLOCK
from seti_ea.format import ago, and_list, clip, cron_words, plural, schedule_health, until
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_int, arg_str, dicts, name_of

MAX_MINUTES = 10080
RUNS_SHOWN = 10
SCRIPT_SHOWN = 3000
STATUS_WORDS = {
    "pending": "waiting for its first run",
    "ok": "working",
    "erroring": "failing its latest runs",
    "failing": "failing, and its subscribers were told",
    "paused": "paused",
}
SCRIPT_API = (
    "A JavaScript module Seti runs in a separate, locked-down Node process with no files, network, "
    "processes or environment, stopped after 5 seconds: export default async function remind({ now, "
    "lastRunAt, lastOutput, state }) returning a string to deliver, null or an empty string to skip "
    "this run, or { message, state } to also keep a small JSON state for the next run. now and "
    "lastRunAt are ISO times; lastOutput is the last message delivered. console.log lines show in "
    "the run log."
)

REMINDER_SCRIPT = {"type": "string", "description": SCRIPT_API}
REMINDER_INTERVAL = {
    "type": "integer",
    "description": "Reminders only: minutes between runs, 1 to 10080; default 60.",
}
REMINDER_CRON = {
    "type": "string",
    "description": "Reminders only: a 5-field cron schedule such as 0 9 * * 1-5 that replaces the "
    "interval; on a change, an empty string goes back to the interval.",
}
REMINDER_TIMEZONE = {
    "type": "string",
    "description": "Reminders only: the cron schedule's IANA timezone, such as Europe/Berlin; leave "
    "out to keep its current one or use the user's own.",
}

REMINDER_SPECS: list[ToolSpec] = [
    ToolSpec(
        "create_reminder",
        "Create a reminder: a channel whose script Seti runs on an interval or a cron schedule without "
        "a model; each message it returns reaches its subscribers like any channel event. Try the "
        "script with test_channel_script first; subscribe agents with subscribe_channel; change or "
        "pause it with update_channel. Needs the user's yes.",
        {
            "name": {"type": "string", "description": "A short name, such as Standup nudge."},
            "script": REMINDER_SCRIPT,
            "interval_minutes": REMINDER_INTERVAL,
            "cron": REMINDER_CRON,
            "timezone": REMINDER_TIMEZONE,
            "subscribe_ea": {
                "type": "boolean",
                "description": "Default false; true sends its messages to your inbox.",
            },
            "confirmed": CONFIRMED,
        },
        ["name", "script"],
    ),
]


def _reminder_of(info: Mapping[str, Any]) -> dict[str, Any]:
    reminder = info.get("reminder")
    return reminder if isinstance(reminder, dict) else {}


def _every(seconds: Any) -> str:
    minutes = int(seconds) // 60 if isinstance(seconds, int | float) else 60
    if minutes % 1440 == 0:
        return plural(minutes // 1440, "day")
    if minutes % 60 == 0:
        return plural(minutes // 60, "hour")
    return plural(minutes, "minute")


def _schedule_of(reminder: Mapping[str, Any]) -> dict[str, Any] | None:
    schedule = reminder.get("schedule")
    return schedule if isinstance(schedule, dict) else None


def _when(reminder: Mapping[str, Any]) -> str:
    """When a reminder runs: its cron schedule in words with its timezone, or its interval."""
    schedule = _schedule_of(reminder)
    if schedule is None:
        return f"every {_every(reminder.get('interval_s', 3600))}"
    return f"{cron_words(str(schedule.get('cron')))} {schedule.get('timezone')}"


def _user_zone() -> str:
    clock = CURRENT_CLOCK.get()
    if clock.known and isinstance(clock.zone, ZoneInfo):
        return clock.zone.key
    raise ToolError(
        "The cron schedule needs a timezone; ask the user for one, such as Europe/Berlin.", "No timezone"
    )


def _schedule_change(reminder: Mapping[str, Any], args: Mapping[str, Any]) -> dict[str, Any] | None:
    """The new schedule cron and timezone ask for, None to go back to the interval."""
    current = _schedule_of(reminder)
    cron = arg_str(args, "cron", required=False) if "cron" in args else str((current or {}).get("cron", ""))
    zone = arg_str(args, "timezone", required=False)
    if not cron:
        if zone and "cron" not in args:
            raise ToolError("A timezone goes with a cron schedule; give one too.", "No cron schedule")
        return None
    return {"cron": cron, "timezone": zone or str((current or {}).get("timezone") or _user_zone())}


def _run_line(run: Mapping[str, Any], now: datetime) -> str:
    when = ago(run.get("started_at"), now)
    how = " by hand" if run.get("trigger") == "manual" else ""
    outcome = run.get("outcome")
    if outcome == "ok":
        return f'delivered {when}{how}: "{clip(str(run.get("message")), 120)}"'
    if outcome == "empty":
        return f"ran {when}{how} with nothing to deliver"
    word = "timed out" if outcome == "timeout" else "failed"
    return f"{word} {when}{how}: {clip(str(run.get('error')), 160)}"


def reminder_line(info: Mapping[str, Any], now: datetime) -> str:
    """One reminder for list_channels."""
    reminder = _reminder_of(info)
    status = STATUS_WORDS.get(str(reminder.get("status")), str(reminder.get("status")))
    runs = dicts(reminder.get("runs"))
    last = f"; last {_run_line(runs[0], now)}" if runs else ""
    return f"{_when(reminder)}, {status}{last}"


def _timing_changes(reminder: Mapping[str, Any], args: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The cron schedule and interval part of a reminder change."""
    body: dict[str, Any] = {}
    if "cron" in args or "timezone" in args:
        schedule = _schedule_change(reminder, args)
        if schedule != _schedule_of(reminder):
            body["schedule"] = schedule
    if "interval_minutes" in args:
        interval = arg_int(args, "interval_minutes", 60, MAX_MINUTES) * 60
        if interval != reminder.get("interval_s"):
            body["interval_s"] = interval
    after = {**reminder, **body}
    changes: list[str] = []
    if "schedule" in body or ("interval_s" in body and _schedule_of(after) is None):
        changes.append(f"runs it {_when(after)}")
    if "interval_s" in body and _schedule_of(after) is not None:
        changes.append(f"keeps every {_every(body['interval_s'])} for when its cron schedule is cleared")
    return body, changes


def reminder_changes(info: Mapping[str, Any], args: Mapping[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The reminder-only part of update_channel: its script, when it runs and whether it runs."""
    reminder = _reminder_of(info)
    body: dict[str, Any] = {}
    changes: list[str] = []
    script = arg_str(args, "script", required=False)
    if script and script != reminder.get("script"):
        body["script"] = script
        changes.append("replaces its script")
    timing, timing_changes = _timing_changes(reminder, args)
    body |= timing
    changes += timing_changes
    if "active" in args and arg_bool(args, "active") != reminder.get("enabled"):
        body["enabled"] = arg_bool(args, "active")
        changes.append("resumes it" if body["enabled"] else "pauses it")
    return body, changes


def _test_words(result: Mapping[str, Any]) -> str:
    seconds = float(result.get("duration_ms") or 0) / 1000
    outcome = result.get("outcome")
    if outcome == "ok":
        lines = [f"The test would deliver, after {seconds:.1f} seconds:", str(result.get("message"))]
    elif outcome == "empty":
        lines = [f"The test returned nothing to deliver, after {seconds:.1f} seconds."]
    else:
        word = "timed out" if outcome == "timeout" else "failed"
        lines = [f"The test {word} after {seconds:.1f} seconds: {result.get('error')}"]
    if result.get("state") is not None:
        lines.append(f"State for the next run: {clip(str(result.get('state')), 200)}")
    logs = [str(n) for n in result.get("logs") or [] if isinstance(n, str)]
    if logs:
        lines.append(f"Log: {' | '.join(clip(line, 160) for line in logs[:10])}")
    return "\n".join(lines)


class ReminderTools:
    """The EA's reminder tool, and the reminder side of the shared channel tools."""

    def __init__(self, seti: SetiClient, confirmations: Confirmations, now: Callable[[], datetime]) -> None:
        self._seti = seti
        self._gate = confirmations
        self._now = now
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "create_reminder": self.create_reminder,
        }

    async def _cleared(self, args: Mapping[str, Any], key: str) -> bool:
        return await self._gate.cleared(key, arg_bool(args, "confirmed"))

    async def _refusable(self, job: Awaitable[Any], summary: str) -> Any:
        try:
            return await job
        except SetiError as e:
            if e.status in (400, 403, 404, 409):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", summary) from e
            raise

    def detail(self, info: Mapping[str, Any]) -> ToolResult:
        """One reminder for get_channel."""
        reminder = _reminder_of(info)
        now = self._now()
        status = STATUS_WORDS.get(str(reminder.get("status")), str(reminder.get("status")))
        next_run = (
            f" Its next run is {until(reminder.get('next_run_at'), now)}."
            if reminder.get("next_run_at")
            else ""
        )
        subs = dicts(info.get("subscriptions"))
        who = and_list(
            ["you" if s.get("target") == "ea" else str(s.get("task_title") or "an agent") for s in subs]
        )
        lines = [
            f"{name_of(info)} is a reminder, {status}; it runs {_when(reminder)}.{next_run}",
            f"It delivers to {who}."
            if subs
            else "Nobody subscribes to it: its messages stay on the channels page.",
        ]
        health = schedule_health(reminder.get("health"))
        if health:
            lines.insert(1, health)
        runs = dicts(reminder.get("runs"))[:3]
        if runs:
            lines.append(f"Latest runs: {'; '.join(_run_line(r, now) for r in runs)}.")
        lines.append(f"Script:\n{clip(str(reminder.get('script')), SCRIPT_SHOWN)}")
        return ToolResult("\n".join(lines), clip(f"Read reminder {name_of(info)}", 70))

    async def runs(self, info: Mapping[str, Any]) -> ToolResult:
        """A reminder's latest runs with their logs, for get_channel with runs."""
        path = f"/channels/reminders/{info.get('id')}/runs"
        runs = dicts(await self._seti.get(path))[:RUNS_SHOWN]
        name = name_of(info)
        if not runs:
            return ToolResult(f"{name} has not run yet.", clip(f"No runs of {name}", 70))
        now = self._now()
        lines = [f"Latest runs of {name}:"]
        for run in runs:
            lines.append(f"- {_run_line(run, now)}")
            logs = [str(line) for line in run.get("logs") or [] if isinstance(line, str)]
            if logs:
                lines.append(f"  log: {' | '.join(clip(line, 120) for line in logs[:5])}")
        return ToolResult("\n".join(lines), clip(f"Read runs of {name}", 70))

    async def create_reminder(self, args: Mapping[str, Any]) -> ToolResult:
        name = arg_str(args, "name")
        body: dict[str, Any] = {
            "name": name,
            "script": arg_str(args, "script"),
            "subscribe_ea": arg_bool(args, "subscribe_ea") if "subscribe_ea" in args else False,
        }
        if "interval_minutes" in args:
            body["interval_s"] = arg_int(args, "interval_minutes", 60, MAX_MINUTES) * 60
        schedule = _schedule_change({}, args)
        if schedule is not None:
            body["schedule"] = schedule
        if not await self._cleared(args, gate_key("create_reminder", body)):
            reach = "reporting to you" if body["subscribe_ea"] else "keeping its messages out of your inbox"
            effect = f"This creates the reminder {name}, running its script {_when(body)} and {reach}."
            return ask("create_reminder", args, effect, f"create reminder {name}")
        created = await self._refusable(self._seti.post("/channels/reminders", body), "Reminder not created")
        first = "at its next cron time" if schedule is not None else "one interval from now"
        text = (
            f"Created the reminder {name}; its first run is {first}. Subscribe agents with subscribe_channel."
        )
        return ToolResult(
            text, clip(f"Created reminder {name_of(created) if isinstance(created, dict) else name}", 70)
        )

    async def run_now(self, args: Mapping[str, Any], info: Mapping[str, Any]) -> ToolResult:
        """Runs a reminder now, for run_channel."""
        name = name_of(info)
        if not await self._cleared(args, gate_key("run_channel", info.get("id"))):
            effect = f"This runs the reminder {name} now; its message reaches its subscribers."
            return ask("run_channel", args, effect, f"run {name} now")
        after = await self._refusable(self._seti.post(f"/channels/reminders/{info.get('id')}/run"), "Not run")
        reminder = after.get("reminder") if isinstance(after, dict) else None
        runs = dicts(reminder.get("runs")) if isinstance(reminder, dict) else []
        outcome = f" It {_run_line(runs[0], self._now())}." if runs else ""
        return ToolResult(f"Ran {name}.{outcome}", clip(f"Ran {name}", 70))

    async def test(self, args: Mapping[str, Any], info: Mapping[str, Any] | None) -> ToolResult:
        """A test run of a draft or a saved reminder, for test_channel_script."""
        script = arg_str(args, "script", required=False)
        body: dict[str, Any] = {}
        label = "the draft"
        if info is not None:
            body = {"script": _reminder_of(info).get("script"), "channel_id": info.get("id")}
            label = name_of(info)
        elif not script:
            raise ToolError("Give a script to test, or a channel.", "Nothing to test")
        if script:
            body["script"] = script
        result = await self._refusable(self._seti.post("/channels/reminders/test", body), "Not tested")
        return ToolResult(
            _test_words(result if isinstance(result, dict) else {}), clip(f"Tested {label}", 70)
        )
