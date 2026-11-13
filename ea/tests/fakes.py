"""An in-memory Seti API and sample data for the tests."""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from seti_ea.config import Settings
from seti_ea.toolkit import queued_update_rows

NOW = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)
SETI_TOKEN = "t" * 43

TASK_LOGIN = "11111111-aaaa-4bbb-8ccc-000000000001"
TASK_LOGOUT = "22222222-aaaa-4bbb-8ccc-000000000002"
TASK_DOCS = "33333333-aaaa-4bbb-8ccc-000000000003"
REPO_SETI = "aaaaaaaa-1111-4222-8333-000000000001"
REPO_WEB = "bbbbbbbb-1111-4222-8333-000000000002"
REPO_WEB_ADMIN = "cccccccc-1111-4222-8333-000000000003"
PR_SETI = "https://github.com/Octocat/seti/pull/28"
PR_GONE = "https://github.com/Octocat/seti/pull/7"


def make_task(task_id: str, title: str, status: str, **extra: Any) -> dict[str, Any]:
    task: dict[str, Any] = {
        "id": task_id,
        "title": title,
        "repo_id": REPO_SETI,
        "repo_slug": "Octocat/seti",
        "repos": [{"id": REPO_SETI, "slug": "Octocat/seti", "dir": "/home/u/seti", "worktree": False}],
        "dirs": [],
        "cwd": "/home/u/seti",
        "worktree": False,
        "pr_urls": [],
        "input_mode": "wake",
        "session_id": None,
        "source_session_id": None,
        "status": status,
        "permission_mode": "bypassPermissions",
        "model": None,
        "cost_usd": 0.0,
        "outward_count": 0,
        "last_error": None,
        "created_at": "2026-09-27T10:00:00.000Z",
        "updated_at": "2026-09-27T11:55:00.000Z",
    }
    task.update(extra)
    return task


def default_tasks() -> list[dict[str, Any]]:
    return [
        make_task(
            TASK_LOGIN,
            "Fix the login redirect bug",
            "running",
            pr_urls=[PR_SETI, PR_GONE],
            cost_usd=3.42,
            updated_at="2026-09-27T11:58:00.000Z",
        ),
        make_task(
            TASK_LOGOUT, "Fix the logout button", "idle", cost_usd=0.4, input_mode="queue", unseen=True
        ),
        make_task(TASK_DOCS, "Write deploy docs", "error", last_error="Agent crashed: out of memory"),
    ]


def pr(url: str, title: str, **extra: Any) -> dict[str, Any]:
    number = int(url.rsplit("/", 1)[-1])
    item: dict[str, Any] = {
        "key": f"seti-{number}",
        "repo_id": REPO_SETI,
        "repo_slug": "Octocat/seti",
        "number": number,
        "title": title,
        "url": url,
        "draft": False,
        "author": "octocat",
        "head_ref": "feat/x",
        "base_ref": "main",
        "head_oid": "abc",
        "updated_at": "2026-09-27T11:00:00Z",
        "review_decision": None,
        "mergeable": "mergeable",
        "labels": [],
        "ci": "success",
        "checks": [],
        "unresolved_threads": 0,
        "preview": {"state": "none", "url": None, "commit": None, "stale": False},
        "preview_host": None,
        "tasks": [],
        "related": [],
    }
    item.update(extra)
    return item


def default_prs() -> dict[str, Any]:
    return {
        "viewer": "octocat",
        "scope": "all",
        "repos": [
            {
                "repo_id": REPO_SETI,
                "slug": "Octocat/seti",
                "error": None,
                "previews": True,
                "prs": [
                    pr(
                        PR_SETI,
                        "fix: login redirect",
                        ci="failure",
                        checks=[
                            {"name": "e2e", "state": "failure", "detail": "", "url": None},
                            {"name": "static", "state": "success", "detail": "", "url": None},
                        ],
                        review_decision="changes_requested",
                        preview={"state": "ready", "url": "https://x", "commit": "abc", "stale": True},
                        tasks=[
                            {"id": TASK_LOGIN, "title": "Fix the login redirect bug", "status": "running"}
                        ],
                    )
                ],
            },
            {"repo_id": REPO_WEB, "slug": "Octocat/web", "error": "gh failed", "previews": False, "prs": []},
        ],
        "previews_on": True,
        "clusters": [],
    }


def default_repos() -> list[dict[str, Any]]:
    return [
        {
            "id": REPO_SETI,
            "slug": "Octocat/seti",
            "path": "/home/u/seti",
            "base_branch": "main",
            "created_at": "x",
        },
        {
            "id": REPO_WEB,
            "slug": "Octocat/web",
            "path": "/home/u/web",
            "base_branch": "dev",
            "created_at": "x",
        },
        {
            "id": REPO_WEB_ADMIN,
            "slug": "Octocat/web-admin",
            "path": "/home/u/wa",
            "base_branch": "main",
            "created_at": "x",
        },
    ]


def default_messages() -> list[dict[str, Any]]:
    return [
        {"id": 1, "kind": "prompt", "payload": {"text": "Fix it"}},
        {"id": 2, "kind": "input", "payload": {"source": "pr", "kind": "ci_failed", "title": "old update"}},
        {"id": 3, "kind": "prompt", "payload": {"text": "", "auto": True}},
        {
            "id": 4,
            "kind": "input",
            "payload": {"source": "pr", "kind": "ci_failed", "title": "CI failed on seti#28"},
        },
        {"id": 5, "kind": "prompt", "payload": {"text": "/compact"}},
        {
            "id": 6,
            "kind": "input",
            "payload": {"source": "pr", "kind": "review", "title": "Review on seti#28"},
        },
    ]


def default_digest() -> list[dict[str, Any]]:
    return [
        {"at": "2026-09-27T11:50:00Z", "kind": "user", "text": "Fix the **redirect** after login"},
        {"at": "2026-09-27T11:51:00Z", "kind": "tool", "text": "Bash: pnpm test"},
        {"at": "2026-09-27T11:57:00Z", "kind": "agent", "text": "Tests pass, see https://example.com/x"},
    ]


PACK_TRIAGE = "2785dbaf-4f57-4752-ba91-9b95f4c6fc19"
PLUGIN_ACME = "747905ff-1788-49e3-a9df-1625d3b54de9"
SUB_EXPLORE = "toolu_01EXPLORE"
SUB_TESTS = "toolu_02TESTS"


def audit_event(event_id: int, at: str, actor: str, kind: str, summary: str, **extra: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": event_id,
        "at": at,
        "actor": actor,
        "kind": kind,
        "subject_type": kind.split(".")[0] if kind.split(".")[0] in ("task", "repo") else "system",
        "subject_id": None,
        "summary": summary,
        "detail": {},
    }
    item.update(extra)
    return item


def default_audit() -> list[dict[str, Any]]:
    """Newest first, as Seti's audit store pages them."""
    return [
        audit_event(
            9,
            "2026-09-27T11:58:00.000Z",
            "user",
            "task.message_sent",
            'Sent a message to task "Fix the logout button"',
            subject_type="task",
            subject_id=TASK_LOGOUT,
            detail={"title": "Fix the logout button", "prompt": "Add a test for it", "via": "ea"},
        ),
        audit_event(
            8,
            "2026-09-27T11:56:00.000Z",
            "agent",
            "agent.outward",
            "Bash: git push origin feat/login",
            subject_type="task",
            subject_id=TASK_LOGIN,
            detail={"tool": "Bash", "tool_use_id": "toolu_x"},
        ),
        audit_event(
            7,
            "2026-09-27T11:40:00.000Z",
            "system",
            "mcp.signin_failed",
            'Sign-in failed for MCP server "linear": token expired',
        ),
        audit_event(
            6,
            "2026-09-27T11:30:00.000Z",
            "user",
            "task.stopped",
            'Stopped task "Write deploy docs"',
            subject_type="task",
            subject_id=TASK_DOCS,
            detail={"title": "Write deploy docs", "via": "ea"},
        ),
        audit_event(
            5,
            "2026-09-27T10:00:00.000Z",
            "user",
            "task.created",
            'Created task "Fix the logout button"',
            subject_type="task",
            subject_id=TASK_LOGOUT,
        ),
        audit_event(
            4,
            "2026-09-27T09:00:00.000Z",
            "system",
            "task.inputs_delivered",
            'Delivered 1 update to task "Fix the login redirect bug"',
            subject_type="task",
            subject_id=TASK_LOGIN,
        ),
        audit_event(
            3,
            "2026-09-26T20:00:00.000Z",
            "user",
            "task.message_sent",
            'Sent a message to task "Write deploy docs"',
            subject_type="task",
            subject_id=TASK_DOCS,
            detail={"title": "Write deploy docs", "prompt": "Start", "via": "ea"},
        ),
        audit_event(
            2,
            "2026-09-26T18:00:00.000Z",
            "agent",
            "seti.context_pack_updated",
            'Agent updated context pack "Triage sources": tighter sources',
            subject_type="context_pack",
        ),
        audit_event(1, "2026-09-25T08:00:00.000Z", "system", "system.started", "Seti started"),
    ]


