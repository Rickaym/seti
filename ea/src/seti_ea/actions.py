"""Tools that change agents, PRs, context packs and repos through the routes the UI uses."""

import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any, Protocol

from seti_ea.access_tools import ACCESS_SPECS, AccessTools
from seti_ea.format import (
    PR_URL,
    ago,
    and_list,
    clip,
    plural,
    pr_label,
    repo_name,
    size_words,
)
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.handoff_tools import SEND_FILE_SPEC, HandoffTools
from seti_ea.location_tools import LOCATION_SPECS, LocationTools
from seti_ea.my_pack_tools import CHANGE_MY_PACKS_SPEC, MyPackTools
from seti_ea.process_tools import STOP_PROCESS_SPEC, ProcessTools
from seti_ea.role_tools import ROLE_SPECS, RoleTools
from seti_ea.seti import SetiClient, SetiError
from seti_ea.settings_tools import SETTINGS_SPECS, SETTINGS_WRITES
from seti_ea.toolkit import (
    TASK_REF,
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_str,
    dicts,
    key_words,
    name_of,
    normalize,
    only,
    pick,
    queued_update_rows,
    resolve_repo,
    running_subagents,
    title_of,
)
from seti_ea.workspace_tools import WORKSPACE_SPECS, WorkspaceTools

PREVIEW_LABEL = "preview"
# Attention tiers, most to least pressing, and where each can reach the user.
TIERS = ("urgent", "active", "digest", "passive")
TIER_SURFACES = ("push", "toast", "brief", "off")
UPDATE_MODES = {
    "wake": "PR updates wake the agent and start a turn",
    "queue": "PR updates wait for the user's next message",
    "off": "PR updates are ignored",
}
AGENT_COLORS = {
    "red": "#e8605b",
    "orange": "#e77f3e",
    "amber": "#e4a339",
    "yellow": "#d4be52",
    "lime": "#95c352",
    "green": "#4eb068",
    "teal": "#3baca6",
    "cyan": "#30b1c4",
    "sky": "#37a4d5",
    "blue": "#5488ec",
    "indigo": "#7e74e1",
    "violet": "#b066da",
    "magenta": "#cb57be",
    "pink": "#e05b9e",
}
COLOR_ALIASES = {
    "crimson": "red",
    "scarlet": "red",
    "maroon": "red",
    "coral": "orange",
    "peach": "orange",
    "gold": "amber",
    "mustard": "yellow",
    "chartreuse": "lime",
    "olive": "lime",
    "emerald": "green",
    "mint": "green",
    "turquoise": "teal",
    "aqua": "cyan",
    "azure": "sky",
    "light blue": "sky",
    "navy": "indigo",
    "lavender": "indigo",
    "purple": "violet",
    "mauve": "violet",
    "fuchsia": "magenta",
    "rose": "pink",
    "clear": "none",
    "no colour": "none",
    "no color": "none",
    "off": "none",
}
HEX_COLOR = re.compile(r"#([0-9a-f]{3}|[0-9a-f]{6})")
MODE_ALIASES = {"wait": "queue", "hold": "queue", "ignore": "off", "none": "off", "start": "wake"}
RESTORES = {
    "conversation": "the conversation",
    "code": "the files",
    "both": "the conversation and the files",
}
LATEST = frozenset({"latest", "last", "newest", "most recent", "recent", "last prompt", "previous"})
PR_REF_WORDS = frozenset({"pr", "prs", "pull", "request", "its", "their", "it", "linked", "number", "no"})
FILES_SHOWN = 6
SOURCE_WORDS = {
    "pr": "PR update",
    "team": "group chat message",
    "channel": "channel event",
    "workspace": "workspace notice",
}

PR_REF = {
    "type": "string",
    "description": "Repo and number such as seti PR 28, a PR URL, or a PR title.",
}
SUBAGENT_REF = {
    "type": "string",
    "description": "Only for a subagent of the task: its description as the user said it, or latest.",
}
PACK_REF = {"type": "string", "description": "The context pack's name as the user said it."}
REPO_REF = {"type": "string", "description": "The repo's name or owner/name slug."}

