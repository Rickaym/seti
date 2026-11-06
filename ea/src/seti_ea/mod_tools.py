"""Seti's mods and themes: listing them for seti_overview, turning them on or off, running their actions."""

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, cast

from seti_ea.format import and_list, clip
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.mod_settings import change_text, settings_change, settings_line
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_str, dicts, only, pick

RUN_MOD_ACTION = "run_mod_action"


def mod_output(mod_id: str, text: str) -> str:
    """A mod's answer wrapped as data from the mod, so it never reads as Seti or the user."""
    contained = text.replace("<", "&lt;")
    return f'<mod_output mod="{mod_id}">\n{contained}\n</mod_output>'


def mod_words(text: object) -> str:
    """Text a mod wrote, on one line and quoted, so it reads as the mod's and never as Seti's."""
    flat = " ".join(str(text).split()).replace('"', "'")
    return f'"{clip(flat, 300)}"'


OPTION = {"type": "string", "description": "An option the theme offers; left out keeps the user's."}

MOD_SPECS: list[ToolSpec] = [
    ToolSpec(
        "set_mod_enabled",
        "Turn one of Seti's mods on or off or change its settings, or pick Seti's theme for every "
        "device; seti_overview with mods lists them with their settings. Only ordinary bundled and "
        "theme mods: third-party and security-sensitive ones are the user's alone, as is safe mode, "
        "and required ones stay on. "
        "Turning a mod on or off or changing its settings needs the user's yes; picking a theme "
        "does not, and it must come from a mod that is on.",
        {
            "mod": {
                "type": "string",
                "description": "The mod's name or id; give enabled or settings with it.",
            },
            "enabled": {"type": "boolean", "description": "true to turn it on, false to turn it off."},
            "settings": {
                "type": "string",
                "description": 'Settings to change as a JSON object by key, such as {"pdf": false}.',
            },
            "theme": {"type": "string", "description": "The theme's title or id, such as Default."},
            "flavour": {**OPTION, "description": f"A dark flavour. {OPTION['description']}"},
            "accent": {**OPTION, "description": f"An accent colour. {OPTION['description']}"},
            "confirmed": CONFIRMED,
        },
        [],
    ),
    ToolSpec(
        RUN_MOD_ACTION,
        "Run an action a mod adds to Seti. The Mod actions part of your prompt lists the actions of "
        "the mods that are on, with their args, and seti_overview with mods lists them too. An "
        "action that changes something needs the user's yes first, as your own tools do.",
        {
            "mod": {"type": "string", "description": "The mod's id or name, such as sample."},
            "action": {"type": "string", "description": "The action's id, such as count."},
            "args": {
                "type": "string",
                "description": "The action's args as a JSON object, such as "
                '{"task": "Docs agent", "note": "hi"}; give task as the agent\'s title or id.',
            },
            "confirmed": CONFIRMED,
        },
        ["mod", "action"],
    ),
]

ACTION_SLACK_SECS = 5.0

THEME_ARGS = ("theme", "flavour", "accent")
DEFAULT_THEME = {"id": "default", "title": "Default", "mod": None, "on": True, "flavours": [], "accents": []}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _options(choice: Any) -> list[str]:
    return [str(o.get("id")) for o in dicts(_dict(choice).get("options"))]


def themes_of(listing: Any) -> list[dict[str, Any]]:
    """Seti's own theme and each one a mod adds, with whether that mod is on and its options."""
    found = [DEFAULT_THEME]
    for mod in dicts(_dict(listing).get("mods")):
        contributes = _dict(_dict(mod.get("manifest")).get("contributes"))
        for theme in dicts(contributes.get("themes")):
            found.append(
                {
                    "id": f"{mod.get('id')}.{theme.get('id')}",
                    "title": str(theme.get("title")),
                    "mod": str(mod.get("name")),
                    "on": mod.get("running") is True,
                    "flavours": _options(theme.get("flavours")),
                    "accents": _options(theme.get("accents")),
                }
            )
    return found


def _theme_line(theme: Mapping[str, Any]) -> str:
    source = f" from the {theme['mod']} mod ({'on' if theme['on'] else 'off'})" if theme["mod"] else ""
    extra = [f"{what}: {', '.join(theme[what])}" for what in ("flavours", "accents") if theme[what]]
    return f"- {theme['title']}{source}" + (f"; {'; '.join(extra)}" if extra else "")


