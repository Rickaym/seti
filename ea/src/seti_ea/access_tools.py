"""Tools for what agents reach: defaults, one agent's access and overrides, and its credentials."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from urllib.parse import quote

from seti_ea.format import and_list, clip, plural
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import (
    TASK_REF,
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_list,
    arg_str,
    dicts,
    name_of,
    only,
    pick,
    title_of,
)

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]
TaskResolver = Callable[[str], Awaitable[dict[str, Any]]]

ITEM_LIST = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Names of MCP servers, context packs or Seti plugins, as agent_access shows them.",
}

# Security settings: Seti refuses the EA any change to them, for one agent or by default.
SECURITY_KINDS = frozenset({"ssh", "aws"})
KIND_WORDS = {
    "ssh": "SSH hosts",
    "aws": "AWS",
    "mcp": "MCP servers",
    "pack": "context packs",
    "plugin": "Seti plugins",
}
# What the access summary adds by Seti control level; Self, the default, needs no word.
SETI_CONTROL_NOTES = {
    "full": " It has Full Seti control, which only the user grants.",
    "off": " Its Seti control is off, so it has no seti tools beyond its status line and file handoffs.",
}
USER_ONLY = (
    "Only the user gives an agent SSH hosts or AWS, or changes their defaults: in the agent's "
    "details under Access, or in Settings under Credentials. You cannot."
)
SSH_USER_ONLY = (
    "Only the user adds or changes SSH hosts, keys, trusted host keys and the credentials that "
    "bundle hosts, in Settings under SSH and Credentials. You cannot."
)

SSH_HOSTS_SPEC = ToolSpec(
    "ssh_hosts",
    "List the SSH hosts agents may reach: where each is, its jump host, the user and key name it "
    "logs in with, whether it is on by default, and which credentials bundle it for their "
    "agents. Never key material. Read only: " + SSH_USER_ONLY,
)

AGENT_ACCESS_SPEC = ToolSpec(
    "agent_access",
    "Say what one agent may reach: its SSH hosts, AWS and its role, MCP servers, context packs, Seti "
    "plugins and credentials, each marked as the default for every agent, the agent's own choice "
    "or from its credential, and whether it has Seti control.",
    {"task": TASK_REF},
    ["task"],
)

ACCESS_SPECS: list[ToolSpec] = [
    ToolSpec(
        "set_mcp_default",
        "Turn an MCP server on or off by default: every agent without its own choice loads it or "
        "leaves it out from its next turn. Needs the user's yes.",
        {
            "server": {"type": "string", "description": "The MCP server's name."},
            "enabled": {"type": "boolean", "description": "true for on by default, false for off."},
            "confirmed": CONFIRMED,
        },
        ["server", "enabled"],
    ),
    ToolSpec(
        "set_agent_access",
        "Turn MCP servers, context packs or Seti plugins on or off for one agent, or back to their "
        "default, from its next turn. SSH hosts and AWS are the user's alone. Call agent_access first "
        "to see what the agent has. Needs the user's yes.",
        {
            "task": TASK_REF,
            "kind": {
                "type": "string",
                "enum": ["mcp", "pack", "plugin"],
                "description": "mcp for MCP servers, pack for context packs, plugin for Seti plugins.",
            },
            "enable": {**ITEM_LIST, "description": "Items to turn on for this agent."},
            "disable": {**ITEM_LIST, "description": "Items to turn off for this agent."},
            "reset": {**ITEM_LIST, "description": "Items to put back on their default for this agent."},
            "confirmed": CONFIRMED,
        },
        ["task", "kind"],
    ),
    ToolSpec(
        "set_agent_profile",
        "Give an agent other credentials: the named bundle whose GitHub tokens, AWS role and connections its "
        "sandbox proxy adds, from its next turn. Without a name it only says which set the agent has "
        "and which exist. You cannot see or change what a credential holds. Changes need the user's yes.",
        {
            "task": TASK_REF,
            "profile": {"type": "string", "description": "The credentials' name, such as Default."},
            "confirmed": CONFIRMED,
        },
        ["task"],
    ),
]


def _refused(e: SetiError, what: str) -> ToolError:
    return ToolError(
        f"Seti did not {what}: {e.detail or e.title}", clip(f"Not done: {e.detail or e.title}", 70)
    )


def _match(servers: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    found = pick(servers, ref, name_of, name_of, lambda _s: [])
    return only(found, ref, "MCP server", name_of, "Call list_mcp_servers to see them.")


def _item_id(item: Mapping[str, Any]) -> str:
    return str(item.get("id", ""))


def _pick_item(items: list[dict[str, Any]], ref: str, kind: str) -> dict[str, Any]:
    found = pick(items, ref, _item_id, name_of, lambda _i: [])
    return only(found, ref, KIND_WORDS[kind].removesuffix("s"), name_of, "Call agent_access to see them.")


def _local_note(item: Mapping[str, Any]) -> str | None:
    """Where a local MCP server of another directory comes from, as Seti words it."""
    detail = str(item.get("detail") or "")
    if item.get("kind") != "mcp" or not detail.startswith("From "):
        return None
    return detail[0].lower() + detail[1:]


def _named(item: Mapping[str, Any], profile: str) -> str:
    notes = ["its own choice"] if item.get("override") is not None else []
    if item.get("in_set") is True:
        notes = [f"from {profile}"]
    if (local := _local_note(item)) is not None:
        notes.append(local)
    missing = [str(m) for m in item.get("missing_key") or []]
    if item.get("enabled") is True and missing:
        where = "" if missing[0] == item.get("id") else f" for its jump host {missing[0]}"
        notes.append(f"no key{where}, so it cannot connect")
    return f"{name_of(item)} ({'; '.join(notes)})" if notes else name_of(item)


def _group_line(kind: str, items: list[dict[str, Any]], profile: str) -> str | None:
    rows = [i for i in items if i.get("kind") == kind]
    if not rows:
        return None
    if kind == "aws":
        row = rows[0]
        notes = [str(row["detail"])] if row.get("detail") else []
        if row.get("override") is not None:
            notes.append("its own choice")
        state = "on" if row.get("enabled") is True else "off"
        return f"AWS {state}: {', '.join(notes)}" if notes else f"AWS {state}"
    on = [_named(i, profile) for i in rows if i.get("enabled") is True]
    off = [_named(i, profile) for i in rows if i.get("enabled") is not True]
    parts = [f"on: {and_list(on)}" if on else "none on", f"off: {and_list(off)}" if off else ""]
    return f"{KIND_WORDS[kind]} {'; '.join(p for p in parts if p)}"


def _host_line(host: Mapping[str, Any]) -> str:
    alias = str(host.get("alias", ""))
    route = str(host.get("route", ""))
    default = ", on by default" if host.get("default_enabled") is True else ""
    key = host.get("key_name")
    who = f"as {host.get('user')} with the key {key}" if key else "no key yet, so no agent can use it"
    sets = [name_of(entry) for entry in dicts(host.get("sets"))]
    bundled = f"; every agent of {and_list(sets)} gets it" if sets else ""
    trusted = "" if host.get("host_keys") else "; its host key is not trusted yet"
    return f"{alias} at {route}{default}; {who}{bundled}{trusted}"


def ssh_hosts_text(status: Mapping[str, Any]) -> str:
    """The SSH hosts with their users, key names and sets, never key material."""
    hosts = dicts(status.get("hosts"))
    if not hosts:
        return f"No SSH hosts yet. {SSH_USER_ONLY}"
    lines = [_host_line(host) for host in hosts]
    return f"{plural(len(hosts), 'SSH host')}: {'. '.join(lines)}. {SSH_USER_ONLY}"


def access_text(title: str, view: Mapping[str, Any]) -> str:
    """One agent's access as a spoken summary, each item marked when it is the agent's own choice."""
    items = dicts(view.get("items"))
    profile = view.get("profile")
    name = name_of(profile) if isinstance(profile, dict) else "Default"
    lines = [line for kind in KIND_WORDS if (line := _group_line(kind, items, name)) is not None]
    unsandboxed = view.get("sandboxed") is False
    note = (
        " It runs unsandboxed, so SSH hosts, AWS and the credentials apply once its sandbox is on."
        if unsandboxed
        else ""
    )
    control = SETI_CONTROL_NOTES.get(str(view.get("seti_control")), "")
    return f"{title}: {'. '.join(lines)}. Credentials {name}.{note}{control}"


class AccessTools:
    """The EA's tools for MCP defaults and one agent's access and profile, through the UI's routes."""

    def __init__(self, seti: SetiClient, resolve_task: TaskResolver, confirmations: Confirmations) -> None:
        self._seti = seti
        self._resolve = resolve_task
        self._gate = confirmations
        self.handlers: dict[str, Handler] = {
            "set_mcp_default": self.set_mcp_default,
            "agent_access": self.agent_access,
            "set_agent_access": self.set_agent_access,
            "set_agent_profile": self.set_agent_profile,
            "ssh_hosts": self.ssh_hosts,
        }

    async def _cleared(self, args: Mapping[str, Any], key: str) -> bool:
        return await self._gate.cleared(key, arg_bool(args, "confirmed"))

    async def _call(self, what: str, run: Callable[[], Awaitable[Any]]) -> Any:
        try:
            return await run()
        except SetiError as e:
            if e.status in (400, 403, 404, 409):
                raise _refused(e, what) from e
            raise

    async def set_mcp_default(self, args: Mapping[str, Any]) -> ToolResult:
        server = _match(dicts(await self._seti.get("/mcp/selection")), arg_str(args, "server"))
        name = name_of(server)
        if "enabled" not in args:
            raise ToolError("The enabled argument is missing.", "Missing enabled")
        enabled = arg_bool(args, "enabled")
        state = "on" if enabled else "off"
        if (server.get("default_enabled") is True) == enabled:
            return ToolResult(f"{name} is already {state} by default.", clip(f"{name} already {state}", 70))
        if not await self._cleared(args, gate_key("set_mcp_default", name, enabled)):
            local = [str(d) for d in server.get("local_to") or []]
            origin = f" It comes from the local config of {and_list(local)}." if local else ""
            effect = (
                f"This turns the MCP server {name} {state} by default: every agent without its own "
                f"choice {'loads it' if enabled else 'leaves it out'} from its next turn. Agents with "
                f"their own choice keep it.{origin}"
            )
            return ask("set_mcp_default", args, effect, f"turn {name} {state} by default")
        await self._call(
            "change it", lambda: self._seti.put(f"/mcp/defaults/{quote(name, safe='')}", {"enabled": enabled})
        )
        return ToolResult(
            f"{name} is now {state} by default for every agent without its own choice.",
            clip(f"{name} {state} by default", 70),
        )

    async def agent_access(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        view = await self._seti.get(f"/tasks/{task.get('id')}/access")
        title = title_of(task)
        return ToolResult(
            access_text(title, view if isinstance(view, dict) else {}), clip(f"Access of {title}", 70)
        )

    async def ssh_hosts(self, _args: Mapping[str, Any]) -> ToolResult:
        status = await self._seti.get("/ssh")
        text = ssh_hosts_text(status if isinstance(status, dict) else {})
        return ToolResult(text, "Read SSH hosts")

    async def set_agent_access(self, args: Mapping[str, Any]) -> ToolResult:
        kind = arg_str(args, "kind")
        if kind in SECURITY_KINDS:
            raise ToolError(USER_ONLY, "Only the user changes SSH or AWS")
        if kind not in KIND_WORDS:
            raise ToolError("kind must be mcp, pack or plugin.", "Unknown kind")
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        path = f"/tasks/{task.get('id')}/access"
        items = [i for i in dicts((await self._seti.get(path)).get("items")) if i.get("kind") == kind]
        wanted: dict[str, bool | None] = {}
        for key, value in (("enable", True), ("disable", False), ("reset", None)):
            for ref in arg_list(args, key):
                wanted[_item_id(_pick_item(items, ref, kind))] = value
        by_id = {_item_id(i): i for i in items}
        changes = {
            item_id: on
            for item_id, on in wanted.items()
            if (
                by_id[item_id].get("override") is not None
                if on is None
                else by_id[item_id].get("enabled") is not on
            )
        }
        if not changes:
            view = await self._seti.get(path)
            return ToolResult(f"No change. {access_text(title, view)}", "Already so")
        words = [
            f"{name_of(by_id[i])} {'back to its default' if on is None else 'on' if on else 'off'}"
            for i, on in sorted(changes.items(), key=lambda entry: name_of(by_id[entry[0]]))
        ]
        if not await self._cleared(args, gate_key("set_agent_access", task.get("id"), kind, changes)):
            effect = (
                f"This turns {and_list(words)} for {title}; its session restarts with them at its next turn."
            )
            return ask("set_agent_access", args, effect, f"change the {KIND_WORDS[kind]} of {title}")
        view: Any = None
        for item_id, on in changes.items():
            body = {"kind": kind, "id": item_id, "enabled": on}
            view = await self._call("change it", lambda body=body: self._seti.put(path, body))
        return ToolResult(
            f"Turned {and_list(words)} for {title} from its next turn. {access_text(title, view)}",
            clip(f"Changed the {KIND_WORDS[kind]} of {title}", 70),
        )

    async def set_agent_profile(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        profiles = dicts(await self._seti.get("/credential-profiles"))
        names = {str(p.get("id")): name_of(p) for p in profiles}
        current = names.get(str(task.get("profile_id")), "Default")
        ref = arg_str(args, "profile", required=False)
        if not ref:
            listed = and_list([name_of(p) for p in profiles])
            return ToolResult(
                f"{title} uses the credentials {current}. Credentials: {listed}.",
                clip(f"Credentials of {title}", 70),
            )
        found = pick(profiles, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: [])
        profile = only(found, ref, "credential", name_of, "Ask the user which credentials they mean.")
        name = name_of(profile)
        if profile.get("id") == task.get("profile_id"):
            return ToolResult(f"{title} already uses the credentials {name}.", "Already so")
        if not await self._cleared(args, gate_key("set_agent_profile", task.get("id"), profile.get("id"))):
            sandboxed = task.get("sandbox") is not False
            note = (
                "" if sandboxed else " It runs unsandboxed, so the credentials apply once its sandbox is on."
            )
            effect = (
                f"This gives {title} the credentials {name} in place of {current}: its sandbox proxy "
                f"adds their tokens from its next turn.{note}"
            )
            return ask("set_agent_profile", args, effect, f"give {title} the credentials {name}")
        await self._call(
            "change it",
            lambda: self._seti.patch(f"/tasks/{task.get('id')}", {"profile_id": profile.get("id")}),
        )
        view = await self._seti.get(f"/tasks/{task.get('id')}/access")
        aws = view.get("aws") if isinstance(view, dict) else None
        aws_off = (
            f" Its AWS role stays off until the user turns AWS on in {title}'s settings."
            if isinstance(aws, dict) and aws.get("state") == "off"
            else ""
        )
        return ToolResult(
            f"{title} uses the credentials {name} from its next turn.{aws_off}",
            clip(f"{title} now uses {name}", 70),
        )
