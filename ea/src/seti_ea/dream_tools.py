"""The EA's tool for agents' dreams: reading how they went, and starting one now."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import clip, plural
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_str, dicts, title_of

SHOWN = 3

DREAM_SPECS: list[ToolSpec] = [
    ToolSpec(
        "dreams",
        "An agent's recent dreams: Seti's sandboxed sessions that tidy the agent's memory folder and "
        "change nothing else, each with how it ended, how many memory files it changed, its cost and "
        "its report. With start, run one dream of the agent now instead. Starting needs the user's "
        "yes; undo a dream's change to a memory file with revert_change.",
        {
            "task": {"type": "string", "description": "The agent's title as the user said it."},
            "start": {"type": "boolean", "description": "true to start a dream of the agent now."},
            "confirmed": CONFIRMED,
        },
        ["task"],
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


class DreamTools:
    """The EA's dream tool, through the routes the agent's settings use."""

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
        task = await self._resolve_task(arg_str(args, "task"))
        title = title_of(task)
        if arg_bool(args, "start"):
            return await self._start(args, task, title)
        runs = dicts(await self._seti.get(f"/tasks/{task.get('id')}/dreams"))
        if not runs:
            return ToolResult(f"{title} has not dreamt yet.", "No dreams")
        lines = [f"Recent dreams of {title}, newest first:"]
        for run in runs[:SHOWN]:
            lines.extend(_run_lines(run))
        return ToolResult("\n".join(lines), clip(f"Read the dreams of {title}", 70))

    async def _start(self, args: Mapping[str, Any], task: Mapping[str, Any], title: str) -> ToolResult:
        if not await self._gate.cleared(gate_key("dreams", task.get("id")), arg_bool(args, "confirmed")):
            effect = (
                f"This starts a dream of {title} now: a sandboxed session of a few minutes that reads its "
                "day and tidies its memory folder, changes nothing else, and costs up to a dollar. Each "
                "memory change can be undone."
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