def themes_text(listing: Any, user: Any) -> str:
    """The theme every device shows and the themes on offer, for seti_overview with mods."""
    themes = themes_of(listing)
    chosen = _dict(_dict(user).get("theme"))
    shown = next((t for t in themes if t["id"] == chosen.get("id")), DEFAULT_THEME)
    options = ", ".join(f"{k} {chosen[k]}" for k in ("flavour", "accent") if chosen.get(k))
    head = f"The theme is {shown['title']}" + (f" ({options})." if options else ".")
    return "\n".join([head, "Themes:", *map(_theme_line, themes)])


def _state(mod: Mapping[str, Any]) -> str:
    if mod.get("problem"):
        return f"cannot run: {mod.get('problem')}"
    if mod.get("held_by_safe_mode") is True:
        return "off while safe mode is on"
    return "on" if mod.get("enabled") is True else "off"


def _action_args(given: Any) -> dict[str, Any]:
    """The args of run_mod_action, given as a JSON object or as its text."""
    if given is None or given == "":
        return {}
    if isinstance(given, str):
        try:
            given = json.loads(given)
        except json.JSONDecodeError as e:
            raise ToolError(f"The args are not JSON: {e.msg}.", "Args not JSON") from e
    if not isinstance(given, Mapping):
        raise ToolError("The args are a JSON object of the action's args by name.", "Args not an object")
    return {str(k): v for k, v in cast(Mapping[Any, Any], given).items()}