ACTION_SPECS: list[ToolSpec] = [
    ToolSpec(
        "rename_agent",
        "Give an agent a new title. Its group chat handle stays as it is.",
        {"task": TASK_REF, "title": {"type": "string", "description": "The new title."}},
        ["task", "title"],
    ),
    ToolSpec(
        "pin_agent",
        "Pin or unpin an agent. A pinned agent is long-running: listed first, and never archived "
        "or cleaned up on its own.",
        {"task": TASK_REF, "pinned": {"type": "boolean", "description": "true to pin, false to unpin."}},
        ["task", "pinned"],
    ),
    ToolSpec(
        "set_agent_color",
        "Mark an agent with a colour so the user recognises it: a stripe on its row, a tint behind "
        "its header, its panel frame and its reply box. Seti adapts the colour to each theme "
        "and gives each new agent a preset the other agents use least. none clears it.",
        {
            "task": TASK_REF,
            "color": {
                "type": "string",
                "description": f"A hex such as #3b82f6 or #38f, a preset ({', '.join(AGENT_COLORS)}), "
                "an everyday name such as purple or navy, which picks the nearest preset, or none.",
            },
        },
        ["task", "color"],
    ),
    ToolSpec(
        "delete_agent",
        "Permanently delete an agent, archived or not: its transcript, its worktree, the folders Seti "
        "made for it, its archive bundle and its session. "
        "Needs the user's yes.",
        {"task": TASK_REF, "confirmed": CONFIRMED},
        ["task"],
    ),
    ToolSpec(
        "archive_agent",
        "Archive an agent: it leaves the agent list and takes no work, its transcript is compressed "
        "and read-only, the folders Seti made for it are packed into a bundle, and its worktree is "
        "removed when it is clean. restore_agent brings "
        "it back. Needs the user's yes.",
        {
            "task": TASK_REF,
            "keep_worktree": {"type": "boolean", "description": "Keep its worktree on disk. Default false."},
            "confirmed": CONFIRMED,
        },
        ["task"],
    ),
    ToolSpec(
        "restore_agent",
        "Bring an archived agent back to the agent list with its transcript and worktree.",
        {"task": {"type": "string", "description": "The archived agent's title as the user said it."}},
        ["task"],
    ),
    ToolSpec(
        "set_update_mode",
        "Choose what an agent does with updates on its linked PRs (CI, reviews, comments): wake starts "
        "a turn, queue holds them for the user's next message, off ignores them.",
        {
            "task": TASK_REF,
            "mode": {"type": "string", "enum": list(UPDATE_MODES), "description": "wake, queue or off."},
        },
        ["task", "mode"],
    ),
    ToolSpec(
        "rewind_agent",
        "Take an idle agent back to just before an earlier prompt: its conversation, the files it "
        "edited since, or both. Needs the user's yes.",
        {
            "task": TASK_REF,
            "prompt": {
                "type": "string",
                "description": "Words from the prompt to go back to, or latest for the last one.",
            },
            "restore": {
                "type": "string",
                "enum": list(RESTORES),
                "description": "conversation (default), code, or both.",
            },
            "confirmed": CONFIRMED,
        },
        ["task", "prompt"],
    ),
    ToolSpec(
        "take_back_message",
        "Take back a message queued for a running agent before the agent reads it.",
        {
            "task": TASK_REF,
            "message": {
                "type": "string",
                "description": "Words from the queued message, when several are queued.",
            },
        },
        ["task"],
    ),
    ToolSpec(
        "dismiss_updates",
        "Dismiss the updates waiting for a task (PR CI, reviews, comments, group chat, channel "
        "events) instead of handing them over: its agent never gets them, and they stay in its "
        "transcript marked dismissed. Needs the user's yes.",
        {"task": TASK_REF, "confirmed": CONFIRMED},
        ["task"],
    ),
    ToolSpec(
        "stop_background_work",
        "End an agent's background work: the subagents and commands still running after its turn. "
        "Needs the user's yes.",
        {"task": TASK_REF, "confirmed": CONFIRMED},
        ["task"],
    ),
    ToolSpec(
        "restart_agent_session",
        "Restart an agent's Claude Code session, as when its MCP servers failed to connect, a sign-in "
        "or config change should take effect, or it seems stuck: the conversation is kept, and its "
        "background shells, processes and subagents end. A running turn stops first. With fresh, the "
        "agent starts a new session that forgets the conversation instead. Needs the user's yes.",
        {
            "task": TASK_REF,
            "fresh": {
                "type": "boolean",
                "description": "true to start a fresh session without the conversation.",
            },
            "confirmed": CONFIRMED,
        },
        ["task"],
    ),
    ToolSpec(
        "retry_agent_turn",
        "Send an agent's last message again, as after a turn that failed or that a Seti restart cut "
        "off, like the Retry turn button under its transcript.",
        {"task": TASK_REF},
        ["task"],
    ),
    ToolSpec(
        "stop_subagent",
        "Stop one running subagent of an agent. Needs the user's yes.",
        {
            "task": TASK_REF,
            "subagent": {**SUBAGENT_REF, "description": "The subagent's description, or latest."},
            "confirmed": CONFIRMED,
        },
        ["task", "subagent"],
    ),
    ToolSpec(
        "set_agent_group_chat",
        "Mute or unmute an agent in the group chat, or change its @handle there.",
        {
            "task": TASK_REF,
            "muted": {"type": "boolean", "description": "true to mute, false to unmute."},
            "handle": {"type": "string", "description": "A new handle: lowercase letters, digits, hyphens."},
        },
        ["task"],
    ),
    ToolSpec(
        "set_notifications",
        "Mute or unmute one agent's notifications (task with muted), or choose where each attention "
        "tier reaches the user: push (a phone push while away, a toast while Seti has focus, this "
        "call while one is live), toast (only Seti with focus, else the brief), brief (only the "
        "since-you-left brief) or off. What is left out stays as it is; the answer tells the tiers.",
        {
            "task": {**TASK_REF, "description": "The agent to mute or unmute."},
            "muted": {
                "type": "boolean",
                "description": "With task: true mutes its notifications, false unmutes.",
            },
            "urgent": {
                "type": "string",
                "enum": ["push", "toast"],
                "description": "Agents that need the user, failed turns and CI, critical alerts.",
            },
            "active": {
                "type": "string",
                "enum": list(TIER_SURFACES),
                "description": "Turns of agents you do not watch, reminders, mentions and alerts.",
            },
            "digest": {
                "type": "string",
                "enum": list(TIER_SURFACES),
                "description": "A watched agent's routine news: a finished turn, CI passed, a merge.",
            },
            "passive": {
                "type": "string",
                "enum": list(TIER_SURFACES),
                "description": "What only informs you, such as a linked PR.",
            },
        },
        [],
    ),
    ToolSpec(
        "link_pr",
        "Link a pull request to an agent, or to one of its subagents, so its CI, reviews and comments "
        "reach the agent as updates.",
        {"task": TASK_REF, "pr": PR_REF, "subagent": SUBAGENT_REF},
        ["task", "pr"],
    ),
    ToolSpec(
        "unlink_pr",
        "Unlink a pull request from an agent or one of its subagents; Seti then never links it to that "
        "agent again on its own. Needs the user's yes.",
        {"task": TASK_REF, "pr": PR_REF, "subagent": SUBAGENT_REF, "confirmed": CONFIRMED},
        ["task", "pr"],
    ),
    ToolSpec(
        "start_agent_from_pr",
        "Start a new agent in a worktree of an open PR's branch, linked to the PR. Needs the user's yes.",
        {
            "pr": PR_REF,
            "instructions": {"type": "string", "description": "What the agent should do on the PR."},
            "title": {"type": "string", "description": "A title, if the user gave one."},
            "confirmed": CONFIRMED,
        },
        ["pr", "instructions"],
    ),
    ToolSpec(
        "request_preview",
        "Request a preview: adds the preview label to an open PR on GitHub, or removes and re-adds it, "
        "so the preview workflow deploys the head commit. Needs the user's yes.",
        {"pr": PR_REF, "confirmed": CONFIRMED},
        ["pr"],
    ),
    ToolSpec(
        "link_context_pack",
        "Include a context pack in an agent's instructions from its next turn.",
        {"task": TASK_REF, "pack": PACK_REF},
        ["task", "pack"],
    ),
    ToolSpec(
        "unlink_context_pack",
        "Stop including a context pack in an agent's instructions. Needs the user's yes.",
        {"task": TASK_REF, "pack": PACK_REF, "confirmed": CONFIRMED},
        ["task", "pack"],
    ),
    ToolSpec(
        "create_context_pack",
        "Create a context pack: reusable instructions agents can include.",
        {
            "name": {"type": "string", "description": "A short name."},
            "description": {"type": "string", "description": "One line on what it is for."},
            "body": {"type": "string", "description": "The instructions, in markdown."},
        },
        ["name", "body"],
    ),
    ToolSpec(
        "update_context_pack",
        "Change a context pack: rename it, change its description, replace its body or add text at its "
        "end, or whether new agents get it by default. Agents that include it read the change. The "
        "built-in Seti guide takes only the default. Needs the user's yes.",
        {
            "pack": PACK_REF,
            "name": {"type": "string", "description": "A new name."},
            "description": {"type": "string", "description": "A new description."},
            "body": {"type": "string", "description": "A new body replacing the whole text."},
            "append": {"type": "string", "description": "Text to add at the end of the body."},
            "linked_by_default": {
                "type": "boolean",
                "description": "true links it to new agents by default, false stops that.",
            },
            "confirmed": CONFIRMED,
        },
        ["pack"],
    ),
    ToolSpec(
        "delete_context_pack",
        "Permanently delete a context pack; the built-in Seti guide cannot be deleted. Needs the user's yes.",
        {"pack": PACK_REF, "confirmed": CONFIRMED},
        ["pack"],
    ),
    ToolSpec(
        "add_repo",
        "Register a local git checkout as a repo agents can run in.",
        {
            "slug": {"type": "string", "description": "The GitHub owner/name, such as acme/web."},
            "path": {"type": "string", "description": "The absolute path of the checkout."},
            "base_branch": {"type": "string", "description": "The branch PRs go into, such as main."},
        },
        ["slug", "path", "base_branch"],
    ),
    ToolSpec(
        "update_repo",
        "Change a registered repo's path, base branch or slug. Needs the user's yes.",
        {
            "repo": REPO_REF,
            "path": {"type": "string", "description": "A new absolute checkout path."},
            "base_branch": {"type": "string", "description": "A new base branch."},
            "slug": {"type": "string", "description": "A new owner/name slug."},
            "confirmed": CONFIRMED,
        },
        ["repo"],
    ),
    ToolSpec(
        "remove_repo",
        "Remove a repo from Seti; the checkout on disk stays. Needs the user's yes.",
        {"repo": REPO_REF, "confirmed": CONFIRMED},
        ["repo"],
    ),
    *LOCATION_SPECS,
    *ROLE_SPECS,
    CHANGE_MY_PACKS_SPEC,
    *ACCESS_SPECS,
    STOP_PROCESS_SPEC,
    *WORKSPACE_SPECS,
    SEND_FILE_SPEC,
]

