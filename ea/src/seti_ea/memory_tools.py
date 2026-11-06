"""Tools for an agent's caps: memory and CPU on its process tree, and its compaction."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.cpu_caps import (
    CPU_ARGS,
    cpu_cap_words,
    cpu_settings_words,
    cpu_use_words,
    parse_cores,
)
from seti_ea.format import clip
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_str, dicts, title_of

AGENT_REF = {
    "type": "string",
    "description": "The agent's title as the user said it; leave out for the default of every agent.",
}
GB = {"type": "string", "description": "A size in GB, such as 6 or 1.5."}

MEMORY_SPECS: list[ToolSpec] = [
    ToolSpec(
        "get_memory_cap",
        "The memory cap every agent runs under, or one agent's cap with what it uses now: above the cap "
        "the kernel stops the agent's largest process, and the rest of the agent goes on. Also the CPU "
        "cap in cores, the cores it uses now and whether it is held at the cap, and how Claude Code "
        "compacts the conversation: on its own or only on /compact, its window and point, and the "
        "instructions every summary follows.",
        {"agent": AGENT_REF},
    ),
    ToolSpec(
        "set_memory_cap",
        "Change the default memory cap of every agent, or give one agent a cap of its own or the default "
        "back; running agents get it at once. With cpu_cores or cpu_default it changes the CPU cap "
        "instead, also at once. With auto_compact or the compact_ arguments it changes instead how "
        "Claude Code compacts the conversation, from the agent's next turn. Needs the user's yes.",
        {
            "agent": AGENT_REF,
            "cap_gb": {**GB, "description": "Above this a process of the agent is stopped."},
            "throttle_gb": {
                **GB,
                "description": "The soft cap. Advanced, only when the user asks: above this the agent "
                "is slowed down; equal to the cap means no soft cap.",
            },
            "swap_gb": {**GB, "description": "How much of the agent may be swapped out."},
            "default": {
                "type": "boolean",
                "description": "true to go back to the default: an agent takes the default cap, and the "
                "default goes back to the built-in one.",
            },
            "cpu_cores": {
                "type": "string",
                "description": "CPU: the most cores the agent may use at once, such as 3 or 1.5, from "
                "0.5 up to the machine's cores; off for no cap.",
            },
            "cpu_default": {
                "type": "boolean",
                "description": "CPU: true to go back to the default CPU cap: an agent takes the default, "
                "and the default goes back to the built-in one.",
            },
            "auto_compact": {
                "type": "boolean",
                "description": "Compaction: true compacts on its own as the context fills; false only on "
                "/compact.",
            },
            "compact_window_k": {
                "type": "integer",
                "description": "Compaction: the context size Claude Code compacts against, in thousands of "
                "tokens, 100 to 1000; 0 leaves it to Claude Code.",
            },
            "compact_at_pct": {
                "type": "integer",
                "description": "Compaction: compact earlier, at this share of the window, 10 to 95; needs a "
                "window; 0 for Claude Code's point.",
            },
            "compact_instructions": {
                "type": "string",
                "description": "Compaction: what every summary keeps, such as the files changed and open "
                "decisions; empty for none.",
            },
            "compact_default": {
                "type": "boolean",
                "description": "Compaction: true to go back to the default rule: an agent takes the default, "
                "and the default goes back to Claude Code's own.",
            },
            "confirmed": CONFIRMED,
        },
    ),
]

FIELDS = (("cap_gb", "max_mb"), ("throttle_gb", "high_mb"), ("swap_gb", "swap_max_mb"))
COMPACT_ARGS = (
    "auto_compact",
    "compact_window_k",
    "compact_at_pct",
    "compact_instructions",
    "compact_default",
)
COMPACT_DEFAULTS: dict[str, Any] = {
    "auto": True,
    "window_k": None,
    "threshold_pct": None,
    "instructions": None,
}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _mb(value: Any) -> int:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0


def mb_words(mb: int) -> str:
    """A size in MiB as Seti shows it: 512 MB, 1.5 GB, 6 GB."""
    if mb < 1024:
        return f"{mb} MB"
    return f"{round(mb / 1024, 1):g} GB"


def cap_words(cap: Mapping[str, Any]) -> str:
    """A cap for speech: its size, the swap it may use, and its soft cap if it has one."""
    high, top = _mb(cap.get("high_mb")), _mb(cap.get("max_mb"))
    soft = f", soft cap at {mb_words(high)}" if high < top else ""
    return f"{mb_words(top)}{soft}, with {mb_words(_mb(cap.get('swap_max_mb')))} swap"


def compact_words(rule: Mapping[str, Any]) -> str:
    """A compaction rule for speech: when it compacts, and what each summary keeps."""
    if rule.get("auto") is False:
        text = "only on /compact"
    else:
        window, pct = rule.get("window_k"), rule.get("threshold_pct")
        text = "on its own"
        text += f" against a {window}k token window" if window else " at the point Claude Code picks"
        text += f", at {pct}% of it" if window and pct else ""
    instructions = rule.get("instructions")
    return text + (f', keeping "{clip(str(instructions), 200)}"' if instructions else "")


def _whole(args: Mapping[str, Any], name: str) -> int | None:
    value = args.get(name)
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise ToolError(f"{name} must be a whole number.", "Bad number")
    try:
        number = int(str(value).strip())
    except ValueError as e:
        raise ToolError(f"{name} must be a whole number.", "Bad number") from e
    return number or None


def _new_rule(args: Mapping[str, Any], current: Mapping[str, Any]) -> dict[str, Any]:
    rule = {key: current.get(key) for key in COMPACT_DEFAULTS}
    if "auto_compact" in args:
        rule["auto"] = arg_bool(args, "auto_compact")
    if "compact_window_k" in args:
        rule["window_k"] = _whole(args, "compact_window_k")
    if "compact_at_pct" in args:
        rule["threshold_pct"] = _whole(args, "compact_at_pct")
    if "compact_instructions" in args:
        rule["instructions"] = str(args.get("compact_instructions") or "").strip() or None
    return rule


def _gb(args: Mapping[str, Any], name: str) -> int | None:
    value = args.get(name)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise ToolError(f"{name} must be a number of GB.", "Bad size")
    try:
        return round(float(value) * 1024)
    except ValueError as e:
        raise ToolError(f"{name} must be a number of GB.", "Bad size") from e


class MemoryTools:
    """The EA's memory cap tools, through the routes Settings and the agent settings use."""

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
            "get_memory_cap": self.get_memory_cap,
            "set_memory_cap": self.set_memory_cap,
        }

    async def _agent(self, args: Mapping[str, Any]) -> dict[str, Any] | None:
        ref = arg_str(args, "agent") if args.get("agent") else ""
        return await self._resolve_task(ref) if ref else None

    @staticmethod
    def _usage(view: Mapping[str, Any]) -> str:
        scopes = dicts(view.get("memory"))
        if not scopes:
            return " It runs no process now."
        used = sum(_mb(s.get("current_bytes")) for s in scopes)
        stopped = sum(_mb(s.get("oom_kills")) for s in scopes)
        text = f" It uses {mb_words(used // (1024 * 1024))} now."
        return text + (f" {stopped} of its processes were stopped at the cap." if stopped else "")

    async def get_memory_cap(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._agent(args)
        if task is None:
            settings = _dict(await self._seti.get("/resources/memory"))
            text = f"Every agent's memory cap is {cap_words(_dict(settings.get('cap')))}."
            if settings.get("enforced") is not True:
                text += " This machine cannot enforce it, so agents run without one."
            text += cpu_settings_words(_dict(await self._seti.get("/resources/cpu")))
            rule = _dict(_dict(await self._seti.get("/compact")).get("rule"))
            text += f" Each agent's conversation compacts {compact_words(rule)}."
            return ToolResult(text, "Read memory cap")
        name = title_of(task)
        state = _dict(await self._seti.get(f"/tasks/{task.get('id')}/memory"))
        own = "its own" if state.get("override") else "the default"
        text = f"{name} has {own} memory cap: {cap_words(_dict(state.get('effective')))}."
        view = _dict(await self._seti.get(f"/tasks/{task.get('id')}/processes"))
        text += self._usage(view)
        cpu = _dict(await self._seti.get(f"/tasks/{task.get('id')}/cpu"))
        cpu_own = "its own" if cpu.get("override") else "the default"
        text += f" It has {cpu_own} CPU cap: {cpu_cap_words(_dict(cpu.get('effective')))}."
        text += cpu_use_words(dicts(view.get("cpu")))
        compact = _dict(await self._seti.get(f"/tasks/{task.get('id')}/compact"))
        owner = "its own rule" if compact.get("override") else "the default rule"
        text += f" By {owner}, its conversation compacts {compact_words(_dict(compact.get('effective')))}."
        return ToolResult(text, f"Read memory cap of {name}")

    def _new_cap(self, args: Mapping[str, Any], current: Mapping[str, Any]) -> dict[str, int]:
        cap = {key: _mb(current.get(key)) for _arg, key in FIELDS}
        throttled = cap["high_mb"] < cap["max_mb"]
        for arg, key in FIELDS:
            value = _gb(args, arg)
            if value is not None:
                cap[key] = value
        if "cap_gb" in args and "throttle_gb" not in args:
            cap["high_mb"] = min(cap["high_mb"], cap["max_mb"]) if throttled else cap["max_mb"]
        return cap

    async def _write(self, path: str, body: Any) -> Any:
        try:
            return await self._seti.put(path, body)
        except SetiError as e:
            if e.status in (400, 404):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Not changed") from e
            raise

    async def set_memory_cap(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._agent(args)
        back = arg_bool(args, "default")
        if any(arg in args for arg in CPU_ARGS):
            others = (*COMPACT_ARGS, "default", *(arg for arg, _key in FIELDS))
            if any(arg in args for arg in others):
                raise ToolError("Change the memory cap, CPU cap and compaction one at a time.", "Two changes")
            return await self._set_cpu(task, args)
        if any(arg in args for arg in COMPACT_ARGS):
            if back or any(arg in args for arg, _key in FIELDS):
                raise ToolError("Change the memory cap and compaction one at a time.", "Two changes")
            return await self._set_compact(task, args)
        if not back and not any(arg in args for arg, _key in FIELDS):
            raise ToolError("The change needs a new cap, soft cap or swap, or default.", "Nothing to change")
        if task is None:
            settings = _dict(await self._seti.get("/resources/memory"))
            cap = _dict(settings.get("defaults")) if back else self._new_cap(args, _dict(settings.get("cap")))
            return await self._set("/resources/memory", cap, cap, "every agent's memory cap", args)
        name = title_of(task)
        state = _dict(await self._seti.get(f"/tasks/{task.get('id')}/memory"))
        if back:
            return await self._set(f"/tasks/{task.get('id')}/memory", {"cap": None}, None, name, args)
        cap = self._new_cap(args, _dict(state.get("effective")))
        return await self._set(f"/tasks/{task.get('id')}/memory", {"cap": cap}, cap, name, args)

    async def _set(
        self, path: str, body: Any, cap: Mapping[str, Any] | None, name: str, args: Mapping[str, Any]
    ) -> ToolResult:
        words = "the default cap" if cap is None else cap_words(cap)
        if not await self._gate.cleared(gate_key("set_memory_cap", path, body), arg_bool(args, "confirmed")):
            effect = f"This gives {name} {words}. Running agents get it at once."
            return ask("set_memory_cap", args, effect, f"change {name}")
        saved = _dict(await self._write(path, body))
        after = _dict(saved.get("cap") or saved.get("effective"))
        return ToolResult(f"Set {name} to {cap_words(after) if after else words}.", f"Changed {name}")

    async def _set_cpu(self, task: dict[str, Any] | None, args: Mapping[str, Any]) -> ToolResult:
        back = arg_bool(args, "cpu_default")
        cap: dict[str, Any] | None
        if task is None:
            path, name = "/resources/cpu", "every agent"
            defaults = _dict(_dict(await self._seti.get(path)).get("defaults"))
            cap = defaults if back else {"quota_percent": parse_cores(args)}
            body: Any = cap
        else:
            path, name = f"/tasks/{task.get('id')}/cpu", title_of(task)
            cap = None if back else {"quota_percent": parse_cores(args)}
            body = {"cap": cap}
        words = "the default CPU cap" if cap is None else f"a CPU cap of {cpu_cap_words(cap)}"
        if not await self._gate.cleared(gate_key("set_memory_cap", path, body), arg_bool(args, "confirmed")):
            effect = f"This gives {name} {words}. Running agents get it at once."
            return ask("set_memory_cap", args, effect, f"change the CPU cap of {name}")
        saved = _dict(await self._write(path, body))
        after = cpu_cap_words(_dict(saved.get("cap") or saved.get("effective")))
        return ToolResult(f"The CPU cap of {name} is {after} now.", f"Changed CPU cap of {name}")

    async def _set_compact(self, task: dict[str, Any] | None, args: Mapping[str, Any]) -> ToolResult:
        back = arg_bool(args, "compact_default")
        rule: dict[str, Any] | None
        if task is None:
            path, name = "/compact", "every agent"
            current = _dict(_dict(await self._seti.get(path)).get("rule"))
            rule = dict(COMPACT_DEFAULTS) if back else _new_rule(args, current)
            body: Any = rule
        else:
            path, name = f"/tasks/{task.get('id')}/compact", title_of(task)
            current = _dict(_dict(await self._seti.get(path)).get("effective"))
            rule = None if back else _new_rule(args, current)
            body = {"rule": rule}
        words = "take the default rule" if rule is None else f"compact {compact_words(rule)}"
        if not await self._gate.cleared(gate_key("set_memory_cap", path, body), arg_bool(args, "confirmed")):
            effect = f"This makes {name} {words}, from the next turn."
            return ask("set_memory_cap", args, effect, f"change how {name} compacts")
        saved = _dict(await self._write(path, body))
        after = compact_words(_dict(saved.get("rule") or saved.get("effective")))
        return ToolResult(f"From the next turn, {name} compacts {after}.", f"Changed compaction of {name}")
