"""A mod's settings as the EA reads and changes them, checked against the fields its manifest declares."""

import json
from collections.abc import Mapping
from typing import Any, cast

from seti_ea.format import and_list
from seti_ea.toolkit import ToolError, dicts


def _fields(mod: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(s.get("key")): s for s in dicts(mod.get("settings"))}


def _value_text(value: Any) -> str:
    return json.dumps(value)


def settings_line(mod: Mapping[str, Any]) -> str | None:
    """The mod's settings with the values in force, as seti_overview lists them; None for none."""
    shown = [
        f"{key} ({setting.get('field', {}).get('title')}) = {_value_text(setting.get('value'))}"
        for key, setting in _fields(mod).items()
    ]
    return f"  Settings: {', '.join(shown)}." if shown else None


def _settings_arg(given: Any) -> dict[str, Any]:
    if isinstance(given, str):
        try:
            given = json.loads(given)
        except json.JSONDecodeError as e:
            raise ToolError(f"The settings are not JSON: {e.msg}.", "Settings not JSON") from e
    if not isinstance(given, Mapping) or not given:
        raise ToolError(
            "The settings are a JSON object of the values to set, by key.", "Settings not an object"
        )
    return {str(k): v for k, v in cast(Mapping[Any, Any], given).items()}


def _problem(field: Mapping[str, Any], value: Any) -> str | None:
    kind = field.get("type")
    if kind == "boolean":
        return None if isinstance(value, bool) else "true or false"
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, int | float):
            return "a number"
        low, high = field.get("min"), field.get("max")
        if (low is not None and value < low) or (high is not None and value > high):
            return (
                f"a number from {low if low is not None else 'any'} to {high if high is not None else 'any'}"
            )
        return None
    options = field.get("options")
    if not isinstance(value, str):
        return "text"
    if options and value not in options:
        return f"one of {and_list([str(o) for o in options])}"
    return None


def settings_change(mod: Mapping[str, Any], given: Any) -> dict[str, Any]:
    """The settings to save that differ from the values in force, each checked against its field."""
    fields = _fields(mod)
    wanted = _settings_arg(given)
    name = str(mod.get("name"))
    for key, value in wanted.items():
        setting = fields.get(key)
        if setting is None:
            offered = and_list(list(fields)) or "no settings"
            raise ToolError(f"The {name} mod has no setting {key}; it has {offered}.", "No such setting")
        problem = _problem(setting.get("field") or {}, value)
        if problem is not None:
            raise ToolError(f"The {name} setting {key} takes {problem}.", "Setting value refused")
    return {k: v for k, v in wanted.items() if fields[k].get("value") != v}


def change_text(mod: Mapping[str, Any], change: Mapping[str, Any]) -> str:
    """The settings being set, by title, such as PDF to false and Mermaid to true."""
    fields = _fields(mod)
    titles = [
        f"{(fields[k].get('field') or {}).get('title', k)} to {_value_text(v)}" for k, v in change.items()
    ]
    return and_list(titles)