# Destructive or outward tools: they act only on a call after the user's next turn.
CONFIRM_TOOLS = frozenset(
    spec.name for spec in [*ACTION_SPECS, *SETTINGS_SPECS] if "confirmed" in spec.properties
)
CHANGE_TOOLS = frozenset(spec.name for spec in ACTION_SPECS) | SETTINGS_WRITES


class Resolver(Protocol):
    """How the action tools find what the user named."""

    async def match_tasks(self, ref: str) -> list[dict[str, Any]]: ...

    async def resolve_task(self, ref: str) -> dict[str, Any]: ...

    async def resolve_pr(self, ref: str) -> dict[str, Any]: ...

    async def resolve_subtask(self, task: Mapping[str, Any], ref: str) -> dict[str, Any]: ...


def _pr_url(ref: str) -> str | None:
    match = PR_URL.search(ref)
    return f"https://{match.group(0)}" if match is not None else None


def _same_pr(a: str, b: str) -> bool:
    first, second = PR_URL.search(a), PR_URL.search(b)
    return first is not None and second is not None and first.group(0).lower() == second.group(0).lower()


def _handle(value: str) -> str:
    return value.strip().lstrip("@").strip().lower()


def agent_color(value: str) -> str | None:
    """A hex, preset or everyday name as #rrggbb, none as none, and None for anything else."""
    text = value.strip().lower()
    hexed = HEX_COLOR.fullmatch(text)
    if hexed is not None:
        digits = hexed.group(1)
        return "#" + ("".join(digit * 2 for digit in digits) if len(digits) == 3 else digits)
    words = normalize(text)
    named = COLOR_ALIASES.get(words, words)
    return "none" if named == "none" else AGENT_COLORS.get(named)


def color_name(color: str) -> str:
    """The preset a colour is, or the hex called a custom colour, which reads well aloud."""
    preset = next((name for name, hex_ in AGENT_COLORS.items() if hex_ == color), None)
    return preset if preset is not None else f"a custom colour ({color})"


