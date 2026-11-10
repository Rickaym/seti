"""Tools for Seti's settings pages; security settings and secret values stay with the user."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import ago, and_list, clip, plural, repo_name, size_words
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.memory_tools import MEMORY_SPECS, MemoryTools
from seti_ea.mod_tools import MOD_SPECS, ModTools
from seti_ea.poller_tools import POLLER_SPECS, PollerTools, poller_line
from seti_ea.prompt import FORM_OF_ADDRESS_MAX
from seti_ea.reminder_tools import (
    REMINDER_CRON,
    REMINDER_INTERVAL,
    REMINDER_SCRIPT,
    REMINDER_SPECS,
    REMINDER_TIMEZONE,
    ReminderTools,
    reminder_changes,
    reminder_line,
)
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import (
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_list,
    arg_str,
    context_file_name,
    dicts,
    find_context_file,
    name_of,
    normalize,
    only,
    pick,
    resolve_repo,
    title_of,
)
from seti_ea.warm_cache_tools import WARM_CACHE_SPECS, WarmCacheTools

GENERIC = "generic"
SOURCE_LABELS = {"poller": "Poller", "reminder": "Reminder"}
SECRET_STATES = {
    "reveal": "Its secret waits for the user: in Settings, Channels they press Show on this webhook and "
    "copy it into the sender. Seti shows it once, and never to you.",
    "paste": "Its secret is still missing: the user pastes the client secret {label} issued in Settings, "
    "Channels, with Paste on this webhook. Deliveries are refused until then.",
}
MAPPING_FIELDS = ("title", "kind", "severity", "url", "subject", "state")
EA_REFS = frozenset({"ea", "you", "me", "the ea", "your inbox", "inbox"})
ROUTE_WORDS = {
    "delivered": "delivered",
    "queued": "queued for its next message",
    "held": "held",
    "ignored": "ignored",
    "skipped": "skipped",
}
DELIVERY_WORDS = {
    "accepted": "accepted",
    "duplicate": "a duplicate",
    "ignored": "ignored",
    "rejected": "refused",
    "rate_limited": "rate limited",
}
MCP_SCOPES = {
    "user": "every agent",
    "local": "agents in {repo}, kept on this machine only",
    "project": "agents in {repo}, written to its .mcp.json that others who clone it see",
}
MCP_REMOVABLE = frozenset(MCP_SCOPES)
OBJECT_WORDS = {"context_pack": "context pack", "context_file": ""}
LIST_LIMIT = 10
SHOWN = 5
SESSION_PAGE = 12
SESSION_SCAN = 200
ACTIVITY_SHOWN = 3
KEEP_AWAKE_RANGE = (5, 600)


WEBHOOK_REF = {"type": "string", "description": "The webhook's name as the user said it."}
CHANNEL_REF = {
    "type": "string",
    "description": "The channel's name as the user said it: a webhook, a poller or a reminder.",
}
REPO_SCOPE = {
    "type": "string",
    "description": "A repo name, for servers of that repo's local or project scope. Leave out otherwise.",
}
MCP_REF = {"type": "string", "description": "The MCP server's name."}
PLUGIN_REF = {"type": "string", "description": "The default plugin's name, or its folder."}
MAPPING = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Generic webhooks only: field=JSON pointer pairs saying where the payload keeps "
    "each field, such as title=/alert/name or severity=/level. Fields: title, kind, severity, url, "
    "subject, state.",
}
SUBSCRIBER_REF = {
    "type": "string",
    "description": "An agent's title as the user said it, or ea for your own inbox.",
}
EVENT_KINDS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Event kinds it takes, such as pull_request, workflow_run.completed or "
    "issue.created; a kind takes every kind under it. Leave out or empty for every event.",
}
EA_MODES = ("report", "act")
EA_MODE = {
    "type": "string",
    "enum": list(EA_MODES),
    "description": "Your inbox only: report (the default) reports its alerts and asks before acting; act "
    "lets you send an alert's work to an existing agent without asking. Leave out to keep it.",
}
MODE_EFFECTS = {
    "report": "has you report them and ask before acting",
    "act": "lets you send their work to an existing agent without asking",
}
MODE_RESULTS = {
    "report": "report them and ask before acting",
    "act": "send their work to an existing agent without asking",
}
SUBSCRIBE_EA = {
    "type": "boolean",
    "description": "Whether its events reach your inbox: true subscribes you, false unsubscribes you.",
}
OBJECT_ARGS = {
    "pack": {"type": "string", "description": "A context pack's name, for its changes."},
    "file": {
        "type": "string",
        "description": "A CLAUDE.md file for its changes: user, or a repo name, adding local for "
        "CLAUDE.local.md.",
    },
}

SETTINGS_SPECS: list[ToolSpec] = [
    ToolSpec(
        "list_channels",
        "List the channels that report to your inbox or to agents: webhooks that senders such as uptime "
        "monitors, GitHub or Sentry post to, pollers Seti runs for services without webhooks, and "
        "reminders whose script Seti runs on an interval or cron schedule, with their latest events.",
    ),
    ToolSpec(
        "list_my_channels",
        "The channels whose events reach your inbox, each with the event kinds you take. Only these "
        "reach you; subscribe or unsubscribe yourself with subscribe_channel or unsubscribe_channel "
        "and subscriber ea, after the user's yes.",
    ),
    ToolSpec(
        "get_channel",
        "One webhook in detail: its URL, how to set up the sender and which headers it signs with, its "
        "secret's state, field mapping, who it delivers to with their event filters, and recent events "
        "and deliveries with why any were refused and where each went. For a poller or a reminder: its "
        "status, schedule, subscribers, script and latest runs; with runs, only its latest runs in "
        "full, with their logs.",
        {
            "channel": CHANNEL_REF,
            "runs": {
                "type": "boolean",
                "description": "Pollers and reminders: show only the latest runs, with their logs.",
            },
        },
        ["channel"],
    ),
    ToolSpec(
        "create_channel",
        "Create a webhook channel. Seti issues its signing secret, which only the user sees, once, in "
        "Settings; for Sentry the user pastes the secret Sentry issues. Needs the user's yes. Its events "
        "reach your inbox only with subscribe_ea; subscribe agents to it with subscribe_channel.",
        {
            "name": {"type": "string", "description": "A short name, such as Uptime or Payments CI."},
            "preset": {
                "type": "string",
                "description": "generic for any JSON sender (default), or a webhook source by its id or "
                "name, such as GitHub or Sentry, while the mod that adds it is on.",
            },
            "subscribe_ea": {
                "type": "boolean",
                "description": "Default false; true sends its events to your inbox too.",
            },
            "mapping": MAPPING,
            "confirmed": CONFIRMED,
        },
        ["name"],
    ),
    ToolSpec(
        "update_channel",
        "Rename a webhook or reminder, subscribe or unsubscribe your inbox, change a generic webhook's "
        "field mapping, or change a reminder's script, interval or cron schedule and pause or resume it. "
        "Pollers change with update_poller. Needs the user's yes.",
        {
            "channel": {
                "type": "string",
                "description": "The webhook's or reminder's name as the user said it.",
            },
            "name": {"type": "string", "description": "A new name."},
            "subscribe_ea": SUBSCRIBE_EA,
            "mapping": {**MAPPING, "description": f"{MAPPING['description']} Replaces the whole mapping."},
            "script": {
                **REMINDER_SCRIPT,
                "description": f"Reminders only: the whole new script. {REMINDER_SCRIPT['description']}",
            },
            "interval_minutes": REMINDER_INTERVAL,
            "cron": REMINDER_CRON,
            "timezone": REMINDER_TIMEZONE,
            "active": {"type": "boolean", "description": "Reminders only: false pauses it, true resumes it."},
            "confirmed": CONFIRMED,
        },
        ["channel"],
    ),
    ToolSpec(
        "run_channel",
        "Run a poller or a reminder now instead of at its next time; what it reports reaches its "
        "subscribers. Needs the user's yes.",
        {
            "channel": {
                "type": "string",
                "description": "The poller's or reminder's name as the user said it.",
            },
            "confirmed": CONFIRMED,
        },
        ["channel"],
    ),
    ToolSpec(
        "test_channel_script",
        "Run a poller or reminder script once without storing or delivering anything, and see what it "
        "returns, its log and any error: a draft script, a saved poller or reminder, or a new script for "
        "a saved one.",
        {
            "script": {
                "type": "string",
                "description": "The script to try; without a channel, give kind too.",
            },
            "channel": {
                "type": "string",
                "description": "A saved poller or reminder to test, or whose settings to use.",
            },
            "kind": {
                "type": "string",
                "enum": ["poller", "reminder"],
                "description": "What a draft script is for, without a channel.",
            },
        },
    ),
    ToolSpec(
        "subscribe_channel",
        "Have a webhook deliver its events to an agent, as updates the agent acts on under its update "
        "mode, or to your inbox; or change which event kinds an existing subscriber takes, or whether you "
        "report or act on its alerts. Pinned agents suit this best. Agents cannot subscribe themselves; "
        "they ask you. Needs the user's yes.",
        {
            "channel": CHANNEL_REF,
            "subscriber": SUBSCRIBER_REF,
            "events": EVENT_KINDS,
            "mode": EA_MODE,
            "confirmed": CONFIRMED,
        },
        ["channel", "subscriber"],
    ),
    ToolSpec(
        "unsubscribe_channel",
        "Stop a webhook delivering its events to an agent or to your inbox. Needs the user's yes.",
        {"channel": CHANNEL_REF, "subscriber": SUBSCRIBER_REF, "confirmed": CONFIRMED},
        ["channel", "subscriber"],
    ),
    ToolSpec(
        "delete_channel",
        "Delete a webhook, whose URL stops working, or a poller or reminder, which stops running; its "
        "events and deliveries go. Needs the user's yes.",
        {"channel": CHANNEL_REF, "confirmed": CONFIRMED},
        ["channel"],
    ),
    ToolSpec(
        "test_channel",
        "Send a webhook a signed sample event through the same checks as a real delivery. Needs the "
        "user's yes.",
        {"channel": WEBHOOK_REF, "confirmed": CONFIRMED},
        ["channel"],
    ),
    ToolSpec(
        "rotate_channel_secret",
        "Have Seti issue a new signing secret for a webhook; the old one stops working at once, and the "
        "user copies the new one from Settings. Needs the user's yes.",
        {"channel": WEBHOOK_REF, "confirmed": CONFIRMED},
        ["channel"],
    ),
    *POLLER_SPECS,
    *REMINDER_SPECS,
    *WARM_CACHE_SPECS,
    *MEMORY_SPECS,
    *MOD_SPECS,
    ToolSpec(
        "get_archive_settings",
        "The auto-archive rule (on or off, after how many idle days), after how many days archived "
        "agents are deleted, whether agents a restart cut off resume on their own, whether an agent "
        "that repeats a call with the same result stops to ask the user, which agents it would "
        "archive now, and what the archive holds. With "
        "stale_folders, also the folders in the scratch and worktree roots no agent owns, with sizes; "
        "listing them changes nothing.",
        {
            "stale_folders": {"type": "boolean", "description": "true to list stale folders too."},
            "days": {
                "type": "integer",
                "description": "Leave out stale folders changed within this many days; default 7.",
            },
        },
    ),
    ToolSpec(
        "set_auto_archive",
        "Turn auto-archive on or off, change after how many idle days it archives complete agents, "
        "after how many days in the archive agents are deleted with their files, whether agents a "
        "Seti restart cut off resume on their own, or whether an agent that repeats a call with the "
        "same result stops to ask the user first. Needs the user's yes.",
        {
            "enabled": {"type": "boolean", "description": "true to turn it on, false to turn it off."},
            "days": {"type": "integer", "description": "Idle days before archiving, 1 to 365."},
            "delete_after_days": {
                "type": "integer",
                "description": "Days in the archive before an agent is deleted, 1 to 3650; 0 keeps them.",
            },
            "resume_after_restart": {
                "type": "boolean",
                "description": "true to send agents a restart cut off one message to go on; false to "
                "leave them for the user.",
            },
            "repeat_guard": {
                "type": "boolean",
                "description": "true to stop an agent that runs the same call again after 2 identical "
                "results until the user allows it; false to let agents repeat calls without asking.",
            },
            "confirmed": CONFIRMED,
        },
    ),
    ToolSpec(
        "run_archive_sweep",
        "Archive now every complete agent the auto-archive rule would take, even while the rule is off. "
        "With stale_folders, instead deletes those folders for good, as get_archive_settings listed "
        "them. Needs the user's yes.",
        {
            "stale_folders": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Paths of stale folders to delete, from get_archive_settings.",
            },
            "days": {"type": "integer", "description": "The days the stale folders were listed with."},
            "confirmed": CONFIRMED,
        },
    ),
    ToolSpec("list_archived_agents", "List archived agents, newest first, with what their archives saved."),
    ToolSpec(
        "write_context_file",
        "Write a CLAUDE.md file Seti manages: replace its text or add to its end. Agents read it from "
        "their next session. Needs the user's yes.",
        {
            "file": OBJECT_ARGS["file"]
            | {"description": "user, or a repo name, adding local for CLAUDE.local.md."},
            "content": {"type": "string", "description": "The whole new text, replacing what is there."},
            "append": {"type": "string", "description": "Text to add at the end instead."},
            "confirmed": CONFIRMED,
        },
        ["file"],
    ),
    ToolSpec(
        "list_changes",
        "Changes agents made to context packs and CLAUDE.md files that the user has not looked at "
        "yet; or, naming one of them, its change history.",
        dict(OBJECT_ARGS),
    ),
    ToolSpec(
        "revert_change",
        "Set a context pack or CLAUDE.md file back to how it was before one change, saved as a new "
        "change. Needs the user's yes.",
        {
            **OBJECT_ARGS,
            "change": {"type": "integer", "description": "The change number; leave out for the latest."},
            "confirmed": CONFIRMED,
        },
    ),
    ToolSpec(
        "mark_changes_seen",
        "Mark agents' changes as seen, so Seti stops flagging them: one pack or file, or all. "
        "Needs the user's yes.",
        {**OBJECT_ARGS, "confirmed": CONFIRMED},
    ),
    ToolSpec(
        "add_plugin",
        "Add a plugin folder on this machine as a Seti default plugin that every new agent gets. "
        "Needs the user's yes.",
        {
            "path": {"type": "string", "description": "The absolute path of the plugin folder."},
            "confirmed": CONFIRMED,
        },
        ["path"],
    ),
    ToolSpec(
        "remove_plugin",
        "Remove a Seti default plugin; its folder stays on disk. Needs the user's yes.",
        {"plugin": PLUGIN_REF, "confirmed": CONFIRMED},
        ["plugin"],
    ),
    ToolSpec(
        "set_plugin_enabled",
        "Turn a Seti default plugin on or off for new agents. Needs the user's yes.",
        {
            "plugin": PLUGIN_REF,
            "enabled": {"type": "boolean", "description": "true to turn it on, false to turn it off."},
            "confirmed": CONFIRMED,
        },
        ["plugin", "enabled"],
    ),
    ToolSpec(
        "add_mcp_server",
        "Add a remote MCP server (HTTP or SSE URL) for agents. Servers that run a command or need "
        "credential headers are added by the user in Settings. Needs the user's yes.",
        {
            "name": {"type": "string", "description": "Letters, digits, hyphens and underscores."},
            "url": {"type": "string", "description": "The server's http or https URL."},
            "transport": {"type": "string", "enum": ["http", "sse"], "description": "http (default) or sse."},
            "scope": {
                "type": "string",
                "enum": list(MCP_SCOPES),
                "description": "user for every agent (default), local or project for one repo.",
            },
            "repo": REPO_SCOPE,
            "confirmed": CONFIRMED,
        },
        ["name", "url"],
    ),
    ToolSpec(
        "remove_mcp_server",
        "Remove an MCP server from agents' configuration. Needs the user's yes.",
        {"server": MCP_REF, "repo": REPO_SCOPE, "confirmed": CONFIRMED},
        ["server"],
    ),
    ToolSpec(
        "reconnect_mcp_server",
        "Check an MCP server's connection again and report its state and tools.",
        {"server": MCP_REF, "repo": REPO_SCOPE},
        ["server"],
    ),
    ToolSpec(
        "start_mcp_sign_in",
        "Start the sign-in of a claude.ai connector MCP server and get the link for the user to open. "
        "Other servers sign in from Settings. Needs the user's yes.",
        {"server": MCP_REF, "repo": REPO_SCOPE, "confirmed": CONFIRMED},
        ["server"],
    ),
    ToolSpec(
        "list_sessions",
        "List Claude Code sessions started from a terminal or IDE on this machine that can be imported "
        "as agents, newest first.",
        {"query": {"type": "string", "description": "Words from a session's title or folder."}},
    ),
    ToolSpec(
        "import_sessions",
        "Import terminal or IDE sessions as agents, with their conversation and the PRs they opened. "
        "Needs the user's yes.",
        {
            "sessions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Session titles as list_sessions gave them, up to 10.",
            },
            "repo": {"type": "string", "description": "A repo to run them in instead of their own folder."},
            "confirmed": CONFIRMED,
        },
        ["sessions"],
    ),
    ToolSpec(
        "resource_usage",
        "This machine's load: CPU, memory, swap and disks, Seti's services, the agents' processes and "
        "any resource warnings.",
    ),
    ToolSpec(
        "get_ea_settings",
        "Your own settings: the wake word, its phrase, how long you stay awake and how you address the user.",
    ),
    ToolSpec(
        "update_ea_settings",
        "Change your own settings: turn the wake word on or off, its phrase, how long you stay awake "
        "after the last words, or how you address the user. Needs the user's yes.",
        {
            "wake_enabled": {"type": "boolean", "description": "true to turn the wake word on."},
            "wake_phrase": {"type": "string", "description": "Two to four words, such as Hey Seti."},
            "keep_awake_seconds": {"type": "integer", "description": "5 to 600 seconds."},
            "form_of_address": {
                "type": "string",
                "description": "What you call the user now and then, such as a title or their name, "
                "at most 20 characters; empty for no title.",
            },
            "confirmed": CONFIRMED,
        },
    ),
    ToolSpec(
        "get_security_settings",
        "Read the sandbox setting, its network allowlist and hidden paths, and whether agents have a "
        "GitHub token. Only the user changes these.",
    ),
]

SETTINGS_WRITES = frozenset(spec.name for spec in SETTINGS_SPECS if "confirmed" in spec.properties)

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]


def form_of_address(args: Mapping[str, Any]) -> str:
    """The form of address the user asked for; empty for no title."""
    value = args.get("form_of_address")
    address = value.strip() if isinstance(value, str) else ""
    if len(address) > FORM_OF_ADDRESS_MAX:
        raise ToolError(f"Keep the form of address to {FORM_OF_ADDRESS_MAX} characters.", "Too long")
    return address


def field_dict(item: Mapping[str, Any], name: str) -> dict[str, Any]:
    """A field that holds an object, or an empty one."""
    value = item.get(name)
    return value if isinstance(value, dict) else {}


def field_list(item: Mapping[str, Any], name: str) -> list[Any]:
    """A field that holds a list, or an empty one."""
    value = item.get(name)
    return value if isinstance(value, list) else []


def _mapping(args: Mapping[str, Any]) -> dict[str, str]:
    """field=pointer pairs as the mapping a generic webhook takes."""
    mapping: dict[str, str] = {}
    for pair in arg_list(args, "mapping"):
        field, sep, pointer = pair.partition("=")
        field = field.strip().lower()
        pointer = pointer.strip()
        if not sep or field not in MAPPING_FIELDS or not pointer.startswith("/"):
            raise ToolError(
                f'"{pair}" is not a field mapping. Use field=/json/pointer with a field of '
                f"{', '.join(MAPPING_FIELDS)}.",
                "Bad mapping",
            )
        mapping[field] = pointer
    return mapping


def _mapping_words(mapping: Mapping[str, Any]) -> str:
    return and_list([f"{k} from {v}" for k, v in mapping.items()]) if mapping else "the best-effort mapping"


def _hook_url(info: Mapping[str, Any]) -> str:
    url = info.get("public_url")
    if url:
        return f"Its URL is {url}."
    return (
        f"Seti has no public hostname yet, so senders on the internet cannot reach it; on this machine "
        f"its path is {info.get('path')}."
    )


def _secret_state(info: Mapping[str, Any]) -> str:
    pending = info.get("secret_pending")
    label = _sender(info).get("label") or "the sender"
    return SECRET_STATES[pending].format(label=label) if pending in SECRET_STATES else ""


WEBHOOK_REFUSALS = {
    "poller": "update_poller, run_channel or test_channel_script",
    "reminder": "update_channel, run_channel or test_channel_script",
}


def _kind(info: Mapping[str, Any]) -> str:
    source = info.get("source")
    return source if source in ("poller", "reminder") else "webhook"


def _sender(info: Mapping[str, Any]) -> dict[str, Any]:
    """The kind of sender a webhook takes, as Seti describes it, even while its mod is off."""
    sender = info.get("sender")
    return sender if isinstance(sender, dict) else {}


def _preset(info: Mapping[str, Any]) -> str:
    preset = str(info.get("preset"))
    return SOURCE_LABELS.get(preset) or str(_sender(info).get("label") or preset)


def _sender_issued(info: Mapping[str, Any]) -> bool:
    return _sender(info).get("secret") == "sender"


def _unavailable(info: Mapping[str, Any]) -> str:
    why = info.get("unavailable")
    return f"refuses deliveries: {why}" if isinstance(why, str) and why else ""


def _source_matches(source: Mapping[str, Any], given: str) -> bool:
    wanted = given.strip().lower()
    source_id = str(source.get("id", ""))
    label = str(source.get("label", ""))
    return wanted in (source_id, label.lower(), source_id.rsplit(".", 1)[-1]) or (
        normalize(label) == normalize(given)
    )


def _delivery(d: Mapping[str, Any], now: datetime) -> str:
    status = DELIVERY_WORDS.get(str(d.get("status")), str(d.get("status")))
    reason = (
        f" ({clip(str(d.get('reason')), 100)})" if d.get("reason") and d.get("status") != "accepted" else ""
    )
    return f"{status} {ago(d.get('received_at'), now)}{reason}"


def _ea_subscription(info: Mapping[str, Any]) -> dict[str, Any] | None:
    return next((s for s in dicts(info.get("subscriptions")) if s.get("target") == "ea"), None)


def _agent_subscriptions(info: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [s for s in dicts(info.get("subscriptions")) if s.get("target") == "task"]


def _events_words(events: Any) -> str:
    return and_list([str(e) for e in events]) if isinstance(events, list) and events else "every event"


def _mode_of(sub: Mapping[str, Any]) -> str:
    return "act" if sub.get("mode") == "act" else "report"


def _mode_arg(args: Mapping[str, Any]) -> str | None:
    mode = arg_str(args, "mode", required=False)
    if not mode:
        return None
    mode = normalize(mode)
    if mode not in EA_MODES:
        raise ToolError(f"Unknown mode {mode}. Use report or act.", "Bad mode")
    return mode


def _subscriber_line(sub: Mapping[str, Any]) -> str:
    if sub.get("target") == "ea":
        who = "you (act)" if _mode_of(sub) == "act" else "you"
    else:
        who = str(sub.get("task_title") or "an agent")
    archived = " (archived, gets nothing until restored)" if sub.get("task_archived") is True else ""
    return f"{who}{archived}: {_events_words(sub.get('events'))}"


def _routes_words(delivery: Mapping[str, Any]) -> str:
    routes = dicts(delivery.get("routes"))
    return and_list(
        [
            f"{'you' if r.get('target') == 'ea' else r.get('label')} "
            f"{ROUTE_WORDS.get(str(r.get('outcome')), str(r.get('outcome')))}"
            for r in routes
        ]
    )


def _event_kinds(args: Mapping[str, Any]) -> list[str] | None:
    kinds = [k.strip().lower() for k in arg_list(args, "events") if k.strip()]
    for kind in kinds:
        if "," in kind or " " in kind:
            raise ToolError(
                f'"{kind}" is not an event kind. Use words such as pull_request.', "Bad event kind"
            )
    return sorted(set(kinds)) or None


def _revision_what(rev: Mapping[str, Any]) -> str:
    kind = rev.get("kind")
    if kind == "created":
        return "created it"
    if kind == "note":
        return f'left a note: "{clip(str(rev.get("reason") or ""), 120)}"'
    before = field_dict(rev, "before")
    after = field_dict(rev, "after")
    keys = sorted(k for k in {*before, *after} if before.get(k) != after.get(k))
    return f"changed its {and_list([k.replace('_', ' ') for k in keys]) or 'nothing'}"


def _revision_who(rev: Mapping[str, Any]) -> str:
    if rev.get("actor") == "agent":
        return f"the agent in {rev.get('task_title')}" if rev.get("task_title") else "an agent"
    return "the user"


class SettingsTools:
    """The EA's tools for Seti's settings pages, each through the route the UI calls."""

    def __init__(
        self,
        seti: SetiClient,
        confirmations: Confirmations,
        now: Callable[[], datetime],
        resolve_task: Callable[[str], Awaitable[dict[str, Any]]],
    ) -> None:
        self._seti = seti
        self._gate = confirmations
        self._now = now
        self._resolve_task = resolve_task
        self.handlers: dict[str, Handler] = {
            "list_channels": self.list_channels,
            "list_my_channels": self.list_my_channels,
            "get_channel": self.get_channel,
            "create_channel": self.create_channel,
            "update_channel": self.update_channel,
            "run_channel": self.run_channel,
            "test_channel_script": self.test_channel_script,
            "subscribe_channel": self.subscribe_channel,
            "unsubscribe_channel": self.unsubscribe_channel,
            "delete_channel": self.delete_channel,
            "test_channel": self.test_channel,
            "rotate_channel_secret": self.rotate_channel_secret,
            "get_archive_settings": self.get_archive_settings,
            "set_auto_archive": self.set_auto_archive,
            "run_archive_sweep": self.run_archive_sweep,
            "list_archived_agents": self.list_archived_agents,
            "write_context_file": self.write_context_file,
            "list_changes": self.list_changes,
            "revert_change": self.revert_change,
            "mark_changes_seen": self.mark_changes_seen,
            "add_plugin": self.add_plugin,
            "remove_plugin": self.remove_plugin,
            "set_plugin_enabled": self.set_plugin_enabled,
            "add_mcp_server": self.add_mcp_server,
            "remove_mcp_server": self.remove_mcp_server,
            "reconnect_mcp_server": self.reconnect_mcp_server,
            "start_mcp_sign_in": self.start_mcp_sign_in,
            "list_sessions": self.list_sessions,
            "import_sessions": self.import_sessions,
            "resource_usage": self.resource_usage,
            "get_ea_settings": self.get_ea_settings,
            "update_ea_settings": self.update_ea_settings,
            "get_security_settings": self.get_security_settings,
        }
        self._pollers = PollerTools(seti, confirmations, now)
        self.handlers.update(self._pollers.handlers)
        self._reminders = ReminderTools(seti, confirmations, now)
        self.handlers.update(self._reminders.handlers)
        self.handlers.update(WarmCacheTools(seti, confirmations).handlers)
        self.handlers.update(MemoryTools(seti, confirmations, resolve_task).handlers)
        self.handlers.update(ModTools(seti, confirmations).handlers)

    async def _cleared(self, args: Mapping[str, Any], key: str) -> bool:
        return await self._gate.cleared(key, arg_bool(args, "confirmed"))

    async def _refusable(self, job: Awaitable[Any], summary: str) -> Any:
        """The result of a write, with Seti's refusals of bad input or of the EA told plainly."""
        try:
            return await job
        except SetiError as e:
            if e.status in (400, 403, 409):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", summary) from e
            raise

    async def _channels(self) -> list[dict[str, Any]]:
        return dicts(await self._seti.get("/channels"))

    async def _channel(self, args: Mapping[str, Any]) -> dict[str, Any]:
        ref = arg_str(args, "channel")
        found = pick(await self._channels(), ref, lambda c: str(c.get("id", "")), name_of, lambda _c: [])
        return only(found, ref, "webhook", name_of, "Call list_channels to see them.")

    async def _webhook(self, args: Mapping[str, Any]) -> dict[str, Any]:
        info = await self._channel(args)
        tools = WEBHOOK_REFUSALS.get(_kind(info))
        if tools is not None:
            raise ToolError(
                f"{name_of(info)} is a {_kind(info)}, not a webhook: use {tools}.",
                "Not a webhook",
            )
        return info

    async def list_channels(self, args: Mapping[str, Any]) -> ToolResult:
        channels = await self._channels()
        if not channels:
            return ToolResult("There are no channels yet.", "No channels")
        now = self._now()
        noun = "channel" if any(_kind(c) != "webhook" for c in channels) else "webhook"
        lines = [f"{plural(len(channels), noun)}:"]
        for c in channels:
            inbox = "reports to you" if _ea_subscription(c) is not None else "keeps out of your inbox"
            agents = _agent_subscriptions(c)
            feeds = f", feeds {plural(len(agents), 'agent')}" if agents else ""
            parts = [f"- {name_of(c)} ({_preset(c)}): {inbox}{feeds}"]
            if c.get("source") == "poller":
                parts.append(poller_line(c, now))
            if c.get("source") == "reminder":
                parts.append(reminder_line(c, now))
            events = dicts(c.get("recent"))
            if events:
                last = events[0]
                parts.append(
                    f'last event {ago(last.get("created_at"), now)}: "{clip(str(last.get("title")), 80)}"'
                )
            deliveries = dicts(c.get("deliveries"))
            if _kind(c) == "webhook":
                parts.append(
                    f"last delivery {_delivery(deliveries[0], now)}" if deliveries else "no deliveries yet"
                )
            if _unavailable(c):
                parts.append(_unavailable(c))
            pending = {"reveal": "secret waiting for the user", "paste": "secret still to be pasted"}
            if c.get("secret_pending") in pending:
                parts.append(pending[str(c.get("secret_pending"))])
            lines.append("; ".join(parts))
        return ToolResult("\n".join(lines), f"Listed {plural(len(channels), noun)}")

    async def list_my_channels(self, args: Mapping[str, Any]) -> ToolResult:
        subs = dicts(await self._seti.get("/ea/channels"))
        if not subs:
            return ToolResult(
                "You subscribe to no channel: no channel event reaches your inbox.", "No channels of yours"
            )
        lines = [f"Your inbox takes events from {plural(len(subs), 'channel')}:"]
        for s in subs:
            kind = s.get("preset") if s.get("preset") in ("poller", "reminder") else "webhook"
            acts = "; you act on its alerts" if _mode_of(s) == "act" else ""
            lines.append(f"- {s.get('channel_name')} ({kind}): {_events_words(s.get('events'))}{acts}")
        return ToolResult("\n".join(lines), f"Listed {plural(len(subs), 'channel')} of yours")

    async def get_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        kind = _kind(info)
        if arg_bool(args, "runs") and kind == "webhook":
            raise ToolError(f"{name_of(info)} is a webhook; its deliveries show without runs.", "No runs")
        if kind == "poller":
            return await self._pollers.runs(info) if arg_bool(args, "runs") else self._pollers.detail(info)
        if kind == "reminder":
            return (
                await self._reminders.runs(info) if arg_bool(args, "runs") else self._reminders.detail(info)
            )
        now = self._now()
        subs = dicts(info.get("subscriptions"))
        inbox = (
            f"It delivers to {'; '.join(_subscriber_line(s) for s in subs)}."
            if subs
            else "Nobody subscribes to it: its events stay on the channels page."
        )
        lines = [
            f"{name_of(info)} is a {_preset(info)} webhook, created "
            f"{ago(info.get('created_at'), now)}. {inbox}",
            f"It {_unavailable(info)}; the user turns its mod on in Settings, Mods."
            if _unavailable(info)
            else "",
            _hook_url(info),
            str(_sender(info).get("setup") or ""),
        ]
        if info.get("preset") == GENERIC:
            mapping = field_dict(info, "mapping")
            lines.append(f"It reads {_mapping_words(mapping)}.")
        state = _secret_state(info)
        rotated = info.get("secret_rotated_at")
        lines.append(
            state
            or f"Its secret was {'rotated' if rotated else 'set'} "
            f"{ago(rotated or info.get('created_at'), now)}."
        )
        events = dicts(info.get("recent"))[:ACTIVITY_SHOWN]
        if events:
            shown = "; ".join(
                f'"{clip(str(e.get("title")), 70)}" ({e.get("severity")}, {ago(e.get("created_at"), now)})'
                for e in events
            )
            lines.append(f"Latest events: {shown}.")
        deliveries = dicts(info.get("deliveries"))[:ACTIVITY_SHOWN]
        if deliveries:
            lines.append(f"Latest deliveries: {'; '.join(_delivery(d, now) for d in deliveries)}.")
            routed = next((d for d in deliveries if dicts(d.get("routes"))), None)
            if routed is not None:
                lines.append(f"The latest event went to: {_routes_words(routed)}.")
        else:
            lines.append("No delivery has reached it yet.")
        return ToolResult(
            "\n".join(line for line in lines if line), f"Read webhook {clip(name_of(info), 50)}"
        )

    async def _webhook_source(self, given: str) -> dict[str, Any]:
        sources = await self._seti.get("/channels/sources")
        webhooks = dicts(sources.get("webhooks")) if isinstance(sources, dict) else []
        found = next((source for source in webhooks if _source_matches(source, given)), None)
        if found is None:
            names = ", ".join(str(source.get("label")) for source in webhooks)
            raise ToolError(
                f"Seti takes no webhook source {given} now; it takes {names}. A source a mod adds "
                "shows only while the user has that mod on in Settings, Mods.",
                "Bad preset",
            )
        return found

    async def create_channel(self, args: Mapping[str, Any]) -> ToolResult:
        name = arg_str(args, "name")
        source = await self._webhook_source(arg_str(args, "preset", required=False) or GENERIC)
        preset = str(source.get("id"))
        mapping = _mapping(args)
        if mapping and preset != GENERIC:
            raise ToolError("Only generic webhooks take a field mapping.", "Bad mapping")
        deliver = arg_bool(args, "subscribe_ea") if "subscribe_ea" in args else False
        body = {"name": name, "preset": preset, "subscribe_ea": deliver, "mapping": mapping}
        label = str(source.get("label"))
        setup = str(source.get("setup") or "")
        if not await self._cleared(args, gate_key("create_channel", body)):
            reach = "reporting to you" if deliver else "keeping its events out of your inbox"
            secret = (
                f"{label} issues its secret: the user puts the webhook URL in {label}, then pastes "
                "the client secret it gives in Settings, Channels; deliveries are refused until then."
                if source.get("secret") == "sender"
                else "Seti issues its signing secret; the user copies it once from Settings, Channels, and "
                "you never see it."
            )
            maps = f" It reads {_mapping_words(mapping)}." if mapping else ""
            effect = f'This creates the {label} webhook "{name}", {reach}.{maps} {secret}'
            return ask("create_channel", args, effect, f"create webhook {name}")
        created = await self._refusable(self._seti.post("/channels", body), "Webhook not created")
        info = created.get("channel") if isinstance(created, dict) else None
        if not isinstance(info, dict):
            return ToolResult(f'Created the {label} webhook "{name}".', clip(f"Created webhook {name}", 70))
        text = " ".join(
            part
            for part in (
                f'Created the {label} webhook "{name}".',
                _hook_url(info),
                setup,
                _secret_state(info),
            )
            if part
        )
        return ToolResult(text, clip(f"Created webhook {name}", 70))

    async def run_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        if _kind(info) == "poller":
            return await self._pollers.run_now(args, info)
        if _kind(info) == "reminder":
            return await self._reminders.run_now(args, info)
        raise ToolError(f"{name_of(info)} is a webhook: send it a sample with test_channel.", "Not runnable")

    async def test_channel_script(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args) if arg_str(args, "channel", required=False) else None
        kind = _kind(info) if info is not None else str(args.get("kind") or "")
        if kind == "poller":
            return await self._pollers.test(args, info)
        if kind == "reminder":
            return await self._reminders.test(args, info)
        if info is not None:
            raise ToolError(f"{name_of(info)} is a webhook: send it a sample with test_channel.", "No script")
        raise ToolError(
            "Say whether the script is for a poller or a reminder, or name a saved one.", "Nothing to test"
        )

    async def update_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        kind = _kind(info)
        if kind == "poller":
            raise ToolError(
                f"{name_of(info)} is a poller: change it with update_poller.", "Use update_poller"
            )
        name = name_of(info)
        body: dict[str, Any] = {}
        changes: list[str] = []
        new_name = arg_str(args, "name", required=False)
        if new_name and new_name != name:
            body["name"] = new_name
            changes.append(f"renames it to {new_name}")
        ea = _ea_subscription(info)
        subscribe_ea: bool | None = None
        if "subscribe_ea" in args and arg_bool(args, "subscribe_ea") != (ea is not None):
            subscribe_ea = arg_bool(args, "subscribe_ea")
            changes.append(
                "sends its events to your inbox" if subscribe_ea else "keeps its events out of your inbox"
            )
        if kind == "reminder":
            extra, more = reminder_changes(info, args)
            body |= extra
            changes += more
        elif any(key in args for key in ("script", "interval_minutes", "cron", "timezone", "active")):
            raise ToolError("Only reminders take a script, a schedule or active.", "Not a reminder")
        if "mapping" in args:
            if info.get("preset") != GENERIC:
                raise ToolError("Only generic webhooks take a field mapping.", "Bad mapping")
            mapping = _mapping(args)
            if mapping != info.get("mapping"):
                body["mapping"] = mapping
                changes.append(f"makes it read {_mapping_words(mapping)}")
        if not changes:
            raise ToolError(f"That changes nothing in the {kind} {name}.", "Nothing to change")
        if not await self._cleared(args, gate_key("update_channel", info.get("id"), body, subscribe_ea)):
            effect = f"This changes the {kind} {name}: it {and_list(changes)}."
            return ask("update_channel", args, effect, f"change {kind} {name}")
        if body:
            path = (
                f"/channels/reminders/{info.get('id')}"
                if kind == "reminder"
                else f"/channels/{info.get('id')}"
            )
            await self._refusable(self._seti.put(path, body), f"{kind.capitalize()} not changed")
        base = f"/channels/{info.get('id')}/subscriptions"
        if subscribe_ea is True:
            await self._refusable(self._seti.post(base, {"target": "ea"}), "Not subscribed")
        elif subscribe_ea is False and ea is not None:
            await self._seti.delete(f"{base}/{ea.get('id')}")
        return ToolResult(
            f"Updated the {kind} {name}: it {and_list(changes)}.", clip(f"Updated {kind} {name}", 70)
        )

    async def _subscriber(self, args: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
        """The subscription body naming who args mean, and a name for them."""
        ref = arg_str(args, "subscriber")
        if normalize(ref) in EA_REFS:
            return {"target": "ea"}, "your inbox"
        task = await self._resolve_task(ref)
        return {"target": "task", "task_id": task.get("id")}, f'the agent "{title_of(task)}"'

    @staticmethod
    def _existing(info: Mapping[str, Any], target: Mapping[str, Any]) -> dict[str, Any] | None:
        return next(
            (
                s
                for s in dicts(info.get("subscriptions"))
                if s.get("target") == target["target"] and s.get("task_id") == target.get("task_id")
            ),
            None,
        )

    async def subscribe_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        name = name_of(info)
        target, who = await self._subscriber(args)
        mode = _mode_arg(args)
        if mode is not None and target["target"] != "ea":
            raise ToolError(
                "Only your inbox has a report or act mode; an agent takes events as updates.", "Bad mode"
            )
        existing = self._existing(info, target)
        keep = existing is not None and mode is not None and "events" not in args
        events = existing.get("events") if existing is not None and keep else _event_kinds(args)
        refilter = existing is not None and existing.get("events") != events
        remode = existing is not None and mode is not None and _mode_of(existing) != mode
        subject = f"{who[0].upper()}{who[1:]}"
        if existing is not None and not refilter and not remode:
            verb = "act on" if _mode_of(existing) == "act" else "report"
            now = f", and you already {verb} its alerts" if mode is not None else ""
            return ToolResult(
                f"{subject} already takes {_events_words(events)} from {name}{now}.",
                clip(f"{name} unchanged", 70),
            )
        if not await self._cleared(args, gate_key("subscribe_channel", info.get("id"), target, events, mode)):
            moded = f", and {MODE_EFFECTS[mode]}" if mode is not None and (existing is None or remode) else ""
            if existing is None:
                how = " as updates it acts on under its update mode" if target["target"] == "task" else ""
                effect = (
                    f"This sends {_events_words(events)} from the {_kind(info)} {name} to {who}{how}{moded}."
                )
            elif refilter:
                effect = (
                    f"This makes {who} take {_events_words(events)} from the {_kind(info)} {name}{moded}."
                )
            else:
                effect = f"For alerts from the {_kind(info)} {name}, this {MODE_EFFECTS[mode or 'report']}."
            return ask("subscribe_channel", args, effect, f"subscribe {who} to {name}")
        base = f"/channels/{info.get('id')}/subscriptions"
        acts = (
            f" Alerts from the {_kind(info)} {name}: you now {MODE_RESULTS[mode]}."
            if mode is not None and (existing is None or remode)
            else ""
        )
        if existing is None:
            body = {**target, "events": events, **({} if mode is None else {"mode": mode})}
            await self._refusable(self._seti.post(base, body), "Not subscribed")
            text = f"Subscribed {who} to the {_kind(info)} {name}: {_events_words(events)}.{acts}"
            return ToolResult(text, clip(f"Subscribed to {name}", 70))
        path = f"{base}/{existing.get('id')}"
        if refilter:
            await self._refusable(self._seti.put(path, {"events": events}), "Filter not changed")
        if remode:
            await self._refusable(self._seti.put(f"{path}/mode", {"mode": mode}), "Mode not changed")
        took = (
            f"{subject} now takes {_events_words(events)} from the {_kind(info)} {name}." if refilter else ""
        )
        text = " ".join(part for part in (took, acts.strip()) if part)
        return ToolResult(text, clip(f"Subscribed to {name}", 70))

    async def unsubscribe_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        name = name_of(info)
        target, who = await self._subscriber(args)
        existing = self._existing(info, target)
        if existing is None:
            raise ToolError(f"{who[0].upper()}{who[1:]} does not subscribe to {name}.", "Not subscribed")
        if not await self._cleared(args, gate_key("unsubscribe_channel", info.get("id"), existing.get("id"))):
            effect = f"This stops the {_kind(info)} {name} delivering its events to {who}."
            return ask("unsubscribe_channel", args, effect, f"unsubscribe {who} from {name}")
        await self._seti.delete(f"/channels/{info.get('id')}/subscriptions/{existing.get('id')}")
        return ToolResult(
            f"Unsubscribed {who} from the {_kind(info)} {name}.", clip(f"Unsubscribed from {name}", 70)
        )

    async def delete_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._channel(args)
        name = name_of(info)
        kind = _kind(info)
        if not await self._cleared(args, gate_key("delete_channel", info.get("id"))):
            what = (
                "Seti stops running it"
                if kind in ("poller", "reminder")
                else "its URL stops working, so its sender's deliveries fail"
            )
            effect = (
                f"This deletes the {kind} {name}: {what}, and its events and deliveries go with it. It "
                "cannot be undone."
            )
            return ask("delete_channel", args, effect, f"delete {kind} {name}")
        await self._seti.delete(f"/channels/{info.get('id')}")
        return ToolResult(f"Deleted the {kind} {name}.", clip(f"Deleted {kind} {name}", 70))

    async def test_channel(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._webhook(args)
        name = name_of(info)
        if not await self._cleared(args, gate_key("test_channel", info.get("id"))):
            reach = (
                " and it reaches its subscribers like a real event"
                if dicts(info.get("subscriptions"))
                else ""
            )
            effect = (
                f"This sends {name} a signed sample event through the same checks as a real delivery{reach}."
            )
            return ask("test_channel", args, effect, f"test webhook {name}")
        try:
            after = await self._seti.post(f"/channels/{info.get('id')}/test")
        except SetiError as e:
            if e.status == 500:
                raise ToolError(f"The test of {name} failed: {e.detail or e.title}", "Test refused") from e
            raise
        deliveries = dicts(after.get("deliveries")) if isinstance(after, dict) else []
        outcome = f" It was {_delivery(deliveries[0], self._now())}." if deliveries else ""
        return ToolResult(f"Sent a test event to {name}.{outcome}", clip(f"Tested webhook {name}", 70))

    async def rotate_channel_secret(self, args: Mapping[str, Any]) -> ToolResult:
        info = await self._webhook(args)
        name = name_of(info)
        if _sender_issued(info):
            label = _preset(info)
            raise ToolError(
                f"{label} issues the secret of {name}, so Seti cannot rotate it: the user makes a new one in "
                f"{label} and pastes it in Settings, Channels, with Rotate on this webhook.",
                "Sender issues the secret",
            )
        if not await self._cleared(args, gate_key("rotate_channel_secret", info.get("id"))):
            effect = (
                f"This has Seti issue a new secret for {name}. The old one stops working now, so its "
                "sender's deliveries are refused until the user copies the new one from Settings, Channels "
                "into the sender. You never see it."
            )
            return ask("rotate_channel_secret", args, effect, f"rotate secret of {name}")
        rotated = await self._refusable(self._seti.post(f"/channels/{info.get('id')}/rotate"), "Not rotated")
        after = rotated.get("channel") if isinstance(rotated, dict) else None
        state = _secret_state(after) if isinstance(after, dict) else ""
        return ToolResult(
            f"Rotated the secret of {name}. {state}".strip(), clip(f"Rotated secret of {name}", 70)
        )

    async def _archive_status(self, days: int | None = None) -> dict[str, Any]:
        status = await self._seti.get("/archive/settings", {"days": days} if days else None)
        return status if isinstance(status, dict) else {}

    @staticmethod
    def _rule(settings: Mapping[str, Any]) -> str:
        days = plural(int(settings.get("days") or 0), "day")
        if settings.get("enabled") is True:
            return f"on: complete agents idle {days} or more are archived"
        return f"off; when on, it archives complete agents idle {days} or more"

    @staticmethod
    def _delete_rule(settings: Mapping[str, Any]) -> str:
        days = settings.get("delete_after_days")
        if isinstance(days, int) and days > 0:
            return f"Archived agents are deleted with their files {plural(days, 'day')} after archiving."
        return "Archived agents are kept until deleted by hand."

    @staticmethod
    def _resume_rule(settings: Mapping[str, Any]) -> str:
        if settings.get("resume_after_restart") is False:
            return "Agents a Seti restart cuts off wait for the user to retry or reply."
        return (
            "Agents a Seti restart cuts off get one message to check their work and go on, "
            "unless they were waiting on the user."
        )

    @staticmethod
    def _guard_rule(settings: Mapping[str, Any]) -> str:
        if settings.get("repeat_guard") is False:
            return "Agents may repeat a call that keeps giving the same result without asking."
        return (
            "An agent that runs the same call again after 2 identical results waits for the user to allow it."
        )

    def _flag_changes(self, before: Mapping[str, Any], after: Mapping[str, Any]) -> list[str]:
        rules = (("resume_after_restart", self._resume_rule), ("repeat_guard", self._guard_rule))
        return [
            rule(after)
            for key, rule in rules
            if (before.get(key) is not False) != (after.get(key) is not False)
        ]

    @staticmethod
    def _stale_words(report: Mapping[str, Any]) -> list[str]:
        folders = dicts(report.get("folders"))
        if not folders:
            return [f"No stale folder unchanged for {plural(int(report.get('days') or 0), 'day')}."]
        lines = [
            f"{plural(len(folders), 'stale folder')} no agent owns, "
            f"{size_words(report.get('total_bytes'))} in all, largest first:"
        ]
        for f in folders[:LIST_LIMIT]:
            kind = {"repo": ", a checkout", "worktree": ", a worktree"}.get(str(f.get("checkout")), "")
            busy = f", in use: {f.get('busy')}" if f.get("busy") else ""
            lines.append(f"- {f.get('path')}: {size_words(f.get('bytes'))}{kind}{busy}")
        if len(folders) > LIST_LIMIT:
            lines.append(f"And {len(folders) - LIST_LIMIT} smaller ones not listed.")
        return lines

    @staticmethod
    def _days_arg(args: Mapping[str, Any], name: str) -> int | None:
        value = args.get(name)
        if isinstance(value, int | str) and not isinstance(value, bool) and str(value).strip().isdigit():
            return int(str(value).strip())
        return None

    def _candidates(self, preview: Mapping[str, Any]) -> str:
        tasks = dicts(preview.get("tasks"))
        count = int(preview.get("count") or 0)
        if count == 0:
            return "no agent"
        now = self._now()
        named = and_list(
            [f"{title_of(t)} (idle since {ago(t.get('idle_since'), now)})" for t in tasks[:SHOWN]]
        )
        more = f" and {count - SHOWN} more" if count > SHOWN else ""
        return f"{plural(count, 'agent')}: {named}{more}"

    async def get_archive_settings(self, args: Mapping[str, Any]) -> ToolResult:
        status = await self._archive_status()
        settings = field_dict(status, "settings")
        preview = field_dict(status, "preview")
        archived = field_dict(status, "archived")
        lines = [
            f"Auto-archive is {self._rule(settings)}.",
            self._delete_rule(settings),
            self._resume_rule(settings),
            self._guard_rule(settings),
            f"The rule would archive {self._candidates(preview)} now.",
            f"The archive holds {plural(int(archived.get('count') or 0), 'agent')} in "
            f"{size_words(archived.get('stored_bytes'))}, and their packed folders take "
            f"{size_words(archived.get('files_bytes'))}.",
        ]
        if arg_bool(args, "stale_folders"):
            days = self._days_arg(args, "days")
            report = await self._seti.get(
                "/archive/stale-folders", {"days": days} if days is not None else None
            )
            lines.extend(self._stale_words(report if isinstance(report, dict) else {}))
        return ToolResult("\n".join(lines), "Read archive settings")

    async def set_auto_archive(self, args: Mapping[str, Any]) -> ToolResult:
        current = (await self._archive_status()).get("settings")
        settings = current if isinstance(current, dict) else {}
        enabled = arg_bool(args, "enabled") if "enabled" in args else settings.get("enabled") is True
        days = self._days_arg(args, "days") or int(settings.get("days") or 3)
        if not 1 <= days <= 365:
            raise ToolError("Days must be between 1 and 365.", "Bad days")
        was_delete = settings.get("delete_after_days")
        delete_arg = self._days_arg(args, "delete_after_days")
        delete = was_delete if delete_arg is None else (delete_arg or None)
        if delete is not None and not 1 <= int(delete) <= 3650:
            raise ToolError("Delete days must be between 1 and 3650, or 0 to keep them.", "Bad days")
        flags = {
            key: arg_bool(args, key) if key in args else settings.get(key) is not False
            for key in ("resume_after_restart", "repeat_guard")
        }
        body = {"enabled": enabled, "days": days, "delete_after_days": delete, **flags}
        rule_same = enabled == (settings.get("enabled") is True) and days == settings.get("days")
        changed = self._flag_changes(settings, body)
        if rule_same and delete == was_delete and not changed:
            raise ToolError(
                f"Auto-archive is already {self._rule(settings)}. {self._delete_rule(settings)} "
                f"{self._resume_rule(settings)} {self._guard_rule(settings)}",
                "Nothing to change",
            )
        if not await self._cleared(args, gate_key("set_auto_archive", body)):
            if rule_same and delete == was_delete:
                effect = " ".join(changed)
            elif delete != was_delete:
                effect = (
                    f"{self._delete_rule(body)} Deleting removes an agent's transcript, folders and "
                    f"bundle for good. Auto-archive is {self._rule(body)}."
                )
            elif enabled:
                preview = (await self._archive_status(days)).get("preview")
                now_words = self._candidates(preview if isinstance(preview, dict) else {})
                effect = (
                    f"This turns auto-archive on for complete agents idle {plural(days, 'day')} or more. "
                    f"Seti checks now and then; right now it would archive {now_words}. Archived "
                    "agents can be restored."
                )
            else:
                effect = "This turns auto-archive off; no agent is archived on its own until it is on again."
            return ask("set_auto_archive", args, effect, "change auto-archive")
        saved = await self._refusable(self._seti.put("/archive/settings", body), "Not changed")
        after = saved.get("settings") if isinstance(saved, dict) else None
        now_set = after if isinstance(after, dict) else body
        flipped = "".join(f" {line}" for line in self._flag_changes(settings, now_set))
        return ToolResult(
            f"Auto-archive is now {self._rule(now_set)}. {self._delete_rule(now_set)}{flipped}",
            "Changed auto-archive",
        )

    async def _delete_stale_folders(self, args: Mapping[str, Any], paths: list[str]) -> ToolResult:
        days = self._days_arg(args, "days")
        body: dict[str, Any] = {"paths": paths, "confirm": True}
        if days is not None:
            body["days"] = days
        if not await self._cleared(args, gate_key("run_archive_sweep", body)):
            effect = (
                f"This deletes {plural(len(paths), 'folder')} for good: {and_list(paths[:SHOWN])}"
                f"{f' and {len(paths) - SHOWN} more' if len(paths) > SHOWN else ''}. No agent owns them; "
                "anything in them that is not pushed is lost."
            )
            return ask("run_archive_sweep", args, effect, "delete stale folders")
        result = await self._refusable(self._seti.post("/archive/stale-folders/delete", body), "Not deleted")
        fields = result if isinstance(result, dict) else {}
        deleted = dicts(fields.get("deleted"))
        refused = dicts(fields.get("refused"))
        freed = sum(int(d.get("bytes") or 0) for d in deleted)
        text = f"Deleted {plural(len(deleted), 'folder')}, freeing {size_words(freed)}."
        if refused:
            first = refused[0]
            text += (
                f" Kept {plural(len(refused), 'folder')}: {first.get('path')} because {first.get('reason')}."
            )
        return ToolResult(text, f"Deleted {plural(len(deleted), 'stale folder')}")

    async def run_archive_sweep(self, args: Mapping[str, Any]) -> ToolResult:
        paths = arg_list(args, "stale_folders")
        if paths:
            return await self._delete_stale_folders(args, paths)
        status = await self._archive_status()
        preview = field_dict(status, "preview")
        settings = field_dict(status, "settings")
        ids = [str(t.get("id")) for t in dicts(preview.get("tasks"))]
        if int(preview.get("count") or 0) == 0:
            raise ToolError("No agent is due for archiving now.", "Nothing to archive")
        if not await self._cleared(args, gate_key("run_archive_sweep", ids)):
            effect = (
                f"This archives {self._candidates(preview)} now, the complete agents idle "
                f"{plural(int(settings.get('days') or 0), 'day')} or more. Their folders are packed into "
                "a bundle, their worktrees are removed when clean, and each can be restored."
            )
            return ask("run_archive_sweep", args, effect, "archive idle agents")
        result = await self._seti.post("/archive/sweep")
        fields = result if isinstance(result, dict) else {}
        done = [title_of(r) for r in dicts(fields.get("archived"))]
        failed = dicts(fields.get("failed"))
        text = f"Archived {plural(len(done), 'agent')}: {and_list(done)}." if done else "Archived no agent."
        if failed:
            text += (
                f" {plural(len(failed), 'agent')} could not be: {clip(str(failed[0].get('reason')), 120)}."
            )
        return ToolResult(text, f"Archived {plural(len(done), 'agent')}")

    async def list_archived_agents(self, args: Mapping[str, Any]) -> ToolResult:
        archived = dicts(await self._seti.get("/tasks/archived"))
        if not archived:
            return ToolResult("No agent is archived.", "No archived agents")
        now = self._now()

        def at(t: Mapping[str, Any]) -> str:
            info = t.get("archive")
            return str(info.get("archived_at", "")) if isinstance(info, dict) else ""

        archived.sort(key=at, reverse=True)
        lines = [f"{plural(len(archived), 'archived agent')}, newest first:"]
        for t in archived[:LIST_LIMIT]:
            info = field_dict(t, "archive")
            by = "by the rule" if info.get("actor") == "system" else "by hand"
            lines.append(
                f"- {title_of(t)}: archived {ago(info.get('archived_at'), now)} {by}, "
                f"{plural(int(info.get('rows') or 0), 'transcript message')} in "
                f"{size_words(info.get('stored_bytes'))}"
            )
        if len(archived) > LIST_LIMIT:
            lines.append(f"And {len(archived) - LIST_LIMIT} older ones not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(archived), 'archived agent')}")

    async def write_context_file(self, args: Mapping[str, Any]) -> ToolResult:
        chosen = find_context_file(dicts(await self._seti.get("/context/files")), arg_str(args, "file"))
        name = context_file_name(chosen)
        key = str(chosen.get("key"))
        current = await self._seti.get(f"/context/files/{key}")
        fields = current if isinstance(current, dict) else {}
        before = str(fields.get("content") or "")
        replacement = arg_str(args, "content", required=False)
        appended = arg_str(args, "append", required=False)
        if not replacement and not appended:
            raise ToolError("Give the new content, or text to append.", "Nothing to write")
        content = replacement or before
        change = f"replaces its text with about {plural(len(content.split()), 'word')}" if replacement else ""
        if appended:
            content = f"{content.rstrip()}\n\n{appended}\n" if content.strip() else f"{appended}\n"
            change = and_list([c for c in (change, f'adds at its end: "{clip(appended, 200)}"') if c])
        if content == before:
            raise ToolError(f"{name} already says that.", "Nothing to change")
        if not await self._cleared(args, gate_key("write_context_file", key, content)):
            verb = "changes" if chosen.get("exists") is True else "creates"
            who = "every agent" if key == "user" else f"agents in {repo_name(str(chosen.get('group', '')))}"
            effect = f"This {verb} {name}: it {change}. {who.capitalize()} read it from their next session."
            return ask("write_context_file", args, effect, f"write {name}")
        body = {"content": content, "base_hash": fields.get("hash")}
        await self._refusable(self._seti.put(f"/context/files/{key}", body), "Not written")
        return ToolResult(f"Wrote {name}: it {change}.", clip(f"Wrote {name}", 70))

    async def _object(self, args: Mapping[str, Any]) -> tuple[str, str, str] | None:
        """The pack or file the arguments name, as type, id and spoken name."""
        named = [k for k in OBJECT_ARGS if arg_str(args, k, required=False)]
        if not named:
            return None
        if len(named) > 1:
            raise ToolError("Name one pack or file.", "Several named")
        kind = named[0]
        ref = arg_str(args, kind)
        if kind == "pack":
            pack = only(
                pick(
                    dicts(await self._seti.get("/context/packs")),
                    ref,
                    lambda p: str(p.get("id", "")),
                    name_of,
                    lambda _p: [],
                ),
                ref,
                "context pack",
                name_of,
                "Call list_context_packs.",
            )
            return "context_pack", str(pack.get("id")), f"context pack {name_of(pack)}"
        chosen = find_context_file(dicts(await self._seti.get("/context/files")), ref)
        return "context_file", str(chosen.get("key")), context_file_name(chosen)

    async def _history(self, object_type: str, object_id: str) -> list[dict[str, Any]]:
        revisions = dicts(
            await self._seti.get("/revisions", {"object_type": object_type, "object_id": object_id})
        )
        return sorted(revisions, key=lambda r: int(r.get("id") or 0), reverse=True)

    def _revision_line(self, rev: Mapping[str, Any]) -> str:
        reason = rev.get("reason") if rev.get("kind") != "note" else None
        why = f', saying "{clip(str(reason), 100)}"' if reason else ""
        when = ago(rev.get("at"), self._now())
        return f"change {rev.get('id')}, {when}: {_revision_who(rev)} {_revision_what(rev)}{why}"

    async def _names(self) -> dict[tuple[str, str], str]:
        packs, files = (
            dicts(await self._seti.get("/context/packs")),
            dicts(await self._seti.get("/context/files")),
        )
        names = {("context_pack", str(p.get("id"))): f"context pack {name_of(p)}" for p in packs}
        names |= {("context_file", str(f.get("key"))): context_file_name(f) for f in files}
        return names

    async def list_changes(self, args: Mapping[str, Any]) -> ToolResult:
        target = await self._object(args)
        if target is not None:
            object_type, object_id, label = target
            history = await self._history(object_type, object_id)
            if not history:
                return ToolResult(f"The {label} has no recorded changes.", "No changes")
            lines = [f"Changes to the {label}, newest first:"]
            lines.extend(f"- {self._revision_line(r)}" for r in history[:LIST_LIMIT])
            if len(history) > LIST_LIMIT:
                lines.append(f"And {len(history) - LIST_LIMIT} older ones not listed.")
            return ToolResult("\n".join(lines), clip(f"Read changes to {label}", 70))
        unseen = dicts(await self._seti.get("/revisions/unseen"))
        if not unseen:
            return ToolResult(
                "No change by an agent is waiting for the user to look at. Name a pack or file for its "
                "history.",
                "No unseen changes",
            )
        names = await self._names()
        lines = [
            f"{plural(len(unseen), 'object')} changed by agents since the user last looked, newest first:"
        ]
        for u in unseen[:SHOWN]:
            object_type, object_id = str(u.get("object_type")), str(u.get("object_id"))
            label = names.get(
                (object_type, object_id), f"{OBJECT_WORDS.get(object_type, '')} since deleted".strip()
            )
            rev = next(
                (
                    r
                    for r in await self._history(object_type, object_id)
                    if r.get("id") == u.get("revision_id")
                ),
                None,
            )
            lines.append(
                f"- {label}: {self._revision_line(rev)}"
                if rev
                else f"- {label}: changed {ago(u.get('at'), self._now())}"
            )
        if len(unseen) > SHOWN:
            lines.append(f"And {len(unseen) - SHOWN} more not listed.")
        return ToolResult("\n".join(lines), f"{plural(len(unseen), 'unseen change')}")

    async def revert_change(self, args: Mapping[str, Any]) -> ToolResult:
        target = await self._object(args)
        if target is None:
            raise ToolError("The pack or file argument is missing.", "Missing object")
        object_type, object_id, label = target
        history = await self._history(object_type, object_id)
        wanted = args.get("change")
        if isinstance(wanted, int | str) and not isinstance(wanted, bool) and str(wanted).strip().isdigit():
            rev = next((r for r in history if r.get("id") == int(str(wanted).strip())), None)
            if rev is None:
                raise ToolError(f"The {label} has no change {wanted}.", "No such change")
        else:
            rev = next((r for r in history if r.get("kind") == "updated"), None)
            if rev is None:
                raise ToolError(f"The {label} has no change to revert.", "Nothing to revert")
        if rev.get("kind") != "updated":
            raise ToolError(
                f"Change {rev.get('id')} did not change an existing {label}; it cannot be reverted.",
                "Cannot revert",
            )
        if not await self._cleared(args, gate_key("revert_change", rev.get("id"))):
            effect = (
                f"This undoes change {rev.get('id')} to the {label}, where {_revision_who(rev)} "
                f"{_revision_what(rev)} {ago(rev.get('at'), self._now())}: those fields go back to how they "
                "were before. It is saved as a new change by the user, which can itself be reverted."
            )
            return ask("revert_change", args, effect, f"revert change to {label}")
        await self._refusable(self._seti.post(f"/revisions/{rev.get('id')}/revert"), "Not reverted")
        return ToolResult(f"Reverted change {rev.get('id')} to the {label}.", clip(f"Reverted {label}", 70))

    async def mark_changes_seen(self, args: Mapping[str, Any]) -> ToolResult:
        target = await self._object(args)
        if target is not None:
            refs = [(target[0], target[1], target[2])]
        else:
            unseen = dicts(await self._seti.get("/revisions/unseen"))
            if not unseen:
                raise ToolError("No change by an agent is waiting to be seen.", "Nothing unseen")
            names = await self._names()
            refs = [
                (
                    str(u.get("object_type")),
                    str(u.get("object_id")),
                    names.get((str(u.get("object_type")), str(u.get("object_id"))), "a deleted object"),
                )
                for u in unseen
            ]
        labels = and_list([r[2] for r in refs[:SHOWN]]) + (
            f" and {len(refs) - SHOWN} more" if len(refs) > SHOWN else ""
        )
        if not await self._cleared(args, gate_key("mark_changes_seen", [r[:2] for r in refs])):
            effect = f"This marks the agents' changes to {labels} as seen, so Seti stops flagging them."
            return ask("mark_changes_seen", args, effect, "mark changes seen")
        for object_type, object_id, _ in refs:
            await self._seti.post("/revisions/seen", {"object_type": object_type, "object_id": object_id})
        return ToolResult(
            f"Marked the changes to {labels} as seen.", f"Marked {plural(len(refs), 'change')} seen"
        )

    async def _plugin(self, args: Mapping[str, Any]) -> dict[str, Any]:
        ref = arg_str(args, "plugin")
        plugins = dicts(await self._seti.get("/plugins/defaults"))
        found = pick(
            plugins, ref, lambda p: str(p.get("id", "")), name_of, lambda p: [str(p.get("path", ""))]
        )
        return only(found, ref, "default plugin", name_of, "Call list_plugins to see them.")

    async def add_plugin(self, args: Mapping[str, Any]) -> ToolResult:
        path = arg_str(args, "path")
        if not await self._cleared(args, gate_key("add_plugin", path)):
            effect = (
                f"This adds the plugin folder {path} as a Seti default plugin: every new agent gets "
                "its skills, commands, subagents and hooks unless it opts out."
            )
            return ask("add_plugin", args, effect, "add plugin")
        plugin = await self._refusable(
            self._seti.post("/plugins/defaults", {"path": path}), "Plugin not added"
        )
        name = name_of(plugin) if isinstance(plugin, dict) else path
        return ToolResult(
            f"Added the default plugin {name}; new agents get it.",
            clip(f"Added plugin {name}", 70),
        )

    async def remove_plugin(self, args: Mapping[str, Any]) -> ToolResult:
        plugin = await self._plugin(args)
        name = name_of(plugin)
        if not await self._cleared(args, gate_key("remove_plugin", plugin.get("id"))):
            effect = (
                f"This removes the default plugin {name} from Seti: new agents no longer get it. "
                "Its folder stays on disk."
            )
            return ask("remove_plugin", args, effect, f"remove plugin {name}")
        await self._seti.delete(f"/plugins/defaults/{plugin.get('id')}")
        return ToolResult(f"Removed the default plugin {name}.", clip(f"Removed plugin {name}", 70))

    async def set_plugin_enabled(self, args: Mapping[str, Any]) -> ToolResult:
        plugin = await self._plugin(args)
        name = name_of(plugin)
        if "enabled" not in args:
            raise ToolError("The enabled argument is missing.", "Missing enabled")
        enabled = arg_bool(args, "enabled")
        state = "on" if enabled else "off"
        if (plugin.get("enabled") is True) == enabled:
            return ToolResult(
                f"The default plugin {name} is already {state}.", f"{clip(name, 50)} already {state}"
            )
        if not await self._cleared(args, gate_key("set_plugin_enabled", plugin.get("id"), enabled)):
            effect = (
                f"This turns the default plugin {name} {state}: new agents "
                f"{'get' if enabled else 'no longer get'} it. Agents already running keep what they "
                "started with."
            )
            return ask("set_plugin_enabled", args, effect, f"turn {name} {state}")
        await self._seti.patch(f"/plugins/defaults/{plugin.get('id')}", {"enabled": enabled})
        return ToolResult(
            f"Turned the default plugin {name} {state}.", clip(f"Turned plugin {name} {state}", 70)
        )

    async def _repo(self, args: Mapping[str, Any]) -> dict[str, Any] | None:
        ref = arg_str(args, "repo", required=False)
        return resolve_repo(dicts(await self._seti.get("/repos")), ref) if ref else None

    async def _server(self, args: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None]:
        repo = await self._repo(args)
        params: dict[str, str | int] | None = {"repo_id": str(repo.get("id"))} if repo else None
        snapshot = await self._seti.get("/capabilities", params)
        servers = dicts(snapshot.get("servers")) if isinstance(snapshot, dict) else []
        ref = arg_str(args, "server")
        found = pick(servers, ref, name_of, name_of, lambda _s: [])
        return only(found, ref, "MCP server", name_of, "Call list_mcp_servers to see them."), repo

    @staticmethod
    def _scope_body(repo: Mapping[str, Any] | None) -> dict[str, Any]:
        return {"repo_id": repo.get("id")} if repo else {}

    async def add_mcp_server(self, args: Mapping[str, Any]) -> ToolResult:
        name = arg_str(args, "name")
        url = arg_str(args, "url")
        transport = normalize(arg_str(args, "transport", required=False) or "http")
        scope = normalize(arg_str(args, "scope", required=False) or "user")
        if transport not in ("http", "sse"):
            raise ToolError(
                "You add only HTTP or SSE servers; one that runs a command is added by the user in Settings, "
                "MCP servers.",
                "Remote servers only",
            )
        if scope not in MCP_SCOPES:
            raise ToolError("Scope must be user, local or project.", "Bad scope")
        repo = await self._repo(args)
        if scope != "user" and repo is None:
            raise ToolError(f"The {scope} scope belongs to a repo; ask the user which.", "No repo")
        body: dict[str, Any] = {
            "name": name,
            "scope": scope,
            "transport": transport,
            "url": url,
            "headers": [],
        }
        body |= self._scope_body(repo) if scope != "user" else {}
        where = MCP_SCOPES[scope].format(repo=repo_name(str(repo.get("slug"))) if repo else "")
        if not await self._cleared(args, gate_key("add_mcp_server", body)):
            effect = (
                f"This adds the MCP server {name} at {url} ({transport.upper()}) for {where}; they get its "
                "tools from their next session. If it needs a sign-in, that follows once it is added."
            )
            return ask("add_mcp_server", args, effect, f"add MCP server {name}")
        await self._refusable(self._seti.post("/mcp/servers", body), "Server not added")
        return ToolResult(
            f"Added the MCP server {name} for {where}. Call list_mcp_servers with refresh to see whether it "
            "connects or needs a sign-in.",
            clip(f"Added MCP server {name}", 70),
        )

    async def remove_mcp_server(self, args: Mapping[str, Any]) -> ToolResult:
        server, repo = await self._server(args)
        name = name_of(server)
        scope = str(server.get("scope") or "")
        if scope not in MCP_REMOVABLE:
            origin = server.get("source") or scope or "outside Seti's configuration"
            raise ToolError(f"{name} comes from {origin}, so it cannot be removed here.", "Not removable")
        if scope != "user" and repo is None:
            raise ToolError(
                f"{name} is configured for one repo ({scope} scope); ask the user which.", "No repo"
            )
        if not await self._cleared(
            args, gate_key("remove_mcp_server", name, scope, repo.get("id") if repo else None)
        ):
            effect = (
                f"This removes the MCP server {name} ({scope} scope): agents no longer get its tools "
                "from their next session."
            )
            return ask("remove_mcp_server", args, effect, f"remove MCP server {name}")
        params: dict[str, str | int] = {"scope": scope}
        if repo is not None:
            params["repo_id"] = str(repo.get("id"))
        await self._seti.delete(f"/mcp/servers/{name}", params)
        return ToolResult(f"Removed the MCP server {name}.", clip(f"Removed MCP server {name}", 70))

    async def reconnect_mcp_server(self, args: Mapping[str, Any]) -> ToolResult:
        server, repo = await self._server(args)
        name = name_of(server)
        after = await self._seti.post(f"/mcp/{name}/reconnect", self._scope_body(repo))
        fields = after if isinstance(after, dict) else server
        status = str(fields.get("status"))
        words = {
            "connected": f"connected, with {plural(len(dicts(fields.get('tools'))), 'tool')}",
            "needs-auth": "waiting for a sign-in",
            "failed": f"failing: {clip(str(fields.get('error') or 'no reason given'), 160)}",
        }.get(status, status)
        return ToolResult(f"Checked {name} again: it is {words}.", clip(f"Reconnected {name}: {status}", 70))

    async def start_mcp_sign_in(self, args: Mapping[str, Any]) -> ToolResult:
        server, repo = await self._server(args)
        name = name_of(server)
        if server.get("status") == "connected" and server.get("sign_in") != "again":
            return ToolResult(
                f"{name} is already connected; no sign-in is needed.", f"{clip(name, 50)} connected"
            )
        transport = server.get("transport")
        kind = transport.get("type") if isinstance(transport, dict) else None
        in_settings = (
            f"Signing in to {name} happens in Settings, MCP servers: the user presses Sign in there, "
            "approves "
            "in the browser and pastes back the address it returns."
        )
        if kind != "claudeai-proxy":
            raise ToolError(in_settings, "Sign in from Settings")
        if not await self._cleared(args, gate_key("start_mcp_sign_in", name)):
            effect = (
                f"This starts the sign-in to {name} and gives you a link for the user to open and "
                "approve on claude.ai."
            )
            return ask("start_mcp_sign_in", args, effect, f"sign in to {name}")
        started = await self._refusable(
            self._seti.post(f"/mcp/{name}/auth/start", self._scope_body(repo)), "No sign-in"
        )
        fields = started if isinstance(started, dict) else {}
        if fields.get("callback_expected") is not False:
            await self._seti.delete(f"/mcp/auth/{fields.get('session_id')}")
            raise ToolError(in_settings, "Sign in from Settings")
        return ToolResult(
            f"Started the sign-in to {name}. Give the user this link to open in their browser: "
            f"{fields.get('authorization_url')} Approving there finishes it; nothing to paste back. "
            "In a call, "
            "say the link is in the chat.",
            clip(f"Sign-in link for {name}", 70),
        )

    async def list_sessions(self, args: Mapping[str, Any]) -> ToolResult:
        query = arg_str(args, "query", required=False)
        params: dict[str, str | int] = {"limit": SESSION_PAGE}
        if query:
            params["q"] = query
        page = await self._seti.get("/sessions", params)
        sessions = dicts(page.get("sessions")) if isinstance(page, dict) else []
        total = int(page.get("total") or 0) if isinstance(page, dict) else 0
        matching = f' matching "{clip(query, 40)}"' if query else ""
        if not sessions:
            return ToolResult(f"No importable session{matching}.", "No sessions")
        now = self._now()
        lines = [f"{plural(total, 'session')}{matching}, newest first:"]
        for s in sessions:
            where = (
                repo_name(str(s.get("repo_slug"))) if s.get("repo_slug") else str(s.get("cwd") or "no folder")
            )
            branch = f", branch {s.get('git_branch')}" if s.get("git_branch") else ""
            pr = s.get("suggested_pr")
            pr_text = f", open PR {pr.get('key') or pr.get('number')}" if isinstance(pr, dict) else ""
            lines.append(
                f"- {clip(str(s.get('title')), 80)}: {where}{branch}{pr_text}, "
                f"active {ago(s.get('last_modified'), now)}"
            )
        if total > len(sessions):
            lines.append(f"And {total - len(sessions)} older ones not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(total, 'session')}")

    async def import_sessions(self, args: Mapping[str, Any]) -> ToolResult:
        refs = arg_list(args, "sessions")
        if not refs:
            raise ToolError("The sessions argument is missing.", "Missing sessions")
        if len(refs) > 10:
            raise ToolError("Import at most 10 sessions at once.", "Too many sessions")
        page = await self._seti.get("/sessions", {"limit": SESSION_SCAN})
        known = dicts(page.get("sessions")) if isinstance(page, dict) else []
        chosen: list[dict[str, Any]] = []
        for ref in refs:
            found = pick(
                known, ref, lambda s: str(s.get("id", "")), lambda s: str(s.get("title", "")), lambda _s: []
            )
            session = only(
                found, ref, "session", lambda s: clip(str(s.get("title")), 60), "Call list_sessions."
            )
            if session not in chosen:
                chosen.append(session)
        repo = await self._repo(args)
        items = [{"session_id": s.get("id"), **({"repo_id": repo.get("id")} if repo else {})} for s in chosen]
        titles = [clip(str(s.get("title")), 60) for s in chosen]
        if not await self._cleared(args, gate_key("import_sessions", items)):
            where = f", running in {repo_name(str(repo.get('slug')))}" if repo else ""
            effect = (
                f"This imports {plural(len(chosen), 'session')} as agents{where}: {and_list(titles)}. "
                "Each keeps "
                "its conversation and is linked to the PRs it opened and its branch's open PR."
            )
            return ask("import_sessions", args, effect, f"import {plural(len(chosen), 'session')}")
        results = dicts(
            await self._refusable(self._seti.post("/sessions/import", {"sessions": items}), "Not imported")
        )
        by_id = {str(s.get("id")): clip(str(s.get("title")), 60) for s in chosen}
        done = [by_id.get(str(r.get("session_id")), "a session") for r in results if r.get("task_id")]
        failed = [
            f"{by_id.get(str(r.get('session_id')), 'a session')} ({r.get('error')})"
            for r in results
            if not r.get("task_id")
        ]
        text = (
            f"Imported {plural(len(done), 'session')} as agents: {and_list(done)}."
            if done
            else "Imported nothing."
        )
        if failed:
            text += f" Not imported: {and_list(failed)}."
        return ToolResult(text, f"Imported {plural(len(done), 'session')}")

    async def resource_usage(self, args: Mapping[str, Any]) -> ToolResult:
        data = await self._seti.get("/resources")
        res = data if isinstance(data, dict) else {}
        host = field_dict(res, "host")
        memory = field_dict(host, "memory")
        swap = field_dict(host, "swap")
        total = int(memory.get("total_bytes") or 0)
        used = int(memory.get("used_bytes") or 0)
        cpu = host.get("cpu_percent")
        load = field_list(host, "load")
        cpu_text = (
            f"CPU {round(cpu)} percent busy across {host.get('cpus')} cores"
            if isinstance(cpu, int | float)
            else "CPU unknown"
        )
        load_text = f", load {load[0]:.1f}" if load and isinstance(load[0], int | float) else ""
        lines = [
            f"{cpu_text}{load_text}. Memory {round(100 * used / total) if total else 0} percent used "
            f"({size_words(used)} of {size_words(total)}); swap {size_words(swap.get('used_bytes'))} used."
        ]
        disks = [
            f"{d.get('mount')} {round(float(d.get('used_percent') or 0))} percent full, "
            f"{size_words(d.get('free_bytes'))} free"
            for d in dicts(host.get("disks"))[:3]
        ]
        if disks:
            lines.append(f"Disks: {'; '.join(disks)}.")
        components = dicts(res.get("components"))
        down = [str(c.get("name")) for c in components if c.get("state") == "down"]
        up = [
            f"{c.get('name')} {size_words(c.get('rss_bytes'))}" for c in components if c.get("state") == "up"
        ]
        lines.append(f"Services: {and_list(up) or 'none up'}{'; down: ' + and_list(down) if down else ''}.")
        procs = sorted(dicts(res.get("tasks")), key=lambda p: -int(p.get("rss_bytes") or 0))
        if procs:
            top = []
            for p in procs[:3]:
                task = p.get("task")
                label = title_of(task) if isinstance(task, dict) else "no agent"
                tool = p.get("tool")
                doing = f", in {tool.get('name')}" if isinstance(tool, dict) else ""
                top.append(f"{label} {size_words(p.get('rss_bytes'))}{doing}")
            totals = field_dict(res, "totals")
            lines.append(
                f"{plural(len(procs), 'Claude Code process', 'Claude Code processes')} use "
                f"{size_words(totals.get('rss_bytes'))}; the largest: {'; '.join(top)}."
            )
        anomalies = dicts(res.get("anomalies"))
        if anomalies:
            lines.append(f"Warnings: {'; '.join(clip(str(a.get('message')), 120) for a in anomalies[:4])}.")
        else:
            lines.append("No resource warnings.")
        return ToolResult("\n".join(lines), "Read resource usage")

    async def _ea_settings(self) -> dict[str, Any]:
        settings = await self._seti.get("/ea/settings")
        return settings if isinstance(settings, dict) else {}

    @staticmethod
    def _wake_words(settings: Mapping[str, Any]) -> str:
        stay = plural(int(settings.get("keep_awake_seconds") or 0), "second")
        if settings.get("wake_enabled") is True:
            return (
                f'Your wake word is on: on a call you answer after hearing "{settings.get("wake_phrase")}", '
                f"and stay awake {stay} after the last words."
            )
        phrase = settings.get("wake_phrase")
        return f'Your wake word is off; its phrase is "{phrase}", with {stay} awake after it.'

    @staticmethod
    def _address_words(settings: Mapping[str, Any]) -> str:
        address = str(settings.get("form_of_address") or "")
        if not address:
            return "You address the user with no title."
        return f'You address the user as "{address}" now and then.'

    def _settings_words(self, settings: Mapping[str, Any]) -> str:
        return f"{self._wake_words(settings)} {self._address_words(settings)}"

    async def get_ea_settings(self, args: Mapping[str, Any]) -> ToolResult:
        text = self._settings_words(await self._ea_settings())
        return ToolResult(
            f"{text} Your voice and models are set in your configuration, not here.", "Read EA settings"
        )

    async def update_ea_settings(self, args: Mapping[str, Any]) -> ToolResult:
        current = await self._ea_settings()
        body = {
            "wake_enabled": current.get("wake_enabled") is True,
            "wake_phrase": str(current.get("wake_phrase") or "Hey Seti"),
            "keep_awake_seconds": int(current.get("keep_awake_seconds") or 30),
            "form_of_address": str(current.get("form_of_address") or ""),
        }
        if "wake_enabled" in args:
            body["wake_enabled"] = arg_bool(args, "wake_enabled")
        phrase = arg_str(args, "wake_phrase", required=False)
        if phrase:
            body["wake_phrase"] = phrase
        seconds = args.get("keep_awake_seconds")
        if (
            isinstance(seconds, int | str)
            and not isinstance(seconds, bool)
            and str(seconds).strip().isdigit()
        ):
            body["keep_awake_seconds"] = int(str(seconds).strip())
            low, high = KEEP_AWAKE_RANGE
            if not low <= body["keep_awake_seconds"] <= high:
                raise ToolError(f"Stay awake between {low} and {high} seconds.", "Bad seconds")
        if "form_of_address" in args:
            body["form_of_address"] = form_of_address(args)
        if all(body[k] == current.get(k) for k in body):
            raise ToolError("That changes nothing in your settings.", "Nothing to change")
        if not await self._cleared(args, gate_key("update_ea_settings", body)):
            effect = f"This changes your settings. Afterwards: {self._settings_words(body)}"
            return ask("update_ea_settings", args, effect, "change EA settings")
        saved = await self._refusable(self._seti.put("/ea/settings", body), "Settings not changed")
        after = saved if isinstance(saved, dict) else body
        return ToolResult(f"Done. {self._settings_words(after)}", "Changed EA settings")

    async def get_security_settings(self, args: Mapping[str, Any]) -> ToolResult:
        status = await self._seti.get("/sandbox")
        fields = status if isinstance(status, dict) else {}
        policy = field_dict(fields, "policy")
        domains = [str(d) for d in policy.get("allowed_domains") or []]
        hidden = [str(p) for p in policy.get("hidden_paths") or []]
        if policy.get("enabled") is True:
            sandbox = (
                "The sandbox is on: agents run in Claude Code's sandbox and reach "
                f"{plural(len(domains), 'allowed domain')} "
                f"on the network ({and_list(domains[:4])}{' and more' if len(domains) > 4 else ''})."
            )
        else:
            sandbox = (
                "The sandbox is off: agents run with the user's full access to this machine and network."
            )
        hides = f" It also hides {and_list(hidden[:4])} from agents." if hidden else ""
        token = (
            "Agents' GitHub requests use a fine-grained token from their credential."
            if fields.get("token_mode") == "agent"
            else "No GitHub token is set for agents."
        )
        return ToolResult(
            f"{sandbox}{hides} {token} These are the user's to change, in Settings under Security: Sandbox, "
            "SSH and Credentials, and per agent in its access switches. You cannot change them or see any "
            "secret.",
            "Read security settings",
        )