def ea_actions(mod: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The actions the mod offers the EA, from its manifest; none while it is off."""
    if mod.get("running") is not True:
        return []
    contributes = _dict(_dict(mod.get("manifest")).get("contributes"))
    return [c for c in dicts(contributes.get("commands")) if "ea" in (c.get("for") or [])]


def _arg_text(name: str, arg: Mapping[str, Any]) -> str:
    optional = ", optional" if arg.get("optional") is True else ""
    return f"{name} ({arg.get('type')}{optional})"


def action_line(mod: Mapping[str, Any], action: Mapping[str, Any]) -> str:
    """One action as seti_overview lists it, with its args and whether it asks first."""
    args = [_arg_text(str(k), _dict(v)) for k, v in _dict(action.get("args")).items()]
    takes = f" Args: {', '.join(args)}." if args else ""
    asks = " Needs the user's yes." if action.get("changes", True) is not False else ""
    title = mod_words(action.get("title")) if mod.get("tier") == "third-party" else action.get("title")
    return f"  - {mod.get('id')} {action.get('id')}: {title}.{takes}{asks}"


def sentences(items: list[str]) -> str:
    """Seti's capability lines as one run of sentences, each ending in a full stop."""
    return " ".join(item if item.endswith(".") else f"{item}." for item in items)


def _install(mod: Mapping[str, Any]) -> str:
    install = _dict(mod.get("install"))
    if not install:
        return ""
    dev = " as a dev mod" if install.get("source_kind") == "dev" else ""
    parts = [f" Installed from {install.get('source')}{dev}."]
    pending = _dict(install.get("pending"))
    if pending:
        waits = "the user's consent" if pending.get("reason") == "consent" else "its update delay"
        parts.append(f" Version {pending.get('version')} waits for {waits}.")
    if install.get("last_error"):
        parts.append(f" Its last error, in its log: {mod_words(install.get('last_error'))}")
    return "".join(parts)


def mod_line(mod: Mapping[str, Any]) -> str:
    """One mod as the EA reports it: state, what it may do, how it was installed, its actions."""
    capabilities = [str(c) for c in mod.get("capabilities") or []]
    may = f" It may: {sentences(capabilities)}" if capabilities else ""
    owner = ""
    if mod.get("required") is True:
        owner = " Part of Seti and always on: no one turns it off, though its settings change."
    elif mod.get("security_sensitive") is True:
        owner = " Only the user turns it on or off."
    name, shown = str(mod.get("name")), str(mod.get("display_name") or mod.get("name"))
    title = name if shown == name else f"{shown} ({name})"
    said = mod.get("description")
    if mod.get("tier") == "third-party":
        title = mod_words(title)
        said = f"a third-party mod that says {mod_words(said)}."
    head = f"- {title} {mod.get('version')} ({_state(mod)}): {said}"
    line = f"{head}{may}{owner}{_install(mod)}"
    settings = settings_line(mod)
    actions = [action_line(mod, action) for action in ea_actions(mod)]
    return "\n".join([line, *([settings] if settings else []), *actions])


def mods_text(listing: Any) -> str:
    """The mods Seti has and whether safe mode is on, for seti_overview with mods."""
    data = listing if isinstance(listing, dict) else {}
    mods = dicts(data.get("mods"))
    safe = "Safe mode is on: every third-party mod is off." if data.get("safe_mode") is True else ""
    if not mods:
        return " ".join(part for part in ["Seti has no mods.", safe] if part)
    lines = [f"Seti has {len(mods)} mod{'s' if len(mods) != 1 else ''}:", *map(mod_line, mods)]
    return "\n".join([*lines, safe] if safe else lines)


def _effect(mod: Mapping[str, Any], enabled: bool | None, change: Mapping[str, Any]) -> tuple[str, str]:
    """What turning the mod on or off and saving the settings does, and the question's short form."""
    name = str(mod.get("name"))
    parts, what = [], []
    if enabled is not None:
        state = "on" if enabled else "off"
        parts.append(f"This turns the {name} mod {state} for everyone using Seti, at once.")
        if enabled and mod.get("capabilities"):
            parts.append(f"Once on it may: {sentences([str(c) for c in mod.get('capabilities') or []])}")
        what.append(f"turn the {name} mod {state}")
    if change:
        parts.append(
            f"This sets {change_text(mod, change)} in the {name} mod for everyone using Seti, at once."
        )
        what.append(f"set {change_text(mod, change)} in {name}")
    return " ".join(parts), " and ".join(what)


class ModTools:
    """The EA's mod tools, through the routes Settings, Mods uses."""

    def __init__(self, seti: SetiClient, confirmations: Confirmations) -> None:
        self._seti = seti
        self._gate = confirmations
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "set_mod_enabled": self.set_mod_enabled,
            RUN_MOD_ACTION: self.run_mod_action,
        }

    async def _mod(self, ref: str) -> dict[str, Any]:
        listing = await self._seti.get("/mods")
        mods = dicts(listing.get("mods") if isinstance(listing, dict) else None)
        found = pick(
            mods, ref, lambda m: str(m.get("id", "")), lambda m: str(m.get("name", "")), lambda _m: []
        )
        return only(
            found, ref, "mod", lambda m: str(m.get("name")), "Call seti_overview with mods to see them."
        )

    async def set_mod_enabled(self, args: Mapping[str, Any]) -> ToolResult:
        picking = any(args.get(name) for name in THEME_ARGS)
        toggling = "mod" in args or "enabled" in args or "settings" in args
        if not picking and not toggling:
            raise ToolError(
                "The mod or theme argument is missing: give a mod with enabled or settings, or a "
                "theme, flavour or accent.",
                "Missing mod or theme",
            )
        done: list[ToolResult] = []
        if toggling:
            result = await self._change(args)
            if result.asked is not None:
                return result
            done.append(result)
        if picking:
            done.append(await self._pick_theme(args))
        return ToolResult(" ".join(r.text for r in done), "; ".join(r.summary for r in done))

    async def _change(self, args: Mapping[str, Any]) -> ToolResult:
        mod = await self._mod(arg_str(args, "mod"))
        name = str(mod.get("name"))
        if "enabled" not in args and "settings" not in args:
            raise ToolError("The enabled or settings argument is missing.", "Missing enabled")
        change = settings_change(mod, args.get("settings")) if "settings" in args else {}
        enabled = arg_bool(args, "enabled") if "enabled" in args else None
        state = "on" if (mod.get("enabled") is True if enabled is None else enabled) else "off"
        if enabled is False and mod.get("required") is True:
            raise ToolError(
                f"The {name} mod is part of Seti and always on, so no one turns it off; "
                "its settings still change.",
                "Mod is always on",
            )
        if enabled == (mod.get("enabled") is True):
            enabled = None
        if enabled is None and not change:
            same = " with those settings" if "settings" in args else ""
            return ToolResult(
                f"The {name} mod is already {state}{same}.", f"{clip(name, 50)} already {state}"
            )
        if mod.get("security_sensitive") is True or mod.get("tier") == "third-party":
            doing = f"turns the {name} mod {state}" if enabled is not None else f"changes the {name} mod"
            raise ToolError(f"Only the user {doing}, in Settings, Mods.", "Mod is the user's")
        key = gate_key("set_mod_enabled", mod.get("id"), enabled, *([change] if change else []))
        if not await self._gate.cleared(key, arg_bool(args, "confirmed")):
            return ask("set_mod_enabled", args, *_effect(mod, enabled, change))
        body: dict[str, Any] = {"settings": change} if change else {}
        if enabled is not None:
            body["enabled"] = enabled
        try:
            await self._seti.patch(f"/mods/{mod.get('id')}", body)
        except SetiError as e:
            if e.status in (400, 403, 409):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Mod not changed") from e
            raise
        done = [f"Turned the {name} mod {state}."] if enabled is not None else []
        if change:
            done.append(f"Set {change_text(mod, change)} in the {name} mod.")
        summary = f"Turned mod {name} {state}" if enabled is not None else f"Changed mod {name} settings"
        return ToolResult(" ".join(done), clip(summary, 70))

    async def _pick_theme(self, args: Mapping[str, Any]) -> ToolResult:
        listing, user = await self._seti.get("/mods"), await self._seti.get("/user")
        chosen = _dict(_dict(user).get("theme"))
        ref = arg_str(args, "theme", required=False) or str(chosen.get("id") or "default")
        theme = only(
            pick(themes_of(listing), ref, lambda t: str(t["id"]), lambda t: str(t["title"]), lambda _t: []),
            ref,
            "theme",
            lambda t: str(t["title"]),
            "Call seti_overview with mods to see them.",
        )
        title = str(theme["title"])
        if not theme["on"]:
            raise ToolError(
                f"The {title} theme comes from the {theme['mod']} mod, which is off. Turn it on first "
                "with set_mod_enabled, after the user's yes.",
                "Theme's mod is off",
            )
        picked = {"id": theme["id"]}
        for what, plural in (("flavour", "flavours"), ("accent", "accents")):
            value = arg_str(args, what, required=False).strip().lower()
            offered = theme[plural]
            if value and offered and value not in offered:
                raise ToolError(
                    f"The {title} theme has no {what} {value}; it offers {and_list(offered)}.",
                    f"No {what} {clip(value, 30)}",
                )
            picked[what] = value or chosen.get(what)
        try:
            await self._seti.put("/user", {"theme": picked})
        except SetiError as e:
            if e.status in (400, 403, 409):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Theme not changed") from e
            raise
        return ToolResult(f"Seti shows the {title} theme on every device.", clip(f"Theme set to {title}", 70))

    async def run_mod_action(self, args: Mapping[str, Any]) -> ToolResult:
        mod = await self._mod(arg_str(args, "mod"))
        name, wanted = str(mod.get("name")), arg_str(args, "action").strip().lower()
        offered = ea_actions(mod)
        action = next((a for a in offered if str(a.get("id")) == wanted), None)
        if action is None:
            ids = and_list([str(a.get("id")) for a in offered]) or "no actions"
            state = "" if mod.get("running") is True else f" The {name} mod is off."
            raise ToolError(
                f"{name} offers you no action {wanted}; it offers {ids}.{state}", "No such action"
            )
        action_args = _action_args(args.get("args"))
        title = str(action.get("title"))
        if action.get("changes", True) is not False and not await self._gate.cleared(
            gate_key(RUN_MOD_ACTION, mod.get("id"), wanted, action_args), arg_bool(args, "confirmed")
        ):
            effect = f"This runs {title} of the {name} mod" + (
                f" with {', '.join(f'{k} {v}' for k, v in action_args.items())}." if action_args else "."
            )
            return ask(RUN_MOD_ACTION, args, effect, f"run {title} of {name}")
        wait = float(action.get("timeoutSeconds") or 30) + ACTION_SLACK_SECS
        try:
            data = await self._seti.post(
                f"/mods/{mod.get('id')}/actions/{wanted}", {"args": action_args}, timeout_secs=wait
            )
        except SetiError as e:
            if e.status in (400, 403, 404, 409, 504):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Action not run") from e
            raise
        text = str(_dict(data).get("text") or "Done.")
        return ToolResult(mod_output(str(mod.get("id")), text), clip(f"Ran {title} of {name}", 70))