class AgentActions:
    """The EA's tools that change things, each through the route the Seti UI calls."""

    def __init__(self, seti: SetiClient, resolver: Resolver, now: Callable[[], datetime]) -> None:
        self._seti = seti
        self._find = resolver
        self._now = now
        self.confirmations = Confirmations(seti)
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "rename_agent": self.rename_agent,
            "pin_agent": self.pin_agent,
            "set_agent_color": self.set_agent_color,
            "delete_agent": self.delete_agent,
            "archive_agent": self.archive_agent,
            "restore_agent": self.restore_agent,
            "set_update_mode": self.set_update_mode,
            "rewind_agent": self.rewind_agent,
            "take_back_message": self.take_back_message,
            "dismiss_updates": self.dismiss_updates,
            "stop_background_work": self.stop_background_work,
            "restart_agent_session": self.restart_agent_session,
            "retry_agent_turn": self.retry_agent_turn,
            "stop_subagent": self.stop_subagent,
            "set_agent_group_chat": self.set_agent_group_chat,
            "set_notifications": self.set_notifications,
            "link_pr": self.link_pr,
            "unlink_pr": self.unlink_pr,
            "start_agent_from_pr": self.start_agent_from_pr,
            "request_preview": self.request_preview,
            "link_context_pack": self.link_context_pack,
            "unlink_context_pack": self.unlink_context_pack,
            "create_context_pack": self.create_context_pack,
            "update_context_pack": self.update_context_pack,
            "delete_context_pack": self.delete_context_pack,
            "add_repo": self.add_repo,
            "update_repo": self.update_repo,
            "remove_repo": self.remove_repo,
        }
        self.handlers.update(LocationTools(seti, resolver.resolve_task, self.confirmations).handlers)
        self.handlers.update(RoleTools(seti, resolver.resolve_task, self.confirmations).handlers)
        self.handlers.update(MyPackTools(seti, self.confirmations).handlers)
        self.handlers.update(AccessTools(seti, resolver.resolve_task, self.confirmations).handlers)
        self.handlers.update(ProcessTools(seti, resolver.resolve_task, self.confirmations, now).handlers)
        self.handlers.update(WorkspaceTools(seti, resolver.match_tasks, self.confirmations).handlers)
        self.handlers.update(HandoffTools(seti, resolver.resolve_task).handlers)

    async def _cleared(self, args: Mapping[str, Any], key: str) -> bool:
        return await self.confirmations.cleared(key, arg_bool(args, "confirmed"))

    async def _task_ref(self, args: Mapping[str, Any]) -> tuple[dict[str, Any], str]:
        task = await self._find.resolve_task(arg_str(args, "task"))
        return task, title_of(task)

    async def rename_agent(self, args: Mapping[str, Any]) -> ToolResult:
        task, old = await self._task_ref(args)
        new = arg_str(args, "title")
        if new == old:
            return ToolResult(f"The agent is already called {old}.", f"{clip(old, 50)} kept its name")
        await self._seti.patch(f"/tasks/{task.get('id')}", {"title": new})
        return ToolResult(
            f'Renamed the agent "{old}" to "{new}". Its group chat handle stays as it was.',
            clip(f"Renamed agent to {new}", 70),
        )

    async def pin_agent(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        pinned = args.get("pinned") is True
        if task.get("pinned") is pinned:
            state = "pinned" if pinned else "not pinned"
            return ToolResult(f'"{title}" is already {state}.', clip(f"{title} already {state}", 70))
        await self._seti.patch(f"/tasks/{task.get('id')}", {"pinned": pinned})
        if pinned:
            text = f'Pinned "{title}": it stays at the top and is never archived or cleaned up on its own.'
        else:
            text = f'Unpinned "{title}": the usual archive rule applies to it again.'
        return ToolResult(text, clip(f"{'Pinned' if pinned else 'Unpinned'} {title}", 70))

    async def set_agent_color(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        raw = arg_str(args, "color")
        parsed = agent_color(raw)
        if parsed is None:
            raise ToolError(
                f"Seti has no {raw} agent colour. Use a hex such as #3b82f6, one of "
                f"{and_list(list(AGENT_COLORS))}, or none.",
                "Bad agent colour",
            )
        color = None if parsed == "none" else parsed
        name = "" if color is None else color_name(color)
        if task.get("color") == color:
            state = "has no colour" if color is None else f"is already {name}"
            return ToolResult(f'"{title}" {state}.', clip(f"{title} {state}", 70))
        await self._seti.patch(f"/tasks/{task.get('id')}", {"color": color})
        if color is None:
            return ToolResult(f'Cleared the colour of "{title}".', clip(f"Cleared colour of {title}", 70))
        return ToolResult(
            f'Coloured "{title}" {name}: its row, header, panel and reply box carry it now.',
            clip(f"Coloured {title} {name}", 70),
        )

    async def _archived(self, ref: str) -> list[dict[str, Any]]:
        archived = dicts(await self._seti.get("/tasks/archived"))
        return pick(archived, ref, lambda t: str(t.get("id", "")), title_of, lambda _t: [])

    async def delete_agent(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "task")
        archived = False
        if await self._find.match_tasks(ref):
            task = await self._find.resolve_task(ref)
        else:
            task = only(await self._archived(ref), ref, "task", title_of, "Call list_tasks to see them.")
            archived = True
        title = title_of(task)
        if not await self._cleared(args, gate_key("delete_agent", task.get("id"))):
            if archived:
                effect = (
                    f'This permanently deletes the archived agent "{title}" with its archived transcript and '
                    "its packed folders; "
                    "it cannot be undone."
                )
                return ask("delete_agent", args, effect, f"delete agent {title}")
            repos = task.get("repos")
            several = isinstance(repos, list) and len(repos) > 1
            worktree = f", its worktree{'s' if several else ''}" if task.get("worktree") is True else ""
            running = " It is running now, so this stops it first." if task.get("status") == "running" else ""
            urls = task.get("pr_urls") or []
            count = len(urls) if isinstance(urls, list) else 0
            prs = {0: "", 1: " Its linked PR stays as it is on GitHub."}.get(
                count, f" Its {count} linked PRs stay as they are on GitHub."
            )
            effect = (
                f'This permanently deletes the agent "{title}" with its transcript{worktree}, the folders '
                "Seti made for it and its "
                f"session; it cannot be undone.{running}{prs}"
            )
            return ask("delete_agent", args, effect, f"delete agent {title}")
        await self._seti.delete(f"/tasks/{task.get('id')}")
        return ToolResult(
            f'Deleted the agent "{title}" and its transcript.', clip(f"Deleted agent {title}", 70)
        )

    async def archive_agent(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        busy = task.get("status") == "running" or running_subagents(task) > 0
        if busy:
            raise ToolError(
                f"{title} is working; it can be archived once it is stopped or finished.",
                f"{clip(title, 50)} is working",
            )
        keep = arg_bool(args, "keep_worktree")
        if not await self._cleared(args, gate_key("archive_agent", task.get("id"), keep)):
            worktree = ""
            if task.get("worktree") is True:
                worktree = (
                    " Its worktree stays on disk."
                    if keep
                    else " Its worktree is removed if it is clean; its branch stays."
                )
            effect = (
                f'This archives the agent "{title}": its transcript is compressed, and it leaves the agent '
                f"list, PR updates and the group chat until it is restored. The folders Seti made for it are "
                f"packed into a bundle until then.{worktree}"
            )
            return ask("archive_agent", args, effect, f"archive agent {title}")
        report = await self._seti.post(f"/tasks/{task.get('id')}/archive", {"remove_worktree": not keep})
        fields = report if isinstance(report, dict) else {}
        rows = int(fields.get("rows") or 0)
        lines = [
            f"Archived {title}: {plural(rows, 'transcript message')} compressed to "
            f"{size_words(fields.get('stored_bytes'))}."
        ]
        for tree in dicts(fields.get("worktrees")):
            name = repo_name(str(tree.get("repo", "")))
            if tree.get("removed") is True:
                lines.append(f"Its {name} worktree was removed, freeing {size_words(tree.get('bytes'))}.")
            elif tree.get("kept_because"):
                lines.append(f"Its {name} worktree stays: {tree.get('kept_because')}.")
        return ToolResult(" ".join(lines), clip(f"Archived agent {title}", 70))

    async def restore_agent(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "task")
        task = only(
            await self._archived(ref),
            ref,
            "archived agent",
            title_of,
            "Only archived agents can be restored.",
        )
        title = title_of(task)
        report = await self._seti.post(f"/tasks/{task.get('id')}/unarchive")
        fields = report if isinstance(report, dict) else {}
        rows = int(fields.get("rows") or 0)
        recreated = [
            repo_name(str(t.get("repo", ""))) for t in dicts(fields.get("worktrees")) if t.get("recreated")
        ]
        trees = f" Its {and_list(recreated)} worktree was checked out again." if recreated else ""
        messages = plural(rows, "transcript message")
        return ToolResult(
            f"Restored {title} with {messages}; it is back in the agent list.{trees}",
            clip(f"Restored agent {title}", 70),
        )

    async def set_update_mode(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        raw = normalize(arg_str(args, "mode"))
        mode = MODE_ALIASES.get(raw, raw)
        if mode not in UPDATE_MODES:
            raise ToolError(f"Unknown update mode {raw}. Use wake, queue or off.", "Bad update mode")
        if task.get("input_mode") == mode:
            return ToolResult(
                f"{title} already has that setting: {UPDATE_MODES[mode]}.", f"{clip(title, 50)} unchanged"
            )
        await self._seti.patch(f"/tasks/{task.get('id')}", {"input_mode": mode})
        no_prs = "" if task.get("pr_urls") else " It has no linked PRs yet, so this applies once one is."
        return ToolResult(
            f"Done: for {title}, {UPDATE_MODES[mode]}.{no_prs}",
            clip(f"PR updates of {title}: {mode}", 70),
        )

    async def rewind_agent(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        task_id = task.get("id")
        restore = arg_str(args, "restore", required=False) or "conversation"
        if restore not in RESTORES:
            raise ToolError("Restore must be conversation, code or both.", "Bad restore")
        if task.get("status") == "running":
            raise ToolError(
                f"{title} is running; it can only be rewound once it is stopped or its turn ends.",
                f"{clip(title, 50)} is running",
            )
        targets = dicts(await self._seti.get(f"/tasks/{task_id}/rewind/targets"))
        if not targets:
            raise ToolError(f"{title} has no earlier prompt to go back to.", "Nothing to rewind to")
        ref = arg_str(args, "prompt")
        if normalize(ref) in LATEST:
            target = targets[0]
        else:
            found = pick(
                targets,
                ref,
                lambda t: str(t.get("message_id", "")),
                lambda t: str(t.get("text", "")),
                lambda _t: [],
            )
            target = only(
                found,
                ref,
                "prompt",
                lambda t: f'"{clip(str(t.get("text", "")), 60)}" ({ago(t.get("created_at"), self._now())})',
                "Ask the user which prompt, in their words.",
            )
        message_id = target.get("message_id")
        said = clip(str(target.get("text", "")), 120)
        if not await self._cleared(args, gate_key("rewind_agent", task_id, message_id, restore)):
            then = ago(target.get("created_at"), self._now())
            parts = [f'This rewinds {title} to just before the prompt "{said}" from {then}.']
            if restore != "code":
                count = int(target.get("message_count") or 0)
                parts.append(
                    f"The agent forgets the {plural(count, 'message')} since; the transcript keeps them, "
                    "marked as rewound."
                )
            if restore != "conversation":
                parts.append(await self._file_change(task_id, message_id))
            effect = " ".join(parts)
            return ask("rewind_agent", args, effect, f"rewind {title}")
        result = await self._seti.post(
            f"/tasks/{task_id}/rewind", {"message_id": message_id, "restore": restore}
        )
        fields = result if isinstance(result, dict) else {}
        rewind = fields.get("rewind")
        files = [str(f) for f in rewind.get("files_changed") or []] if isinstance(rewind, dict) else []
        restored = f" Restored {plural(len(files), 'file')}." if restore != "conversation" else ""
        prompt = clip(str(fields.get("prompt") or target.get("text", "")), 300)
        follow = (
            f' Its next message continues from there; the prompt was: "{prompt}". Offer to send it '
            "again, as it was or changed."
            if restore != "code"
            else ""
        )
        return ToolResult(
            f"Rewound {title} ({RESTORES[restore]}).{restored}{follow}", clip(f"Rewound agent {title}", 70)
        )

    async def _file_change(self, task_id: Any, message_id: Any) -> str:
        preview = await self._seti.get(f"/tasks/{task_id}/rewind/files", {"message_id": int(message_id)})
        fields = preview if isinstance(preview, dict) else {}
        if fields.get("can_rewind") is not True:
            reason = fields.get("error") or "Claude Code kept no checkpoint of the files there"
            raise ToolError(
                f"The files cannot be restored to that point: {reason}.", "Files cannot be restored"
            )
        files = [str(f) for f in fields.get("files") or []]
        if not files:
            return "No files changed since then."
        shown = and_list([f.rsplit("/", 1)[-1] for f in files[:FILES_SHOWN]])
        more = f" and {len(files) - FILES_SHOWN} more" if len(files) > FILES_SHOWN else ""
        return f"It puts back {plural(len(files), 'file')} as they were then: {shown}{more}."

    async def take_back_message(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        page = await self._seti.get(f"/tasks/{task.get('id')}/messages", {"limit": 200})
        rows = dicts(page.get("messages")) if isinstance(page, dict) else []
        queued = [
            r
            for r in rows
            if r.get("kind") == "prompt"
            and isinstance(r.get("payload"), dict)
            and r["payload"].get("queued") == "waiting"
        ]
        if not queued:
            raise ToolError(f"No message is queued for {title}.", f"Nothing queued for {clip(title, 50)}")

        def text(row: Mapping[str, Any]) -> str:
            payload = row.get("payload")
            return str(payload.get("text", "")) if isinstance(payload, dict) else ""

        ref = arg_str(args, "message", required=False)
        found = pick(queued, ref, lambda r: str(r.get("id", "")), text, lambda _r: []) if ref else queued
        row = only(
            found, ref or "the queued message", "queued message", lambda r: f'"{clip(text(r), 60)}"', ""
        )
        await self._seti.delete(f"/tasks/{task.get('id')}/queue/{row.get('id')}")
        return ToolResult(
            f'Took back the message "{clip(text(row), 120)}" before {title} read it.',
            clip(f"Took back a message for {title}", 70),
        )

    async def dismiss_updates(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        page = await self._seti.get(f"/tasks/{task.get('id')}/messages", {"limit": 200})
        rows = queued_update_rows(dicts(page.get("messages")) if isinstance(page, dict) else [])
        last = rows[-1] if rows else None
        if last is None:
            raise ToolError(f"No updates are waiting for {title}.", f"Nothing waiting for {clip(title, 50)}")
        tally: dict[str, int] = {}
        for row in rows:
            source = str(row["payload"].get("source", ""))
            tally[source] = tally.get(source, 0) + 1
        kinds = ", ".join(plural(n, SOURCE_WORDS.get(source, "update")) for source, n in tally.items())
        if not await self._cleared(args, gate_key("dismiss_updates", task.get("id"), last.get("id"))):
            effect = (
                f"This dismisses {plural(len(rows), 'update')} waiting for {title} ({kinds}): its agent "
                "never gets them, and they stay in its transcript marked dismissed."
            )
            return ask("dismiss_updates", args, effect, f"dismiss updates for {title}")
        done = await self._seti.post(f"/tasks/{task.get('id')}/inputs/dismiss", {"up_to": last.get("id")})
        count = int(done.get("count") or 0) if isinstance(done, dict) else len(rows)
        return ToolResult(
            f"Dismissed {plural(count, 'update')} for {title}; its agent never gets them.",
            clip(f"Dismissed {plural(count, 'update')} for {title}", 70),
        )

    async def stop_background_work(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        subs = running_subagents(task)
        if not await self._cleared(args, gate_key("stop_background_work", task.get("id"))):
            named = f" ({plural(subs, 'subagent')} running)" if subs else ""
            effect = (
                f"This ends the background work of {title}{named}: its subagents and commands still "
                "running stop, and its next message starts the agent again where the conversation left off."
            )
            return ask("stop_background_work", args, effect, f"stop background work of {title}")
        try:
            await self._seti.post(f"/tasks/{task.get('id')}/session/end")
        except SetiError as e:
            if e.status == 409:
                raise ToolError(f"{title} has no background work running.", "No background work") from e
            raise
        return ToolResult(
            f"Ended the background work of {title}.", clip(f"Stopped background work of {title}", 70)
        )

    async def restart_agent_session(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        fresh = arg_bool(args, "fresh")
        running = task.get("status") == "running"
        if not await self._cleared(args, gate_key("restart_agent_session", task.get("id"), fresh, running)):
            stop = " Its running turn stops first." if running else ""
            effect = (
                f"This starts {title} in a fresh Claude Code session: the agent forgets the conversation "
                "so far, which stays in its transcript, and its background shells, processes and "
                f"subagents end.{stop}"
                if fresh
                else f"This restarts the Claude Code session of {title}: the conversation is kept, "
                "Claude Code starts again with its MCP servers, plugins and tools loaded anew, and its "
                f"background shells, processes and subagents end.{stop}"
            )
            what = f"start {title} fresh" if fresh else f"restart the session of {title}"
            return ask("restart_agent_session", args, effect, what)
        body = {"interrupt": running, "fresh": fresh}
        try:
            await self._seti.post(f"/tasks/{task.get('id')}/session/restart", body)
        except SetiError as e:
            if e.status == 409:
                raise ToolError(
                    f"Could not restart the session of {title}: {e.detail or e.title}", "Not restarted"
                ) from e
            raise
        if fresh:
            return ToolResult(
                f"Started {title} in a fresh session; it no longer has the earlier conversation.",
                clip(f"Started {title} fresh", 70),
            )
        return ToolResult(
            f"Restarted the session of {title}; the conversation continues.",
            clip(f"Restarted the session of {title}", 70),
        )

    async def retry_agent_turn(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        try:
            await self._seti.post(f"/tasks/{task.get('id')}/retry")
        except SetiError as e:
            if e.status == 409:
                raise ToolError(f"Could not retry {title}: {e.detail or e.title}", "Not retried") from e
            raise
        return ToolResult(f"Sent the last message of {title} again.", clip(f"Retried {title}", 70))

    async def stop_subagent(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        sub = await self._find.resolve_subtask(task, arg_str(args, "subagent"))
        about = clip(str(sub.get("description", "subagent")), 80)
        if sub.get("status") != "running":
            raise ToolError(
                f'The subagent "{about}" is not running; it is {sub.get("status")}.', "Not running"
            )
        if not await self._cleared(args, gate_key("stop_subagent", task.get("id"), sub.get("tool_use_id"))):
            effect = (
                f'This stops the subagent "{about}" of {title} before it finishes; the agent itself goes on.'
            )
            return ask("stop_subagent", args, effect, f"stop subagent {about}")
        await self._seti.post(f"/tasks/{task.get('id')}/subtasks/{sub.get('tool_use_id')}/stop")
        return ToolResult(
            f'Stopped the subagent "{about}" of {title}.', clip(f"Stopped subagent {about}", 70)
        )

    async def set_agent_group_chat(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        body: dict[str, Any] = {}
        handle = _handle(arg_str(args, "handle", required=False))
        if handle:
            body["handle"] = handle
        if isinstance(args.get("muted"), bool | str):
            body["muted"] = arg_bool(args, "muted")
        if not body:
            raise ToolError(
                "Say whether to mute or unmute the agent, or give a new handle.", "Nothing to change"
            )
        member = await self._seti.patch(f"/team/members/{task.get('id')}", body)
        fields = member if isinstance(member, dict) else {}
        parts: list[str] = []
        if "handle" in body:
            parts.append(f"its handle is now @{fields.get('handle', handle)}")
        if "muted" in body:
            parts.append(
                "it is muted: group chat messages no longer reach it on its own"
                if body["muted"]
                else "it is unmuted: group chat messages reach it again"
            )
        summary = "Muted" if body.get("muted") is True else "Unmuted" if "muted" in body else "Set handle of"
        return ToolResult(
            f"In the group chat, {title}: {'; '.join(parts)}.",
            clip(f"{summary} {title} in the group chat", 70),
        )

    async def set_notifications(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "task", required=False)
        has_muted = isinstance(args.get("muted"), bool | str)
        change = {tier: arg_str(args, tier) for tier in TIERS if isinstance(args.get(tier), str)}
        if not ref and not has_muted and not change:
            raise ToolError(
                "The change is missing: name an agent with muted, or set urgent, active, digest or passive.",
                "Nothing to change",
            )
        if bool(ref) != has_muted:
            raise ToolError(
                "The agent and muted go together: name both to mute or unmute it.", "Mute needs an agent"
            )
        parts: list[str] = []
        summary = "Changed notification tiers"
        if ref and has_muted:
            task, title = await self._task_ref(args)
            muted = arg_bool(args, "muted")
            word = "muted" if muted else "unmuted"
            if task.get("notifications_muted", False) is muted:
                parts.append(f"{title} is already {word}")
            else:
                await self._seti.patch(f"/tasks/{task.get('id')}", {"notifications_muted": muted})
                parts.append(
                    f"{title} is {word}: its turns {'no longer notify' if muted else 'notify again'}"
                )
            summary = f"{word.capitalize()} {title}"
        if change:
            status = await self._seti.put("/notifications/settings", change)
        else:
            status = await self._seti.get("/notifications")
        fields = status if isinstance(status, dict) else {}
        settings = fields.get("settings", {})
        count = len(fields.get("devices", []))
        devices = "1 device gets" if count == 1 else f"{count} devices get"
        tiers = ", ".join(f"{tier} goes to {settings.get(tier, '?')}" for tier in TIERS)
        parts.append(f"{tiers}; {devices} push notifications")
        text = "; ".join(parts)
        return ToolResult(f"{text[0].upper()}{text[1:]}.", clip(summary, 70))

    async def _pr_to_link(self, ref: str) -> str:
        url = _pr_url(ref)
        if url is not None:
            return url
        return str((await self._find.resolve_pr(ref)).get("url"))

    async def link_pr(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        url = await self._pr_to_link(arg_str(args, "pr"))
        label = pr_label(url)
        sub_ref = arg_str(args, "subagent", required=False)
        if sub_ref:
            sub = await self._find.resolve_subtask(task, sub_ref)
            about = clip(str(sub.get("description", "subagent")), 60)
            if any(_same_pr(u, url) for u in sub.get("pr_urls") or []):
                return ToolResult(f'{label} is already linked to the subagent "{about}".', "Already linked")
            await self._seti.post(
                f"/tasks/{task.get('id')}/subtasks/{sub.get('tool_use_id')}/prs", {"url": url}
            )
            return ToolResult(
                f'Linked {label} to the subagent "{about}" of {title}, and to {title} itself.',
                clip(f"Linked {label} to subagent {about}", 70),
            )
        if any(_same_pr(u, url) for u in task.get("pr_urls") or []):
            return ToolResult(f"{label} is already linked to {title}.", "Already linked")
        await self._seti.post(f"/tasks/{task.get('id')}/prs", {"url": url})
        mode = UPDATE_MODES.get(str(task.get("input_mode")), "")
        return ToolResult(
            f"Linked {label} to {title}. Its CI, reviews and comments now reach the agent; {mode}.",
            clip(f"Linked {label} to {title}", 70),
        )

    async def _linked_url(self, urls: list[str], ref: str, owner: str) -> str:
        """The linked PR ref names, by URL, number, a generic word when only one is linked, or title."""
        if not urls:
            raise ToolError(f"{owner} has no linked PRs.", "No linked PRs")
        url = _pr_url(ref)
        numbers = [w for w in normalize(ref).split() if w.isdigit()]
        if url is not None:
            found = [u for u in urls if _same_pr(u, url)]
        elif len(numbers) == 1:
            found = [u for u in urls if u.rstrip("/").endswith(f"/pull/{numbers[0]}")]
            words = [w for w in key_words(ref) if not w.isdigit() and w not in PR_REF_WORDS]
            narrowed = [u for u in found if any(w in normalize(u) for w in words)]
            found = narrowed or found
        elif not [w for w in key_words(ref) if w not in PR_REF_WORDS]:
            found = urls
        else:
            open_pr = await self._find.resolve_pr(ref)
            found = [u for u in urls if _same_pr(u, str(open_pr.get("url", "")))]
        linked = and_list([pr_label(u) for u in urls])
        return only(found, ref, "linked PR", pr_label, f"{owner} has {linked} linked.")

    async def unlink_pr(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        ref = arg_str(args, "pr")
        sub_ref = arg_str(args, "subagent", required=False)
        sub = await self._find.resolve_subtask(task, sub_ref) if sub_ref else None
        if sub is not None:
            owner = f'the subagent "{clip(str(sub.get("description", "subagent")), 60)}" of {title}'
            urls = [str(u) for u in sub.get("pr_urls") or []]
            path = f"/tasks/{task.get('id')}/subtasks/{sub.get('tool_use_id')}/prs"
        else:
            owner = title
            urls = [str(u) for u in task.get("pr_urls") or []]
            path = f"/tasks/{task.get('id')}/prs"
        url = await self._linked_url(urls, ref, owner)
        label = pr_label(url)
        if not await self._cleared(args, gate_key("unlink_pr", path, url)):
            effect = (
                f"This unlinks {label} from {owner}: its CI, reviews and comments stop reaching the agent, "
                "and Seti will not link it again on its own. The PR itself stays as it is on GitHub."
            )
            return ask("unlink_pr", args, effect, f"unlink {label}")
        await self._seti.delete(path, {"url": url})
        return ToolResult(f"Unlinked {label} from {owner}.", clip(f"Unlinked {label} from {title}", 70))

    async def start_agent_from_pr(self, args: Mapping[str, Any]) -> ToolResult:
        pr = await self._find.resolve_pr(arg_str(args, "pr"))
        instructions = arg_str(args, "instructions")
        number = pr.get("number")
        head = str(pr.get("head_ref", ""))
        title = arg_str(args, "title", required=False) or f"PR #{number}: {pr.get('title', '')}"
        label = pr_label(str(pr.get("url", "")))
        if not await self._cleared(args, gate_key("start_agent_from_pr", pr.get("url"), title, instructions)):
            effect = (
                f'This starts a new agent "{title}" in a worktree of {label}\'s branch {head}, linked to '
                f'the PR, and it may push to that branch. Its instructions: "{clip(instructions, 240)}"'
            )
            return ask("start_agent_from_pr", args, effect, f"start an agent on {label}")
        prompt = "\n".join(
            [
                f"Work on pull request #{number} in {pr.get('repo_slug')}: {pr.get('title', '')}",
                str(pr.get("url", "")),
                "",
                f"You are in an isolated worktree checked out at origin/{head} (detached HEAD).",
                f"The PR merges {head} into {pr.get('base_ref')}.",
                f"Commit your changes and push them to the PR branch with: git push origin HEAD:{head}",
                "",
                f"Task: {instructions}",
            ]
        )
        body = {
            "title": title,
            "prompt": prompt,
            "repo_ids": [pr.get("repo_id")],
            "worktree": True,
            "ref": head,
            "pr_urls": [pr.get("url")],
        }
        created = await self._seti.post("/tasks/start", body)
        status = created.get("status") if isinstance(created, dict) else "running"
        return ToolResult(
            f'Started the agent "{title}" on {label}, in a worktree of {head}. It is {status}.',
            clip(f"Started agent on {label}", 70),
        )

    async def request_preview(self, args: Mapping[str, Any]) -> ToolResult:
        pr = await self._find.resolve_pr(arg_str(args, "pr"))
        label = pr_label(str(pr.get("url", "")))
        listing = await self._seti.get("/prs", {"scope": "all"})
        if isinstance(listing, dict) and listing.get("previews_on") is False:
            raise ToolError(
                "PR previews are off in Seti. The user can turn them on in Settings, Mods.",
                "PR previews are off",
            )
        groups = dicts(listing.get("repos")) if isinstance(listing, dict) else []
        group = next((g for g in groups if g.get("repo_id") == pr.get("repo_id")), None)
        if group is not None and group.get("previews") is not True:
            raise ToolError(
                f"Seti has no previews for {repo_name(str(pr.get('repo_slug', '')))}, so it offers no "
                "Preview action there.",
                "No previews for that repo",
            )
        labels = [str(x).lower() for x in pr.get("labels") or []]
        relabel = PREVIEW_LABEL in labels
        if not await self._cleared(args, gate_key("request_preview", pr.get("url"), relabel)):
            change = (
                f"removes the {PREVIEW_LABEL} label from {label} and adds it again"
                if relabel
                else f"adds the {PREVIEW_LABEL} label to {label}"
            )
            effect = (
                f"This {change} on GitHub as the user's account, so others see it; the preview workflow "
                "then deploys the head commit in a few minutes, and every push redeploys it while the "
                "label stays."
            )
            return ask("request_preview", args, effect, f"preview label on {label}")
        repo = str(pr.get("repo_slug", ""))
        result = await self._seti.post(f"/prs/{repo}/{pr.get('number')}/redeploy")
        done = "Re-added" if isinstance(result, dict) and result.get("relabeled") is True else "Added"
        return ToolResult(
            f"{done} the {PREVIEW_LABEL} label on {label}. The preview updates in a few minutes.",
            clip(f"{done} preview label on {label}", 70),
        )

    async def _packs(self) -> list[dict[str, Any]]:
        return dicts(await self._seti.get("/context/packs"))

    @staticmethod
    def _pick_pack(packs: list[dict[str, Any]], ref: str, hint: str) -> dict[str, Any]:
        found = pick(packs, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: [])
        return only(found, ref, "context pack", name_of, hint)

    async def _task_packs(self, task: Mapping[str, Any]) -> list[dict[str, Any]]:
        return dicts(await self._seti.get(f"/tasks/{task.get('id')}/context-packs"))

    async def link_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        pack = self._pick_pack(await self._packs(), arg_str(args, "pack"), "Call list_context_packs.")
        if pack.get("kind") == "role":
            raise ToolError(
                f"{name_of(pack)} is a role; give it with set_agent_role, which replaces the current role.",
                "Role pack",
            )
        attached = await self._task_packs(task)
        ids = [str(p.get("id")) for p in attached]
        if str(pack.get("id")) in ids:
            return ToolResult(f"{title} already includes the pack {name_of(pack)}.", "Already linked")
        await self._seti.put(f"/tasks/{task.get('id')}/context-packs", {"pack_ids": [*ids, pack.get("id")]})
        return ToolResult(
            f"Linked the context pack {name_of(pack)} to {title}; it applies from its next turn.",
            clip(f"Linked pack {name_of(pack)} to {title}", 70),
        )

    async def unlink_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        task, title = await self._task_ref(args)
        attached = await self._task_packs(task)
        if not attached:
            raise ToolError(f"{title} includes no context packs.", "No packs linked")
        names = and_list([name_of(p) for p in attached])
        pack = self._pick_pack(attached, arg_str(args, "pack"), f"{title} includes {names}.")
        if not await self._cleared(args, gate_key("unlink_context_pack", task.get("id"), pack.get("id"))):
            effect = (
                f"This unlinks the context pack {name_of(pack)} from {title}; from its next turn the agent "
                "no longer gets those instructions. The pack itself stays."
            )
            return ask("unlink_context_pack", args, effect, f"unlink pack {name_of(pack)}")
        rest = [p.get("id") for p in attached if p.get("id") != pack.get("id")]
        await self._seti.put(f"/tasks/{task.get('id')}/context-packs", {"pack_ids": rest})
        return ToolResult(
            f"Unlinked the context pack {name_of(pack)} from {title}.",
            clip(f"Unlinked pack {name_of(pack)} from {title}", 70),
        )

    async def create_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        name = arg_str(args, "name")
        body = {
            "name": name,
            "description": arg_str(args, "description", required=False),
            "body": arg_str(args, "body"),
        }
        await self._seti.post("/context/packs", body)
        words = len(str(body["body"]).split())
        return ToolResult(
            f"Created the context pack {name}, about {plural(words, 'word')}. Link it to an agent to use it.",
            clip(f"Created context pack {name}", 70),
        )

    async def update_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        pack = self._pick_pack(await self._packs(), arg_str(args, "pack"), "Call list_context_packs.")
        name = name_of(pack)
        edits_text = any(
            arg_str(args, key, required=False) for key in ("name", "description", "body", "append")
        )
        if pack.get("builtin") is True and edits_text:
            raise ToolError(
                f"{name} is built into Seti and its text cannot change. You can link or unlink it, or "
                "change whether new agents get it by default.",
                "Built-in pack",
            )
        body = {
            "name": name,
            "description": str(pack.get("description") or ""),
            "body": str(pack.get("body") or ""),
        }
        changes: list[str] = []
        new_name = arg_str(args, "name", required=False)
        if new_name and new_name != name:
            body["name"] = new_name
            changes.append(f"renames it to {new_name}")
        description = arg_str(args, "description", required=False)
        if description and description != body["description"]:
            body["description"] = description
            changes.append(f'sets its description to "{clip(description, 120)}"')
        replacement = arg_str(args, "body", required=False)
        appended = arg_str(args, "append", required=False)
        if replacement:
            body["body"] = replacement
            size = plural(len(replacement.split()), "word")
            changes.append(f'replaces its text with about {size}: "{clip(replacement, 200)}"')
        if appended:
            body["body"] = f"{body['body'].rstrip()}\n\n{appended}\n"
            changes.append(f'adds at its end: "{clip(appended, 200)}"')
        default = arg_bool(args, "linked_by_default") if "linked_by_default" in args else None
        if default is True and pack.get("kind") == "role":
            raise ToolError(
                f"{name} is a role; roles are given per agent with set_agent_role, never by default.",
                "Role pack",
            )
        default_changed = default is not None and default != (pack.get("linked_by_default") is True)
        if default_changed:
            changes.append(f"{'links' if default else 'stops linking'} it to new agents by default")
        if not changes:
            raise ToolError(f"That changes nothing in the context pack {name}.", "Nothing to change")
        if not await self._cleared(args, gate_key("update_context_pack", pack.get("id"), body, default)):
            effect = (
                f"This changes the context pack {name}: it {and_list(changes)}. It reaches any agent that "
                "includes it, from their next turn."
            )
            return ask("update_context_pack", args, effect, f"change pack {name}")
        if edits_text:
            await self._seti.put(f"/context/packs/{pack.get('id')}", body)
        if default_changed:
            await self._seti.put(f"/context/packs/{pack.get('id')}/default", {"linked_by_default": default})
        return ToolResult(
            f"Updated the context pack {name}: it {and_list(changes)}.",
            clip(f"Updated context pack {name}", 70),
        )

    async def delete_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        pack = self._pick_pack(await self._packs(), arg_str(args, "pack"), "Call list_context_packs.")
        name = name_of(pack)
        if pack.get("builtin") is True:
            raise ToolError(
                f"{name} is built into Seti and cannot be deleted; unlink it instead.", "Built-in pack"
            )
        if not await self._cleared(args, gate_key("delete_context_pack", pack.get("id"))):
            effect = (
                f"This permanently deletes the context pack {name}; it cannot be undone. Its "
                "instructions leave every agent that includes it."
            )
            return ask("delete_context_pack", args, effect, f"delete pack {name}")
        await self._seti.delete(f"/context/packs/{pack.get('id')}")
        return ToolResult(f"Deleted the context pack {name}.", clip(f"Deleted context pack {name}", 70))

    async def add_repo(self, args: Mapping[str, Any]) -> ToolResult:
        body = {
            "slug": arg_str(args, "slug"),
            "path": arg_str(args, "path"),
            "base_branch": arg_str(args, "base_branch"),
        }
        try:
            await self._seti.post("/repos", body)
        except SetiError as e:
            if e.status == 400:
                raise ToolError(f"Seti did not add it: {e.detail or e.title}", "Repo not added") from e
            raise
        return ToolResult(
            f"Registered {body['slug']} at {body['path']}, base branch {body['base_branch']}.",
            clip(f"Added repo {body['slug']}", 70),
        )

    async def _repo(self, args: Mapping[str, Any]) -> dict[str, Any]:
        return resolve_repo(dicts(await self._seti.get("/repos")), arg_str(args, "repo"))

    async def update_repo(self, args: Mapping[str, Any]) -> ToolResult:
        repo = await self._repo(args)
        slug = str(repo.get("slug"))
        body = {"slug": slug, "path": str(repo.get("path")), "base_branch": str(repo.get("base_branch"))}
        changes: list[str] = []
        for field, words in (("slug", "slug"), ("path", "path"), ("base_branch", "base branch")):
            value = arg_str(args, field, required=False)
            if value and value != body[field]:
                changes.append(f"its {words} from {body[field]} to {value}")
                body[field] = value
        if not changes:
            raise ToolError(f"That changes nothing in {slug}.", "Nothing to change")
        if not await self._cleared(args, gate_key("update_repo", repo.get("id"), body)):
            effect = f"This changes the repo {slug}: {and_list(changes)}. New agents use it."
            return ask("update_repo", args, effect, f"change repo {slug}")
        try:
            await self._seti.put(f"/repos/{repo.get('id')}", body)
        except SetiError as e:
            if e.status == 400:
                raise ToolError(f"Seti did not change it: {e.detail or e.title}", "Repo not changed") from e
            raise
        return ToolResult(f"Updated {slug}: {and_list(changes)}.", clip(f"Updated repo {slug}", 70))

    async def remove_repo(self, args: Mapping[str, Any]) -> ToolResult:
        repo = await self._repo(args)
        slug = str(repo.get("slug"))
        if not await self._cleared(args, gate_key("remove_repo", repo.get("id"))):
            effect = (
                f"This removes {slug} from Seti: new agents cannot pick it, and agents that ran in it no "
                "longer list it. The checkout on disk stays."
            )
            return ask("remove_repo", args, effect, f"remove repo {slug}")
        await self._seti.delete(f"/repos/{repo.get('id')}")
        return ToolResult(
            f"Removed {slug} from Seti; its checkout stays on disk.", clip(f"Removed repo {slug}", 70)
        )
