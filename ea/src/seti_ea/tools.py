"""Tools the EA's LLM calls to read and steer Seti tasks, returning text meant for speech."""

import asyncio
import re
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

from seti_ea.access_tools import AGENT_ACCESS_SPEC, SSH_HOSTS_SPEC
from seti_ea.actions import ACTION_SPECS, CONFIRM_TOOLS, AgentActions
from seti_ea.agent_files import read_agent_file
from seti_ea.asks import (
    CONFIRM_ASKED,
    CONFIRM_ASKED_SPEC,
    AnsweredAsk,
    confirm_text,
    parse_answered,
    record_ask,
    report_outcome,
)
from seti_ea.changelog_tools import CHANGELOG_SCAN, WHATS_NEW, WHATS_NEW_OFF, changelog_lines
from seti_ea.clock import CURRENT_CLOCK, zone_label
from seti_ea.format import (
    CI_WORDS,
    PR_URL,
    ago,
    and_list,
    clip,
    duration,
    headings,
    local_time,
    matching_lines,
    money,
    parse_time,
    plural,
    pr_label,
    pr_line,
    preview_word,
    repo_name,
    size_words,
    status_note,
    status_word,
    task_repos,
    threads_word,
    until,
    zone_of,
)
from seti_ea.gate import ANSWER, GATE_CALL, GateCall, UserAnswer
from seti_ea.history_tools import HISTORY_WINDOW, activity_result, window_transcript
from seti_ea.location_tools import location_lines
from seti_ea.metrics_tools import ea_usage_lines, metrics_lines
from seti_ea.mod_tools import mods_text, themes_text
from seti_ea.my_pack_tools import LIST_MY_PACKS_SPEC
from seti_ea.process_tools import LIST_PROCESSES_SPEC
from seti_ea.role_tools import role_lines
from seti_ea.seti import SetiClient, SetiError
from seti_ea.settings_tools import SETTINGS_SPECS, SettingsTools
from seti_ea.toolkit import (
    TASK_REF,
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_int,
    arg_str,
    context_file_name,
    dicts,
    find_context_file,
    key_words,
    name_of,
    normalize,
    only,
    pick,
    queued_update_rows,
    resolve_repo,
    running_subagents,
    title_of,
    word_score,
)
from seti_ea.workspace_tools import LIST_WORKSPACES_SPEC, resolve_workspace, workspace_list, workspace_names

TASK_STATUSES = ("running", "idle", "asking", "blocked", "error", "interrupted", "stopped")
LIST_LIMIT = 12
PR_LIMIT = 12
DIGEST_LIMIT = 14
SEARCH_LIMIT = 6
SNIPPET_CHARS = 500
MESSAGE_WINDOW = 200
WAITING_SCAN = 30
SCAN_CONCURRENCY = 6
AUDIT_PAGE = 200
AUDIT_PAGES = 5
AUDIT_LIMIT = 10
AUDIT_LIMIT_MAX = 25
GIST_CHARS = 300
REPORT_CHARS = 700
OUTLINE_LIMIT = 10
MATCH_LIMIT = 6
TEAM_LIMIT = 12
TEAM_LIMIT_MAX = 30
TEAM_LINE_CHARS = 240
FIND_LIMIT = 10
FIND_QUERY = {
    "type": "string",
    "description": "The text to find, at least two characters; case does not matter.",
}
FIND_WHOLE_WORDS = {
    "type": "boolean",
    "description": "Match these whole words in any order instead of the exact text. Default false.",
}
FIND_WHERE = {
    "type": "string",
    "enum": ["transcript", "file_names", "file_text", "file"],
    "description": "Where to look: transcript (the default); file_names, the paths of the task's files "
    "and folders matched loosely as an editor's quick open does; file_text, the text inside its "
    "files; or file, to read one file whole, with query its path as the agent or a file search "
    "names it, such as a file an agent sent you. Files cover the task's working directory, repos, "
    "folders and workspace as its Files view shows them, never hidden paths or secrets. "
    "whole_words applies to the transcript only.",
}
FIND_TOOLS = {
    "type": "boolean",
    "description": "Search the task's tool calls and their output, shell runs and Seti's notes too. "
    "Default false: only the user's prompts, updates and the agent's replies.",
}
FILE_SEARCH_MODES = {"file_names": "name", "file_text": "text"}
FILE_FIND_LIMIT = 20
FIND_KINDS = {
    "prompt": "prompt",
    "sdk": "agent",
    "input": "update",
    "shell": "shell run",
    "seti": "Seti note",
}
# Messages before a mention that show what it answers, and room for what came after it.
MENTION_BEFORE = 8
MENTION_WINDOW = 16
RECENT = timedelta(hours=1)
NUMBER = re.compile(r"\d+")
PR_WORDS = frozenset({"pr", "pull", "request", "number", "no"})
WINDOW = re.compile(r"^(?:in )?(?:the )?(?:last |past )?(\d+|an|a|one)? ?(minute|min|hour|hr|day|week)s?$")
UNIT_SECS = {"minute": 60, "min": 60, "hour": 3600, "hr": 3600, "day": 86400, "week": 604800}
LATEST = frozenset({"latest", "last", "newest", "most recent", "recent"})
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

AUDIT_AREAS = (
    "task",
    "agent",
    "repo",
    "context",
    "mcp",
    "plugin",
    "pr",
    "account",
    "seti",
    "team",
    "workspace",
    "system",
)
AUDIT_ACTORS = ("user", "ea", "agent", "system")
AREA_ALIASES = {
    "tasks": "task",
    "agents": "agent",
    "repos": "repo",
    "plugins": "plugin",
    "prs": "pr",
    "pull requests": "pr",
    "outward": "agent.outward",
    "outward calls": "agent.outward",
    "settings": "seti",
}
AREA_WORDS = {"mcp": "MCP", "pr": "PR", "seti": "Seti settings"}
ACTOR_ALIASES = {
    "me": "user",
    "i": "user",
    "you": "ea",
    "assistant": "ea",
    "agents": "agent",
    "seti": "system",
}
ACTOR_WORDS = {"user": "user", "ea": "EA", "agent": "agent", "system": "Seti"}
AUDIT_WHO = {"user": "you", "agent": "an agent", "system": "Seti"}
AUDIT_BY = {"user": "you", "ea": "the EA", "agent": "agents", "system": "Seti"}
KIND_WORDS = {
    "task.created": ("task created", "tasks created"),
    "task.message_sent": ("message sent", "messages sent"),
    "task.stopped": ("task stopped", "tasks stopped"),
    "task.deleted": ("task deleted", "tasks deleted"),
    "task.inputs_delivered": ("update hand-over", "update hand-overs"),
    "task.pr_linked": ("PR linked", "PRs linked"),
    "task.pr_unlinked": ("PR unlinked", "PRs unlinked"),
    "task.subtask_pr_linked": ("PR linked to a subagent", "PRs linked to subagents"),
    "task.subtask_pr_unlinked": ("PR unlinked from a subagent", "PRs unlinked from subagents"),
    "task.process_stopped": ("process stopped", "processes stopped"),
    "agent.outward": ("outward call by an agent", "outward calls by agents"),
    "mcp.signin_failed": ("failed MCP sign-in", "failed MCP sign-ins"),
    "seti.context_pack_created": ("context pack change by an agent", "context pack changes by agents"),
    "seti.context_pack_updated": ("context pack change by an agent", "context pack changes by agents"),
    "seti.context_file_saved": ("CLAUDE.md change by an agent", "CLAUDE.md changes by agents"),
    "seti.task_context_packs_changed": ("task pack change by an agent", "task pack changes by agents"),
    "seti.note_added": ("note by an agent", "notes by agents"),
    "ea.chat_message": ("message typed to the EA", "messages typed to the EA"),
    "team.message_posted": ("group chat message", "group chat messages"),
    "team.direct_posted": ("direct message", "direct messages"),
}
QUIET_KINDS = frozenset(
    {
        "agent.outward",
        "task.side_chat",
        "ea.chat_message",
        "task.inputs_delivered",
        "task.pr_linked",
        "task.pr_unlinked",
        "task.subtask_pr_linked",
        "task.subtask_pr_unlinked",
        "task.message_sent",
        "task.shell_run",
        "task.shell_stopped",
        "task.terminal_opened",
        "task.terminal_closed",
        "system.terminal_opened",
        "system.terminal_closed",
    }
)
MCP_WORDS = {
    "connected": "connected",
    "needs-auth": "needs sign-in",
    "failed": "failed",
    "pending": "still connecting",
    "disabled": "disabled",
}
MERGEABLE_WORDS = {"mergeable": "no merge conflicts", "conflicting": "has merge conflicts"}


QUERY = {
    "type": "string",
    "description": "Words to look for; returns the matching lines instead of an outline.",
}

NOTIFY_WHEN_DONE = {
    "type": "boolean",
    "description": "Hear in your inbox, with its final message, when the turn that takes this ends. "
    "Default false.",
}

NOTIFY_NOTE = " You will hear in your inbox when that turn ends."