def subtask(tool_use_id: str, description: str, status: str, **extra: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "tool_use_id": tool_use_id,
        "tool_use_ids": [tool_use_id],
        "parent_tool_use_id": None,
        "message_id": 10,
        "sdk_task_id": None,
        "description": description,
        "subagent_type": "general-purpose",
        "background": False,
        "status": status,
        "progress": None,
        "usage": None,
        "started_at": "2026-09-27T11:50:00.000Z",
        "ended_at": None,
        "summary": None,
    }
    item.update(extra)
    return item


def default_subtasks() -> dict[str, list[dict[str, Any]]]:
    return {
        TASK_LOGIN: [
            subtask(
                SUB_TESTS,
                "Write the redirect tests",
                "completed",
                started_at="2026-09-27T11:40:00.000Z",
                ended_at="2026-09-27T11:44:30.000Z",
                usage={"total_tokens": 48200, "tool_uses": 23, "duration_ms": 270000},
                summary="Added 4 tests; all pass",
            ),
            subtask(
                SUB_EXPLORE,
                "Explore the auth flow",
                "running",
                subagent_type="Explore",
                background=True,
                progress={"description": "Reading middleware", "last_tool": "Grep", "summary": None},
            ),
        ]
    }


def listed_subtasks(subtasks: list[dict[str, Any]]) -> dict[str, Any]:
    """The subtask fields a task list entry carries: the running subtasks and counts by status."""
    counts = dict.fromkeys(("running", "completed", "failed", "stopped", "unknown"), 0)
    for s in subtasks:
        counts[s["status"]] += 1
    return {"running_subtasks": [s for s in subtasks if s["status"] == "running"], "subtask_counts": counts}


def default_subtask_details() -> dict[str, dict[str, Any]]:
    return {
        SUB_TESTS: {
            "prompt": "Write tests for the login redirect covering the **next** param.",
            "result": "## Report\n\nAdded 4 tests in `auth.test.ts`. " + "All of them pass now. " * 60,
        },
        SUB_EXPLORE: {"prompt": "Find where the redirect is decided.", "result": None},
    }


def default_packs() -> list[dict[str, Any]]:
    return [
        {
            "id": PACK_TRIAGE,
            "name": "Triage sources",
            "description": "Where the morning triage looks for problems",
            "body": "# Triage sources\n\n- Slack: the #problems channel (read only).\n"
            "- PostHog: error tracking for production.\n\n## Output\n\nGroup findings by severity.",
            "created_at": "2026-09-26T21:09:56.739Z",
            "updated_at": "2026-09-27T09:00:00.000Z",
        },
        {
            "id": "3785dbaf-4f57-4752-ba91-9b95f4c6fc19",
            "name": "Release checklist",
            "description": "",
            "body": "Cherry-pick dev to main.",
            "created_at": "2026-09-26T21:09:56.739Z",
            "updated_at": "2026-09-26T21:09:56.739Z",
        },
    ]


def context_file(key: str, group: str, label: str, size: int | None) -> dict[str, Any]:
    return {
        "key": key,
        "group": group,
        "label": label,
        "path": f"/home/u/{label}",
        "exists": size is not None,
        "size": size,
        "modified_at": "2026-09-27T11:40:00.000Z" if size is not None else None,
    }


def default_files() -> list[dict[str, Any]]:
    return [
        context_file("user", "User level", "CLAUDE.md", 5717),
        context_file(f"repo:{REPO_SETI}:project", "Octocat/seti", "CLAUDE.md", 1200),
        context_file(f"repo:{REPO_SETI}:local", "Octocat/seti", "CLAUDE.local.md", 300),
        context_file(f"repo:{REPO_WEB}:project", "Octocat/web", "CLAUDE.md", None),
        context_file(f"repo:{REPO_WEB}:local", "Octocat/web", "CLAUDE.local.md", None),
    ]


USER_CLAUDE_MD = """# Global conventions

## Identity

The user is Ada Lovelace.

## Commits and PRs

- Conventional style: `feat:`, `fix:`.
- Never commit directly to a default branch.
- Push a branch as soon as it is created.
"""


def default_capabilities() -> dict[str, Any]:
    def server(name: str, status: str, tools: int, **extra: Any) -> dict[str, Any]:
        item: dict[str, Any] = {
            "name": name,
            "status": status,
            "scope": "user",
            "source": None,
            "transport": {"type": "http", "target": "https://mcp.example.com/mcp"},
            "server_version": None,
            "error": None,
            "tools": [
                {
                    "name": f"t{i}",
                    "description": "",
                    "read_only": True,
                    "destructive": False,
                    "open_world": False,
                }
                for i in range(tools)
            ],
            "sign_in": "required" if status == "needs-auth" else "none",
        }
        item.update(extra)
        return item

    return {
        "cwd": "/home/u",
        "probed_at": "2026-09-27T11:50:00.000Z",
        "duration_ms": 1200,
        "pending_timed_out": False,
        "account": {"email": None, "organization": None, "subscription_type": None, "api_provider": None},
        "servers": [
            server("slack", "connected", 12, sign_in="again"),
            server("posthog", "needs-auth", 0),
            server("seti", "connected", 5, scope=None, transport={"type": "sdk", "target": "seti"}),
            server("langfuse", "failed", 0, error="Connection refused at https://x.example"),
        ],
        "skill_groups": [],
        "builtin_commands": [],
        "subagents": [],
        "models": [],
    }


def default_plugins() -> dict[str, Any]:
    none = {"skills": [], "agents": [], "commands": [], "hooks": [], "mcp_servers": [], "lsp_servers": []}
    return {
        "defaults": [
            {
                "id": PLUGIN_ACME,
                "name": "acme",
                "path": "/home/u/acme-dev-skills",
                "version": "0.3.0",
                "description": "Shared skills",
                "enabled": True,
                "created_at": "2026-09-27T09:06:52.509Z",
                "problem": None,
                "components": {**none, "skills": ["git", "release", "worktree"]},
            },
            {
                "id": "847905ff-1788-49e3-a9df-1625d3b54de9",
                "name": "old-tools",
                "path": "/home/u/old",
                "version": None,
                "description": "",
                "enabled": False,
                "created_at": "2026-09-27T09:06:52.509Z",
                "problem": "The folder no longer exists",
                "components": None,
            },
        ],
        "installed": [
            {
                "id": "posthog@claude-plugins-official",
                "name": "posthog",
                "marketplace": "claude-plugins-official",
                "version": "1.1.64",
                "scope": "user",
                "enabled": True,
                "components": {**none, "skills": ["a", "b"], "mcp_servers": ["posthog"]},
            }
        ],
        "installed_error": None,
    }


def change(sha: str, date: str, subject: tuple[str | None, str | None, str], **extra: Any) -> dict[str, Any]:
    """A changelog entry as Seti lists it; `subject` is type, scope and description."""
    kind, scope, description = subject
    entry: dict[str, Any] = {
        "commit": sha * 40,
        "date": date,
        "type": kind,
        "scope": scope,
        "breaking": False,
        "description": description,
        "pr": None,
        "body": "",
        "notable": kind in ("feat", "fix", "perf") and scope != "deps",
        "current": False,
        "unseen": False,
    }
    entry.update(extra)
    return entry


