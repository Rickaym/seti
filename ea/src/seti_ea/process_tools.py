"""Tools for an agent's background shells and processes: list them, and stop one with the user's yes."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import clip, duration, parse_time, plural, size_words
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import (
    TASK_REF,
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_str,
    dicts,
    only,
    pick,
    title_of,
)

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]
TaskResolver = Callable[[str], Awaitable[dict[str, Any]]]

SHELLS_SHOWN = 8
PROCESSES_SHOWN = 10
STOPPABLE = ("command", "tool")
ENDED_WORDS = {"completed": "finished", "failed": "failed", "killed": "was stopped"}

LIST_PROCESSES_SPEC = ToolSpec(
    "list_processes",
    "An agent's background shells (commands it left running, such as dev servers and watches) with "
    "status and how long they ran, and the other processes running for it now with CPU and memory.",
    {"task": TASK_REF},
    ["task"],
)

STOP_PROCESS_SPEC = ToolSpec(
    "stop_process",
    "Stop one of an agent's background shells or processes, and what it started; the agent is told. "
    "Not Claude Code itself: stop_task or stop_background_work do that. Needs the user's yes.",
    {
        "task": TASK_REF,
        "target": {
            "type": "string",
            "description": "The shell's description or command as the user said it, a shell id, or a pid.",
        },
        "confirmed": CONFIRMED,
    },
    ["task", "target"],
)


def _elapsed(item: Mapping[str, Any], now: datetime) -> str:
    start = parse_time(item.get("started_at"))
    end = parse_time(item.get("ended_at")) or now
    return duration((end - start).total_seconds() if start else 0.0)


def _shell_name(shell: Mapping[str, Any]) -> str:
    return clip(str(shell.get("description") or shell.get("command") or shell.get("id")), 80)


def _shell_line(shell: Mapping[str, Any], now: datetime) -> str:
    head = f"- {_shell_name(shell)} ({shell.get('tool', 'Bash')}, shell {shell.get('id')})"
    if shell.get("status") == "running":
        pid = f", pid {shell.get('pid')}" if shell.get("pid") is not None else ""
        return f"{head}: running for {_elapsed(shell, now)}{pid}"
    code = shell.get("exit_code")
    exit_text = f" with exit code {code}" if code is not None else ""
    word = ENDED_WORDS.get(str(shell.get("status")), "ended")
    return f"{head}: {word}{exit_text} after {_elapsed(shell, now)}"


def _process_line(proc: Mapping[str, Any]) -> str:
    cpu = proc.get("cpu_percent")
    cpu_text = f"{round(float(cpu))}% CPU, " if isinstance(cpu, int | float) else ""
    kind = " (tool)" if proc.get("kind") == "tool" else ""
    pid = proc.get("ns_pid") or proc.get("pid")
    return (
        f"- pid {pid}{kind}: {clip(str(proc.get('command', '')), 100)}: {cpu_text}"
        f"{size_words(proc.get('rss_bytes'))}, {duration(float(proc.get('elapsed_s') or 0))}"
    )


def processes_text(title: str, view: Mapping[str, Any], now: datetime) -> str:
    """What runs for an agent, in sentences for speech."""
    shells = dicts(view.get("shells"))
    procs = [
        p for p in dicts(view.get("processes")) if p.get("kind") in STOPPABLE and p.get("shell_id") is None
    ]
    running = [s for s in shells if s.get("status") == "running"]
    ended = sorted(
        (s for s in shells if s.get("status") != "running"),
        key=lambda s: str(s.get("started_at")),
        reverse=True,
    )
    if not shells and not procs:
        state = "" if view.get("open") else " Its Claude Code process is not open."
        return f"{title} runs no background shells or other processes.{state}"
    lines = [
        f"{title} has {plural(len(running), 'background shell')} running, "
        f"{len(shells) - len(running)} ended, and {plural(len(procs), 'other process', 'other processes')}."
    ]
    shown = [*running, *ended][:SHELLS_SHOWN]
    lines.extend(_shell_line(s, now) for s in shown)
    if len(shells) > SHELLS_SHOWN:
        lines.append(f"And {len(shells) - SHELLS_SHOWN} older shells not listed.")
    if procs:
        lines.append("Other processes:")
        lines.extend(_process_line(p) for p in procs[:PROCESSES_SHOWN])
    return "\n".join(lines)


class ProcessTools:
    """The EA's tools for an agent's processes, through the routes the Processes panel calls."""

    def __init__(
        self,
        seti: SetiClient,
        resolve_task: TaskResolver,
        confirmations: Confirmations,
        now: Callable[[], datetime],
    ) -> None:
        self._seti = seti
        self._resolve = resolve_task
        self._gate = confirmations
        self._now = now
        self.handlers: dict[str, Handler] = {
            "list_processes": self.list_processes,
            "stop_process": self.stop_process,
        }

    async def _view(self, task: Mapping[str, Any]) -> dict[str, Any]:
        view = await self._seti.get(f"/tasks/{task.get('id')}/processes")
        return view if isinstance(view, dict) else {}

    async def list_processes(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        view = await self._view(task)
        running = int(view.get("running") or 0)
        return ToolResult(
            processes_text(title, view, self._now()),
            clip(f"Listed processes of {title}: {running} running", 70),
        )

    def _target(self, view: Mapping[str, Any], ref: str) -> tuple[str, dict[str, Any]]:
        """The running shell or stoppable process ref names, by pid, shell id, description or command."""
        shells = [s for s in dicts(view.get("shells")) if s.get("status") == "running"]
        procs = [p for p in dicts(view.get("processes")) if p.get("kind") in STOPPABLE]
        if ref.strip().isdigit():
            pid = int(ref.strip())
            shell = next((s for s in shells if s.get("pid") == pid), None)
            if shell is not None:
                return "shell", shell
            found = [p for p in procs if pid in (p.get("pid"), p.get("ns_pid"))]
            hint = "Call list_processes to see the pids."
            return "process", only(found, ref, "process", lambda p: f"pid {p.get('pid')}", hint)
        found = pick(
            shells,
            ref,
            lambda s: str(s.get("id", "")),
            lambda s: str(s.get("description") or ""),
            lambda s: [str(s.get("command") or "")],
        )
        if found:
            return "shell", only(found, ref, "running shell", _shell_name, "Call list_processes to see them.")
        by_command = pick(
            procs, ref, lambda p: str(p.get("pid", "")), lambda p: str(p.get("command", "")), lambda _p: []
        )
        hint = "Call list_processes to see what runs."
        return "process", only(
            by_command, ref, "running shell or process", lambda p: f"pid {p.get('pid')}", hint
        )

    async def stop_process(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        view = await self._view(task)
        kind, target = self._target(view, arg_str(args, "target"))
        if kind == "shell":
            name = f'the background shell "{_shell_name(target)}"'
            key = gate_key("stop_process", task.get("id"), "shell", target.get("id"))
        else:
            command = clip(str(target.get("command")), 60)
            name = f"process {target.get('ns_pid') or target.get('pid')} ({command})"
            key = gate_key("stop_process", task.get("id"), target.get("pid"), target.get("start_ticks"))
        if not await self._gate.cleared(key, arg_bool(args, "confirmed")):
            effect = (
                f"This stops {name} of {title} and everything it started; the agent is told it was stopped."
            )
            return ask("stop_process", args, effect, f"stop {clip(name, 50)}")
        try:
            if kind == "shell":
                await self._seti.post(f"/tasks/{task.get('id')}/shells/{target.get('id')}/stop")
            else:
                body = {"pid": target.get("pid"), "start_ticks": target.get("start_ticks")}
                await self._seti.post(f"/tasks/{task.get('id')}/processes/stop", body)
        except SetiError as e:
            if e.status in (404, 409):
                raise ToolError(f"Could not stop {name}: {e.detail or e.title}", "Not stopped") from e
            raise
        return ToolResult(f"Stopped {name} of {title}.", clip(f"Stopped {name}", 70))