TOOL_SPECS: list[ToolSpec] = [
    ToolSpec(
        "list_tasks",
        "List Seti tasks with their workspace, status, repos and when each last changed, newest first.",
        {
            "status": {
                "type": "string",
                "enum": list(TASK_STATUSES),
                "description": "Only tasks with this status. Leave out for all tasks.",
            },
            "workspace": {
                "type": "string",
                "description": "Only tasks in this workspace, by name. Leave out for every workspace.",
            },
            "active": {
                **HISTORY_WINDOW,
                "description": "Instead, what happened then: the tasks with turns in this window, "
                "most active first, with prompts, replies, PRs linked and the last reply. "
                + str(HISTORY_WINDOW["description"]),
            },
        },
    ),
    LIST_WORKSPACES_SPEC,
    ToolSpec(
        "seti_overview",
        "A compact picture of what is going on in Seti: running and failed tasks, updates waiting, "
        "the user's PRs with failing CI or conflicts, notable events in the last hour and account "
        "limits. The live context note holds most of it; use this when the "
        "note is missing or for account limits and the audit log.",
        {
            "changelog": {
                "type": "boolean",
                "description": "Instead, say what changed in Seti itself lately: the running version, "
                "whether a newer one is on main and how to update, and its newest features and fixes "
                "by day, marking the ones the latest deploy brought.",
            },
            "metrics": {
                "type": "boolean",
                "description": "Instead, the shipping metrics: PRs merged in the "
                "last 7 and 30 days and the daily streak, turns, time running and cost, today and "
                "the 7 days before for comparison, the latest merges, the agents that merged "
                "most with the MCP servers they use, and your own model calls over 7 days with "
                "their tokens, cached share and latency.",
            },
            "mods": {
                "type": "boolean",
                "description": "Instead, Seti's mods: each with its version, whether it is on, what "
                "it does and may do, the actions it offers you for run_mod_action, and whether safe "
                "mode is on.",
            },
        },
    ),
    ToolSpec(
        "get_task",
        "Details of one task: status, repos, cost, its todo list, linked PRs with CI and review, "
        "updates waiting for the agent, and a condensed recent transcript, or with window what it "
        "did then, such as yesterday. To ask an agent why it did something, use the side chat mod's "
        "ask action through run_mod_action while that mod is on.",
        {
            "task": TASK_REF,
            "window": {
                **HISTORY_WINDOW,
                "description": "Read its prompts and replies in this window instead of the recent "
                "transcript. " + str(HISTORY_WINDOW["description"]),
            },
        },
        ["task"],
    ),
    ToolSpec(
        "search_seti",
        "Search what tasks, their subagents and PRs said: decisions, findings, reports, reviews and "
        "PR descriptions, with the task or PR each excerpt came from. Use it for what a task decided, "
        "found or was told, which the live context does not hold.",
        {
            "query": {"type": "string", "description": "What to look for, in a few keywords."},
            "task": {
                **TASK_REF,
                "description": "Only this task, if the user named one; approximate titles work.",
            },
        },
        ["query"],
    ),
    ToolSpec(
        "list_subtasks",
        "List the subagents a task's agent started, with status, what each does and how long it ran.",
        {"task": TASK_REF},
        ["task"],
    ),
    ToolSpec(
        "get_subtask",
        "One subagent of a task: its brief, progress while running, and the gist of its report.",
        {
            "task": TASK_REF,
            "subtask": {
                "type": "string",
                "description": "The subagent's description as the user said it, or latest.",
            },
        },
        ["task", "subtask"],
    ),
    ToolSpec(
        "list_waiting_updates",
        "PR updates (CI, reviews, comments) waiting to be handed to agents, across all tasks.",
    ),
    ToolSpec(
        "list_prs",
        "List open pull requests in registered repos with CI, review, preview and linked tasks.",
        {
            "scope": {
                "type": "string",
                "enum": ["mine", "all"],
                "description": "mine for the user's own PRs (default), all for everyone's.",
            }
        },
    ),
    ToolSpec(
        "get_pr",
        "One open pull request in detail: checks with failing names, review, merge conflicts, "
        "preview, related PRs and linked tasks.",
        {
            "pr": {
                "type": "string",
                "description": "Repo and number such as seti PR 28, a PR title, or a task whose PR it is.",
            }
        },
        ["pr"],
    ),
    ToolSpec(
        "search_audit",
        "Search the audit log of what the user, the EA, agents and Seti did, newest "
        "first, with a tally by kind.",
        {
            "area": {
                "type": "string",
                "description": "An area (task, agent, repo, context, mcp, plugin, pr, account, seti, "
                "system) or a kind such as agent.outward or mcp.signin_failed.",
            },
            "actor": {
                "type": "string",
                "enum": list(AUDIT_ACTORS),
                "description": "Who acted: user, ea (you), agent or system (Seti itself).",
            },
            "query": {"type": "string", "description": "Text to find in the event summaries."},
            "window": {
                "type": "string",
                "description": "Time window: today, yesterday, this week, last hour, last 30 minutes, "
                "last 2 days. Leave out for the latest events.",
            },
            "timezone": {
                "type": "string",
                "description": "The user's timezone from the time note, for today, yesterday and this week.",
            },
            "limit": {"type": "integer", "description": "How many events to list, 1 to 25. Default 10."},
        },
    ),
    ToolSpec(
        "stop_task",
        "Stop a running task's current turn. Confirm with the user first.",
        {"task": TASK_REF},
        ["task"],
    ),
    ToolSpec(
        "hand_over_updates",
        "Hand the updates waiting for a task (PR CI, reviews, comments) to its agent now, "
        "which starts a turn.",
        {"task": TASK_REF},
        ["task"],
    ),
    ToolSpec(
        "start_task",
        "Start a new task: a Claude Code agent working on the prompt. Seti's planner titles it and "
        "picks repos, context packs and MCP servers from the prompt for whatever you leave out; "
        "with no repo it gets a fresh folder under ~/work. Unclear permissions are not given: it "
        "runs sandboxed with SSH hosts and AWS only as their defaults say; only the user grants "
        "more. Everything can be changed later. Confirm the prompt, and the repos if the user "
        "named any, with the user first.",
        {
            "prompt": {"type": "string", "description": "The full instructions for the agent."},
            "title": {
                "type": "string",
                "description": "Only when the user names the task; otherwise Seti titles it.",
            },
            "repos": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Only repos the user named, as slugs or names, the one the agent runs in "
                "first. Leave out to let Seti pick.",
            },
            "worktree": {
                "type": "boolean",
                "description": "With named repos: false to work in the checkout itself. Worktrees are "
                "the default so parallel tasks do not collide.",
            },
            "directory": {
                "type": "string",
                "description": "Without repos only: an existing directory to work in, absolute or ~/.",
            },
            "workspace": {
                "type": "string",
                "description": "Only when the user names one: the workspace it joins. Left out, the first.",
            },
            "notify_when_done": NOTIFY_WHEN_DONE,
        },
        ["prompt"],
    ),
    ToolSpec("list_repos", "List the repos registered in Seti with their base branches."),
    ToolSpec(
        "get_repo",
        "One registered repo: its tasks, open PRs and CLAUDE.md files.",
        {"repo": {"type": "string", "description": "The repo's name or owner/name slug."}},
        ["repo"],
    ),
    ToolSpec(
        "list_context_packs",
        "List context packs, the reusable instructions tasks can include.",
    ),
    ToolSpec(
        "get_context_pack",
        "Summarise one context pack: description, size, outline, opening, or lines matching a query.",
        {
            "pack": {"type": "string", "description": "The pack's name as the user said it."},
            "query": QUERY,
        },
        ["pack"],
    ),
    LIST_MY_PACKS_SPEC,
    ToolSpec(
        "list_context_files",
        "List the CLAUDE.md files Seti manages: the user-level one and each repo's.",
    ),
    ToolSpec(
        "read_context_file",
        "Summarise one CLAUDE.md file: size, outline and opening, or the lines matching a query.",
        {
            "file": {
                "type": "string",
                "description": "user for the user-level CLAUDE.md, or a repo name, adding local for "
                "CLAUDE.local.md.",
            },
            "query": QUERY,
        },
        ["file"],
    ),
    ToolSpec(
        "list_mcp_servers",
        "List the MCP servers agents get, with connection and sign-in state and tool counts.",
        {"refresh": {"type": "boolean", "description": "Probe them again first, after a change."}},
    ),
    AGENT_ACCESS_SPEC,
    SSH_HOSTS_SPEC,
    LIST_PROCESSES_SPEC,
    ToolSpec(
        "list_plugins",
        "List Seti's default plugin folders and the Claude Code plugins installed, with what they add.",
    ),
    ToolSpec(
        "account_status",
        "The Claude account Seti's agents use: the saved login in use, login health, plan usage "
        "windows and rate limits.",
        {"refresh": {"type": "boolean", "description": "Fetch the usage from Claude again first."}},
    ),
    ToolSpec(
        "schedule_followup",
        "Schedule a check-back for yourself, or a reminder the user asked for. When it is due you "
        "get the note back: on a call you tell the user at the next pause, otherwise your report goes "
        "in the chat. Use followup to check on work you started or steered, reminder for the user.",
        {
            "when": {
                "type": "string",
                "description": "When it is due, in the user's local time: in 20 minutes, in 2 hours, "
                "at 15:00, at 3pm, tomorrow at 9am, friday at 10:00.",
            },
            "note": {
                "type": "string",
                "description": "What to check or remind about, in full; you read it again when it is due.",
            },
            "kind": {
                "type": "string",
                "enum": ["followup", "reminder"],
                "description": "followup (default) to check on work, reminder for something the user asked.",
            },
            "task": {**TASK_REF, "description": "The task it is about, if any; approximate titles work."},
        },
        ["when", "note"],
    ),
    ToolSpec("list_followups", "List the follow-ups and reminders scheduled and not yet due, soonest first."),
    ToolSpec(
        "cancel_followup",
        "Cancel a scheduled follow-up or reminder.",
        {"followup": {"type": "string", "description": "Words from its note, or its id."}},
        ["followup"],
    ),
    ToolSpec(
        "watch_task",
        "Keep an eye on a task: its turn ends, errors and stops, PR links, merges and CI results on "
        "its PRs, and updates waiting for the user reach you as they happen. The task never sees them. "
        "With once, only how its current turn ends, or its next one while it is idle, reaches you. "
        "With stop, you stop watching it.",
        {
            "task": TASK_REF,
            "note": {"type": "string", "description": "Why the user wants it watched."},
            "once": {
                "type": "boolean",
                "description": "Hear once when this turn ends, with its final message, then stop. "
                "Default false.",
            },
            "stop": {"type": "boolean", "description": "Stop watching the task instead. Default false."},
        },
        ["task"],
    ),
    ToolSpec("list_watches", "List the tasks you are watching."),
    ToolSpec(
        "read_team_chat",
        "Read the Seti group chat, where the user, you and the agents of tasks talk; agents mention "
        "each other with @handles. Newest last.",
        {
            "limit": {
                "type": "integer",
                "description": f"How many recent messages, 1 to {TEAM_LIMIT_MAX}. Default {TEAM_LIMIT}.",
            }
        },
    ),
    ToolSpec(
        "find_in_team_chat",
        "Find group chat messages with some text, however far back, newest first, each with a line "
        "around the match and its message id.",
        {"query": FIND_QUERY, "whole_words": FIND_WHOLE_WORDS},
        ["query"],
    ),
    ToolSpec(
        "find_in_transcript",
        "Find messages in one task's own transcript with some text, however far back, newest first, "
        "each with a line around the match: the user's prompts, updates and the agent's replies, and "
        "with include_tools its tool calls, tool output, shell runs and Seti's notes too. Use it to "
        "locate a moment; search_seti suits decisions across tasks. Set where to search the task's "
        "files by name or by their text instead, or to read one of its files whole.",
        {
            "task": {**TASK_REF, "description": "The task's id, title or group chat @handle."},
            "query": FIND_QUERY,
            "whole_words": FIND_WHOLE_WORDS,
            "include_tools": FIND_TOOLS,
            "where": FIND_WHERE,
        },
        ["task", "query"],
    ),
    ToolSpec(
        "post_team_chat",
        "Post to the group chat as the EA; this is how you message agents, never as the user. "
        "Public, it reaches every active task that is not muted at its next step, an @handle in the "
        "text reaches that task at once, mid-turn, and @all also starts idle tasks: confirm a public "
        "post's text with the user first. With to, it is a direct message to that one agent: it "
        "joins its running turn at once or starts a turn, and only you, that agent and the user see "
        "it. It never cuts a turn short; stop_task does that. To hear when the agent is done, use "
        "watch_task.",
        {
            "text": {"type": "string", "description": "The message, short and self-contained."},
            "to": {
                "type": "string",
                "description": "For a direct message: the agent's @handle, title or id. Leave out "
                "for a public post.",
            },
        },
        ["text"],
    ),
    ToolSpec(
        "reply_team_chat",
        "Answer a group chat message that mentioned you (@ea). The reply names the agent that asked "
        "and reaches only it, at its next step, without interrupting it. Mention nobody else.",
        {
            "message_id": {
                "type": "integer",
                "description": "The id of the message that mentioned you, from the inbox note.",
            },
            "text": {"type": "string", "description": "The answer, brief and self-contained."},
        },
        ["message_id", "text"],
    ),
    CONFIRM_ASKED_SPEC,
    *ACTION_SPECS,
    *SETTINGS_SPECS,
]

# Set while the EA reports on act alerts: it may message one agent directly, not post to everyone.
DIRECT_ONLY: ContextVar[bool] = ContextVar("direct_only", default=False)

# The follow-up the EA is working on, so one it schedules from there chains from it.
INBOX_ORIGIN: ContextVar[int | None] = ContextVar("inbox_origin", default=None)


def setup_note(setup: Mapping[str, Any]) -> str:
    """What the planner chose beyond the defaults, and the access it held back."""
    choices = [
        (setup.get("packs_linked"), "linked the context packs"),
        (setup.get("mcp_enabled"), "turned on the MCP servers"),
        (setup.get("mcp_disabled"), "turned off the MCP servers"),
    ]
    done = [f"{verb} {and_list([str(n) for n in names])}" for names, verb in choices if names]
    held = [str(w).split(":")[0] for w in setup.get("withheld") or [] if str(w).startswith(("SSH ", "AWS:"))]
    note = f" Seti {and_list(done)}." if done else ""
    if held:
        verb, pronoun = ("stays", "it") if len(held) == 1 else ("stay", "them")
        note += f" {and_list(held)} {verb} off; the user turns {pronoun} on in the agent's details."
    if setup.get("planner") == "fallback":
        note += " The planner did not answer, so it has the defaults."
    return note


def todo_line(task: Mapping[str, Any]) -> str | None:
    """The agent's own todo list as one sentence: counts and the item in progress."""
    todos = dicts(task.get("todos"))
    if not todos:
        return None
    done = sum(1 for t in todos if t.get("status") == "completed")
    line = f"Its todo list has {done} of {plural(len(todos), 'item')} done"
    current = next((t for t in todos if t.get("status") == "in_progress"), None)
    if current is None:
        return f"{line}."
    text = current.get("active_form") or current.get("content") or "an item"
    return f'{line}; now: "{clip(str(text), 120)}".'


def shown_status(task: Mapping[str, Any]) -> str:
    """The status Seti shows: blocked on the user, running while subagents run, or asking."""
    if task.get("blocked"):
        return "blocked"
    if running_subagents(task) > 0:
        return "running"
    status = str(task.get("status"))
    return "asking" if status == "idle" and task.get("asking") is True else status


def queued_updates(messages: list[Any]) -> list[dict[str, Any]]:
    """Update payloads waiting for the agent, as the Seti UI counts them."""
    return [row["payload"] for row in queued_update_rows(messages)]


def _author(message: Mapping[str, Any]) -> str:
    kind = message.get("author_kind")
    if kind == "ea":
        return "you"
    if kind == "user":
        return "the user"
    return f"@{message.get('author_handle') or 'task'}"


def team_author(message: Mapping[str, Any]) -> str:
    """Who wrote a group chat message, and for a direct message whom it went to."""
    kind = message.get("to_kind")
    if kind is None:
        return _author(message)
    to = "you" if kind == "ea" else f"@{message.get('to_handle') or 'task'}"
    return f"{_author(message)}, directly to {to}"


TEAM_MODES = (
    ("now", "reached mid-turn"),
    ("next", "reached at the next step"),
    ("start", "started"),
    ("held", "waiting for the next turn"),
)