def default_changelog() -> dict[str, Any]:
    return {
        "version": {"commit": "a" * 40, "date": "2026-09-27T09:00:00.000Z"},
        "unseen": 1,
        "entries": [
            change(
                "a", "2026-09-27T09:00:00.000Z", ("feat", None, "grid view"), pr=12, current=True, unseen=True
            ),
            change("b", "2026-09-27T08:00:00.000Z", ("chore", "deps", "bump zod"), pr=11, current=True),
            change("c", "2026-09-26T16:00:00.000Z", ("fix", "ea", "keep tools within the limit"), pr=10),
            change("d", "2026-09-25T16:00:00.000Z", ("perf", None, "faster lists")),
            change("e", "2026-09-25T10:00:00.000Z", ("docs", None, "explain the grid")),
        ],
        "has_more": False,
    }


def default_ea_usage() -> dict[str, Any]:
    return {
        "zone": "UTC",
        "window_days": 7,
        "calls_today": 4,
        "calls_window": 30,
        "by_channel": {"voice": 18, "chat": 9, "inbox": 3},
        "ttfb": {"samples": 30, "p50_ms": 820, "p95_ms": 1940},
        "avg_prompt_tokens": 16200,
        "avg_completion_tokens": 85,
        "cached_share": 0.62,
        "tool_calls": 11,
        "models": ["gpt-4.1", "gpt-4.1-mini"],
        "stt": {"samples": 20, "p50_ms": 310, "p95_ms": 640},
        "tts": {"samples": 0, "p50_ms": None, "p95_ms": None},
    }


def default_home() -> dict[str, Any]:
    tally = {"turns_7d": 12, "turns_30d": 40, "run_ms_7d": 5_400_000, "run_ms_30d": 18_000_000}
    return {
        "zone": "UTC",
        "totals": {**tally, "merged_7d": 3, "merged_30d": 9, "cost_7d_usd": 4.2, "cost_30d_usd": 31},
        "streak_days": 4,
        "days": [
            *[{"day": "", "merged": 1, "turns": 2, "cost_usd": 0.5, "run_ms": 600_000}] * 7,
            *[{"day": "", "merged": 0, "turns": 0, "cost_usd": 0, "run_ms": 0}] * 6,
            {"day": "", "merged": 2, "turns": 3, "cost_usd": 1.2, "run_ms": 1_800_000},
        ],
        "recent": [
            {
                "pr_url": "https://github.com/acme/seti/pull/28",
                "merged_at": (NOW - timedelta(hours=2)).isoformat(),
                "task_ids": [TASK_LOGIN, "gone"],
            }
        ],
        "agents": [
            {
                "task_id": TASK_LOGIN,
                **tally,
                "merged_30d": 6,
                "cost_30d_usd": 20,
                "mcp": [{"server": "github", "calls": 9}],
            },
            {"task_id": "gone", **tally, "merged_30d": 3, "cost_30d_usd": 11, "mcp": []},
        ],
        "live": [{"task_id": TASK_LOGIN, "tool": "Bash", "server": None, "subagent": None, "since": ""}],
    }


def default_update() -> dict[str, Any]:
    return {
        "state": "available",
        "branch": "main",
        "latest": {"commit": "f" * 40, "date": "2026-09-27T11:00:00.000Z"},
        "behind": 3,
        "notable": 1,
        "checked_at": "2026-09-27T11:30:00.000Z",
        "error": None,
        "command": "cd /srv/seti\nscripts/upgrade.sh",
    }


def default_account() -> dict[str, Any]:
    return {
        "account": {
            "email": "user@example.com",
            "organization": "Org",
            "subscription_type": "Claude Max",
            "token_source": None,
            "api_key_source": None,
            "api_provider": "firstParty",
        },
        "health": {"state": "ok", "message": "Using the Claude Code login of user@example.com (Claude Max)."},
        "usage": {
            "source": "usage_api",
            "observed_at": "2026-09-27T11:50:00.000Z",
            "windows": [
                {
                    "key": "five_hour",
                    "label": "5h",
                    "utilization": 46,
                    "resets_at": "2026-09-27T13:30:00+00:00",
                },
                {"key": "seven_day", "label": "7d", "utilization": 22, "resets_at": "2026-10-03T23:00:00Z"},
                {"key": "model:x", "label": "7d Fable", "utilization": None, "resets_at": None},
            ],
        },
        "usage_note": None,
        "rate_limit_event": {
            "task_id": TASK_LOGIN,
            "task_title": "Fix the login redirect bug",
            "at": "2026-09-27T11:55:00.000Z",
            "status": "allowed",
            "rate_limit_type": "five_hour",
            "windows": [],
        },
        "task_error": None,
        "fetched_at": "2026-09-27T11:50:00.000Z",
    }


def audit_page(events: list[dict[str, Any]], params: httpx.QueryParams) -> httpx.Response:
    """Filters and pages like server/src/store/audit.ts, including its query validation."""
    limit = int(params.get("limit", "50"))
    if not 1 <= limit <= 200:
        return err(400, "Invalid query", "limit: Too big: expected number to be <=200")
    kind = params.get("kind")
    actor = params.get("actor")
    q = (params.get("q") or "").lower()
    before = params.get("before")
    rows = [
        e
        for e in events
        if (kind is None or e["kind"] == kind or e["kind"].startswith(f"{kind}."))
        and (actor is None or e["actor"] == actor)
        and (not q or q in e["summary"].lower() or q in e["kind"] or q in str(e["subject_id"]).lower())
        and (before is None or e["id"] < int(before))
    ][: limit + 1]
    page = rows[:limit]
    return ok({"events": page, "next_before": page[-1]["id"] if len(rows) > limit else None})


