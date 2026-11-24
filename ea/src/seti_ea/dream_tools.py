"""The EA's tool for dreams: Dreaming's settings, an agent's dreams, and starting one now."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import clip, plural
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_str, dicts, title_of
from seti_ea.workspace_tools import resolve_workspace, workspace_list

SHOWN = 3

SETTING_ARGS: dict[str, dict[str, Any]] = {
    "enabled": {"type": "boolean", "description": "true to turn nightly Dreaming on, false to turn it off."},
    "window_start": {"type": "string", "description": "When the window starts, 24-hour HH:MM local time."},
    "window_end": {"type": "string", "description": "When the window ends, HH:MM; no dream starts after it."},
    "zone": {"type": "string", "description": "The IANA zone the window is in, such as Europe/Istanbul."},
    "model": {
        "type": "string",
        "enum": ["claude-sonnet-5-5", "claude-haiku-5-5", "agent"],
        "description": "The model dreams run on; agent means each agent's own model.",
    },
    "dream_budget_usd": {"type": "string", "description": "Most one dream may cost in dollars, 0.1 to 10."},
    "night_budget_usd": {
        "type": "string",
        "description": "Most a night's dreams may cost in dollars, 0.5 to 100.",
    },
    "at_once": {"type": "integer", "description": "How many dreams may run at once, 1 to 3."},
    "cleanups": {
        "type": "boolean",
        "description": "true to let dreams propose clean-ups for the user to allow.",
    },
}

DREAM_SPECS: list[ToolSpec] = [
    ToolSpec(
        "dreams",
        "Dreams: Seti's sandboxed sessions that tidy an agent's memory folder and change nothing else. "
        "Without task or workspace: nightly Dreaming's settings and how last night went, or change "
        "them with the setting arguments. With task: the agent's recent dreams with their reports; "
        "with start, run one dream of it now; with dreaming, switch it in or out of nightly Dreaming. "
        "With workspace and dreaming: switch that workspace's agents together. With restore, put a "
        "trash item back. Every change needs the user's yes; undo a dream's change to a memory file "
        "with revert_change. Only the user allows a proposed clean-up, in Seti.",
        {
            "task": {"type": "string", "description": "The agent's title as the user said it."},
            "workspace": {"type": "string", "description": "A workspace's name, to switch its agents."},
            "start": {"type": "boolean", "description": "true to start a dream of the agent now."},
            "restore": {"type": "integer", "description": "A trash item's id, to put it back where it was."},
            "dreaming": {
                "type": "boolean",
                "description": "true to switch into nightly Dreaming, false out.",
            },
            **SETTING_ARGS,
            "confirmed": CONFIRMED,
        },
    ),
]


def _report_lines(report: Mapping[str, Any]) -> list[str]:
    lines = [f"  {clip(str(report.get('summary') or ''), 120)}"]
    for key, word in (
        ("tidied", "Tidied"),
        ("remembered", "Remembered"),
        ("asks", "Asks"),
        ("found", "Found"),
    ):
        items = [str(item) for item in report.get(key) or []]
        if items:
            lines.append(f"  {word}: " + "; ".join(clip(item, 120) for item in items))
    return lines


def _run_lines(run: Mapping[str, Any]) -> list[str]:
    reason = f" ({run.get('reason')})" if run.get("reason") else ""
    head = (
        f"- Night of {run.get('night')}: {run.get('state')}{reason}, "
        f"{plural(int(run.get('memory_changes') or 0), 'memory file')} changed, "
        f"${float(run.get('cost_usd') or 0):.2f}"
    )
    report = run.get("report")
    return [head, *(_report_lines(report) if isinstance(report, dict) else [])]


def _settings_line(settings: Mapping[str, Any]) -> str:
    state = "on" if settings.get("enabled") is True else "off"
    zone = settings.get("zone") or "no zone chosen yet"
    return (
        f"Nightly Dreaming is {state}: window {settings.get('window_start')} to {settings.get('window_end')} "
        f"({zone}), model {settings.get('model')}, "
        f"${float(settings.get('dream_budget_usd') or 0):.2f} a dream and "
        f"${float(settings.get('night_budget_usd') or 0):.2f} a night, {settings.get('at_once')} at once."
    )


def _night_line(night: Mapping[str, Any] | None) -> str:
    if not night:
        return "No night has been planned yet."
    runs = dicts(night.get("runs"))
    done = sum(1 for run in runs if run.get("state") in ("done", "stopped"))
    asking = sum(1 for run in runs if isinstance(run.get("report"), dict) and run["report"].get("asks"))
    return (
        f"The night of {night.get('night')} ({night.get('state')}): {plural(done, 'agent')} dreamt, "
        f"{asking} with asks, ${float(night.get('cost_usd') or 0):.2f}."
    )


def _setting(args: Mapping[str, Any], key: str) -> Any:
    """A setting argument as Seti takes it: a switch, a count or an amount in dollars."""
    value = args[key]
    try:
        if key in ("enabled", "cleanups"):
            return arg_bool(args, key)
        if key == "at_once":
            return int(value)
        return float(value) if key.endswith("_usd") else str(value).strip()
    except (TypeError, ValueError) as e:
        raise ToolError(f"{key.replace('_', ' ')} must be a number.", "Bad setting") from e


def _trash_line(trash: list[dict[str, Any]]) -> str:
    if not trash:
        return "The trash is empty."
    items = "; ".join(f"{item.get('id')}: {item.get('original_path')}" for item in trash[:5])
    return f"The trash holds {plural(len(trash), 'item')}: {items}."


def _change_word(key: str, value: Any) -> str:
    if key == "enabled":
        return f"turns it {'on' if value else 'off'}"
    if key == "cleanups":
        return f"turns clean-up proposals {'on' if value else 'off'}"
    return f"sets {key.replace('_', ' ')} to {value}"


def _change_words(change: Mapping[str, Any]) -> str:
    return ", ".join(_change_word(key, value) for key, value in change.items())


class DreamTools:
    """The EA's dream tool, through the routes Seti's own pages use."""

    def __init__(
        self,
        seti: SetiClient,
        confirmations: Confirmations,
        resolve_task: Callable[[str], Awaitable[dict[str, Any]]],
    ) -> None:
        self._seti = seti
        self._gate = confirmations
        self._resolve_task = resolve_task
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "dreams": self.dreams,
        }

    async def dreams(self, args: Mapping[str, Any]) -> ToolResult:
        if "restore" in args:
            return await self._restore(args)
        if arg_str(args, "workspace", required=False):
            return await self._workspace(args)
        if not arg_str(args, "task", required=False):
            return await self._settings(args)
        task = await self._resolve_task(arg_str(args, "task"))
        title = title_of(task)
        if "dreaming" in args:
            return await self._switch_agent(args, task, title)
        if arg_bool(args, "start"):
            return await self._start(args, task, title)
        runs = dicts(await self._seti.get(f"/tasks/{task.get('id')}/dreams"))
        if not runs:
            return ToolResult(f"{title} has not dreamt yet.", "No dreams")
        lines = [f"Recent dreams of {title}, newest first:"]
        for run in runs[:SHOWN]:
            lines.extend(_run_lines(run))
        pending = dicts(await self._seti.get("/dreams/proposals", {"task": str(task.get("id"))}))
        lines.extend(
            f"- Clean-up waiting for the user: {p.get('kind')} {p.get('target')} ({p.get('reason')})"
            for p in pending
        )
        return ToolResult("\n".join(lines), clip(f"Read the dreams of {title}", 70))

    async def _settings(self, args: Mapping[str, Any]) -> ToolResult:
        change = {key: _setting(args, key) for key in SETTING_ARGS if key in args}
        if not change:
            settings = await self._seti.get("/dreams/settings")
            night = await self._seti.get("/dreams")
            trash = dicts(await self._seti.get("/trash"))
            night_line = _night_line(night if isinstance(night, dict) else None)
            text = f"{_settings_line(settings)} {night_line} {_trash_line(trash)}"
            return ToolResult(text, "Read Dreaming")
        if not await self._gate.cleared(gate_key("dreams", "settings", change), arg_bool(args, "confirmed")):
            effect = f"This changes nightly Dreaming: {_change_words(change)}."
            return ask("dreams", args, effect, "change Dreaming")
        try:
            settings = await self._seti.put("/dreams/settings", change)
        except SetiError as e:
            if e.status in (400, 403):
                raise ToolError(f"Dreaming was not changed: {e.detail or e.title}", "Not changed") from e
            raise
        return ToolResult(_settings_line(settings), "Changed Dreaming")

    async def _switch_agent(self, args: Mapping[str, Any], task: Mapping[str, Any], title: str) -> ToolResult:
        on = arg_bool(args, "dreaming")
        if not await self._gate.cleared(gate_key("dreams", task.get("id"), on), arg_bool(args, "confirmed")):
            effect = f"This switches {title} {'into' if on else 'out of'} nightly Dreaming."
            return ask("dreams", args, effect, f"switch Dreaming for {title}")
        await self._seti.put(f"/tasks/{task.get('id')}/dreaming", {"on": on})
        return ToolResult(
            f"Switched nightly Dreaming {'on' if on else 'off'} for {title}.",
            clip(f"Dreaming for {title}", 70),
        )

    async def _workspace(self, args: Mapping[str, Any]) -> ToolResult:
        workspace = resolve_workspace(await workspace_list(self._seti), arg_str(args, "workspace"))
        name = str(workspace.get("name"))
        if "dreaming" not in args:
            raise ToolError(
                "Say whether to switch the workspace's agents in or out with dreaming.", "Missing dreaming"
            )
        on = arg_bool(args, "dreaming")
        if not await self._gate.cleared(
            gate_key("dreams", workspace.get("id"), on), arg_bool(args, "confirmed")
        ):
            way = "into" if on else "out of"
            effect = f"This switches every agent in the {name} workspace {way} nightly Dreaming."
            return ask("dreams", args, effect, f"switch Dreaming for {name}")
        await self._seti.put(f"/workspaces/{workspace.get('id')}/dreaming", {"on": on})
        return ToolResult(
            f"Switched nightly Dreaming {'on' if on else 'off'} for the {name} workspace.", "Switched"
        )

    async def _start(self, args: Mapping[str, Any], task: Mapping[str, Any], title: str) -> ToolResult:
        if not await self._gate.cleared(gate_key("dreams", task.get("id")), arg_bool(args, "confirmed")):
            effect = (
                f"This starts a dream of {title} now: a sandboxed session of a few minutes that reads its "
                "day and tidies its memory folder, changes nothing else, and costs at most a dream's "
                "budget. Each memory change can be undone."
            )
            return ask("dreams", args, effect, f"start a dream of {title}")
        try:
            await self._seti.post(f"/tasks/{task.get('id')}/dream", {})
        except SetiError as e:
            if e.status == 409:
                raise ToolError(f"{title} cannot dream now: {e.detail or e.title}", "Not started") from e
            raise
        return ToolResult(
            f"Started a dream of {title}; its report comes when it ends.", clip(f"Dreaming {title}", 70)
        )

    async def _restore(self, args: Mapping[str, Any]) -> ToolResult:
        item = args.get("restore")
        if not isinstance(item, int) or isinstance(item, bool):
            raise ToolError("Say which trash item to restore by its id.", "Missing restore")
        if not await self._gate.cleared(gate_key("dreams", "restore", item), arg_bool(args, "confirmed")):
            return ask(
                "dreams", args, f"This puts trash item {item} back where it was.", "restore from the trash"
            )
        try:
            restored = await self._seti.post(f"/trash/{item}/restore", {})
        except SetiError as e:
            if e.status in (404, 409):
                raise ToolError(f"Not restored: {e.detail or e.title}", "Not restored") from e
            raise
        return ToolResult(f"Restored {restored.get('original_path')}.", "Restored")