def team_outcome(deliveries: list[dict[str, Any]], unknown: list[str], archived: Sequence[str] = ()) -> str:
    """What a post did for the tasks it reached, in a sentence or two."""
    by_mode: dict[str, list[str]] = {}
    for d in deliveries:
        by_mode.setdefault(str(d.get("mode")), []).append(f"@{d.get('handle')}")
    parts = [f"{verb}: {and_list(by_mode[mode])}" for mode, verb in TEAM_MODES if by_mode.get(mode)]
    muted = [f"@{d.get('handle')}" for d in deliveries if d.get("reason") == "muted"]
    if muted:
        parts.append(f"muted, so not told: {and_list(muted)}")
    if parts:
        joined = "; ".join(parts)
        text = f"Posted to the group chat. {joined[:1].upper()}{joined[1:]}."
    else:
        text = "Posted to the group chat. No active task was reached."
    if unknown:
        text += f" No task has the handle {and_list([f'@{h}' for h in unknown])}."
    return text + archived_note(archived)


def archived_note(archived: Sequence[str]) -> str:
    """Names archived agents a post or reply left out; empty when there are none."""
    if not archived:
        return ""
    handles = and_list([f"@{h}" for h in archived])
    return f" {handles} {'is' if len(archived) == 1 else 'are'} archived and got nothing until restored."


REPLY_OUTCOMES = {
    "next": "It reaches {who} at its next step.",
    "start": "It started a turn of {who}.",
    "held": "{who} sees it on its next turn.",
    "skipped": "{who} muted the chat, so it sees the reply only when it reads the chat.",
}


DIRECT_OUTCOMES = {
    "now": "it joined its running turn",
    "next": "it reaches it at its next step",
    "start": "it started a turn",
    "held": "it waits for its next turn",
}


def reply_outcome(deliveries: list[dict[str, Any]], archived: Sequence[str] = ()) -> str:
    """What a reply to a mention did for the agent that asked."""
    if not deliveries:
        return "Replied in the group chat." + archived_note(archived)
    first = deliveries[0]
    template = REPLY_OUTCOMES.get(str(first.get("mode")), "It went to {who}.")
    return f"Replied in the group chat. {template.format(who=f'@{first.get("handle")}')}"


def _waiting_reason(task: Mapping[str, Any]) -> str:
    if task.get("input_mode") != "wake":
        return "they go with the next message, or can be handed over now"
    if task.get("status") == "running":
        return "the agent gets them when this turn ends"
    return "Seti paused automatic turns, so they wait for a hand-over or the next message"


def parse_window(text: str, now: datetime, zone: tzinfo) -> tuple[datetime, datetime | None, str]:
    """Start, optional end and a spoken label for a window such as today or last 2 hours."""
    norm = normalize(text)
    local = now.astimezone(zone)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if norm == "today":
        return midnight, None, "today"
    if norm == "yesterday":
        return midnight - timedelta(days=1), midnight, "yesterday"
    if norm == "this week":
        return midnight - timedelta(days=local.weekday()), None, "this week"
    match = WINDOW.match(norm)
    if match is None:
        raise ToolError(
            f'Unknown time window "{text}". Use today, yesterday, this week, or a span such as '
            "last hour or last 30 minutes.",
            "Bad time window",
        )
    count_text, unit = match.groups()
    count = int(count_text) if count_text and count_text.isdigit() else 1
    count = max(1, min(count, 400))
    unit_name = {"min": "minute", "hr": "hour"}.get(unit, unit)
    label = f"in the last {unit_name}" if count == 1 else f"in the last {count} {unit_name}s"
    return now - timedelta(seconds=count * UNIT_SECS[unit]), None, label


def audit_kind(text: str) -> str:
    """The audit area or kind filter for text such as tasks, outward calls or task.created."""
    raw = text.strip().lower()
    if raw == "":
        return ""
    alias = AREA_ALIASES.get(normalize(raw))
    if alias is not None:
        return alias
    head, _, rest = raw.partition(".")
    head = normalize(head)
    if head not in AUDIT_AREAS and head.endswith("s"):
        head = head[:-1]
    if head not in AUDIT_AREAS:
        raise ToolError(f"Unknown area {text}. Use one of {', '.join(AUDIT_AREAS)}.", "Bad area")
    return f"{head}.{normalize(rest).replace(' ', '_')}" if normalize(rest) else head


def _audit_noun(area: str, actor: str) -> tuple[str, str]:
    """Singular and plural names for the audit events a search asks for."""
    by = f" by {AUDIT_BY[actor]}" if actor else ""
    if area in KIND_WORDS:
        one, many = KIND_WORDS[area]
        return (one, many) if area == "agent.outward" else (f"{one}{by}", f"{many}{by}")
    if area:
        words = area.replace(".", " ").replace("_", " ")
        words = AREA_WORDS.get(words, words)
        return f"{words} event{by}", f"{words} events{by}"
    if actor in ("ea", "user", "agent"):
        return f"{ACTOR_WORDS[actor]} action", f"{ACTOR_WORDS[actor]} actions"
    return f"event{by}", f"events{by}"


def _window_words(label: str) -> str:
    """A usage window label such as 5h or 7d Fable as speech."""
    match = re.match(r"^(\d+)([hd])\b(.*)$", label.strip())
    if match is None:
        return label
    count, unit, rest = match.groups()
    return f"{count}-{'hour' if unit == 'h' else 'day'}{rest}"


