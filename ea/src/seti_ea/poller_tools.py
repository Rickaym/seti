"""Tools for poller channels: small scripts Seti runs on a schedule for services without webhooks."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import ago, and_list, clip, plural, schedule_health, until
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import (
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_int,
    arg_list,
    arg_str,
    dicts,
    name_of,
    only,
    pick,
)

INTERVAL_MINUTES = (1, 1440)
TIMEOUT_SECONDS = (5, 120)
ITEMS_SHOWN = 10
RUNS_SHOWN = 10
SCRIPT_SHOWN = 3000
STATUS_WORDS = {
    "pending": "waiting for its first run",
    "ok": "working",
    "erroring": "failing its latest runs",
    "failing": "failing, and its subscribers were told",
    "paused": "paused",
}
USER_ONLY = (
    "Only the user gives a poller extra hosts beyond the sandbox allowlist, or secrets to send; they "
    "do that in Settings, Channels, with Edit on the poller."
)
SCRIPT_API = (
    "A JavaScript module Seti runs in an isolated engine, with no Node, files, processes or CLIs: "
    "export default async function poll({ fetch, parseFeed, log, state, since }) returning an array of "
    "items, or { items, state } to keep a small JSON state. An item has key (required and stable), and "
    "optionally title, kind, url, body, fields (an object) and fingerprint. fetch(url, init) returns "
    "{ status, ok, headers.get(name), text(), json() } and reaches only hosts on the sandbox allowlist "
    "plus the poller's extra hosts. parseFeed(text) reads RSS or Atom into [{ id, title, link, summary, "
    "published, updated }]. log(...) keeps a line in the run log. The first run only records what is "
    "there; later runs report new keys, changed items and, with detect_gone, keys that went missing."
)

POLLER_REF = {"type": "string", "description": "The poller's name as the user said it."}
SCRIPT = {"type": "string", "description": SCRIPT_API}
INTERVAL = {"type": "integer", "description": "Minutes between runs, 1 to 1440; default 5."}
TIMEOUT = {"type": "integer", "description": "Seconds a run may take, 5 to 120; default 30."}
FINGERPRINT = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Watched fields: the ones that decide whether an item changed, such as status; "
    "empty watches the whole item.",
}
GONE = {"type": "boolean", "description": "Report items a complete run no longer returns; default off."}

POLLER_SPECS: list[ToolSpec] = [
    ToolSpec(
        "create_poller",
        "Create a poller: a channel for a service without webhooks, such as a JSON API or an RSS feed. "
        "Seti runs its script on a schedule without a model and reports what changed to its "
        "subscribers, like a webhook. Try the script with test_channel_script first. Needs the user's yes.",
        {
            "name": {"type": "string", "description": "A short name, such as Release feed."},
            "script": SCRIPT,
            "interval_minutes": INTERVAL,
            "timeout_seconds": TIMEOUT,
            "fingerprint_fields": FINGERPRINT,
            "detect_gone": GONE,
            "subscribe_ea": {
                "type": "boolean",
                "description": "Default false; true sends its events to your inbox.",
            },
            "confirmed": CONFIRMED,
        },
        ["name", "script"],
    ),
    ToolSpec(
        "update_poller",
        "Change a poller: its name, script, schedule or change detection, or pause and resume it. "
        "Needs the user's yes.",
        {
            "poller": POLLER_REF,
            "name": {"type": "string", "description": "A new name."},
            "script": {**SCRIPT, "description": f"The whole new script. {SCRIPT_API}"},
            "interval_minutes": INTERVAL,
            "timeout_seconds": TIMEOUT,
            "fingerprint_fields": FINGERPRINT,
            "detect_gone": GONE,
            "active": {"type": "boolean", "description": "false pauses it, true resumes it."},
            "confirmed": CONFIRMED,
        },
        ["poller"],
    ),
]

POLLER_WRITES = frozenset(spec.name for spec in POLLER_SPECS if "confirmed" in spec.properties)


def _poller_of(info: Mapping[str, Any]) -> dict[str, Any]:
    poller = info.get("poller")
    return poller if isinstance(poller, dict) else {}


def _every(seconds: Any) -> str:
    minutes = int(seconds) // 60 if isinstance(seconds, int | float) else 5
    if minutes % 60 == 0:
        return plural(minutes // 60, "hour")
    return plural(minutes, "minute")


def _bounded(args: Mapping[str, Any], name: str, limits: tuple[int, int], scale: int) -> int | None:
    if name not in args:
        return None
    low, high = limits
    return max(low, arg_int(args, name, low, high)) * scale


def _run_line(run: Mapping[str, Any], now: datetime) -> str:
    when = ago(run.get("started_at"), now)
    how = " by hand" if run.get("trigger") == "manual" else ""
    if run.get("ok") is not True:
        return f"failed {when}{how}: {clip(str(run.get('error')), 160)}"
    notes = [n for n in run.get("invalid") or [] if isinstance(n, str)]
    extra = f", {plural(len(notes), 'unusable item note')}" if notes else ""
    return (
        f"ran {when}{how}: {plural(int(run.get('items') or 0), 'item')}, "
        f"{plural(int(run.get('emitted') or 0), 'event')}{extra}"
    )


def poller_line(info: Mapping[str, Any], now: datetime) -> str:
    """One poller for list_channels."""
    poller = _poller_of(info)
    status = STATUS_WORDS.get(str(poller.get("status")), str(poller.get("status")))
    runs = dicts(poller.get("runs"))
    last = f"; last {_run_line(runs[0], now)}" if runs else ""
    return f"every {_every(poller.get('interval_s'))}, {status}{last}"


def _settings_words(poller: Mapping[str, Any]) -> str:
    fingerprint = poller.get("fingerprint_fields")
    parts = [
        f"runs every {_every(poller.get('interval_s'))} with a {poller.get('timeout_s')} second timeout",
        (
            f"counts an item changed when {and_list([str(f) for f in fingerprint])} change"
            if isinstance(fingerprint, list) and fingerprint
            else "counts an item changed when anything in it changes"
        ),
        "reports items that went missing"
        if poller.get("detect_gone") is True
        else "does not report gone items",
    ]
    return and_list(parts)


def _reach_words(poller: Mapping[str, Any]) -> str:
    hosts = [str(h) for h in poller.get("extra_hosts") or [] if isinstance(h, str)]
    secrets = [str(s) for s in poller.get("secrets") or [] if isinstance(s, str)]
    reach = f"It reaches the sandbox allowlist{f' plus {and_list(hosts)}' if hosts else ''}"
    sends = f" and sends the secrets {and_list(secrets)}, whose values you never see" if secrets else ""
    return f"{reach}{sends}."


def _test_words(result: Mapping[str, Any]) -> str:
    seconds = float(result.get("duration_ms") or 0) / 1000
    if result.get("ok") is not True:
        lines = [f"The test failed after {seconds:.1f} seconds: {result.get('error')}"]
    else:
        items = dicts(result.get("items"))
        lines = [f"The test returned {plural(len(items), 'item')} in {seconds:.1f} seconds."]
        lines += [
            f"- {clip(str(i.get('key')), 60)}: {clip(str(i.get('title')), 100)}"
            + (f" ({i.get('kind')})" if i.get("kind") else "")
            for i in items[:ITEMS_SHOWN]
        ]
        if len(items) > ITEMS_SHOWN:
            lines.append(f"And {len(items) - ITEMS_SHOWN} more.")
    invalid = [str(n) for n in result.get("invalid") or [] if isinstance(n, str)]
    if invalid:
        lines.append(f"Not usable: {'; '.join(invalid[:5])}.")
    logs = [str(n) for n in result.get("logs") or [] if isinstance(n, str)]
    if logs:
        lines.append(f"Log: {' | '.join(clip(line, 160) for line in logs[:10])}")
    return "\n".join(lines)


class PollerTools:
    """The EA's poller tools, each through the route the UI calls; hosts and secrets stay the user's."""

    def __init__(self, seti: SetiClient, confirmations: Confirmations, now: Callable[[], datetime]) -> None:
        self._seti = seti
        self._gate = confirmations
        self._now = now
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "create_poller": self.create_poller,
            "update_poller": self.update_poller,
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

    async def _poller(self, args: Mapping[str, Any], name: str = "poller") -> dict[str, Any]:
        ref = arg_str(args, name)
        pollers = [c for c in dicts(await self._seti.get("/channels")) if c.get("source") == "poller"]
        found = pick(pollers, ref, lambda c: str(c.get("id", "")), name_of, lambda _c: [])
        return only(found, ref, "poller", name_of, "Call list_channels to see the channels.")

    def detail(self, info: Mapping[str, Any]) -> ToolResult:
        """One poller for get_channel."""
        poller = _poller_of(info)
        now = self._now()
        status = STATUS_WORDS.get(str(poller.get("status")), str(poller.get("status")))
        next_run = (
            f" Its next run is {until(poller.get('next_run_at'), now)}." if poller.get("next_run_at") else ""
        )
        subs = dicts(info.get("subscriptions"))
        who = and_list(
            ["you" if s.get("target") == "ea" else str(s.get("task_title") or "an agent") for s in subs]
        )
        lines = [
            f"{name_of(info)} is a poller, {status}; it {_settings_words(poller)}.{next_run}",
            _reach_words(poller),
            f"It delivers to {who}."
            if subs
            else "Nobody subscribes to it: its events stay on the channels page.",
            f"It tracks {plural(int(poller.get('keys') or 0), 'item')}.",
        ]
        health = schedule_health(poller.get("health"))
        if health:
            lines.insert(1, health)
        runs = dicts(poller.get("runs"))[:3]
        if runs:
            lines.append(f"Latest runs: {'; '.join(_run_line(r, now) for r in runs)}.")
        lines.append(f"Script:\n{clip(str(poller.get('script')), SCRIPT_SHOWN)}")
        return ToolResult("\n".join(lines), clip(f"Read poller {name_of(info)}", 70))

    async def create_poller(self, args: Mapping[str, Any]) -> ToolResult:
        name = arg_str(args, "name")
        body: dict[str, Any] = {
            "name": name,
            "script": arg_str(args, "script"),
            "subscribe_ea": arg_bool(args, "subscribe_ea") if "subscribe_ea" in args else False,
            "detect_gone": arg_bool(args, "detect_gone"),
            "fingerprint_fields": arg_list(args, "fingerprint_fields"),
        }
        interval = _bounded(args, "interval_minutes", INTERVAL_MINUTES, 60)
        timeout = _bounded(args, "timeout_seconds", TIMEOUT_SECONDS, 1)
        body |= {} if interval is None else {"interval_s": interval}
        body |= {} if timeout is None else {"timeout_s": timeout}
        if not await self._cleared(args, gate_key("create_poller", body)):
            reach = "reporting to you" if body["subscribe_ea"] else "keeping its events out of your inbox"
            effect = (
                f"This creates the poller {name}, running its script every "
                f"{_every(body.get('interval_s', 300))} and {reach}. Its first run only records what "
                "is there."
            )
            return ask("create_poller", args, effect, f"create poller {name}")
        created = await self._refusable(self._seti.post("/channels/pollers", body), "Poller not created")
        text = (
            f"Created the poller {name}; its first run records what is there, and later runs report "
            f"changes. {USER_ONLY}"
        )
        return ToolResult(
            text, clip(f"Created poller {name_of(created) if isinstance(created, dict) else name}", 70)
        )

    async def update_poller(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._poller(args)
        name = name_of(info)
        body: dict[str, Any] = {}
        changes: list[str] = []
        new_name = arg_str(args, "name", required=False)
        if new_name and new_name != name:
            body["name"] = new_name
            changes.append(f"renames it to {new_name}")
        script = arg_str(args, "script", required=False)
        if script:
            body["script"] = script
            changes.append("replaces its script")
        interval = _bounded(args, "interval_minutes", INTERVAL_MINUTES, 60)
        if interval is not None:
            body["interval_s"] = interval
            changes.append(f"runs it every {_every(interval)}")
        timeout = _bounded(args, "timeout_seconds", TIMEOUT_SECONDS, 1)
        if timeout is not None:
            body["timeout_s"] = timeout
            changes.append(f"gives each run {timeout} seconds")
        if "fingerprint_fields" in args:
            body["fingerprint_fields"] = arg_list(args, "fingerprint_fields")
            changes.append("changes which fields decide a change")
        if "detect_gone" in args:
            body["detect_gone"] = arg_bool(args, "detect_gone")
            changes.append("reports gone items" if body["detect_gone"] else "stops reporting gone items")
        if "active" in args:
            body["enabled"] = arg_bool(args, "active")
            changes.append("resumes it" if body["enabled"] else "pauses it")
        if not changes:
            raise ToolError(f"That changes nothing in the poller {name}.", "Nothing to change")
        if not await self._cleared(args, gate_key("update_poller", info.get("id"), body)):
            effect = f"This changes the poller {name}: it {and_list(changes)}."
            return ask("update_poller", args, effect, f"change poller {name}")
        await self._refusable(
            self._seti.put(f"/channels/pollers/{info.get('id')}", body), "Poller not changed"
        )
        return ToolResult(
            f"Updated the poller {name}: it {and_list(changes)}.", clip(f"Updated poller {name}", 70)
        )

    async def run_now(self, args: Mapping[str, Any], info: Mapping[str, Any]) -> ToolResult:
        """Polls now, for run_channel."""
        name = name_of(info)
        if not await self._cleared(args, gate_key("run_channel", info.get("id"))):
            effect = f"This runs the poller {name} now; whatever changed reaches its subscribers."
            return ask("run_channel", args, effect, f"poll {name} now")
        after = await self._refusable(
            self._seti.post(f"/channels/pollers/{info.get('id')}/poll"), "Not polled"
        )
        poller = after.get("poller") if isinstance(after, dict) else None
        runs = dicts(poller.get("runs")) if isinstance(poller, dict) else []
        outcome = f" It {_run_line(runs[0], self._now())}." if runs else ""
        return ToolResult(f"Polled {name}.{outcome}", clip(f"Polled {name}", 70))

    async def test(self, args: Mapping[str, Any], info: Mapping[str, Any] | None) -> ToolResult:
        """A test run of a draft or a saved poller, for test_channel_script."""
        script = arg_str(args, "script", required=False)
        body: dict[str, Any] = {}
        label = "the draft"
        if info is not None:
            poller = _poller_of(info)
            keys = ("script", "timeout_s", "extra_hosts", "secrets", "fingerprint_fields")
            body = {k: poller[k] for k in keys if k in poller} | {"channel_id": info.get("id")}
            label = name_of(info)
        elif not script:
            raise ToolError("Give a script to test, or a channel.", "Nothing to test")
        if script:
            body["script"] = script
        result = await self._refusable(self._seti.post("/channels/pollers/test", body), "Not tested")
        text = _test_words(result if isinstance(result, dict) else {})
        return ToolResult(text, clip(f"Tested {label}", 70))

    async def runs(self, info: Mapping[str, Any]) -> ToolResult:
        """A poller's latest runs with their logs, for get_channel with runs."""
        path = f"/channels/pollers/{info.get('id')}/runs"
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
