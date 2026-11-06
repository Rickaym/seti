"""Words and arguments for an agent's CPU cap, which get_memory_cap and set_memory_cap carry."""

from collections.abc import Mapping
from typing import Any

from seti_ea.toolkit import ToolError

CPU_ARGS = ("cpu_cores", "cpu_default")
OFF_WORDS = {"off", "none", "no", "0"}


def _percent(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return int(value)


def cores_words(percent: int) -> str:
    """Percent of one core as Seti shows it: 3 cores, 1.5 cores, 1 core."""
    cores = round(percent / 100, 2)
    return f"{cores:g} {'core' if cores == 1 else 'cores'}"


def cpu_cap_words(cap: Mapping[str, Any]) -> str:
    """A CPU cap for speech: its cores, or that it has none."""
    quota = _percent(cap.get("quota_percent"))
    return "no CPU cap" if quota is None else cores_words(quota)


def cpu_settings_words(settings: Mapping[str, Any]) -> str:
    """Every agent's CPU cap against the machine's cores, and whether the machine enforces it."""
    cap = settings.get("cap")
    quota = _percent(cap.get("quota_percent")) if isinstance(cap, dict) else None
    machine = cores_words(_percent(settings.get("max_percent")) or 0)
    if quota is None:
        text = f" Agents have no CPU cap and may use all {machine} of this machine."
    else:
        text = f" Every agent's CPU cap is {cores_words(quota)} of this machine's {machine}."
    if settings.get("enforced") is not True:
        text += " This machine cannot enforce a CPU cap."
    return text


def cpu_use_words(scopes: list[dict[str, Any]]) -> str:
    """What an agent's scopes use of the CPU now, and whether the kernel holds them at the cap."""
    if not scopes:
        return ""
    used = sum(float(s.get("usage_percent") or 0) for s in scopes)
    text = f" It uses {round(used / 100, 1):g} cores now"
    held = any(s.get("throttled_now") is True for s in scopes)
    return text + (", held at its CPU cap so it runs slower." if held else ".")


def parse_cores(args: Mapping[str, Any]) -> int | None:
    """The cap cpu_cores asks for in percent of one core; None turns the cap off."""
    value = args.get("cpu_cores")
    if isinstance(value, str) and value.strip().lower() in OFF_WORDS:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float | str):
        raise ToolError("cpu_cores must be a number of cores, or off.", "Bad cores")
    try:
        cores = float(value)
    except ValueError as e:
        raise ToolError("cpu_cores must be a number of cores, or off.", "Bad cores") from e
    return None if cores == 0 else round(cores * 100)