def _kind_tally(events: list[dict[str, Any]]) -> str:
    counts: dict[tuple[str, str], int] = {}
    for e in events:
        kind = str(e.get("kind"))
        plain = kind.replace(".", " ").replace("_", " ")
        words = KIND_WORDS.get(kind, (plain, plain))
        counts[words] = counts.get(words, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    return ", ".join(f"{count} {one if count == 1 else many}" for (one, many), count in ranked)


def _via_ea(event: Mapping[str, Any]) -> bool:
    detail = event.get("detail")
    return isinstance(detail, dict) and detail.get("via") == "ea"


def _elapsed(sub: Mapping[str, Any], now: datetime) -> float:
    start = parse_time(sub.get("started_at"))
    end = parse_time(sub.get("ended_at")) or now
    return (end - start).total_seconds() if start else 0.0


async def _limited[T](jobs: Iterable[Awaitable[T]], limit: int) -> list[T | BaseException]:
    """Runs the jobs at most limit at a time; failures come back in place of results."""
    gate = asyncio.Semaphore(limit)

    async def run(job: Awaitable[T]) -> T:
        async with gate:
            return await job

    return await asyncio.gather(*(run(j) for j in jobs), return_exceptions=True)


async def _attempt[T](job: Awaitable[T]) -> T | SetiError:
    try:
        return await job
    except SetiError as e:
        return e


class EaTools:
    """The EA's tools over the Seti API."""

    def __init__(self, seti: SetiClient, now: Callable[[], datetime] | None = None) -> None:
        self._seti = seti
        self._now = now or (lambda: datetime.now(UTC))
        self._handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "seti_overview": self.seti_overview,
            "list_tasks": self.list_tasks,
            "get_task": self.get_task,
            "search_seti": self.search_seti,
            "list_subtasks": self.list_subtasks,
            "get_subtask": self.get_subtask,
            "list_waiting_updates": self.list_waiting_updates,
            "list_prs": self.list_prs,
            "get_pr": self.get_pr,
            "search_audit": self.search_audit,
            "stop_task": self.stop_task,
            "hand_over_updates": self.hand_over_updates,
            "start_task": self.start_task,
            "list_repos": self.list_repos,
            "get_repo": self.get_repo,
            "list_context_packs": self.list_context_packs,
            "get_context_pack": self.get_context_pack,
            "list_context_files": self.list_context_files,
            "read_context_file": self.read_context_file,
            "list_mcp_servers": self.list_mcp_servers,
            "list_plugins": self.list_plugins,
            "account_status": self.account_status,
            "schedule_followup": self.schedule_followup,
            "list_followups": self.list_followups,
            "cancel_followup": self.cancel_followup,
            "watch_task": self.watch_task,
            "list_watches": self.list_watches,
            "read_team_chat": self.read_team_chat,
            "find_in_team_chat": self.find_in_team_chat,
            "find_in_transcript": self.find_in_transcript,
            "post_team_chat": self.post_team_chat,
            "reply_team_chat": self.reply_team_chat,
        }
        self._actions = AgentActions(seti, self, self._now)
        self._handlers.update(self._actions.handlers)
        settings = SettingsTools(seti, self._actions.confirmations, self._now, self.resolve_task)
        self._handlers.update(settings.handlers)
        self._handlers[CONFIRM_ASKED] = self.confirm_asked

    @property
    def seti(self) -> SetiClient:
        """The Seti client the tools call through."""
        return self._seti

    def user_turn(self) -> None:
        """The user spoke or typed, so a question a destructive tool asked may now be answered."""
        self._actions.confirmations.user_turn()

    async def call(self, name: str, args: Mapping[str, Any]) -> ToolResult:
        """Run a tool; Seti errors and bad arguments come back as a failed result, never raise."""
        gate = self._actions.confirmations
        seen = GateCall()
        token = GATE_CALL.set(seen)
        try:
            result = await self._run(name, args)
        finally:
            GATE_CALL.reset(token)
        if seen.taken is not None:
            await report_outcome(self._seti, seen.taken, result)
        if result.asked is not None and seen.asked_key is not None and name in CONFIRM_TOOLS:
            return await record_ask(gate, name, args, result, seen.asked_key)
        return result

    async def _run(self, name: str, args: Mapping[str, Any]) -> ToolResult:
        handler = self._handlers.get(name)
        if handler is None:
            return ToolResult(f"There is no tool called {name}.", f"Unknown tool {name}", False)
        try:
            return await handler(args)
        except ToolError as e:
            return ToolResult(e.text, e.summary, False)
        except SetiError as e:
            detail = f" {clip(e.detail, 300)}" if e.detail and e.detail != e.title else ""
            return ToolResult(f"The Seti call failed: {e.title}.{detail}", f"Failed: {e.title}", False)

    async def answer(self, ask: AnsweredAsk) -> ToolResult:
        """Runs the exact recorded call the user allowed, or forgets the question they denied."""
        if not ask.allow:
            return ToolResult(f"The user said no: {ask.summary} stays undone.", "Left undone")
        if ask.tool not in CONFIRM_TOOLS:
            result = ToolResult(f"{ask.tool} does not ask first.", "Not a question", False)
        else:
            token = ANSWER.set(UserAnswer())
            try:
                result = await self._run(ask.tool, {**ask.args, "confirmed": True})
            finally:
                ANSWER.reset(token)
        await report_outcome(self._seti, ask.id, result)
        return result

    async def confirm_asked(self, args: Mapping[str, Any]) -> ToolResult:
        raw = args.get("ids")
        ids = [int(i) for i in raw if isinstance(i, int)] if isinstance(raw, list) else []
        if not ids:
            raise ToolError("Name the ids of the questions the user said yes to.", "No question ids")
        gate = self._actions.confirmations
        if gate.turn == 0:
            raise ToolError("The user has not answered since you asked.", "No answer yet")
        taken = parse_answered(await gate.confirm(ids=ids))
        done = [(ask, await self.answer(ask)) for ask in taken]
        missing = [i for i in ids if i not in {ask.id for ask in taken}]
        return confirm_text(done, missing)

    async def _list(self, path: str) -> list[dict[str, Any]]:
        return dicts(await self._seti.get(path))

    async def _tasks(self) -> list[dict[str, Any]]:
        return await self._list("/tasks")

    async def match_tasks(self, ref: str) -> list[dict[str, Any]]:
        """The tasks ref could name, from the most exact rule that matches any."""
        return pick(await self._tasks(), ref, lambda t: str(t.get("id", "")), title_of, lambda _t: [])

    async def resolve_task(self, ref: str) -> dict[str, Any]:
        """The one task ref names, or a ToolError saying none or several match."""
        found = await self.match_tasks(ref)
        return only(
            found,
            ref,
            "task",
            lambda t: f"{title_of(t)} ({status_word(shown_status(t))})",
            "Call list_tasks to see the task titles.",
        )

    def _history_window(self, text: str) -> tuple[datetime, datetime | None, tzinfo, str]:
        """A window the user named, read on their clock: a date, today, yesterday or a span."""
        zone = CURRENT_CLOCK.get().zone
        day = text.strip()
        if DATE.match(day):
            try:
                start = datetime.fromisoformat(day).replace(tzinfo=zone)
            except ValueError as e:
                raise ToolError(f"{day} is not a date.", "Bad date") from e
            return start, start + timedelta(days=1), zone, f"on {day}"
        start, end, label = parse_window(text, self._now(), zone)
        return start, end, zone, label

    async def list_tasks(self, args: Mapping[str, Any]) -> ToolResult:
        active = arg_str(args, "active", required=False)
        if active:
            return await activity_result(self._seti, *self._history_window(active))
        status = arg_str(args, "status", required=False)
        if status != "" and status not in TASK_STATUSES:
            raise ToolError(f"Unknown status {status}. Use one of {', '.join(TASK_STATUSES)}.", "Bad status")
        tasks = await self._tasks()
        names = await workspace_names(self._seti)
        if status:
            tasks = [t for t in tasks if shown_status(t) == status]
        ref = arg_str(args, "workspace", required=False)
        place = ""
        if ref:
            workspace = resolve_workspace(await workspace_list(self._seti), ref)
            tasks = [t for t in tasks if t.get("workspace_id") == workspace.get("id")]
            place = f" in {name_of(workspace)}"
        if not tasks:
            which = f"{status_word(status)} " if status else ""
            return ToolResult(f"There are no {which}tasks{place}.", f"No {which}agents{place}")
        tasks.sort(key=lambda t: str(t.get("updated_at", "")), reverse=True)
        now = self._now()
        counts: dict[str, int] = {}
        for t in tasks:
            counts[shown_status(t)] = counts.get(shown_status(t), 0) + 1
        tally = ", ".join(f"{n} {status_word(s)}" for s, n in counts.items())
        lines = [f"{plural(len(tasks), 'task')}{place}: {tally}."]
        for t in tasks[:LIST_LIMIT]:
            where = (
                "" if ref or len(names) < 2 else f" in {names.get(str(t.get('workspace_id')), 'a workspace')}"
            )
            seen = ", not seen yet" if t.get("unseen") is True else ""
            lines.append(
                f"- {title_of(t)}{where}: {status_word(shown_status(t))}{status_note(t)}{seen}, "
                f"{task_repos(t)}, "
                f"updated {ago(t.get('updated_at'), now)}"
            )
        if len(tasks) > LIST_LIMIT:
            lines.append(f"And {len(tasks) - LIST_LIMIT} older ones not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(tasks), 'agent')}")

    async def _open_prs(self, scope: str) -> dict[str, Any]:
        data = await self._seti.get("/prs", {"scope": scope})
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _prs_of(pr_list: Mapping[str, Any]) -> list[dict[str, Any]]:
        prs: list[dict[str, Any]] = []
        for repo in dicts(pr_list.get("repos")):
            prs.extend(dicts(repo.get("prs")))
        return prs

    async def _task_prs(self, task: Mapping[str, Any]) -> list[str]:
        urls = [u for u in task.get("pr_urls") or [] if isinstance(u, str)]
        if not urls:
            return ["No linked PRs."]
        try:
            open_prs = {str(p.get("url")): p for p in self._prs_of(await self._open_prs("all"))}
        except SetiError as e:
            return [f"{plural(len(urls), 'linked PR')}, status unavailable: {e.title}."]
        lines = [f"{plural(len(urls), 'linked PR')}:"]
        for url in urls:
            pr = open_prs.get(url)
            if pr is None:
                lines.append(f"- {pr_label(url)}: not open in a registered repo")
            else:
                lines.append(f"- {pr_line(pr)}")
        return lines

    async def _waiting(self, task_id: str) -> list[dict[str, Any]]:
        page = await self._seti.get(f"/tasks/{task_id}/messages", {"limit": MESSAGE_WINDOW})
        rows = page.get("messages") if isinstance(page, dict) else None
        return queued_updates(rows if isinstance(rows, list) else [])

    async def _digest(self, task_id: str) -> list[str]:
        try:
            data = await self._seti.get(f"/tasks/{task_id}/digest", {"limit": DIGEST_LIMIT})
        except SetiError as e:
            return [f"Recent transcript unavailable: {e.title}."]
        lines = data.get("lines") if isinstance(data, dict) else None
        if not isinstance(lines, list) or not lines:
            return ["The transcript is empty."]
        now = self._now()
        out = ["Recent transcript, oldest first:"]
        for line in lines[-DIGEST_LIMIT:]:
            if isinstance(line, dict):
                text = clip(str(line.get("text", "")), 240)
                out.append(f"- {line.get('kind', 'note')}, {ago(line.get('at'), now)}: {text}")
        return out

    async def get_task(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        task_id = str(task.get("id"))
        now = self._now()
        worktree = " in a worktree" if task.get("worktree") is True else ""
        lines = [
            f"Task {title_of(task)} is {status_word(shown_status(task))}, in {task_repos(task)}"
            f"{worktree}. Started {ago(task.get('created_at'), now)}, last change "
            f"{ago(task.get('updated_at'), now)}. Cost so far at API prices {money(task.get('cost_usd'))}."
        ]
        workspace = (await workspace_names(self._seti)).get(str(task.get("workspace_id")))
        if workspace is not None:
            lines.append(f"It is in the workspace {workspace}.")
        lines.extend(location_lines(task))
        lines.extend(await role_lines(self._seti, task))
        subagents = running_subagents(task)
        if subagents > 0 and task.get("status") != "running":
            lines.append(f"Its own turn has ended; {plural(subagents, 'subagent')} it started still running.")
        todos = todo_line(task)
        if todos is not None:
            lines.append(todos)
        if task.get("status_line"):
            since = ago(task.get("status_line_at"), now)
            lines.append(f'Its status line reads "{task.get("status_line")}", set {since}.')
        if task.get("status") == "error" and task.get("last_error"):
            lines.append(f"Last error: {clip(str(task.get('last_error')), 200)}")
        outward = task.get("outward_count")
        if isinstance(outward, int) and outward > 0:
            lines.append(f"It made {plural(outward, 'call')} that reach outside the machine.")
        lines.extend(await self._task_prs(task))
        waiting = await self._waiting(task_id)
        if waiting:
            about = "; ".join(clip(str(u.get("title", "update")), 80) for u in waiting[:5])
            when = _waiting_reason(task)
            lines.append(f"{plural(len(waiting), 'update')} waiting for the agent ({when}): {about}")
        else:
            lines.append("No updates are waiting.")
        window = arg_str(args, "window", required=False)
        if window:
            lines.extend(await window_transcript(self._seti, task_id, *self._history_window(window)))
        else:
            lines.extend(await self._digest(task_id))
        return ToolResult("\n".join(lines), f"Read agent {clip(title_of(task), 60)}")

    async def search_seti(self, args: Mapping[str, Any]) -> ToolResult:
        query = arg_str(args, "query")
        ref = arg_str(args, "task", required=False)
        params: dict[str, str | int] = {"q": query, "limit": SEARCH_LIMIT}
        task = await self.resolve_task(ref) if ref else None
        if task is not None:
            params["task"] = str(task.get("id"))
        data = await self._seti.get("/ea/search", params)
        hits = dicts(data.get("hits")) if isinstance(data, dict) else []
        within = f" in {title_of(task)}" if task is not None else ""
        if not hits:
            return ToolResult(f"Nothing in Seti's index matches {query}{within}.", "No matches")
        now = self._now()
        lines = [f"{plural(len(hits), 'excerpt')} for {query}{within}, best first:"]
        for number, hit in enumerate(hits, 1):
            kind = str(hit.get("kind", "text")).replace("_", " ")
            if hit.get("task_id"):
                archived = " (archived)" if hit.get("archived") else ""
                task_title = hit.get("task_title") or "deleted"
                source = f'task "{task_title}"{archived} (link #agents/{hit.get("task_id")})'
            else:
                title = f' "{hit.get("pr_title")}"' if hit.get("pr_title") else ""
                source = f"{pr_label(str(hit.get('pr_url', '')))}{title} (link {hit.get('pr_url')})"
            snippet = clip(str(hit.get("snippet", "")), SNIPPET_CHARS)
            lines.append(f'{number}. From {source}, {kind}, {ago(hit.get("at"), now)}: "{snippet}"')
        return ToolResult("\n".join(lines), f"Found {plural(len(hits), 'excerpt')}")

    async def _subtasks(self, task: Mapping[str, Any]) -> list[dict[str, Any]]:
        return await self._list(f"/tasks/{task.get('id')}/subtasks")

    def _subtask_line(self, sub: Mapping[str, Any], now: datetime) -> str:
        status = str(sub.get("status", "unknown"))
        kind = f" ({sub.get('subagent_type')})" if sub.get("subagent_type") else ""
        nested = ", nested" if sub.get("parent_tool_use_id") else ""
        spent = duration(_elapsed(sub, now))
        head = f"- {clip(str(sub.get('description', 'subagent')), 80)}{kind}{nested}"
        if status == "running":
            progress = sub.get("progress")
            last = progress.get("last_tool") if isinstance(progress, dict) else None
            doing = f", last tool {last}" if last else ""
            return f"{head}: running for {spent}{doing}"
        summary = f": {clip(str(sub.get('summary')), 100)}" if sub.get("summary") else ""
        word = {"completed": "completed in", "failed": "failed after", "stopped": "stopped after"}.get(status)
        return f"{head}: {word} {spent}{summary}" if word else f"{head}: outcome unknown{summary}"

    async def list_subtasks(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        title = title_of(task)
        subs = await self._subtasks(task)
        if not subs:
            return ToolResult(f"{title} has started no subagents.", f"No subagents in {clip(title, 50)}")
        now = self._now()
        running = [s for s in subs if s.get("status") == "running"]
        rest = sorted(
            (s for s in subs if s.get("status") != "running"),
            key=lambda s: str(s.get("started_at", "")),
            reverse=True,
        )
        counts: dict[str, int] = {}
        for s in subs:
            counts[str(s.get("status"))] = counts.get(str(s.get("status")), 0) + 1
        tally = ", ".join(f"{n} {s}" for s, n in counts.items())
        lines = [f"{title} has {plural(len(subs), 'subagent')}: {tally}."]
        shown = [*running, *rest][:LIST_LIMIT]
        lines.extend(self._subtask_line(s, now) for s in shown)
        if len(subs) > LIST_LIMIT:
            lines.append(f"And {len(subs) - LIST_LIMIT} older ones not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(subs), 'subagent')} of {clip(title, 40)}")

    async def resolve_subtask(self, task: Mapping[str, Any], ref: str) -> dict[str, Any]:
        """The one subagent of task that ref names by description, type or latest."""
        subs = await self._subtasks(task)
        if not subs:
            raise ToolError(f"{title_of(task)} has started no subagents.", "No subagents")
        if normalize(ref) in LATEST:
            found = [max(subs, key=lambda s: str(s.get("started_at", "")))]
        else:
            found = pick(
                subs,
                ref,
                lambda s: str(s.get("tool_use_id", "")),
                lambda s: str(s.get("description", "")),
                lambda s: [str(s.get("subagent_type") or "")],
            )
        return only(
            found,
            ref,
            "subagent",
            lambda s: f"{clip(str(s.get('description', '')), 60)} ({s.get('status')})",
            "Call list_subtasks to see them.",
        )

    async def get_subtask(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        brief = await self.resolve_subtask(task, arg_str(args, "subtask"))
        sub = await self._seti.get(f"/tasks/{task.get('id')}/subtasks/{brief.get('tool_use_id')}")
        detail: dict[str, Any] = sub if isinstance(sub, dict) else brief
        now = self._now()
        description = clip(str(detail.get("description", "subagent")), 80)
        status = str(detail.get("status", "unknown"))
        kind = f" (type {detail.get('subagent_type')})" if detail.get("subagent_type") else ""
        background = " in the background" if detail.get("background") is True else ""
        started = f"started {ago(detail.get('started_at'), now)}"
        if status == "unknown":
            state = f"has no recorded outcome; it {started}"
        else:
            state = f"is {status}{background}; {started}, ran {duration(_elapsed(detail, now))}"
        lines = [f'Subagent "{description}"{kind} of {title_of(task)} {state}.']
        usage = detail.get("usage")
        if isinstance(usage, dict):
            lines.append(
                f"{plural(int(usage.get('tool_uses') or 0), 'tool call')}, about "
                f"{round(int(usage.get('total_tokens') or 0) / 1000)} thousand tokens."
            )
        if detail.get("prompt"):
            lines.append(f"Its brief: {clip(str(detail.get('prompt')), GIST_CHARS)}")
        progress = detail.get("progress")
        if status == "running" and isinstance(progress, dict):
            last = f" Last tool {progress.get('last_tool')}." if progress.get("last_tool") else ""
            said = f" {clip(str(progress.get('summary')), 200)}" if progress.get("summary") else ""
            lines.append(f"Progress: {clip(str(progress.get('description', '')), 120)}.{last}{said}")
        result = detail.get("result")
        if result:
            text = str(result)
            more = " The full report is in the Seti UI." if len(text) > REPORT_CHARS else ""
            lines.append(f"Report gist: {clip(text, REPORT_CHARS)}{more}")
        elif status != "running":
            lines.append("It left no report.")
        return ToolResult("\n".join(lines), f"Read subagent {clip(description, 50)}")

    async def _waiting_across(
        self, tasks: list[dict[str, Any]]
    ) -> tuple[list[tuple[dict[str, Any], list[dict[str, Any]]]], int]:
        """Tasks with PR updates waiting, newest first, and how many tasks could not be checked."""
        linked = [t for t in tasks if t.get("pr_urls")]
        linked.sort(key=lambda t: str(t.get("updated_at", "")), reverse=True)
        scan = linked[:WAITING_SCAN]
        results = await _limited((self._waiting(str(t.get("id"))) for t in scan), SCAN_CONCURRENCY)
        found: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        failed = 0
        for task, result in zip(scan, results, strict=True):
            if isinstance(result, BaseException):
                failed += 1
            elif result:
                found.append((task, result))
        return found, failed

    async def list_waiting_updates(self, args: Mapping[str, Any]) -> ToolResult:
        waiting, failed = await self._waiting_across(await self._tasks())
        total = sum(len(updates) for _, updates in waiting)
        lines = [
            f"{plural(total, 'update')} waiting across {plural(len(waiting), 'task')}:"
            if waiting
            else "No updates are waiting on any task."
        ]
        for task, updates in waiting[:LIST_LIMIT]:
            about = "; ".join(clip(str(u.get("title", "update")), 70) for u in updates[-3:])
            lines.append(
                f"- {title_of(task)} ({status_word(shown_status(task))}): {plural(len(updates), 'update')}, "
                f"latest {about}. {_waiting_reason(task).capitalize()}."
            )
        if len(waiting) > LIST_LIMIT:
            lines.append(f"And {len(waiting) - LIST_LIMIT} more tasks not listed.")
        if failed:
            lines.append(f"Could not check {plural(failed, 'task')}.")
        summary = f"{plural(total, 'update')} waiting" if total else "No updates waiting"
        return ToolResult("\n".join(lines), summary)

    async def list_prs(self, args: Mapping[str, Any]) -> ToolResult:
        scope = arg_str(args, "scope", required=False) or "mine"
        if scope not in ("mine", "all"):
            raise ToolError("Scope must be mine or all.", "Bad scope")
        data = await self._open_prs(scope)
        lines: list[str] = []
        if scope == "mine" and data.get("viewer") is None:
            lines.append("The GitHub CLI is not logged in, so Seti cannot tell which PRs are yours.")
        for repo in dicts(data.get("repos")):
            if repo.get("error"):
                lines.append(
                    f"Could not load {repo_name(str(repo.get('slug')))}: {clip(str(repo['error']), 120)}"
                )
        prs = self._prs_of(data)
        prs.sort(key=lambda p: str(p.get("updated_at", "")), reverse=True)
        whose = "of yours" if scope == "mine" else "in total"
        lines.insert(0, f"{plural(len(prs), 'open PR')} {whose}.")
        for pr in prs[:PR_LIMIT]:
            linked = [f"{title_of(t)} ({status_word(t.get('status'))})" for t in dicts(pr.get("tasks"))]
            task_text = f"; task {', '.join(linked)}" if linked else "; no task"
            lines.append(f"- {pr_line(pr)}{task_text}")
        if len(prs) > PR_LIMIT:
            lines.append(f"And {len(prs) - PR_LIMIT} more not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(prs), 'PR')} ({scope})")

    async def resolve_pr(self, ref: str) -> dict[str, Any]:
        """The open PR ref names by URL, repo and number, title, or the task it belongs to."""
        prs = self._prs_of(await self._open_prs("all"))

        def label(p: Mapping[str, Any]) -> str:
            return f"{pr_label(str(p.get('url', '')))}, {clip(str(p.get('title', '')), 50)}"

        url = PR_URL.search(ref)
        if url is not None:
            key = url.group(0).lower()
            found = [
                p for p in prs if (m := PR_URL.search(str(p.get("url", "")))) and m.group(0).lower() == key
            ]
            if found:
                return found[0]
            pr = await self._seti.get("/prs/by-url", {"url": f"https://{url.group(0)}"})
            if isinstance(pr, dict):
                return pr
            raise ToolError(
                f"{pr_label(ref)} is merged, closed, or not in a registered repo.",
                f"{pr_label(ref)} is not open",
            )
        numbers = NUMBER.findall(ref)
        if len(numbers) == 1:
            number = int(numbers[0])
            found = [p for p in prs if p.get("number") == number]
            words = [w for w in key_words(NUMBER.sub(" ", ref)) if w not in PR_WORDS]
            if words and len(found) > 1:
                narrowed = [p for p in found if word_score(words, repo_name(str(p.get("repo_slug", "")))) > 0]
                found = narrowed or found
            return only(found, ref, "open PR", label, "Call list_prs to see the open PRs.")
        found = pick(
            prs,
            ref,
            lambda p: str(p.get("key", "")),
            lambda p: str(p.get("title", "")),
            lambda p: [str(p.get("head_ref", ""))],
        )
        if found:
            return only(found, ref, "open PR", label, "")
        tasks = pick(await self._tasks(), ref, lambda t: str(t.get("id", "")), title_of, lambda _t: [])
        if len(tasks) == 1:
            urls = set(tasks[0].get("pr_urls") or [])
            of_task = [p for p in prs if p.get("url") in urls]
            if not of_task:
                raise ToolError(f"Task {title_of(tasks[0])} has no open PRs.", "No open PRs")
            return only(of_task, ref, "open PR", label, "")
        raise ToolError(
            f'No open PR matches "{ref}". Call list_prs to see the open PRs.',
            f'No open PR matches "{clip(ref, 40)}"',
        )

    @staticmethod
    def _checks_line(pr: Mapping[str, Any]) -> str:
        checks = dicts(pr.get("checks"))
        if not checks:
            return "No CI checks."
        by_state: dict[str, list[str]] = {}
        for c in checks:
            by_state.setdefault(str(c.get("state")), []).append(str(c.get("name")))
        failing = by_state.get("failure", [])
        pending = by_state.get("pending", [])
        passing = len(by_state.get("success", []))
        parts = [f"{passing} of {plural(len(checks), 'check')} passing"]
        if failing:
            parts.append(f"failing: {and_list(failing[:6])}")
        if pending:
            parts.append(f"still running: {and_list(pending[:4])}")
        other = len(checks) - passing - len(failing) - len(pending)
        if other:
            parts.append(f"{other} neutral or skipped")
        return f"CI: {'; '.join(parts)}."

    @staticmethod
    def _relation(reasons: list[dict[str, Any]]) -> str:
        words: list[str] = []
        for r in reasons:
            match r.get("type"):
                case "mentions":
                    words.append(f"this PR mentions it in its {r.get('place')}")
                case "mentioned_by":
                    words.append(f"it mentions this PR in its {r.get('place')}")
                case "same_task":
                    words.append(f"same task {r.get('task_title')}")
                case "same_branch":
                    words.append(f"same branch {r.get('branch')}")
                case _:
                    pass
        return "; ".join(words[:2])

    async def get_pr(self, args: Mapping[str, Any]) -> ToolResult:
        pr = await self.resolve_pr(arg_str(args, "pr"))
        now = self._now()
        label = pr_label(str(pr.get("url", "")))
        author = f", by {pr.get('author')}" if pr.get("author") else ""
        draft = " It is a draft." if pr.get("draft") is True else ""
        lines = [
            f"{label}, {clip(str(pr.get('title', '')), 100)}{author}, {pr.get('head_ref')} into "
            f"{pr.get('base_ref')}, updated {ago(pr.get('updated_at'), now)}.{draft}",
            self._checks_line(pr),
        ]
        review = {"approved": "approved", "changes_requested": "changes requested"}.get(
            str(pr.get("review_decision")),
            "awaiting review" if pr.get("review_decision") else "no review decision",
        )
        threads = threads_word(pr)
        review = f"{review}, {threads}" if threads else review
        merge = MERGEABLE_WORDS.get(str(pr.get("mergeable")), "mergeability not known yet")
        preview = preview_word(pr.get("preview")) or "no preview"
        lines.append(f"Review: {review}. {merge.capitalize()}. {preview.capitalize()}.")
        labels = [str(x) for x in pr.get("labels") or [] if isinstance(x, str)]
        if labels:
            lines.append(f"Labels: {', '.join(labels[:8])}.")
        tasks = [f"{title_of(t)} ({status_word(t.get('status'))})" for t in dicts(pr.get("tasks"))]
        lines.append(f"Linked tasks: {', '.join(tasks)}." if tasks else "No linked task.")
        related = dicts(pr.get("related"))
        if related:
            lines.append(f"{plural(len(related), 'related PR')}:")
            for r in related[:5]:
                ci = CI_WORDS.get(str(r.get("ci")))
                ci_text = f", {ci}" if ci else ""
                why = self._relation(dicts(r.get("reasons")))
                lines.append(f"- {pr_label(str(r.get('url', '')))}{ci_text}: {why}")
            if len(related) > 5:
                lines.append(f"And {len(related) - 5} more not listed.")
        return ToolResult("\n".join(lines), f"Read {label}")

    async def _audit_scan(
        self,
        params: dict[str, str | int],
        since: datetime | None,
        end: datetime | None,
        ea_only: bool,
        want: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        """Matching events newest first, and whether the scan stopped before covering the window."""
        matched: list[dict[str, Any]] = []
        before: int | None = None
        for _ in range(AUDIT_PAGES):
            query = dict(params) if before is None else {**params, "before": before}
            page = await self._seti.get("/audit", query)
            events = dicts(page.get("events")) if isinstance(page, dict) else []
            for e in events:
                at = parse_time(e.get("at"))
                if since is not None and at is not None and at < since:
                    return matched, False
                if end is not None and at is not None and at >= end:
                    continue
                if not ea_only or _via_ea(e):
                    matched.append(e)
            if since is None and len(matched) >= want:
                return matched, False
            nxt = page.get("next_before") if isinstance(page, dict) else None
            if not isinstance(nxt, int):
                return matched, False
            before = nxt
        return matched, True

    def _audit_line(self, event: Mapping[str, Any], titles: Mapping[str, str], now: datetime) -> str:
        actor = str(event.get("actor"))
        who = "the EA" if _via_ea(event) else AUDIT_WHO.get(actor, actor)
        if actor == "agent" and event.get("subject_type") == "task":
            who = f"agent in {titles.get(str(event.get('subject_id')), 'a task since deleted')}"
        text = clip(str(event.get("summary", "")), 110)
        detail = event.get("detail")
        if event.get("kind") == "task.message_sent" and isinstance(detail, dict) and detail.get("prompt"):
            text += f': "{clip(str(detail.get("prompt")), 80)}"'
        return f"- {ago(event.get('at'), now)}, {who}: {text}"

    async def search_audit(self, args: Mapping[str, Any]) -> ToolResult:
        area = audit_kind(arg_str(args, "area", required=False))
        actor = normalize(arg_str(args, "actor", required=False))
        actor = ACTOR_ALIASES.get(actor, actor)
        if actor and actor not in AUDIT_ACTORS:
            raise ToolError(f"Unknown actor {actor}. Use one of {', '.join(AUDIT_ACTORS)}.", "Bad actor")
        query = arg_str(args, "query", required=False)
        limit = arg_int(args, "limit", AUDIT_LIMIT, AUDIT_LIMIT_MAX)
        now = self._now()
        window = arg_str(args, "window", required=False)
        zone_name = arg_str(args, "timezone", required=False)
        zone = zone_of(zone_name) if zone_name else None
        since: datetime | None = None
        end: datetime | None = None
        when = ""
        if window:
            since, end, when = parse_window(window, now, zone or UTC)
            if zone is None and when in ("today", "yesterday", "this week"):
                when += " (UTC)"
        ea_only = actor == "ea"
        params: dict[str, str | int] = {"limit": AUDIT_PAGE if since or ea_only else limit}
        if area:
            params["kind"] = area
        if actor:
            params["actor"] = "user" if ea_only else actor
        if query:
            params["q"] = query[:200]
        events, partial = await self._audit_scan(params, since, end, ea_only, limit)
        one, many = _audit_noun(area, actor)
        about = f' matching "{clip(query, 40)}"' if query else ""
        tail = f"{about}{' ' + when if when else ''}"
        if not events:
            text = f"No {many}{tail} in the audit log."
            if partial:
                text += f" Only the latest {AUDIT_PAGE * AUDIT_PAGES} events were searched."
            return ToolResult(text, clip(f"No {many}{tail}", 70))
        titles: dict[str, str] = {}
        if any(e.get("actor") == "agent" and e.get("subject_type") == "task" for e in events[:limit]):
            try:
                titles = {str(t.get("id")): title_of(t) for t in await self._tasks()}
            except SetiError:
                titles = {}
        count = f"{'At least ' if partial else ''}{len(events)} {one if len(events) == 1 else many}"
        head = f"{count}{tail}" if since else f"Latest {many}{tail}"
        kinds = {e.get("kind") for e in events}
        tally = f": {_kind_tally(events)}" if len(kinds) > 1 or "." not in area else ""
        lines = [f"{head}{tally}."]
        if partial:
            lines.append(
                f"Only the latest {AUDIT_PAGE * AUDIT_PAGES} events were searched; older ones were not."
            )
        lines.append("Newest first:")
        lines.extend(self._audit_line(e, titles, now) for e in events[:limit])
        if len(events) > limit:
            lines.append(f"And {len(events) - limit} more not listed.")
        return ToolResult("\n".join(lines), clip(f"Audit: {count}{tail}", 70))

    async def stop_task(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        title = title_of(task)
        if task.get("status") != "running":
            raise ToolError(
                f"{title} is not running; it is {status_word(task.get('status'))}. Nothing to stop.",
                f"{clip(title, 50)} was not running",
            )
        updated = await self._seti.post(f"/tasks/{task.get('id')}/stop")
        status = updated.get("status") if isinstance(updated, dict) else "stopped"
        return ToolResult(f"Stopped {title}. It is now {status_word(status)}.", f"Stopped {clip(title, 60)}")

    async def hand_over_updates(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        title = title_of(task)
        waiting = await self._waiting(str(task.get("id")))
        if not waiting:
            raise ToolError(f"No updates are waiting for {title}.", f"Nothing waiting for {clip(title, 50)}")
        if task.get("status") == "running":
            raise ToolError(
                f"{title} is running; it receives the {plural(len(waiting), 'update')} "
                "when this turn ends, or with the next message.",
                f"{clip(title, 50)} is running",
            )
        await self._seti.post(f"/tasks/{task.get('id')}/inputs/deliver")
        return ToolResult(
            f"Handed {plural(len(waiting), 'update')} to {title}; its agent is working on them.",
            f"Handed {plural(len(waiting), 'update')} to {clip(title, 50)}",
        )

    async def _repos(self) -> list[dict[str, Any]]:
        return await self._list("/repos")

    async def start_task(self, args: Mapping[str, Any]) -> ToolResult:
        prompt = arg_str(args, "prompt")
        title = arg_str(args, "title", required=False)
        raw = args.get("repos")
        refs = [
            r
            for r in (raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else [])
            if isinstance(r, str) and r.strip()
        ]
        repo_ids: list[str] = []
        if refs:
            repos = await self._repos()
            for ref in refs:
                repo_id = str(resolve_repo(repos, ref).get("id"))
                if repo_id not in repo_ids:
                    repo_ids.append(repo_id)
        directory = "" if repo_ids else arg_str(args, "directory", required=False)
        body: dict[str, Any] = {"prompt": prompt}
        workspace_ref = arg_str(args, "workspace", required=False)
        if workspace_ref:
            body["workspace_id"] = resolve_workspace(await workspace_list(self._seti), workspace_ref).get(
                "id"
            )
        if title:
            body["title"] = title
        if repo_ids:
            body["repo_ids"] = repo_ids
            if "worktree" in args:
                body["worktree"] = arg_bool(args, "worktree")
        elif directory:
            body["cwd"] = directory
        notify = arg_bool(args, "notify_when_done")
        if notify:
            body["notify_when_done"] = True
        created = await self._seti.post("/tasks/start", body)
        task = created if isinstance(created, dict) else {}
        title = str(task.get("title") or title or "the new task")
        slugs = [str(r.get("slug")) for r in dicts(task.get("repos"))]
        if slugs:
            where = ", ".join(repo_name(s) for s in slugs)
        else:
            where = directory or f"a fresh folder, {task.get('cwd')}, with no repo"
        worktree = " in a worktree" if task.get("worktree") else ""
        setup = task.get("setup")
        note = setup_note(setup) if isinstance(setup, dict) else ""
        return ToolResult(
            f"Started task {title} in {where}{worktree}. It is {status_word(task.get('status', 'running'))}."
            f"{note}{NOTIFY_NOTE if notify else ''}",
            f"Started agent {clip(title, 60)}",
        )

    async def list_repos(self, args: Mapping[str, Any]) -> ToolResult:
        repos = await self._repos()
        if not repos:
            return ToolResult("No repos are registered in Seti.", "No repos")
        lines = [f"{plural(len(repos), 'repo')} registered:"]
        lines.extend(f"- {r.get('slug')}, base branch {r.get('base_branch')}" for r in repos)
        return ToolResult("\n".join(lines), f"Listed {plural(len(repos), 'repo')}")

    async def get_repo(self, args: Mapping[str, Any]) -> ToolResult:
        repo = resolve_repo(await self._repos(), arg_str(args, "repo"))
        repo_id = str(repo.get("id"))
        slug = str(repo.get("slug"))
        tasks, prs, files = await asyncio.gather(
            _attempt(self._tasks()),
            _attempt(self._open_prs("all")),
            _attempt(self._list("/context/files")),
        )
        lines = [f"{slug}, base branch {repo.get('base_branch')}."]
        if isinstance(tasks, list):
            mine = [t for t in tasks if any(r.get("id") == repo_id for r in dicts(t.get("repos")))]
            counts: dict[str, int] = {}
            for t in mine:
                counts[shown_status(t)] = counts.get(shown_status(t), 0) + 1
            tally = ", ".join(f"{n} {status_word(s)}" for s, n in counts.items())
            lines.append(f"{plural(len(mine), 'task')}{': ' + tally if tally else ''}.")
        if isinstance(prs, dict):
            entry = next((r for r in dicts(prs.get("repos")) if r.get("repo_id") == repo_id), None)
            if entry is not None and entry.get("error"):
                lines.append(f"Open PRs could not be loaded: {clip(str(entry.get('error')), 120)}")
            elif entry is not None:
                open_prs = dicts(entry.get("prs"))
                failing = [p for p in open_prs if p.get("ci") == "failure"]
                conflicts = sum(1 for p in open_prs if p.get("mergeable") == "conflicting")
                lines.append(
                    f"{plural(len(open_prs), 'open PR')}, {len(failing)} failing CI, "
                    f"{conflicts} with merge conflicts."
                )
        if isinstance(files, list):
            own = [f for f in files if str(f.get("key", "")).startswith(f"repo:{repo_id}:")]
            parts = [
                f"{f.get('label')} {size_words(f.get('size')) if f.get('exists') else 'not created'}"
                for f in own
            ]
            if parts:
                lines.append(f"Context files: {', '.join(parts)}.")
        return ToolResult("\n".join(lines), f"Read repo {clip(slug, 60)}")

    @staticmethod
    def _summarise_text(text: str, query: str) -> list[str]:
        if query:
            found = matching_lines(text, query, MATCH_LIMIT)
            if not found:
                return [f'No lines mention "{clip(query, 40)}".']
            return [f'Lines mentioning "{clip(query, 40)}":', *(f"- {line}" for line in found)]
        lines: list[str] = []
        outline = headings(text, OUTLINE_LIMIT)
        if outline:
            lines.append(f"Sections: {'; '.join(outline)}.")
        body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        if body.strip():
            lines.append(f"Opening: {clip(body, GIST_CHARS)}")
        return lines

    async def list_context_packs(self, args: Mapping[str, Any]) -> ToolResult:
        packs = await self._list("/context/packs")
        if not packs:
            return ToolResult("There are no context packs.", "No context packs")
        lines = [f"{plural(len(packs), 'context pack')}:"]
        for p in packs[:LIST_LIMIT]:
            description = f": {clip(str(p.get('description')), 100)}" if p.get("description") else ""
            words = len(str(p.get("body", "")).split())
            tags = [
                *(["a role, given per agent with set_agent_role"] if p.get("kind") == "role" else []),
                *(["built into Seti, read-only"] if p.get("builtin") is True else []),
                *(["linked to new agents by default"] if p.get("linked_by_default") is True else []),
            ]
            tag_text = f"; {', '.join(tags)}" if tags else ""
            lines.append(f"- {name_of(p)}{description} (about {plural(words, 'word')}{tag_text})")
        if len(packs) > LIST_LIMIT:
            lines.append(f"And {len(packs) - LIST_LIMIT} more not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(packs), 'context pack')}")

    async def get_context_pack(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "pack")
        packs = await self._list("/context/packs")
        found = pick(packs, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: [])
        pack = only(found, ref, "context pack", name_of, "Call list_context_packs to see their names.")
        body = str(pack.get("body", ""))
        description = f" {clip(str(pack.get('description')), 200)}." if pack.get("description") else ""
        lines = [
            f"Context pack {name_of(pack)}.{description} About {plural(len(body.split()), 'word')}, "
            f"updated {ago(pack.get('updated_at'), self._now())}."
        ]
        lines.extend(self._summarise_text(body, arg_str(args, "query", required=False)))
        return ToolResult("\n".join(lines), f"Read context pack {clip(name_of(pack), 50)}")

    async def list_context_files(self, args: Mapping[str, Any]) -> ToolResult:
        files = await self._list("/context/files")
        if not files:
            return ToolResult("Seti manages no context files.", "No context files")
        now = self._now()
        present = [f for f in files if f.get("exists") is True]
        missing = [context_file_name(f) for f in files if f.get("exists") is not True]
        lines = [f"{plural(len(files), 'context file')}, {len(present)} exist:"]
        for f in present[:LIST_LIMIT]:
            changed = ago(f.get("modified_at"), now)
            lines.append(f"- {context_file_name(f)}: {size_words(f.get('size'))}, changed {changed}")
        if len(present) > LIST_LIMIT:
            lines.append(f"And {len(present) - LIST_LIMIT} more not listed.")
        if missing:
            shown = ", ".join(missing[:6])
            more = f" and {len(missing) - 6} more" if len(missing) > 6 else ""
            lines.append(f"Not created yet: {shown}{more}.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(files), 'context file')}")

    async def read_context_file(self, args: Mapping[str, Any]) -> ToolResult:
        chosen = find_context_file(await self._list("/context/files"), arg_str(args, "file"))
        name = context_file_name(chosen)
        if chosen.get("exists") is not True:
            return ToolResult(f"{name} has not been created yet.", f"{clip(name, 50)} does not exist")
        data = await self._seti.get(f"/context/files/{chosen.get('key')}")
        content = str(data.get("content", "")) if isinstance(data, dict) else ""
        lines = [
            f"{name}: {size_words(chosen.get('size'))} in {plural(len(content.splitlines()), 'line')}, "
            f"changed {ago(chosen.get('modified_at'), self._now())}."
        ]
        lines.extend(self._summarise_text(content, arg_str(args, "query", required=False)))
        return ToolResult("\n".join(lines), f"Read {clip(name, 60)}")

    async def list_mcp_servers(self, args: Mapping[str, Any]) -> ToolResult:
        refresh = arg_bool(args, "refresh")
        snapshot = await (
            self._seti.post("/capabilities/refresh") if refresh else self._seti.get("/capabilities")
        )
        servers = dicts(snapshot.get("servers")) if isinstance(snapshot, dict) else []
        if not servers:
            return ToolResult("No MCP servers are configured.", "No MCP servers")
        counts: dict[str, int] = {}
        for s in servers:
            counts[str(s.get("status"))] = counts.get(str(s.get("status")), 0) + 1
        tally = ", ".join(f"{n} {MCP_WORDS.get(s, s)}" for s, n in counts.items())
        checked = ago(snapshot.get("probed_at"), self._now()) if isinstance(snapshot, dict) else "earlier"
        lines = [f"{plural(len(servers), 'MCP server')}: {tally}. Checked {checked}."]
        servers.sort(key=lambda s: (s.get("status") == "connected", name_of(s).lower()))
        for s in servers[:20]:
            status = str(s.get("status"))
            scope = f", {s.get('scope')} scope" if s.get("scope") else ""
            tools = len(dicts(s.get("tools")))
            tool_text = f", {plural(tools, 'tool')}" if status == "connected" else ""
            error = f": {clip(str(s.get('error')), 100)}" if s.get("error") and status != "connected" else ""
            lines.append(f"- {name_of(s)}: {MCP_WORDS.get(status, status)}{scope}{tool_text}{error}")
        if len(servers) > 20:
            lines.append(f"And {len(servers) - 20} more not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(servers), 'MCP server')}")

    @staticmethod
    def _components(value: Any) -> str:
        if not isinstance(value, dict):
            return ""
        nouns = {"skills": "skill", "agents": "agent", "commands": "command", "hooks": "hook"}
        nouns |= {"mcp_servers": "MCP server", "lsp_servers": "LSP server"}
        parts = [
            plural(len(items), noun)
            for kind, noun in nouns.items()
            if isinstance(items := value.get(kind), list) and items
        ]
        return ", ".join(parts)

    async def list_plugins(self, args: Mapping[str, Any]) -> ToolResult:
        data = await self._seti.get("/plugins")
        listing: dict[str, Any] = data if isinstance(data, dict) else {}
        defaults = dicts(listing.get("defaults"))
        installed = dicts(listing.get("installed"))
        lines: list[str] = []
        if defaults:
            on = sum(1 for p in defaults if p.get("enabled") is True)
            lines.append(f"{plural(len(defaults), 'Seti default plugin')}, {on} enabled:")
            for p in defaults[:LIST_LIMIT]:
                state = "enabled" if p.get("enabled") is True else "disabled"
                parts = self._components(p.get("components"))
                problem = f"; problem: {clip(str(p.get('problem')), 80)}" if p.get("problem") else ""
                lines.append(f"- {name_of(p)}: {state}{', ' + parts if parts else ''}{problem}")
        else:
            lines.append("No Seti default plugins.")
        if listing.get("installed_error"):
            lines.append(f"Installed plugins unavailable: {clip(str(listing.get('installed_error')), 120)}")
        elif installed:
            on = sum(1 for p in installed if p.get("enabled") is True)
            lines.append(f"{plural(len(installed), 'installed Claude Code plugin')}, {on} enabled:")
            for p in installed[:LIST_LIMIT]:
                state = "enabled" if p.get("enabled") is True else "disabled"
                parts = self._components(p.get("components"))
                lines.append(
                    f"- {name_of(p)} ({p.get('scope')} scope): {state}{', ' + parts if parts else ''}"
                )
            if len(installed) > LIST_LIMIT:
                lines.append(f"And {len(installed) - LIST_LIMIT} more not listed.")
        else:
            lines.append("No Claude Code plugins installed.")
        total = len(defaults) + len(installed)
        return ToolResult("\n".join(lines), f"Listed {plural(total, 'plugin')}")

    def _usage_parts(self, windows: list[dict[str, Any]]) -> list[str]:
        now = self._now()
        parts: list[str] = []
        for w in windows:
            used = w.get("utilization")
            if not isinstance(used, int | float):
                continue
            resets = f", resets {until(w.get('resets_at'), now)}" if w.get("resets_at") else ""
            parts.append(
                f"{_window_words(str(w.get('label', '')))} window {round(used)} percent used{resets}"
            )
        return parts

    def _login_line(self, logins: Any) -> str | None:
        if not isinstance(logins, dict):
            return None
        accounts = dicts(logins.get("accounts"))
        active = next((a for a in accounts if a.get("id") == logins.get("active_id")), None)
        others = [str(a.get("name", "")) for a in accounts if a is not active]
        saved = f"; also saved: {', '.join(others)}" if others else ""
        if active is not None:
            return (
                f"Claude login in use: {active.get('name')}{saved}. Only the user switches logins, in Seti."
            )
        unsaved = logins.get("unsaved")
        if isinstance(unsaved, dict):
            who = unsaved.get("email") or "an account"
            return f"Claude Code is signed in to {who}, which is not a saved login{saved}."
        return f"No Claude login in use{saved}." if others else None

    async def account_status(self, args: Mapping[str, Any]) -> ToolResult:
        refresh = arg_bool(args, "refresh")
        data = await (self._seti.post("/account/refresh") if refresh else self._seti.get("/account"))
        status: dict[str, Any] = data if isinstance(data, dict) else {}
        now = self._now()
        health = status.get("health") if isinstance(status.get("health"), dict) else {}
        state = str(health.get("state", "unknown")) if isinstance(health, dict) else "unknown"
        message = str(health.get("message", "")) if isinstance(health, dict) else ""
        lines = [f"Login health {'good' if state == 'ok' else state.replace('_', ' ')}: {clip(message, 160)}"]
        login = self._login_line(status.get("logins"))
        if login:
            lines.append(login)
        usage = status.get("usage")
        parts = self._usage_parts(dicts(usage.get("windows"))) if isinstance(usage, dict) else []
        if parts:
            lines.append(f"Usage: {'; '.join(parts)}.")
        elif status.get("usage_note"):
            lines.append(f"Usage unavailable: {clip(str(status.get('usage_note')), 120)}")
        event = status.get("rate_limit_event")
        if isinstance(event, dict) and event.get("status") not in (None, "allowed"):
            lines.append(
                f"Task {event.get('task_title')} hit a rate limit ({event.get('status')}) "
                f"{ago(event.get('at'), now)}."
            )
        error = status.get("task_error")
        if isinstance(error, dict):
            said = f": {clip(str(error.get('message')), 120)}" if error.get("message") else ""
            lines.append(
                f"Task {error.get('task_title')} failed on the login {ago(error.get('at'), now)} "
                f"({error.get('error')}){said}"
            )
        return ToolResult("\n".join(lines), "Read account status")

    def _followup_line(self, item: Mapping[str, Any], now: datetime) -> str:
        kind = "reminder" if item.get("kind") == "reminder" else "follow-up"
        about = f", about {item.get('source')}" if item.get("task_id") else ""
        due = f"{item.get('local_due')}, {until(item.get('due_at'), now)}"
        return f"- {due}, {kind}{about}: {clip(str(item.get('title', '')), 160)}"

    async def schedule_followup(self, args: Mapping[str, Any]) -> ToolResult:
        note = arg_str(args, "note")
        when = arg_str(args, "when")
        kind = "reminder" if arg_str(args, "kind", required=False) == "reminder" else "followup"
        zone = zone_label(CURRENT_CLOCK.get())
        body: dict[str, Any] = {"kind": kind, "when": when, "note": note, "timezone": zone}
        task_ref = arg_str(args, "task", required=False)
        if task_ref:
            body["task_id"] = str((await self.resolve_task(task_ref)).get("id"))
        origin = INBOX_ORIGIN.get()
        if origin is not None:
            body["parent_id"] = origin
        try:
            item = await self._seti.post("/ea/followups", body)
        except SetiError as e:
            if e.status == 400:
                raise ToolError(f"Seti could not schedule it: {e.detail or e.title}", "Not scheduled") from e
            raise
        fields = item if isinstance(item, dict) else {}
        what = "reminder" if kind == "reminder" else "follow-up"
        due = f"{fields.get('local_due')}, {until(fields.get('due_at'), self._now())}"
        at = local_time(fields.get("due_at"), zone)
        return ToolResult(f"Scheduled a {what} for {due}: {note}", clip(f"{what.capitalize()} {at}", 60))

    async def _followups(self) -> list[dict[str, Any]]:
        return await self._list("/ea/followups")

    async def list_followups(self, args: Mapping[str, Any]) -> ToolResult:
        items = await self._followups()
        if not items:
            return ToolResult("Nothing is scheduled.", "Nothing scheduled")
        now = self._now()
        lines = [f"{plural(len(items), 'item')} scheduled, soonest first:"]
        lines.extend(self._followup_line(item, now) for item in items[:LIST_LIMIT])
        if len(items) > LIST_LIMIT:
            lines.append(f"And {len(items) - LIST_LIMIT} later ones not listed.")
        return ToolResult("\n".join(lines), f"Listed {plural(len(items), 'scheduled item')}")

    async def cancel_followup(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "followup")
        items = await self._followups()
        found = pick(
            items, ref, lambda i: str(i.get("id", "")), lambda i: str(i.get("title", "")), lambda _i: []
        )
        item = only(
            found,
            ref,
            "scheduled item",
            lambda i: f"{clip(str(i.get('title', '')), 60)} at {i.get('local_due')}",
            "Call list_followups to see what is scheduled.",
        )
        await self._seti.delete(f"/ea/followups/{item.get('id')}")
        title = clip(str(item.get("title", "")), 120)
        return ToolResult(
            f"Cancelled: {title}, which was due {item.get('local_due')}.", f"Cancelled {clip(title, 50)}"
        )

    async def watch_task(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self.resolve_task(arg_str(args, "task"))
        if arg_bool(args, "stop"):
            return await self._unwatch(task)
        note = arg_str(args, "note", required=False)
        once = arg_bool(args, "once")
        body: dict[str, Any] = {"task_id": str(task.get("id")), "note": note}
        if once:
            body["once"] = True
        await self._seti.post("/ea/watches", body)
        title = title_of(task)
        if once:
            which = "current" if task.get("status") == "running" else "next"
            return ToolResult(
                f"You will hear once when {title} ends its {which} turn, with its final message.",
                f"Waiting on {clip(title, 60)}",
            )
        return ToolResult(
            f"Watching {title}. You will hear when its turn ends, fails or stops, and when its PRs change.",
            f"Watching {clip(title, 60)}",
        )

    async def _unwatch(self, task: Mapping[str, Any]) -> ToolResult:
        title = title_of(task)
        try:
            await self._seti.delete(f"/ea/watches/{task.get('id')}")
        except SetiError as e:
            if e.status == 404:
                raise ToolError(f"You were not watching {title}.", f"Not watching {clip(title, 50)}") from e
            raise
        return ToolResult(f"Stopped watching {title}.", f"Stopped watching {clip(title, 50)}")

    async def list_watches(self, args: Mapping[str, Any]) -> ToolResult:
        watches = await self._list("/ea/watches")
        if not watches:
            return ToolResult("You are not watching any task.", "No watches")
        lines = [f"Watching {plural(len(watches), 'task')}:"]
        for watch in watches:
            note = f": {clip(str(watch.get('note')), 120)}" if watch.get("note") else ""
            lines.append(f"- {watch.get('task_title')}{note}")
        return ToolResult("\n".join(lines), f"Watching {plural(len(watches), 'agent')}")

    async def read_team_chat(self, args: Mapping[str, Any]) -> ToolResult:
        limit = arg_int(args, "limit", TEAM_LIMIT, TEAM_LIMIT_MAX)
        messages = dicts(await self._seti.get("/team/messages", {"limit": limit}))
        if not messages:
            return ToolResult("The group chat is empty.", "Group chat is empty")
        now = self._now()
        lines = [f"The last {plural(len(messages), 'group chat message')}, oldest first:"]
        lines.extend(
            f"- {team_author(m)} ({ago(m.get('created_at'), now)}): "
            f"{clip(str(m.get('text', '')), TEAM_LINE_CHARS)}"
            for m in messages
        )
        return ToolResult("\n".join(lines), f"Read {plural(len(messages), 'group chat message')}")

    async def _find(
        self, path: str, args: Mapping[str, Any], extra: Mapping[str, Any] | None = None
    ) -> tuple[str, list[dict[str, Any]], bool]:
        query = arg_str(args, "query")
        mode = "words" if arg_bool(args, "whole_words") else "text"
        data = await self._seti.get(path, {"q": query, "mode": mode, "limit": FIND_LIMIT, **(extra or {})})
        found = data if isinstance(data, dict) else {}
        return query, dicts(found.get("hits")), found.get("has_more") is True

    def _found(
        self, query: str, where: str, hits: list[dict[str, Any]], more: bool, kinds: Mapping[str, str]
    ) -> str:
        if not hits:
            return f"Nothing in {where} matches {query}."
        now = self._now()
        count = f"{len(hits)}+" if more else str(len(hits))
        lines = [f"{count} messages in {where} match {query}, newest first:"]
        for hit in hits:
            kind = kinds.get(str(hit.get("kind")), str(hit.get("kind", "message")))
            snippet = clip(str(hit.get("snippet", "")), TEAM_LINE_CHARS)
            lines.append(f'- message {hit.get("id")}, {kind}, {ago(hit.get("created_at"), now)}: "{snippet}"')
        if more:
            lines.append("Older matches exist; narrow the words to reach them.")
        return "\n".join(lines)

    async def find_in_team_chat(self, args: Mapping[str, Any]) -> ToolResult:
        query, hits, more = await self._find("/team/search", args)
        kinds = {"user": "the user", "ea": "you", "task": "an agent"}
        text = self._found(query, "the group chat", hits, more, kinds)
        return ToolResult(text, f"Found {plural(len(hits), 'group chat message')}")

    async def _task_or_handle(self, ref: str) -> dict[str, Any]:
        """The task ref names: an @handle through the group chat, else its id or title."""
        if not ref.strip().startswith("@"):
            return await self.resolve_task(ref)
        wanted = ref.strip().removeprefix("@").lower()
        members = dicts(await self._seti.get("/team/members"))
        member = next((m for m in members if m.get("handle") == wanted), None)
        if member is None:
            raise ToolError(f"No agent has the handle {ref.strip()}.", "No such handle")
        return await self.resolve_task(str(member.get("task_id")))

    async def find_in_transcript(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._task_or_handle(arg_str(args, "task"))
        where = arg_str(args, "where", required=False) or "transcript"
        if where == "file":
            return await read_agent_file(self._seti, task, arg_str(args, "query"))
        if where in FILE_SEARCH_MODES:
            return await self._find_in_files(task, FILE_SEARCH_MODES[where], arg_str(args, "query"))
        if where != "transcript":
            raise ToolError("Set where to transcript, file_names, file_text or file.", "Bad where")
        tools = {"tools": "true"} if arg_bool(args, "include_tools") else {}
        query, hits, more = await self._find(f"/tasks/{task.get('id')}/search", args, tools)
        text = self._found(query, f"the transcript of {title_of(task)}", hits, more, FIND_KINDS)
        return ToolResult(text, f"Found {plural(len(hits), 'transcript message')}")

    async def _find_in_files(self, task: Mapping[str, Any], mode: str, query: str) -> ToolResult:
        """The task's files whose path or text matches, through the Files view's search."""
        base = f"/tasks/{task.get('id')}/files"
        data = await self._seti.get(f"{base}/search", {"q": query, "mode": mode, "limit": FILE_FIND_LIMIT})
        found = data if isinstance(data, dict) else {}
        hits = dicts(found.get("hits"))
        where = "the text in the files" if mode == "text" else "the file and folder names"
        title = title_of(task)
        if not hits:
            return ToolResult(f"Nothing in {where} of {title} matches {query}.", "Found no files")
        roots = {str(r.get("id")): str(r.get("label")) for r in dicts(await self._seti.get(f"{base}/roots"))}
        more = found.get("truncated") is True
        count = f"{len(hits)}+ matches" if more else plural(len(hits), "match", "matches")
        lines = [f"{count} for {query} in {where} of {title}:"]
        for hit in hits:
            place = f"{roots.get(str(hit.get('root')), hit.get('root'))}/{hit.get('path')}"
            if mode == "text":
                lines.append(
                    f'- {place}:{hit.get("line")}: "{clip(str(hit.get("text", "")), TEAM_LINE_CHARS)}"'
                )
            else:
                lines.append(f"- {place}{'/' if hit.get('type') == 'dir' else ''}")
        if found.get("truncated") is True:
            lines.append("More match; narrow the query to reach them.")
        if found.get("partial") is True:
            lines.append("The search stopped early, so some files were not searched.")
        return ToolResult("\n".join(lines), f"Found {plural(len(hits), 'file match', 'file matches')}")

    async def _handle_of(self, ref: str) -> str:
        """The group chat handle of the agent a reference names: its handle, title or id."""
        wanted = ref.strip().removeprefix("@").lower()
        members = dicts(await self._seti.get("/team/members"))
        if any(m.get("handle") == wanted for m in members):
            return wanted
        task = await self.resolve_task(ref)
        found = next((m for m in members if m.get("task_id") == task.get("id")), None)
        member = found or await self._seti.get(f"/team/members/{task.get('id')}")
        return str(member.get("handle")) if isinstance(member, dict) else wanted

    async def post_team_chat(self, args: Mapping[str, Any]) -> ToolResult:
        text = arg_str(args, "text")
        to = arg_str(args, "to", required=False)
        if not to and DIRECT_ONLY.get():
            raise ToolError(
                "Here you may only send a direct message to one agent, with to; a public post waits "
                "for the user's yes.",
                "Direct messages only",
            )
        if to:
            return await self._post_direct(text, await self._handle_of(to))
        posted = await self._seti.post("/team/messages", {"text": text})
        fields = posted if isinstance(posted, dict) else {}
        deliveries = dicts(fields.get("deliveries"))
        unknown = [str(h) for h in fields.get("unknown") or [] if isinstance(h, str)]
        archived = [str(h) for h in fields.get("archived") or [] if isinstance(h, str)]
        reached = sum(1 for d in deliveries if d.get("mode") != "skipped")
        return ToolResult(
            team_outcome(deliveries, unknown, archived),
            f"Posted to the group chat, {plural(reached, 'agent')}",
        )

    async def _post_direct(self, text: str, handle: str) -> ToolResult:
        posted = await self._seti.post("/team/messages", {"text": text, "to": handle})
        fields = posted if isinstance(posted, dict) else {}
        deliveries = dicts(fields.get("deliveries"))
        mode = str(deliveries[0].get("mode")) if deliveries else "skipped"
        how = DIRECT_OUTCOMES.get(mode, "it was not delivered")
        return ToolResult(
            f"Sent @{handle} a direct message; {how}. Only you, @{handle} and the user see it.",
            clip(f"Sent @{handle} a direct message", 70),
        )

    async def reply_team_chat(self, args: Mapping[str, Any]) -> ToolResult:
        message_id = args.get("message_id")
        if isinstance(message_id, str) and message_id.strip().isdigit():
            message_id = int(message_id.strip())
        if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 1:
            raise ToolError("The message_id argument is missing.", "Missing message_id")
        text = arg_str(args, "text")
        data = await self._seti.post("/team/messages", {"text": text, "reply_to": message_id})
        fields = data if isinstance(data, dict) else {}
        deliveries = dicts(fields.get("deliveries"))
        handle = next((f"@{d.get('handle')}" for d in deliveries), None)
        archived = [str(h) for h in fields.get("archived") or [] if isinstance(h, str)]
        summary = f"Replied to {handle} in the group chat" if handle else "Replied in the group chat"
        return ToolResult(reply_outcome(deliveries, archived), summary)

    async def team_excerpt(self, around: int) -> str:
        """The group chat around a message, oldest first, each line with its id."""
        after = max(0, around - MENTION_BEFORE - 1)
        messages = dicts(await self._seti.get("/team/messages", {"after": after, "limit": MENTION_WINDOW}))
        now = self._now()
        return "\n".join(
            f"- #{m.get('id')} {team_author(m)} ({ago(m.get('created_at'), now)}): "
            f"{clip(str(m.get('text', '')), TEAM_LINE_CHARS)}"
            for m in messages
        )

    async def _changelog(self) -> ToolResult:
        log, update = await asyncio.gather(
            _attempt(self._seti.get(f"{WHATS_NEW}/changelog", {"limit": CHANGELOG_SCAN})),
            _attempt(self._seti.get(f"{WHATS_NEW}/update")),
        )
        if isinstance(log, SetiError):
            if log.status == 404:
                return ToolResult(WHATS_NEW_OFF, "Read the Seti changelog")
            raise log
        if isinstance(update, SetiError):
            update = {"state": "unknown", "error": update.title}
        lines = changelog_lines(log, update, self._now(), zone_label(CURRENT_CLOCK.get()))
        return ToolResult("\n".join(lines), "Read the Seti changelog")

    async def seti_overview(self, args: Mapping[str, Any]) -> ToolResult:
        if arg_bool(args, "changelog"):
            return await self._changelog()
        if arg_bool(args, "metrics"):
            return await self._metrics()
        if arg_bool(args, "mods"):
            listing, user = await asyncio.gather(self._seti.get("/mods"), _attempt(self._seti.get("/user")))
            text = mods_text(listing)
            if not isinstance(user, SetiError):
                text = f"{text}\n{themes_text(listing, user)}"
            return ToolResult(text, "Read Seti's mods")
        tasks, prs, audit, account = await asyncio.gather(
            _attempt(self._tasks()),
            _attempt(self._open_prs("mine")),
            _attempt(self._seti.get("/audit", {"limit": AUDIT_PAGE})),
            _attempt(self._seti.get("/account")),
        )
        now = self._now()
        lines: list[str] = []
        if isinstance(tasks, SetiError):
            lines.append(f"Tasks unavailable: {tasks.title}.")
        else:
            lines.append(self._overview_tasks(tasks))
            waiting, failed = await self._waiting_across(tasks)
            if waiting:
                shown = ", ".join(f"{title_of(t)} ({len(u)})" for t, u in waiting[:4])
                more = f" and {len(waiting) - 4} more tasks" if len(waiting) > 4 else ""
                lines.append(f"Updates waiting: {shown}{more}.")
            else:
                lines.append("No updates waiting.")
            if failed:
                lines.append(f"Could not check updates for {plural(failed, 'task')}.")
        lines.append(self._overview_prs(prs))
        lines.extend(self._overview_audit(audit, now))
        lines.extend(self._overview_account(account))
        return ToolResult("\n".join(line for line in lines if line), "Read the Seti overview")

    async def _metrics(self) -> ToolResult:
        clock = CURRENT_CLOCK.get()
        zone: dict[str, str | int] = {"zone": clock.label} if isinstance(clock.zone, ZoneInfo) else {}
        summary, live, archived, usage = await asyncio.gather(
            self._seti.get("/home", zone),
            _attempt(self._tasks()),
            _attempt(self._list("/tasks/archived")),
            _attempt(self._seti.get("/ea/usage", zone)),
        )
        titles = {
            str(task.get("id")): title_of(task)
            for found in (live, archived)
            if not isinstance(found, SetiError)
            for task in found
        }
        lines = metrics_lines(summary, titles, self._now())
        if isinstance(usage, SetiError):
            lines.append(f"The EA's own usage is unavailable: {usage.title}.")
        else:
            lines.extend(ea_usage_lines(usage))
        return ToolResult("\n".join(lines), "Read the shipping metrics")

    @staticmethod
    def _overview_tasks(tasks: list[dict[str, Any]]) -> str:
        if not tasks:
            return "No tasks."
        running = [t for t in tasks if shown_status(t) == "running"]
        errored = [t for t in tasks if shown_status(t) == "error"]
        asking = [t for t in tasks if shown_status(t) == "asking"]
        idle = sum(1 for t in tasks if shown_status(t) == "idle")
        parts = []
        if running:
            parts.append(f"{len(running)} running ({', '.join(title_of(t) for t in running[:3])})")
        else:
            parts.append("none running")
        parts.append(f"{idle} idle")
        if asking:
            parts.append(f"{len(asking)} asking you ({', '.join(title_of(t) for t in asking[:3])})")
        blocked = [t for t in tasks if shown_status(t) == "blocked"]
        if blocked:
            waits = ", ".join(f"{title_of(t)}: {t.get('blocked')}" for t in blocked[:3])
            parts.append(f"{len(blocked)} waiting on the user ({waits})")
        if errored:
            parts.append(
                f"{len(errored)} stopped with an error ({', '.join(title_of(t) for t in errored[:3])})"
            )
        subagents = sum(running_subagents(t) for t in tasks)
        busy = f" {plural(subagents, 'subagent')} running." if subagents else ""
        return f"Tasks: {plural(len(tasks), 'task')}, {', '.join(parts)}.{busy}"

    def _overview_prs(self, prs: dict[str, Any] | SetiError) -> str:
        if isinstance(prs, SetiError):
            return f"PRs unavailable: {prs.title}."
        if prs.get("viewer") is None:
            return "The GitHub CLI is not logged in, so your PRs are unknown."
        mine = self._prs_of(prs)
        failing = sorted(
            (p for p in mine if p.get("ci") == "failure"),
            key=lambda p: str(p.get("updated_at", "")),
            reverse=True,
        )
        failing.sort(key=lambda p: not p.get("tasks"))
        conflicts = sum(1 for p in mine if p.get("mergeable") == "conflicting")
        approved = sum(1 for p in mine if p.get("review_decision") == "approved")
        text = f"Your PRs: {len(mine)} open, {len(failing)} failing CI"
        text += f", {conflicts} with conflicts, {approved} approved."
        if failing:
            named = []
            for p in failing[:3]:
                tasks = dicts(p.get("tasks"))
                of = f" (task {title_of(tasks[0])})" if tasks else ""
                named.append(f"{pr_label(str(p.get('url', '')))}{of}")
            text += f" Failing: {', '.join(named)}."
        return text

    def _overview_audit(self, audit: Any, now: datetime) -> list[str]:
        if isinstance(audit, SetiError):
            return [f"Audit log unavailable: {audit.title}."]
        events = dicts(audit.get("events")) if isinstance(audit, dict) else []
        recent = [e for e in events if (at := parse_time(e.get("at"))) is not None and now - at <= RECENT]
        outward = sum(1 for e in recent if e.get("kind") == "agent.outward")
        notable = [e for e in recent if e.get("kind") not in QUIET_KINDS]
        lines: list[str] = []
        if notable:
            shown = "; ".join(
                f"{clip(str(e.get('summary', '')), 80)} ({ago(e.get('at'), now)})" for e in notable[:4]
            )
            more = f"; and {len(notable) - 4} more" if len(notable) > 4 else ""
            lines.append(f"Notable in the last hour: {shown}{more}.")
        if outward:
            lines.append(f"Agents made {plural(outward, 'outward call')} in the last hour.")
        return lines

    def _overview_account(self, account: Any) -> list[str]:
        if not isinstance(account, dict):
            return []
        lines: list[str] = []
        health = account.get("health")
        if isinstance(health, dict) and health.get("state") != "ok":
            lines.append(f"Account problem: {clip(str(health.get('message', '')), 120)}")
        usage = account.get("usage")
        windows = dicts(usage.get("windows")) if isinstance(usage, dict) else []
        high = [
            w for w in windows if isinstance(w.get("utilization"), int | float) and w["utilization"] >= 75
        ]
        if high:
            lines.append(f"Usage is high: {'; '.join(self._usage_parts(high))}.")
        return lines