@dataclass
class FakeSeti:
    """An in-memory Seti API; records every request."""

    tasks: list[dict[str, Any]] = field(default_factory=default_tasks)
    prs: dict[str, Any] = field(default_factory=default_prs)
    repos: list[dict[str, Any]] = field(default_factory=default_repos)
    messages: list[dict[str, Any]] = field(default_factory=default_messages)
    task_messages: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    digest: list[dict[str, Any]] | None = field(default_factory=default_digest)
    audit: list[dict[str, Any]] = field(default_factory=default_audit)
    subtasks: dict[str, list[dict[str, Any]]] = field(default_factory=default_subtasks)
    subtask_details: dict[str, dict[str, Any]] = field(default_factory=default_subtask_details)
    packs: list[dict[str, Any]] = field(default_factory=default_packs)
    files: list[dict[str, Any]] = field(default_factory=default_files)
    file_contents: dict[str, str] = field(default_factory=lambda: {"user": USER_CLAUDE_MD})
    capabilities: dict[str, Any] = field(default_factory=default_capabilities)
    plugins: dict[str, Any] = field(default_factory=default_plugins)
    account: dict[str, Any] = field(default_factory=default_account)
    changelog: dict[str, Any] = field(default_factory=default_changelog)
    update: dict[str, Any] = field(default_factory=default_update)
    home: dict[str, Any] = field(default_factory=default_home)
    ea_usage: dict[str, Any] = field(default_factory=default_ea_usage)
    usage_records: list[dict[str, Any]] = field(default_factory=list)
    requests: list[httpx.Request] = field(default_factory=list)
    fail: dict[tuple[str, str], tuple[int, dict[str, Any]]] = field(default_factory=dict)
    ea_history: list[dict[str, Any]] = field(default_factory=list)
    asks: list[dict[str, Any]] = field(default_factory=list)
    ea_settings: dict[str, Any] | None = None
    form_of_address: str = ""
    followups: list[dict[str, Any]] = field(default_factory=list)
    watches: list[dict[str, Any]] = field(default_factory=list)
    inbox: list[dict[str, Any]] = field(default_factory=list)
    live_context: dict[str, Any] | None = None
    search_hits: list[dict[str, Any]] = field(default_factory=list)
    knowledge: list[dict[str, Any]] = field(default_factory=list)
    questions: list[dict[str, Any]] = field(default_factory=list)
    team: list[dict[str, Any]] = field(default_factory=list)
    chat_hits: list[dict[str, Any]] = field(default_factory=list)
    chat_more: bool = False
    file_search: dict[str, Any] = field(
        default_factory=lambda: {"mode": "name", "hits": [], "truncated": False, "partial": False}
    )
    file_texts: dict[str, str] = field(default_factory=dict)
    team_deliveries: list[dict[str, Any]] = field(default_factory=list)
    rewind_targets: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    rewind_files: dict[str, Any] = field(default_factory=dict)
    task_packs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    ea_pack_ids: list[str] = field(default_factory=list)
    ea_pack_max: int = 8000
    handles: dict[str, str] = field(default_factory=dict)
    archived: list[dict[str, Any]] = field(default_factory=list)
    workspaces: list[dict[str, Any]] = field(default_factory=list)
    activity: dict[str, Any] = field(default_factory=lambda: {"agents": [], "more": 0, "archived_since": []})
    history: dict[str, Any] = field(default_factory=lambda: {"lines": [], "older_cursor": None})
    notifications: dict[str, Any] = field(
        default_factory=lambda: {
            "public_key": "BPublic",
            "settings": {"urgent": "push", "active": "push", "digest": "brief", "passive": "off"},
            "devices": [{"device_id": "phone-0001", "label": "Safari on iPhone", "created_at": "2026-10-01"}],
        }
    )
    mcp_defaults: dict[str, bool] = field(default_factory=dict)
    brief: dict[str, Any] | None = None
    mcp_local: dict[str, list[str]] = field(default_factory=dict)
    task_mcp: dict[str, dict[str, bool]] = field(default_factory=dict)
    ssh_hosts: list[str] = field(default_factory=lambda: ["jump", "k8s"])
    ssh_keys: dict[str, str | None] = field(default_factory=lambda: {"jump": "ops", "k8s": "ops"})
    ssh_sets: dict[str, list[str]] = field(default_factory=dict)
    access_defaults: dict[str, bool] = field(default_factory=dict)
    processes: dict[str, dict[str, Any]] = field(default_factory=dict)
    task_access: dict[str, dict[str, bool]] = field(default_factory=dict)
    aws_outcomes: dict[str, dict[str, Any]] = field(default_factory=dict)
    profiles: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {"id": "default", "name": "Default", "builtin": True, "agents": 2},
            {"id": "p-client", "name": "Client A", "builtin": False, "agents": 0},
        ]
    )

    def inbox_item(self, kind: str, title: str, **extra: Any) -> dict[str, Any]:
        """A due item waiting in the inbox."""
        item = {
            "id": len(self.inbox) + 1,
            "kind": kind,
            "event": "due" if kind in ("followup", "reminder") else "turn_finished",
            "title": title,
            "body": "",
            "url": None,
            "severity": "info",
            "source": "EA",
            "task_id": None,
            "timezone": None,
            "due_at": "2026-09-27T11:59:00.000Z",
            "delivered_via": None,
            **extra,
        }
        self.inbox.append(item)
        return item

    def _deliver(self, ids: list[int], via: str) -> httpx.Response:
        items = [i for i in self.inbox if i["id"] in ids and i["delivered_via"] is None]
        entries: list[dict[str, Any]] = []
        for item in items:
            item["delivered_via"] = via
            entries.append(
                self.ea_append("inbox", {"role": "developer", "content": f"Inbox: {item['title']}."})
            )
        return ok({"items": items, "entries": entries})

    def ea_context(self) -> list[dict[str, Any]]:
        """What Seti answers for scope=context: the latest summary and every later entry."""
        summaries = [e for e in self.ea_history if e["kind"] == "summary"]
        latest = summaries[-1] if summaries else None
        through = latest["through_id"] if latest else 0
        rest = [e for e in self.ea_history if e["kind"] != "summary" and e["id"] > through]
        return ([latest] if latest else []) + rest

    def ea_append(self, kind: str, message: dict[str, Any], through_id: int | None = None) -> dict[str, Any]:
        entry_id = (self.ea_history[-1]["id"] if self.ea_history else 0) + 1
        entry = {
            "id": entry_id,
            "kind": kind,
            "message": message,
            "through_id": through_id,
            "created_at": "x",
        }
        self.ea_history.append(entry)
        return entry

    def ea_packs(self) -> list[dict[str, Any]]:
        """The packs linked to the EA, its role first, as Seti lists them."""
        linked = [p for p in self.packs if p["id"] in self.ea_pack_ids]
        ordered = sorted(linked, key=lambda p: (p.get("kind") != "role", p["name"].lower()))
        return [{"id": p["id"], "name": p["name"], "kind": p.get("kind", "reference")} for p in ordered]

    def ea_pack_prompt(self) -> dict[str, Any]:
        """The text Seti renders for the EA's packs, cut at the limit as Seti does."""
        packs = [next(p for p in self.packs if p["id"] == s["id"]) for s in self.ea_packs()]
        sections = [
            f"## Your role\n\n{p['body']}"
            if p.get("kind") == "role"
            else f"## Context pack: {p['name']}\n\n{p['body']}"
            for p in packs
        ]
        text = "\n\n".join(sections)
        return {
            "text": text[: self.ea_pack_max],
            "chars": len(text),
            "max_chars": self.ea_pack_max,
            "form_of_address": self.form_of_address,
        }

    def _answer_questions(self, body: dict[str, Any]) -> httpx.Response:
        result: dict[str, Any] = {"answered": 0, "dismissed": 0, "skipped": 0, "resumed": []}
        for item in body["items"]:
            question = next(
                (q for q in self.questions if q["id"] == item["id"] and q["status"] == "open"), None
            )
            if question is None:
                result["skipped"] += 1
                continue
            if "ghp_" in (item.get("other") or ""):
                return err(422, "Unprocessable", "That answer looks like a secret or credential")
            question["status"] = "answered" if item["action"] == "answer" else "dismissed"
            result["answered" if item["action"] == "answer" else "dismissed"] += 1
            group = [q for q in self.questions if q["group_id"] == question["group_id"]]
            if all(q["status"] != "open" for q in group):
                result["resumed"].append(
                    {"task_id": question["task_id"], "task_title": question["task_title"]}
                )
        return ok(result)

    def posts(self) -> list[tuple[str, Any]]:
        """Every POST but the gate's own bookkeeping of questions."""
        return [
            (r.url.path, json.loads(r.content or b"null"))
            for r in self.requests
            if r.method == "POST" and not _gate_path(r)
        ]

    def writes(self) -> list[tuple[str, str, dict[str, str], Any]]:
        """Every request that changes something: method, path, query and body."""
        return [
            (r.method, r.url.path, dict(r.url.params), json.loads(r.content or b"null"))
            for r in self.requests
            if r.method != "GET" and not _gate_path(r)
        ]

    def expire_asks(self) -> None:
        """Every open question passes its ten minutes."""
        for row in self.asks:
            if row["decision"] is None:
                row["expired"] = True

    def _open_asks(self) -> list[dict[str, Any]]:
        return [a for a in self.asks if a["decision"] is None and not a["expired"]]

    def _add_ask(self, body: dict[str, Any]) -> httpx.Response:
        same = next((a for a in self._open_asks() if a["key"] == body["key"]), None)
        if same is not None:
            return ok(same)
        row = {
            **body,
            "id": len(self.asks) + 1,
            "decision": None,
            "taken": False,
            "outcome": None,
            "expired": False,
            "created_at": "2026-09-27T11:58:00.000Z",
        }
        self.asks.append(row)
        return ok(row)

    def _confirm_asks(self, body: dict[str, Any]) -> httpx.Response:
        ids = body.get("ids") or []
        taken: list[dict[str, Any]] = []
        for row in self._open_asks():
            earlier = row["epoch"] != body["epoch"] or row["turn"] < body["turn"]
            if earlier and (row["id"] in ids or row["key"] == body.get("key")):
                row.update(decision="allow", taken=True)
                taken.append(row)
        return ok(taken)

    def _claim_asks(self) -> httpx.Response:
        rows = [a for a in self.asks if a["decision"] is not None and not a["taken"]]
        for row in rows:
            row["taken"] = True
        return ok(rows)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        key = (request.method, path)
        if key in self.fail:
            status, body = self.fail[key]
            return httpx.Response(status, json=body)
        parts = path.removeprefix("/api/").split("/")
        if request.method == "GET":
            return self._get(parts, request)
        if request.method == "DELETE":
            return self._delete(parts, request.url.params)
        if request.method in ("PUT", "PATCH"):
            return self._put(parts, request)
        return self._post(parts, request)

    def _put(self, parts: list[str], request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        match parts:
            case ["tasks", task_id]:
                task = self._task(task_id) or next((t for t in self.archived if t["id"] == task_id), None)
                return ok({**task, **body}) if task else err(404, "Task not found")
            case ["workspaces", workspace_id]:
                return self._rename_workspace(workspace_id, body["name"])
            case ["notifications", "settings"]:
                self.notifications["settings"].update(body)
                return ok(self.notifications)
            case ["tasks", task_id, "context-packs"]:
                packs = [
                    {"id": p["id"], "name": p["name"], "kind": p.get("kind", "reference")}
                    for p in self.packs
                    if p["id"] in body["pack_ids"]
                ]
                self.task_packs[task_id] = packs
                return ok(packs)
            case ["ea", "context-packs"]:
                roles = [p for p in self.packs if p["id"] in body["pack_ids"] and p.get("kind") == "role"]
                if len(roles) > 1:
                    return err(400, "The EA takes one role pack")
                self.ea_pack_ids = list(body["pack_ids"])
                return ok(self.ea_packs())
            case ["ea", "role"]:
                roles = {p["id"] for p in self.packs if p.get("kind") == "role"}
                self.ea_pack_ids = [i for i in self.ea_pack_ids if i not in roles]
                if body["pack_id"] is not None:
                    self.ea_pack_ids.append(body["pack_id"])
                return ok(self.ea_packs())
            case ["tasks", task_id, "role"]:
                kept = [p for p in self.task_packs.get(task_id, []) if p.get("kind") != "role"]
                pack = next((p for p in self.packs if p["id"] == body["pack_id"]), None)
                if body["pack_id"] is not None and pack is None:
                    return err(404, "Context pack not found")
                role = [] if pack is None else [{"id": pack["id"], "name": pack["name"], "kind": "role"}]
                self.task_packs[task_id] = kept + role
                return ok(self.task_packs[task_id])
            case ["tasks", task_id, "mcp"]:
                on = dict.fromkeys(body["mcp_enabled"], True)
                self.task_mcp[task_id] = on | dict.fromkeys(body["mcp_disabled"], False)
                return ok(self.task_mcp_servers(task_id))
            case ["tasks", task_id, "access"]:
                return self._set_access(task_id, body)
            case ["mcp", "defaults", name]:
                if body["enabled"] == (name not in self.mcp_local):
                    self.mcp_defaults.pop(name, None)
                else:
                    self.mcp_defaults[name] = body["enabled"]
                return ok(self.mcp_selection())
            case ["team", "members", task_id]:
                task = self._task(task_id)
                if task is None:
                    return err(404, "Task not found")
                if body.get("handle") == "taken":
                    return err(409, "Conflict", "@taken is taken by another agent")
                handle = body.get("handle") or self.handles.get(task_id, "login")
                self.handles[task_id] = handle
                muted = body.get("muted", False)
                member = {"task_id": task_id, "handle": handle, "title": task["title"], "muted": muted}
                return ok(member)
            case ["context", "packs", pack_id] | ["context", "packs", pack_id, "default"]:
                found = next((p for p in self.packs if p["id"] == pack_id), None)
                return ok({**found, **body}) if found else err(404, "Context pack not found")
            case ["repos", repo_id]:
                if not body["path"].startswith("/home/u/"):
                    return err(400, "Invalid request", "path must be a local git checkout")
                found = next((r for r in self.repos if r["id"] == repo_id), None)
                return ok({**found, **body}) if found else err(404, "Repo not found")
            case _:
                return self._post(parts, request)

    def _rename_workspace(self, workspace_id: str, name: str) -> httpx.Response:
        if any(w["name"].lower() == name.lower() and w["id"] != workspace_id for w in self.workspaces):
            return err(409, "Conflict", f'A workspace named "{name}" already exists')
        workspace = next((w for w in self.workspaces if w["id"] == workspace_id), None)
        if workspace is None:
            return err(404, "Workspace not found")
        workspace["name"] = name
        return ok(workspace)

    def _delete_workspace(self, workspace_id: str) -> httpx.Response:
        held = [t for t in [*self.tasks, *self.archived] if t.get("workspace_id") == workspace_id]
        if held:
            return err(
                409, "Conflict", f"Move or delete the {len(held)} agents first, archived ones included"
            )
        self.workspaces = [w for w in self.workspaces if w["id"] != workspace_id]
        return httpx.Response(204)

    def _delete(self, parts: list[str], params: httpx.QueryParams) -> httpx.Response:
        match parts:
            case ["workspaces", workspace_id]:
                return self._delete_workspace(workspace_id)
            case ["tasks", task_id, "repos", repo_id]:
                task = self._task(task_id)
                if task is None:
                    return err(404, "Task not found")
                task["repos"] = [r for r in task["repos"] if r["id"] != repo_id]
                return ok(task)
            case ["tasks", task_id, "dirs"]:
                task = self._task(task_id)
                if task is None or params.get("path") not in task.get("dirs", []):
                    return err(404, "Not Found", "That directory is not part of this agent")
                task["dirs"] = [d for d in task["dirs"] if d != params.get("path")]
                return ok(task)
            case ["tasks", task_id] | ["context", "packs", task_id]:
                return httpx.Response(204)
            case ["repos", _]:
                return httpx.Response(204)
            case ["tasks", task_id, "prs"] | ["tasks", task_id, "subtasks", _, "prs"]:
                return ok(self._task(task_id))
            case ["tasks", task_id, "queue", _]:
                return ok(self._task(task_id))
            case ["ea", "followups", item_id]:
                found = [f for f in self.followups if str(f["id"]) == item_id]
                if not found:
                    return err(404, "No scheduled follow-up or reminder with that id")
                self.followups.remove(found[0])
                return ok(found[0])
            case ["ea", "watches", task_id]:
                found = [w for w in self.watches if w["task_id"] == task_id]
                if not found:
                    return err(404, "The EA does not watch that task")
                self.watches.remove(found[0])
                return ok(found[0])
            case _:
                return err(404, "Not Found")

    def _schedule(self, body: dict[str, Any]) -> httpx.Response:
        if body["when"] == "yesterday":
            return err(400, "Invalid request", '"yesterday" is in the past')
        item = {
            "id": 100 + len(self.followups),
            "kind": body.get("kind", "followup"),
            "title": body["note"],
            "source": "EA",
            "task_id": body.get("task_id"),
            "timezone": body.get("timezone"),
            "due_at": "2026-09-27T12:20:00.000Z",
            "local_due": f"Sunday 14:20 ({body.get('timezone')})",
        }
        self.followups.append(item)
        return ok(item)

    def mcp_selection(self) -> list[dict[str, Any]]:
        names = sorted(
            {s["name"] for s in self.capabilities["servers"]} | set(self.mcp_defaults) | set(self.mcp_local)
        )
        return [
            {
                "name": n,
                "kind": "config",
                "default_enabled": self.mcp_defaults.get(n, n not in self.mcp_local),
                "known": True,
                "local_to": self.mcp_local.get(n, []),
            }
            for n in names
        ]

    def _detail(self, kind: str, item_id: str, default: bool) -> str | None:
        local = self.mcp_local.get(item_id) if kind == "mcp" else None
        if not local:
            return None
        return f"From {local[0]}; {'on by default' if default else 'off unless turned on'}"

    def _set_access(self, task_id: str, body: dict[str, Any]) -> httpx.Response:
        if body["kind"] in ("ssh", "aws"):
            return err(403, "Forbidden", "The EA cannot choose ssh hosts or AWS for agents")
        key = f"{body['kind']}:{body['id']}"
        item = next((i for i in self.access_items(task_id) if f"{i['kind']}:{i['id']}" == key), None)
        if item is None:
            return err(404, "Not Found")
        choices = self.task_access.setdefault(task_id, {})
        choices.pop(key, None)
        if body["enabled"] is not None and body["enabled"] != item["default_enabled"]:
            choices[key] = body["enabled"]
        return ok(self.access_view(task_id))

    def access_items(self, task_id: str) -> list[dict[str, Any]]:
        """Every item an agent may reach, as GET /tasks/:id/access lists them."""
        choices = self.task_access.get(task_id, {})
        defaults = [
            *[
                ("ssh", alias, alias, self.access_defaults.get(f"ssh:{alias}", False))
                for alias in self.ssh_hosts
            ],
            ("aws", "aws", "AWS", self.access_defaults.get("aws:aws", False)),
            *[("mcp", e["name"], e["name"], e["default_enabled"]) for e in self.mcp_selection()],
            *[("pack", p["id"], p["name"], p.get("linked_by_default", False)) for p in self.packs],
            *[("plugin", p["id"], p["name"], p["enabled"]) for p in self.plugins["defaults"]],
        ]
        items: list[dict[str, Any]] = []
        for kind, item_id, name, default in defaults:
            override = choices.get(f"{kind}:{item_id}")
            items.append(
                {
                    "kind": kind,
                    "id": item_id,
                    "name": name,
                    "detail": self._detail(kind, item_id, default),
                    "default_enabled": default,
                    "override": override,
                    "enabled": default if override is None else override,
                    "jump_for": [],
                    "missing_key": [] if kind != "ssh" or self.ssh_keys.get(item_id) else [item_id],
                    "in_set": False,
                }
            )
        return items

    def ssh_status(self) -> dict[str, Any]:
        hosts = [
            {
                "alias": alias,
                "route": f"10.0.0.{index + 1}:22" if alias == "jump" else f"10.0.0.{index + 1}:22 via jump",
                "user": "ops",
                "key_name": self.ssh_keys.get(alias),
                "sets": [{"id": name.lower(), "name": name} for name in self.ssh_sets.get(alias, [])],
                "default_enabled": self.access_defaults.get(f"ssh:{alias}", False),
                "host_keys": [{"host": f"10.0.0.{index + 1}"}] if alias == "jump" else [],
            }
            for index, alias in enumerate(self.ssh_hosts)
        ]
        return {"hosts": hosts, "keys": [], "other_host_keys": []}

    def access_view(self, task_id: str) -> dict[str, Any]:
        task = self._task(task_id) or {}
        return {
            "task_id": task_id,
            "sandboxed": task.get("sandbox", True),
            "items": self.access_items(task_id),
            "profile": {"id": "default", "name": "Default"},
            "seti_control": task.get("seti_control", "self"),
            "aws": self.aws_outcomes.get(task_id, {"state": "no_role", "profile": "Default"}),
        }

    def task_mcp_servers(self, task_id: str) -> list[dict[str, Any]]:
        choices = self.task_mcp.get(task_id, {})
        return [
            {**e, "choice": choices.get(e["name"]), "enabled": choices.get(e["name"], e["default_enabled"])}
            for e in self.mcp_selection()
        ]

    def _task(self, task_id: str) -> dict[str, Any] | None:
        return next((t for t in self.tasks if t["id"] == task_id), None)

    def _get(self, parts: list[str], request: httpx.Request) -> httpx.Response:
        params = request.url.params
        match parts:
            case ["tasks"]:
                return ok([{**listed_subtasks(self.subtasks.get(t["id"], [])), **t} for t in self.tasks])
            case ["tasks", "archived"]:
                return ok(self.archived)
            case ["notifications"]:
                return ok(self.notifications)
            case ["history", "activity"]:
                return ok(self.activity)
            case ["history", "tasks", _]:
                return ok(self.history)
            case ["tasks", task_id]:
                task = self._task(task_id)
                return ok(task) if task else err(404, "Task not found")
            case ["tasks", task_id, "messages"]:
                rows = self.task_messages.get(task_id, self.messages)
                return ok({"messages": rows, "has_older": False})
            case ["tasks", _, "search"] | ["team", "search"]:
                return ok({"hits": self.chat_hits, "has_more": self.chat_more, "total": len(self.chat_hits)})
            case ["tasks", _, "files", "search"]:
                return ok(self.file_search)
            case ["tasks", _, "files", "roots"]:
                return ok([{"id": "cwd", "label": "login-app"}, {"id": "workspace", "label": "Workspace"}])
            case ["tasks", _, "files", "resolve"]:
                return ok([self._resolved(p) for p in params.get_list("p")])
            case ["tasks", _, "files", "text"]:
                return self._file_text(params["root"], params["path"])
            case ["tasks", _, "digest"]:
                if self.digest is None:
                    return err(404, "Not Found")
                return ok({"lines": self.digest})
            case ["tasks", task_id, "processes"]:
                view = self.processes.get(task_id)
                return ok(view) if view is not None else err(404, "Task not found")
            case ["tasks", task_id, "subtasks"]:
                return (
                    ok(self.subtasks.get(task_id, [])) if self._task(task_id) else err(404, "Task not found")
                )
            case ["tasks", task_id, "rewind", "targets"]:
                return ok(self.rewind_targets.get(task_id, []))
            case ["tasks", _, "rewind", "files"]:
                return ok(self.rewind_files)
            case ["tasks", task_id, "context-packs"]:
                return ok(self.task_packs.get(task_id, []))
            case ["tasks", task_id, "mcp"]:
                return (
                    ok(self.task_mcp_servers(task_id)) if self._task(task_id) else err(404, "Task not found")
                )
            case ["mcp", "selection"]:
                return ok(self.mcp_selection())
            case ["tasks", task_id, "access"]:
                return ok(self.access_view(task_id)) if self._task(task_id) else err(404, "Task not found")
            case ["credential-profiles"]:
                return ok(self.profiles)
            case ["ssh"]:
                return ok(self.ssh_status())
            case ["tasks", task_id, "subtasks", tool_use_id]:
                brief = next(
                    (s for s in self.subtasks.get(task_id, []) if s["tool_use_id"] == tool_use_id), None
                )
                if brief is None:
                    return err(404, "Subtask not found")
                return ok({**brief, **self.subtask_details.get(tool_use_id, {"prompt": "", "result": None})})
            case ["prs"]:
                return ok({**self.prs, "scope": params.get("scope", "mine")})
            case ["prs", "by-url"]:
                url = params.get("url")
                found = [p for r in self.prs["repos"] for p in r["prs"] if p["url"] == url]
                return ok(found[0] if found else None)
            case ["repos"]:
                return ok(self.repos)
            case ["workspaces"]:
                return ok(self.workspaces)
            case ["audit"]:
                return audit_page(self.audit, params)
            case ["ea", "context-packs"]:
                return ok(self.ea_packs())
            case ["ea", "context-packs", "prompt"]:
                return ok(self.ea_pack_prompt())
            case ["context", "packs"]:
                return ok(self.packs)
            case ["context", "files"]:
                return ok(self.files)
            case ["context", "files", key]:
                found = next((f for f in self.files if f["key"] == key), None)
                if found is None:
                    return err(404, "Unknown context file")
                content = self.file_contents.get(key, "")
                return ok({**found, "content": content, "hash": "h" if found["exists"] else None})
            case ["capabilities"]:
                return ok(self.capabilities)
            case ["plugins"]:
                return ok(self.plugins)
            case ["plugins", "defaults"]:
                return ok(self.plugins["defaults"])
            case ["account"]:
                return ok(self.account)
            case ["mods", "whats-new", "changelog"]:
                limit = int(params.get("limit", "200"))
                return ok({**self.changelog, "entries": self.changelog["entries"][:limit]})
            case ["mods", "whats-new", "update"]:
                return ok(self.update)
            case ["home"]:
                return ok(self.home)
            case ["ea", "usage"]:
                return ok(self.ea_usage)
            case ["ea", "history"]:
                scope = request.url.params.get("scope", "all")
                entries = self.ea_context() if scope == "context" else self.ea_history
                return ok({"entries": entries, "has_older": False})
            case ["ea", "settings"]:
                if self.ea_settings is None:
                    return err(404, "Not Found")
                return ok(self.ea_settings)
            case ["ea", "followups"]:
                return ok(self.followups)
            case ["ea", "watches"]:
                return ok(self.watches)
            case ["ea", "context"]:
                return ok(self.live_context) if self.live_context else err(404, "Not Found")
            case ["knowledge", "search"]:
                words = params.get("q", "").lower().split()
                found = [n for n in self.knowledge if n["status"] in ("approved", "stale")]
                return ok(
                    [n for n in found if all(w in n["title"].lower() + n["body"].lower() for w in words)]
                )
            case ["knowledge"]:
                return ok([n for n in self.knowledge if n["status"] == params.get("status", "proposed")])
            case ["questions"]:
                return ok([q for q in self.questions if q["status"] == "open"])
            case ["ea", "search"]:
                task = params.get("task")
                hits = [h for h in self.search_hits if task is None or h.get("task_id") == task]
                return ok({"mode": params.get("mode", "hybrid"), "hits": hits})
            case ["ea", "inbox", "due"]:
                return ok([i for i in self.inbox if i["delivered_via"] is None])
            case ["ea", "brief"]:
                brief, self.brief = self.brief, None
                return ok({"brief": brief})
            case ["ea", "asks", "open"]:
                return ok(self._open_asks())
            case ["team", "messages"]:
                limit = int(params.get("limit", "50"))
                if "after" in params:
                    return ok([m for m in self.team if m["id"] > int(params["after"])][:limit])
                return ok(self.team[-limit:])
            case ["team", "members"]:
                return ok([{"task_id": t["id"], "handle": self.handle_of(t["id"])} for t in self.tasks])
            case _:
                return err(404, "Not Found")

    def _resolved(self, raw: str) -> dict[str, Any] | None:
        """An absolute path under /work/ is in the cwd root; one under /work/docs/ is a folder."""
        if not raw.startswith("/work/"):
            return None
        rel = raw.removeprefix("/work/")
        return {"input": raw, "root": "cwd", "path": rel, "type": "dir" if rel == "docs" else "file"}

    def _file_text(self, root: str, path: str) -> httpx.Response:
        key = f"{root}:{path}"
        if key not in self.file_texts:
            return err(404, "Not Found", f"{path} does not exist")
        if path.endswith(".png"):
            return err(415, "Unsupported Media Type", f"{path} is not a text file the editor opens")
        return ok({"root": root, "path": path, "text": self.file_texts[key]})

    def handle_of(self, task_id: str) -> str:
        task = self._task(task_id)
        return self.handles.get(task_id, str(task["title"]).split()[-1].lower() if task else "gone")

    def _send_files(self, body: dict[str, Any]) -> httpx.Response:
        if any(p.startswith("/etc/") for p in body["paths"]):
            return err(403, "Forbidden", f"{body['paths'][0]} is outside your working folders and workspace")
        to = next((t for t in self.tasks if self.handle_of(t["id"]) == body["to"]), None)
        if to is None:
            return err(404, "Not Found", f"No agent has the handle @{body['to']}")
        sender = self.handle_of(body["from"])
        inbox = f"/seti/workspace/{to['id']}/inbox/{sender}"
        files = [{"source": p, "path": f"{inbox}/{p.rsplit('/', 1)[-1]}", "bytes": 3} for p in body["paths"]]
        return ok({"from": sender, "to": body["to"], "files": files, "posted": {"deliveries": []}})

    def _planned_task(self, body: dict[str, Any]) -> dict[str, Any]:
        """What POST /tasks/start makes: the planner picks seti when the prompt names it."""
        prompt = str(body["prompt"])
        planned = "repo_ids" not in body and "cwd" not in body and "seti" in prompt.lower()
        ids = [REPO_SETI] if planned else list(body.get("repo_ids") or [])
        title = body.get("title") or f"Planned: {prompt[:24]}"
        task = make_task("44444444-aaaa-4bbb-8ccc-000000000004", title, "running")
        worktree = bool(ids) and body.get("worktree", True)
        repos = [r for i in ids for r in self.repos if r["id"] == i]
        if repos:
            entries = [
                {"id": r["id"], "slug": r["slug"], "dir": r["path"], "worktree": worktree} for r in repos
            ]
            task.update(repo_id=repos[0]["id"], repo_slug=repos[0]["slug"], repos=entries, worktree=worktree)
        else:
            cwd = body.get("cwd") or "/home/u/work/scratch-44444444"
            task.update(repo_id=None, repo_slug=None, repos=[], cwd=cwd)
        withheld = ["AWS: not asked for explicitly"] if "aws" in prompt.lower() else []
        task["setup"] = {
            "planner": "model",
            "fallback_reason": None,
            "repos": [r["slug"] for r in repos],
            "worktree": worktree,
            "packs_linked": ["Style"] if planned else [],
            "packs_unlinked": [],
            "mcp_enabled": [],
            "mcp_disabled": [],
            "access": [],
            "withheld": withheld,
            "ms": 2100,
        }
        return task

    def _post(self, parts: list[str], request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        match parts:
            case ["tasks", "start"]:
                return ok(self._planned_task(body))
            case ["ea", "usage"]:
                self.usage_records.extend(body["records"])
                return ok({"recorded": len(body["records"])})
            case ["workspaces"]:
                workspace = {
                    "id": f"w{len(self.workspaces) + 1}",
                    "name": body["name"],
                    "agents": 0,
                    "needs_you": 0,
                }
                if any(w["name"].lower() == body["name"].lower() for w in self.workspaces):
                    return err(409, "Conflict", f'A workspace named "{body["name"]}" already exists')
                self.workspaces.append(workspace)
                return ok(workspace)
            case ["tasks"]:
                task = make_task("44444444-aaaa-4bbb-8ccc-000000000004", body["title"], "running")
                if not body.get("repo_ids"):
                    cwd = body.get("cwd") or "/home/u/work/scratch-44444444"
                    task.update(repo_id=None, repo_slug=None, repos=[], cwd=cwd)
                return ok(task)
            case ["tasks", task_id, "repos"]:
                task = self._task(task_id)
                repo = next((r for r in self.repos if r["id"] == body["repo_id"]), None)
                if task is None or repo is None:
                    return err(404, "Task not found")
                if any(r["id"] == repo["id"] for r in task["repos"]):
                    return err(409, "Conflict", f"{repo['slug']} is already part of this agent")
                worktree = body.get("worktree", False)
                entry_dir = (
                    f"/home/u/.seti/worktrees/{repo['slug'].split('/')[-1]}-x" if worktree else repo["path"]
                )
                entry = {"id": repo["id"], "slug": repo["slug"], "dir": entry_dir, "worktree": worktree}
                task["repos"] = [*task["repos"], entry]
                return ok(task)
            case ["tasks", task_id, "dirs"]:
                task = self._task(task_id)
                if task is None:
                    return err(404, "Task not found")
                if not body["path"].startswith(("/", "~/")):
                    return err(400, "Bad Request", "Give an absolute path or one under ~/")
                task["dirs"] = [*task.get("dirs", []), body["path"]]
                return ok(task)
            case ["tasks", task_id, "messages"]:
                task = self._task(task_id)
                return ok({**task, "status": "running"}) if task else err(404, "Task not found")
            case ["tasks", task_id, "stop"]:
                task = self._task(task_id)
                return ok({**task, "status": "stopped"}) if task else err(404, "Task not found")
            case ["tasks", task_id, "prs"] | ["tasks", task_id, "subtasks", _, "prs"]:
                return ok(self._task(task_id))
            case ["tasks", task_id, "shells", shell_id, "stop"]:
                view = self.processes.get(task_id, {"shells": []})
                shell = next((s for s in view["shells"] if s["id"] == shell_id), None)
                if shell is None or shell["status"] != "running":
                    return err(409, "Conflict", "That background shell is not running")
                shell["status"] = "killed"
                return ok(view)
            case ["tasks", task_id, "processes", "stop"]:
                view = self.processes.get(task_id, {"processes": []})
                pid = json.loads(request.content)["pid"]
                view["processes"] = [p for p in view["processes"] if p["pid"] != pid]
                return ok(view)
            case ["tasks", _, "subtasks", tool_use_id, "stop"]:
                return ok({"tool_use_id": tool_use_id, "status": "stopped"})
            case ["tasks", task_id, "archive"]:
                task = self._task(task_id)
                if task is None:
                    return err(404, "Task not found")
                tree = {"repo": "Octocat/seti", "removed": body["remove_worktree"], "bytes": 2048}
                kept = {"kept_because": None if body["remove_worktree"] else "kept as asked"}
                report = {
                    "task_id": task_id,
                    "rows": 120,
                    "stored_bytes": 5300,
                    "worktrees": [{**tree, **kept}],
                }
                return ok(report)
            case ["tasks", task_id, "unarchive"]:
                found = [t for t in self.archived if t["id"] == task_id]
                if not found:
                    return err(409, "Conflict", "Agent is not archived")
                worktrees = [{"repo": "Octocat/seti", "dir": "/w", "recreated": True}]
                return ok(
                    {"task_id": task_id, "title": found[0]["title"], "rows": 120, "worktrees": worktrees}
                )
            case ["tasks", task_id, "session", "end"]:
                return err(409, "Conflict", "The agent has no open session")
            case ["tasks", task_id, "session", "restart"]:
                return ok(self._task(task_id))
            case ["tasks", task_id, "retry"] | ["tasks", task_id, "model", "switch-back"]:
                return ok(self._task(task_id))
            case ["tasks", task_id, "rewind"]:
                target = next(
                    t for t in self.rewind_targets[task_id] if t["message_id"] == body["message_id"]
                )
                files = self.rewind_files.get("files", []) if body["restore"] != "conversation" else []
                rewind = {"restore": body["restore"], "files_changed": files}
                return ok({"task": self._task(task_id), "rewind": rewind, "prompt": target["text"]})
            case ["prs", _, _, _, "redeploy"]:
                return ok({"label": "preview", "relabeled": False})
            case ["context", "packs"]:
                if any(p["name"] == body["name"] for p in self.packs):
                    return err(409, "Conflict", f'A context pack named "{body["name"]}" already exists')
                created = {"id": "new-pack", **body}
                self.packs.append(created)
                return ok(created)
            case ["repos"]:
                if not body["path"].startswith("/home/u/"):
                    return err(400, "Invalid request", "path must be a local git checkout")
                return ok({"id": "new-repo", **body})
            case ["tasks", task_id, "inputs", "deliver"]:
                task = self._task(task_id)
                return ok({**task, "status": "running"}) if task else err(404, "Task not found")
            case ["tasks", task_id, "inputs", "dismiss"]:
                rows = self.task_messages.get(task_id, self.messages)
                waiting = [r for r in queued_update_rows(rows) if r["id"] <= body["up_to"]]
                for row in waiting:
                    row["payload"]["dismissed_at"] = "2026-09-27T12:00:00.000Z"
                sources = list(dict.fromkeys(r["payload"]["source"] for r in waiting))
                return ok({"count": len(waiting), "sources": sources})
            case ["ea", "history", "messages"]:
                entries = [self.ea_append(e["kind"], e["message"]) for e in body["entries"]]
                return ok({"ids": [e["id"] for e in entries]})
            case ["ea", "followups"]:
                return self._schedule(body)
            case ["ea", "watches"]:
                task = self._task(body["task_id"])
                if task is None:
                    return err(404, "Task not found")
                watch = {"id": len(self.watches) + 1, "task_title": task["title"], **body}
                self.watches.append(watch)
                return ok(watch)
            case ["ea", "inbox", "deliver"]:
                return self._deliver(body["ids"], body["via"])
            case ["ea", "asks"]:
                return self._add_ask(body)
            case ["ea", "asks", "confirm"]:
                return self._confirm_asks(body)
            case ["ea", "asks", "claim"]:
                return self._claim_asks()
            case ["ea", "asks", ask_id, "outcome"]:
                row = next((a for a in self.asks if str(a["id"]) == ask_id), None)
                if row is None or row["decision"] != "allow":
                    return err(409, "No allowed question waits for its outcome")
                row["outcome"] = body["outcome"]
                return ok(row)
            case ["team", "messages"]:
                to = {"to_kind": "task", "to_handle": body["to"]} if "to" in body else {}
                message = team_message(len(self.team) + 1, "ea", body["text"], **to)
                self.team.append(message)
                unknown = [w[1:] for w in body["text"].split() if w == "@nobody"]
                return ok({"message": message, "deliveries": self.team_deliveries, "unknown": unknown})
            case ["team", "files"]:
                return self._send_files(body)
            case ["questions", "answers"]:
                return self._answer_questions(body)
            case ["knowledge"]:
                if "AKIA" in body["body"]:
                    return err(
                        400,
                        "Invalid request",
                        "The body looks like it holds a secret (AWS access key, line 1)",
                    )
                note = {
                    **body,
                    "id": f"note-{len(self.knowledge) + 1}",
                    "status": "proposed",
                    "proposer": "ea",
                }
                self.knowledge.append(note)
                return ok(note)
            case ["ea", "history", "summary"]:
                if not any(e["id"] == body["through_id"] for e in self.ea_history):
                    return err(409, "The EA history changed")
                return ok(
                    self.ea_append(
                        "summary", {"role": "user", "content": body["summary"]}, body["through_id"]
                    )
                )
            case _:
                return err(404, "Not Found")


def _gate_path(request: httpx.Request) -> bool:
    return request.url.path.startswith("/api/ea/asks")


def team_message(message_id: int, author_kind: str, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": message_id,
        "author_kind": author_kind,
        "author_task_id": None,
        "author_handle": None,
        "text": text,
        "mentions": [],
        "created_at": "2026-09-27T11:50:00.000Z",
        **extra,
    }


def ok(data: Any) -> httpx.Response:
    return httpx.Response(200, json={"data": data, "meta": {}})


def err(status: int, title: str, detail: str | None = None) -> httpx.Response:
    return httpx.Response(status, json={"error": {"title": title, "detail": detail or title}})


def live_context(
    text: str = "Tasks: 3 in all; 1 running.", as_of: str = "2026-09-27T11:59:50.000Z"
) -> dict[str, Any]:
    """What Seti answers at /api/ea/context."""
    return {
        "text": text,
        "as_of": as_of,
        "tokens": len(text) // 4,
        "tasks": [{"id": t["id"], "title": t["title"], "status": t["status"]} for t in default_tasks()],
    }


def search_hit(snippet: str, **extra: Any) -> dict[str, Any]:
    """One hit of /api/ea/search."""
    return {
        "kind": "agent",
        "task_id": TASK_LOGIN,
        "task_title": "Fix the login redirect bug",
        "pr_url": None,
        "pr_title": None,
        "repo": "Octocat/seti",
        "at": "2026-09-27T10:00:00.000Z",
        "snippet": snippet,
        "score": 1,
        "archived": False,
        **extra,
    }


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "deepgram_api_key": "",
        "openai_api_key": "",
        "elevenlabs_api_key": "",
        "elevenlabs_voice_id": "voice",
        "elevenlabs_model": "eleven_flash_v2_5",
        "model": "gpt-6-sol",
        "turn_key_id": "",
        "turn_api_token": "",
        "seti_api": "http://127.0.0.1:3006",
        "port": 3007,
        "env_file": Path("/nonexistent/ea.env"),
        "seti_api_token": SETI_TOKEN,
    }
    values.update(overrides)
    return Settings(**values)
