import json
from typing import Any

import httpx
import pytest
from fakes import NOW, PACK_TRIAGE, REPO_SETI, REPO_WEB, TASK_LOGOUT, FakeSeti, err, ok

from seti_ea.announce import ToolCall, action_line
from seti_ea.memory_tools import COMPACT_DEFAULTS
from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.settings_tools import SETTINGS_SPECS, SETTINGS_WRITES
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

HOOK = "h" * 24
WARM_DEFAULTS = {
    "enabled": True,
    "patterns": ["**/*.tsbuildinfo", "**/.next/cache", "**/.turbo"],
    "max_mb": 2048,
}
MEMORY_DEFAULTS = {"high_mb": 6144, "max_mb": 6144, "swap_max_mb": 1024}
CPU_DEFAULTS = {"quota_percent": 300}
SENTRY_HOOK = "s" * 24
SECRET_WORD = "whsec_"


def subscription(sub_id: int, channel_id: str, target: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": sub_id,
        "channel_id": channel_id,
        "target": target,
        "task_id": None,
        "task_title": None,
        "task_archived": False,
        "events": None,
        **extra,
    }


def source(source_id: str, label: str, signature: str, secret: str, setup: str) -> dict[str, Any]:
    mod = source_id.split(".")[0] if "." in source_id else None
    return {
        "id": source_id,
        "mod": mod,
        "label": label,
        "description": "",
        "signature": signature,
        "secret": secret,
        "kinds": [],
        "setup": setup,
    }


GITHUB = "github-webhooks.github"
SENTRY = "sentry-webhooks.sentry"
SOURCES = [
    source(
        "generic",
        "Generic",
        "X-Seti-Signature",
        "generated",
        "The sender signs with X-Seti-Signature: sha256= and the hex HMAC-SHA256 of the body; a sender "
        "that cannot sign sends Authorization: Bearer and the secret instead.",
    ),
    source(GITHUB, "GitHub", "X-Hub-Signature-256", "generated", "GitHub signs with X-Hub-Signature-256."),
    source(SENTRY, "Sentry", "Sentry-Hook-Signature", "sender", "Sentry signs with Sentry-Hook-Signature."),
]
ALIASES = {"github": GITHUB, "sentry": SENTRY}


def channel(channel_id: str, name: str, preset: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": channel_id,
        "name": name,
        "preset": preset,
        "sender": next(s for s in SOURCES if s["id"] == preset),
        "unavailable": None,
        "subscriptions": [subscription(1, channel_id, "ea")],
        "path": f"/hooks/{channel_id}",
        "public_url": f"https://seti.example.com/hooks/{channel_id}",
        "mapping": {},
        "created_at": "2026-09-26T12:00:00.000Z",
        "updated_at": "2026-09-26T12:00:00.000Z",
        "secret_rotated_at": None,
        "secret_pending": None,
        "recent": [],
        "deliveries": [],
        **extra,
    }


class SettingsFake(FakeSeti):
    """FakeSeti plus the settings routes, recording every request the same way."""

    def __init__(self) -> None:
        super().__init__()
        self.channels = [
            channel(
                HOOK,
                "Uptime",
                "generic",
                recent=[
                    {"title": "api down", "severity": "critical", "created_at": "2026-09-27T11:40:00.000Z"}
                ],
                deliveries=[
                    {
                        "status": "rejected",
                        "reason": "signature mismatch",
                        "received_at": "2026-09-27T11:50:00.000Z",
                    }
                ],
            )
        ]
        self.mods_off: set[str] = set()
        self.archive = {"enabled": True, "days": 3, "updated_at": None}
        self.unseen: list[dict[str, Any]] = []
        self.clean_plan: dict[str, Any] = dict(CLEAN_PLAN)
        self.revisions: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self.dreams: list[dict[str, Any]] = []
        self.proposals: list[dict[str, Any]] = []
        self.tidies: list[dict[str, Any]] = []
        self.trash: list[dict[str, Any]] = []
        self.dreams_off: dict[str, list[str]] = {"tasks": [], "workspaces": []}
        self.dream_settings: dict[str, Any] = {
            "enabled": False,
            "window_start": "01:00",
            "window_end": "05:00",
            "zone": None,
            "model": "claude-sonnet-5-5",
            "dream_budget_usd": 1,
            "night_budget_usd": 5,
            "at_once": 1,
        }
        self.warm: dict[str, dict[str, Any]] = {}
        self.memory: dict[str, Any] = {
            "cap": MEMORY_DEFAULTS,
            "defaults": MEMORY_DEFAULTS,
            "enforced": True,
            "updated_at": None,
        }
        self.task_memory: dict[str, dict[str, int]] = {}
        self.cpu: dict[str, Any] = {
            "cap": CPU_DEFAULTS,
            "defaults": CPU_DEFAULTS,
            "enforced": True,
            "updated_at": None,
            "max_percent": 800,
            "weight": 50,
        }
        self.task_cpu: dict[str, dict[str, int | None]] = {}
        self.compact: dict[str, Any] = {"rule": dict(COMPACT_DEFAULTS), "updated_at": None}
        self.task_compact: dict[str, dict[str, Any]] = {}
        self.ea = {
            "wake_enabled": False,
            "wake_phrase": "Hey Seti",
            "keep_awake_seconds": 30,
            "updated_at": None,
        }
        gmail = {**self.capabilities["servers"][1], "name": "claude.ai Gmail", "scope": "claudeai"}
        gmail["transport"] = {"type": "claudeai-proxy", "target": "gmail"}
        self.capabilities["servers"].append(gmail)
        self.sessions = [
            {
                "id": "5e551011-0000-4000-8000-000000000001",
                "title": "Fix flaky login test",
                "cwd": "/home/u/web",
                "git_branch": "fix/flaky",
                "last_modified": "2026-09-27T10:00:00.000Z",
                "repo_id": REPO_WEB,
                "repo_slug": "Octocat/web",
                "suggested_pr": {"key": "web#12", "number": 12},
            }
        ]

    def handle(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.removeprefix("/api/").split("/")
        body = json.loads(request.content or b"{}")
        if (request.method, request.url.path) in self.fail:
            return super().handle(request)
        handled = self._settings(request.method, parts, body, request.url.params)
        if handled is None:
            return super().handle(request)
        self.requests.append(request)
        return handled

    def _task_memory(self, task_id: str) -> dict[str, Any]:
        own = self.task_memory.get(task_id)
        return {"override": own, "effective": own or self.memory["cap"], "enforced": True}

    def _task_cpu(self, task_id: str) -> dict[str, Any]:
        own = self.task_cpu.get(task_id)
        effective = own or self.cpu["cap"]
        return {"override": own, "effective": effective, "enforced": True, "max_percent": 800}

    def _task_compact(self, task_id: str) -> dict[str, Any]:
        own = self.task_compact.get(task_id)
        return {"override": own, "effective": own or self.compact["rule"]}

    def _warm_status(self, repo_id: str) -> dict[str, Any]:
        settings = self.warm.get(repo_id, {**WARM_DEFAULTS, "updated_at": None})
        hint = (
            "Its typecheck cannot be warmed: no tsconfig sets incremental." if repo_id == REPO_SETI else None
        )
        return {"repo_id": repo_id, "settings": settings, "defaults": WARM_DEFAULTS, "hint": hint}

    def _channel(self, channel_id: str) -> dict[str, Any] | None:
        return next((c for c in self.channels if c["id"] == channel_id), None)

    def _settings(
        self, method: str, parts: list[str], body: dict[str, Any], params: httpx.QueryParams
    ) -> httpx.Response | None:
        match method, parts:
            case "GET", ["channels"]:
                return ok(self.channels)
            case "GET", ["resources", "memory"]:
                return ok(self.memory)
            case "PUT", ["resources", "memory"]:
                if body["high_mb"] > body["max_mb"]:
                    return err(400, "The soft cap cannot be above the RAM cap")
                self.memory = {**self.memory, "cap": body}
                return ok(self.memory)
            case "GET", ["tasks", task_id, "memory"]:
                return ok(self._task_memory(task_id))
            case "PUT", ["tasks", task_id, "memory"]:
                if body["cap"] is None:
                    self.task_memory.pop(task_id, None)
                else:
                    self.task_memory[task_id] = body["cap"]
                return ok(self._task_memory(task_id))
            case "GET", ["resources", "cpu"]:
                return ok(self.cpu)
            case "PUT", ["resources", "cpu"]:
                if (body["quota_percent"] or 0) > self.cpu["max_percent"]:
                    return err(400, "This host has 8 cores; the cap cannot be above that")
                self.cpu = {**self.cpu, "cap": body}
                return ok(self.cpu)
            case "GET", ["tasks", task_id, "cpu"]:
                return ok(self._task_cpu(task_id))
            case "PUT", ["tasks", task_id, "cpu"]:
                if body["cap"] is None:
                    self.task_cpu.pop(task_id, None)
                else:
                    self.task_cpu[task_id] = body["cap"]
                return ok(self._task_cpu(task_id))
            case "GET", ["compact"]:
                return ok(self.compact)
            case "PUT", ["compact"]:
                if body["threshold_pct"] is not None and body["window_k"] is None:
                    return err(400, "Claude Code applies a percentage only to a window you set")
                self.compact = {"rule": body, "updated_at": "2026-10-20T10:00:00.000Z"}
                return ok(self.compact)
            case "GET", ["tasks", task_id, "compact"]:
                return ok(self._task_compact(task_id))
            case "PUT", ["tasks", task_id, "compact"]:
                if body["rule"] is None:
                    self.task_compact.pop(task_id, None)
                else:
                    self.task_compact[task_id] = body["rule"]
                return ok(self._task_compact(task_id))
            case "GET", ["ea", "channels"]:
                subs = [
                    {**s, "channel_name": c["name"], "preset": c["preset"]}
                    for c in self.channels
                    for s in c["subscriptions"]
                    if s["target"] == "ea"
                ]
                return ok(subs)
            case "GET", ["channels", "sources"]:
                on = [s for s in SOURCES if s["mod"] not in self.mods_off]
                return ok({"webhooks": on, "pollers": []})
            case "POST", ["channels"]:
                preset = str(ALIASES.get(body["preset"], body["preset"]))
                if preset.split(".")[0] in self.mods_off:
                    return err(409, "The mod is off; turn it on in Settings, Mods")
                body["preset"] = preset
                pending = "paste" if preset == SENTRY else "reveal"
                made = channel(SENTRY_HOOK if pending == "paste" else "n" * 24, body["name"], preset)
                made |= {
                    "secret_pending": pending,
                    "mapping": body["mapping"],
                    "subscriptions": made["subscriptions"] if body["subscribe_ea"] else [],
                }
                self.channels.append(made)
                return ok({"channel": made, "secret": None})
            case "POST", ["channels", "pollers"]:
                return ok({"id": "n" * 24, "name": body["name"], "source": "poller"})
            case "POST", ["channels", "reminders"]:
                return ok({"id": "r" * 24, "name": body["name"], "source": "reminder"})
            case "PUT", ["channels", channel_id]:
                found = self._channel(channel_id)
                return ok({**found, **body}) if found else err(404, "No such webhook")
            case "DELETE", ["channels", channel_id]:
                return ok({"id": channel_id})
            case "POST", ["channels", channel_id, "subscriptions"]:
                found = self._channel(channel_id)
                if found is None:
                    return err(404, "No such webhook")
                task = next((t for t in self.tasks if t["id"] == body.get("task_id")), None)
                title = {"task_title": task["title"]} if task else {}
                added = subscription(len(found["subscriptions"]) + 7, channel_id, **body, **title)
                found["subscriptions"].append(added)
                return ok(added)
            case "PUT", ["channels", channel_id, "subscriptions", sub_id, "mode"]:
                found = self._channel(channel_id)
                sub = (
                    next((s for s in found["subscriptions"] if str(s["id"]) == sub_id), None)
                    if found
                    else None
                )
                if sub is None:
                    return err(404, "No such subscription on this channel")
                sub["mode"] = body["mode"]
                return ok(sub)
            case "PUT", ["channels", channel_id, "subscriptions", sub_id, "delivery"]:
                found = next((c for c in self.channels if c["id"] == channel_id), None)
                subs = found["subscriptions"] if found else []
                sub = next((s for s in subs if str(s["id"]) == sub_id), None)
                if sub is None or sub["target"] != "task":
                    return httpx.Response(400, json={"error": {"message": "Only an agent has a delivery"}})
                sub["delivery"] = body["delivery"]
                return ok(sub)
            case "PUT", ["channels", channel_id, "subscriptions", sub_id]:
                found = self._channel(channel_id)
                subs = found["subscriptions"] if found else []
                sub = next((s for s in subs if str(s["id"]) == sub_id), None)
                return ok({**sub, **body}) if sub else err(404, "No such subscription on this channel")
            case "DELETE", ["channels", channel_id, "subscriptions", sub_id]:
                return ok({"id": int(sub_id)})
            case "POST", ["channels", channel_id, "test"]:
                found = self._channel(channel_id)
                accepted = {
                    "status": "accepted",
                    "reason": "sent to the EA inbox",
                    "received_at": "2026-09-27T12:00:00Z",
                }
                return ok({**found, "deliveries": [accepted]}) if found else err(404, "No such webhook")
            case "POST", ["channels", channel_id, "rotate"]:
                found = self._channel(channel_id)
                return (
                    ok({"channel": {**found, "secret_pending": "reveal"}, "secret": None}) if found else None
                )
            case "GET", ["archive", "settings"]:
                count = 5 if params.get("days") == "1" else 1
                preview = {
                    "count": count,
                    "tasks": [{"id": "t-old", "title": "Old spike", "idle_since": "2026-09-20"}],
                }
                archived = {
                    "count": 4,
                    "stored_bytes": 2_000_000,
                    "table_bytes": 3_000_000,
                    "files_bytes": 50_000_000,
                }
                return ok({"settings": self.archive, "preview": preview, "archived": archived})
            case "GET", ["storage"]:
                return ok(STORAGE)
            case "GET", ["tasks", task_id, "files", "roots"]:
                return ok(ROOTS) if task_id == TASK_LOGOUT else None
            case "GET", ["tasks", task_id, "files", "tree"]:
                return ok(tree(params.get("root"), params.get("path"))) if task_id == TASK_LOGOUT else None
            case "GET", ["storage", "agents", task_id, "clean"]:
                return ok(self.clean_plan)
            case "POST", ["storage", "agents", task_id, "clean"]:
                return ok(
                    {
                        "removed": [{"path": body["dirs"][0], "bytes": 900_000_000}],
                        "refused": [{"path": body["dirs"][1], "reason": "process 7 works in it"}],
                        "freed_bytes": 900_000_000,
                    }
                )
            case "PUT", ["archive", "settings"]:
                self.archive = {**body, "updated_at": "now"}
                return ok({"settings": self.archive, "preview": {"count": 0, "tasks": []}, "archived": {}})
            case "POST", ["archive", "sweep"]:
                return ok({"archived": [{"task_id": "t-old", "title": "Old spike"}], "failed": []})
            case "GET", ["tasks", _, "dreams"]:
                return ok(self.dreams)
            case "POST", ["tasks", _, "dream"]:
                return ok({"id": 1, "state": "running"})
            case "GET", ["dreams", "settings"]:
                return ok(self.dream_settings)
            case "PUT", ["dreams", "settings"]:
                self.dream_settings = {**self.dream_settings, **body}
                return ok(self.dream_settings)
            case "GET", ["dreams"]:
                return ok(None)
            case "GET", ["dreams", "off"]:
                return ok(self.dreams_off)
            case "GET", ["dreams", "proposals"]:
                return ok(self.proposals)
            case "GET", ["dreams", "tidies"]:
                return ok(self.tidies)
            case "POST", ["dreams", "tidies", _, "undo"]:
                return ok({"id": 7, "label": "ci-alerts", "state": "undone"})
            case "GET", ["trash"]:
                return ok(self.trash)
            case "POST", ["trash", _, "restore"]:
                return ok({"id": 4, "original_path": "/work/old-notes.md"})
            case "PUT", ["tasks", _, "dreaming"] | ["workspaces", _, "dreaming"]:
                return ok(body)
            case "GET", ["workspaces"]:
                return ok([{"id": "w-client", "name": "Client", "position": 0}])
            case "GET", ["revisions", "unseen"]:
                return ok(self.unseen)
            case "GET", ["revisions"] if "task_id" in params:
                return ok(
                    [
                        r
                        for (kind, object_id), revs in self.revisions.items()
                        if kind == params["object_type"] and object_id.startswith(f"{params['task_id']}:")
                        for r in revs
                    ]
                )
            case "GET", ["revisions"]:
                return ok(self.revisions.get((params["object_type"], params["object_id"]), []))
            case "POST", ["revisions", "seen"]:
                return ok(None)
            case "POST", ["revisions", revision_id, "revert"]:
                return ok({"id": int(revision_id) + 100})
            case "PUT", ["context", "files", key]:
                if body["base_hash"] != "h":
                    return err(409, "Conflict", "The file changed since it was read")
                return ok({"key": key, "content": body["content"]})
            case "POST", ["plugins", "defaults"]:
                if not body["path"].startswith("/"):
                    return err(400, "Invalid request", "path must be absolute")
                return ok({"id": "new-plugin", "name": "review-kit", "path": body["path"], "enabled": True})
            case "PATCH", ["plugins", "defaults", plugin_id]:
                return ok({"id": plugin_id, **body})
            case "DELETE", ["plugins", "defaults", _]:
                return httpx.Response(204)
            case "PATCH", ["shared-tools", name]:
                return ok({"name": name, **body})
            case "DELETE", ["shared-tools", _]:
                return httpx.Response(204)
            case "POST", ["mcp", "servers"]:
                return ok({"name": body["name"], "scope": body["scope"]})
            case "DELETE", ["mcp", "servers", name]:
                return ok({"name": name, "scope": params["scope"]})
            case "POST", ["mcp", name, "reconnect"]:
                return ok({"name": name, "status": "failed", "error": "connection refused", "tools": []})
            case "POST", ["mcp", _, "auth", "start"]:
                return ok(
                    {
                        "session_id": "sess-1",
                        "authorization_url": "https://claude.ai/a",
                        "callback_expected": False,
                    }
                )
            case "GET", ["sessions"]:
                return ok({"sessions": self.sessions, "total": len(self.sessions)})
            case "POST", ["sessions", "import"]:
                return ok(
                    [
                        {"session_id": s["session_id"], "task_id": "new-task", "error": None}
                        for s in body["sessions"]
                    ]
                )
            case "POST", ["account", "refresh"]:
                return ok({**self.account, "fetched_at": "2026-09-27T12:00:00.000Z"})
            case "POST", ["capabilities", "refresh"]:
                return ok(self.capabilities)
            case "GET", ["repos", repo_id, "warm-caches"]:
                return ok(self._warm_status(repo_id))
            case "PUT", ["repos", repo_id, "warm-caches"]:
                if any(p.startswith(".env") for p in body["patterns"]):
                    return err(400, "Invalid request", "patterns: .env files are never copied")
                self.warm[repo_id] = {**body, "updated_at": "now"}
                return ok(self._warm_status(repo_id))
            case "GET", ["ea", "settings"]:
                return ok(self.ea)
            case "PUT", ["ea", "settings"]:
                if len(body["wake_phrase"].split()) > 4:
                    return err(400, "Invalid request", "wake_phrase: Use at most 4 words")
                self.ea = {**body, "updated_at": "now"}
                return ok(self.ea)
            case "GET", ["resources"]:
                return ok(RESOURCES)
            case "GET", ["sandbox"]:
                policy = {
                    "enabled": True,
                    "allowed_domains": ["github.com", "pypi.org"],
                    "hidden_paths": ["~/work"],
                }
                return ok({"policy": policy, "token_mode": "none"})
            case "GET", ["runtimes"]:
                failure = {"reason": "network", "message": "Could not reach registry.npmjs.org"}
                return ok({"codex": {"state": "failed", "failure": failure, "pinned": "0.171.0"}})
            case _:
                return None


STORAGE = {
    "disk": {"path": "/home/u/work", "total_bytes": 500_000_000_000, "free_bytes": 120_000_000_000},
    "total_bytes": 40_000_000_000,
    "rebuildable_bytes": 9_000_000_000,
    "agents": [
        {
            "task_id": TASK_LOGOUT,
            "title": "Fix the logout button",
            "state": "idle",
            "last_activity": "2026-09-27T10:00:00.000Z",
            "size": {"bytes": 30_000_000_000, "files": 400_000, "capped": True},
            "rebuildable_bytes": 9_000_000_000,
            "folders": [],
        }
    ],
    "orphans": [
        {
            "path": "/home/u/work/old-clone",
            "kind": "folder",
            "where": "/home/u/work",
            "size": {"bytes": 3_000_000_000, "files": 10, "capped": False},
            "modified_at": "2026-09-01T10:00:00.000Z",
            "kept": "it has 2 commit(s) that are not pushed",
        }
    ],
    "measuring": False,
    "schedule": {"enabled": False, "idle_days": 14, "last_run_at": None, "last_freed_bytes": None},
}
ROOTS = [
    {"id": "cwd", "label": "logout", "path": "/home/u/work/logout", "kind": "cwd", "exists": True},
    {"id": "workspace", "label": "Workspace", "path": "/s/ws", "kind": "workspace", "exists": True},
]


def tree(root: str | None, path: str | None) -> dict[str, Any]:
    entries = [
        {
            "name": "node_modules",
            "path": "node_modules",
            "type": "dir",
            "mtime": "2026",
            "size": {"bytes": 900_000_000, "files": 12_000, "capped": False},
            "git": None,
            "rebuildable": True,
        },
        {
            "name": "app",
            "path": "app",
            "type": "dir",
            "mtime": "2026",
            "size": {"bytes": 2_000_000_000, "files": 30, "capped": True},
            "git": {"branch": "main", "dirty": 2, "ahead": 1, "behind": 0},
            "rebuildable": False,
        },
        {"name": "notes.md", "path": "notes.md", "type": "file", "mtime": "2026", "size": {"bytes": 2000}},
    ]
    size = {"bytes": 3_000_000_000, "files": 12_031, "capped": True}
    return {
        "root": root,
        "path": path,
        "size": size,
        "entries": entries if root == "cwd" else [],
        "measuring": False,
    }


CLEAN_TARGETS: list[dict[str, Any]] = [
    {
        "dir": "/home/u/work/logout/node_modules",
        "base": "/home/u/work/logout",
        "path": "node_modules",
        "bytes": 900_000_000,
    },
    {
        "dir": "/home/u/work/logout/app/dist",
        "base": "/home/u/work/logout",
        "path": "app/dist",
        "bytes": 1000,
    },
]
CLEAN_PLAN: dict[str, Any] = {
    "task_id": TASK_LOGOUT,
    "title": "Fix the logout button",
    "targets": CLEAN_TARGETS,
    "bytes": 900_001_000,
    "refused": None,
    "kept": [],
    "measuring": False,
}

RESOURCES = {
    "host": {
        "cpus": 8,
        "load": [1.25, 1.0, 0.9],
        "cpu_percent": 23.4,
        "memory": {
            "total_bytes": 16_000_000_000,
            "used_bytes": 8_000_000_000,
            "available_bytes": 8_000_000_000,
        },
        "swap": {"total_bytes": 0, "used_bytes": 0},
        "disks": [{"mount": "/", "used_percent": 72.2, "free_bytes": 40_000_000_000}],
    },
    "components": [
        {"name": "Seti server", "state": "up", "rss_bytes": 800_000_000},
        {"name": "Redis", "state": "down", "rss_bytes": 0},
    ],
    "tasks": [
        {
            "task": {"id": "t", "title": "Fix the login redirect bug"},
            "rss_bytes": 1_100_000_000,
            "tool": {"name": "Bash", "command": "npm test"},
        }
    ],
    "totals": {"rss_bytes": 1_100_000_000},
    "anomalies": [{"message": "Disk / is 72% full"}],
}


@pytest.fixture
def fake() -> SettingsFake:
    return SettingsFake()


@pytest.fixture
def tools(fake: SettingsFake) -> EaTools:
    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    return EaTools(client, now=lambda: NOW)


async def confirm(tools: EaTools, name: str, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call(name, args)
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    return asked, done


def writes(fake: FakeSeti) -> list[tuple[str, str, Any]]:
    return [(m, p, b) for m, p, _q, b in fake.writes()]


def test_every_settings_write_is_gated_and_announced() -> None:
    reads = {spec.name for spec in SETTINGS_SPECS} - SETTINGS_WRITES
    assert reads == {
        "list_channels",
        "list_my_channels",
        "get_channel",
        "test_channel_script",
        "get_archive_settings",
        "list_archived_agents",
        "list_changes",
        "reconnect_mcp_server",
        "list_sessions",
        "resource_usage",
        "get_ea_settings",
        "get_warm_caches",
        "get_memory_cap",
        "get_security_settings",
    }
    for name in SETTINGS_WRITES:
        assert action_line(ToolCall(name, {})) is None
        assert action_line(ToolCall(name, {"confirmed": True})) is not None


@pytest.mark.parametrize(
    ("name", "args"),
    [
        ("create_channel", {"name": "Uptime 2"}),
        ("update_channel", {"channel": "uptime", "subscribe_ea": False}),
        ("subscribe_channel", {"channel": "uptime", "subscriber": "logout", "events": ["disk"]}),
        ("unsubscribe_channel", {"channel": "uptime", "subscriber": "ea"}),
        ("delete_channel", {"channel": "uptime"}),
        ("test_channel", {"channel": "uptime"}),
        ("rotate_channel_secret", {"channel": "uptime"}),
        ("create_poller", {"name": "Feed", "script": "export default () => []"}),
        ("create_reminder", {"name": "Nudge", "script": "export default () => 'hi'"}),
        ("set_auto_archive", {"days": 1}),
        ("run_archive_sweep", {}),
        ("write_context_file", {"file": "user", "append": "Be brief."}),
        ("mark_changes_seen", {"pack": "triage"}),
        ("add_plugin", {"path": "/home/u/plugins/review"}),
        ("remove_plugin", {"plugin": "acme"}),
        ("set_plugin_enabled", {"plugin": "acme", "enabled": False}),
        ("add_mcp_server", {"name": "tracker", "url": "https://mcp.tracker.test/mcp"}),
        ("remove_mcp_server", {"server": "langfuse"}),
        ("start_mcp_sign_in", {"server": "claude.ai Gmail"}),
        ("import_sessions", {"sessions": ["flaky login"]}),
        ("update_ea_settings", {"wake_enabled": True}),
        ("set_warm_caches", {"repo": "web", "enabled": False}),
        ("set_memory_cap", {"cap_gb": "8"}),
        ("set_memory_cap", {"agent": "logout", "default": True}),
        ("set_memory_cap", {"agent": "logout", "compact_instructions": "Keep the plan."}),
        ("set_memory_cap", {"cpu_cores": "2"}),
        ("set_memory_cap", {"agent": "logout", "cpu_default": True}),
    ],
)
async def test_every_write_asks_first_and_acts_only_after_a_yes(
    tools: EaTools, fake: SettingsFake, name: str, args: dict[str, Any]
) -> None:
    fake.revisions[("context_pack", PACK_TRIAGE)] = []
    asked = await tools.call(name, args)
    assert asked.ok, asked.text
    assert asked.summary.startswith("Asked first"), asked.text
    same_turn = await tools.call(name, {**args, "confirmed": True})
    assert same_turn.summary.startswith("Asked first")
    assert writes(fake) == []
    tools.user_turn()
    done = await tools.call(name, {**args, "confirmed": True})
    assert done.ok, done.text
    assert writes(fake) != []


async def test_webhooks_are_listed_and_explained_for_the_sender(tools: EaTools) -> None:
    listed = await tools.call("list_channels", {})
    assert listed.text == (
        '1 webhook:\n- Uptime (Generic): reports to you; last event 20 minutes ago: "api down"; '
        "last delivery refused 10 minutes ago (signature mismatch)"
    )
    detail = await tools.call("get_channel", {"channel": "uptime"})
    assert "Its URL is https://seti.example.com/hooks/" in detail.text
    assert "X-Seti-Signature" in detail.text
    assert "Authorization: Bearer" in detail.text
    assert "It reads the best-effort mapping." in detail.text


async def test_a_new_webhook_never_carries_its_secret_to_the_ea(tools: EaTools, fake: SettingsFake) -> None:
    asked, done = await confirm(
        tools, "create_channel", {"name": "Deploys", "preset": "github", "mapping": ["title=/x"]}
    )
    assert not asked.ok
    assert asked.text == "Only generic webhooks take a field mapping."
    asked, done = await confirm(tools, "create_channel", {"name": "Deploys", "preset": "github"})
    assert "Seti issues its signing secret; the user copies it once from Settings, Channels" in asked.text
    assert done.ok
    assert "X-Hub-Signature-256" in done.text
    assert "in Settings, Channels they press Show on this webhook" in done.text
    assert SECRET_WORD not in done.text
    assert writes(fake) == [
        (
            "POST",
            "/api/channels",
            {"name": "Deploys", "preset": GITHUB, "subscribe_ea": False, "mapping": {}},
        )
    ]
    sentry = await confirm(tools, "create_channel", {"name": "Errors", "preset": "sentry"})
    assert "pastes the secret Sentry issued in Settings, Channels" in sentry[1].text
    rotate = await tools.call("rotate_channel_secret", {"channel": "errors"})
    assert not rotate.ok
    assert "Sentry issues the secret of Errors" in rotate.text


async def test_a_webhook_source_resolves_by_name_and_offers_only_mods_that_are_on(
    tools: EaTools, fake: SettingsFake
) -> None:
    asked, done = await confirm(tools, "create_channel", {"name": "CI", "preset": "GitHub"})
    assert 'This creates the GitHub webhook "CI"' in asked.text
    assert done.ok
    assert writes(fake)[-1][2]["preset"] == GITHUB
    fake.mods_off.add("github-webhooks")
    refused = await tools.call("create_channel", {"name": "CI 2", "preset": "github"})
    assert not refused.ok
    assert refused.text.startswith("Seti takes no webhook source github now; it takes Generic, Sentry.")


async def test_a_webhook_whose_mod_is_off_says_it_refuses_deliveries(
    tools: EaTools, fake: SettingsFake
) -> None:
    off = channel("g" * 24, "Repo", GITHUB, unavailable="The GitHub webhooks mod is off")
    fake.channels.append(off)
    listed = await tools.call("list_channels", {})
    assert (
        "- Repo (GitHub): reports to you; no deliveries yet; "
        "refuses deliveries: The GitHub webhooks mod is off" in listed.text
    )
    detail = await tools.call("get_channel", {"channel": "repo"})
    assert (
        "It refuses deliveries: The GitHub webhooks mod is off; the user turns its mod on in Settings, Mods."
        in detail.text
    )


async def test_agents_and_the_ea_subscribe_with_filters(tools: EaTools, fake: SettingsFake) -> None:
    asked, done = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "events": ["Disk", "cpu"]}
    )
    assert "This sends cpu and disk from the webhook Uptime to the agent" in asked.text
    assert "as updates it acts on under its update mode" in asked.text
    assert done.text == 'Subscribed the agent "Fix the logout button" to the webhook Uptime: cpu and disk.'
    assert writes(fake) == [
        (
            "POST",
            f"/api/channels/{HOOK}/subscriptions",
            {"target": "task", "task_id": TASK_LOGOUT, "events": ["cpu", "disk"]},
        )
    ]
    detail = await tools.call("get_channel", {"channel": "uptime"})
    assert "It delivers to you: every event; Fix the logout button: cpu and disk." in detail.text
    listed = await tools.call("list_channels", {})
    assert "- Uptime (Generic): reports to you, feeds 1 agent;" in listed.text

    same = await tools.call("subscribe_channel", {"channel": "uptime", "subscriber": "ea"})
    assert same.text == "Your inbox already takes every event from Uptime."
    _, narrowed = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "events": ["disk"]}
    )
    assert narrowed.text == "Your inbox now takes disk from the webhook Uptime."
    assert writes(fake)[-1] == ("PUT", f"/api/channels/{HOOK}/subscriptions/1", {"events": ["disk"]})

    bad = await tools.call("subscribe_channel", {"channel": "uptime", "subscriber": "ea", "events": ["a,b"]})
    assert not bad.ok
    assert bad.summary == "Bad event kind"


async def test_an_agent_subscription_says_when_the_agent_gets_its_updates(
    tools: EaTools, fake: SettingsFake
) -> None:
    asked, done = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "delivery": "Now"}
    )
    assert "and hands its updates to the agent at once, joining a running turn at its next step" in asked.text
    assert done.text.endswith(
        'The agent "Fix the logout button" now gets its updates at once, during a running turn too.'
    )
    assert writes(fake)[-1] == (
        "POST",
        f"/api/channels/{HOOK}/subscriptions",
        {"target": "task", "task_id": TASK_LOGOUT, "events": None, "delivery": "now"},
    )
    detail = await tools.call("get_channel", {"channel": "uptime"})
    assert "Fix the logout button: every event, at once, during a running turn too." in detail.text

    same = await tools.call(
        "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "delivery": "now"}
    )
    assert same.text == (
        'The agent "Fix the logout button" already takes every event from Uptime, '
        "at once, during a running turn too."
    )
    asked, held = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "delivery": "with_message"}
    )
    assert "this holds its updates for the user's next message to the agent" in asked.text
    assert held.text.endswith("now gets its updates with the user's next message.")
    sub_id = fake.channels[0]["subscriptions"][-1]["id"]
    path = f"/api/channels/{HOOK}/subscriptions/{sub_id}/delivery"
    assert writes(fake)[-1] == ("PUT", path, {"delivery": "with_message"})
    _, follows = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "delivery": "agent"}
    )
    assert follows.text.endswith("now gets its updates as its update mode says.")
    assert writes(fake)[-1] == ("PUT", path, {"delivery": None})

    inbox = await tools.call(
        "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "delivery": "now"}
    )
    assert inbox.summary == "Bad delivery"
    bad = await tools.call(
        "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "delivery": "interrupt"}
    )
    assert bad.text == "Unknown delivery interrupt. Use now, after_turn, with_message or agent."


async def test_the_ea_lists_its_own_channels_and_changes_them_only_after_a_yes(
    tools: EaTools, fake: SettingsFake
) -> None:
    mine = await tools.call("list_my_channels", {})
    assert mine.text == "Your inbox takes events from 1 channel:\n- Uptime (webhook): every event"
    fake.channels[0]["subscriptions"] = []
    none = await tools.call("list_my_channels", {})
    assert none.text == "You subscribe to no channel: no channel event reaches your inbox."
    asked = await tools.call(
        "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "confirmed": True}
    )
    assert asked.summary.startswith("Asked first")
    assert writes(fake) == []
    tools.user_turn()
    done = await tools.call("subscribe_channel", {"channel": "uptime", "subscriber": "ea", "confirmed": True})
    assert done.ok, done.text
    assert writes(fake) == [("POST", f"/api/channels/{HOOK}/subscriptions", {"target": "ea", "events": None})]
    mine = await tools.call("list_my_channels", {})
    assert "- Uptime (webhook): every event" in mine.text


async def test_your_inbox_reports_or_acts_on_a_channel_and_agents_have_no_mode(
    tools: EaTools, fake: SettingsFake
) -> None:
    fake.channels[0]["subscriptions"][0]["events"] = ["disk"]
    asked, done = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "mode": "Act"}
    )
    assert (
        "For alerts from the webhook Uptime, this lets you send their work to an existing agent" in asked.text
    )
    assert (
        done.text
        == "Alerts from the webhook Uptime: you now send their work to an existing agent without asking."
    )
    assert writes(fake) == [("PUT", f"/api/channels/{HOOK}/subscriptions/1/mode", {"mode": "act"})]
    mine = await tools.call("list_my_channels", {})
    assert "- Uptime (webhook): disk; you act on its alerts" in mine.text
    detail = await tools.call("get_channel", {"channel": "uptime"})
    assert "It delivers to you (act): disk." in detail.text
    same = await tools.call("subscribe_channel", {"channel": "uptime", "subscriber": "ea", "mode": "act"})
    assert same.text == "Your inbox already takes disk from Uptime, and you already act on its alerts."

    _, both = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "events": [], "mode": "report"}
    )
    assert both.text == (
        "Your inbox now takes every event from the webhook Uptime. Alerts from the webhook Uptime: you now "
        "report them and ask before acting."
    )
    assert writes(fake)[-2:] == [
        ("PUT", f"/api/channels/{HOOK}/subscriptions/1", {"events": None}),
        ("PUT", f"/api/channels/{HOOK}/subscriptions/1/mode", {"mode": "report"}),
    ]

    agent = await tools.call(
        "subscribe_channel", {"channel": "uptime", "subscriber": "logout", "mode": "act"}
    )
    assert not agent.ok
    assert agent.summary == "Bad mode"
    bad = await tools.call("subscribe_channel", {"channel": "uptime", "subscriber": "ea", "mode": "auto"})
    assert bad.text == "Unknown mode auto. Use report or act."

    fake.channels[0]["subscriptions"] = []
    _, added = await confirm(
        tools, "subscribe_channel", {"channel": "uptime", "subscriber": "ea", "mode": "act"}
    )
    assert added.text.endswith("you now send their work to an existing agent without asking.")
    assert writes(fake)[-1] == (
        "POST",
        f"/api/channels/{HOOK}/subscriptions",
        {"target": "ea", "events": None, "mode": "act"},
    )


async def test_the_inbox_switch_and_unsubscribing_go_through_subscriptions(
    tools: EaTools, fake: SettingsFake
) -> None:
    _, off = await confirm(tools, "update_channel", {"channel": "uptime", "subscribe_ea": False})
    assert off.text == "Updated the webhook Uptime: it keeps its events out of your inbox."
    assert writes(fake) == [("DELETE", f"/api/channels/{HOOK}/subscriptions/1", None)]
    fake.channels[0]["subscriptions"] = []
    _, on = await confirm(tools, "update_channel", {"channel": "uptime", "subscribe_ea": True})
    assert on.text == "Updated the webhook Uptime: it sends its events to your inbox."
    assert writes(fake)[-1] == ("POST", f"/api/channels/{HOOK}/subscriptions", {"target": "ea"})
    missing = await tools.call("unsubscribe_channel", {"channel": "uptime", "subscriber": "logout"})
    assert not missing.ok
    assert missing.text == 'The agent "Fix the logout button" does not subscribe to Uptime.'


async def test_generic_mapping_is_parsed_and_checked(tools: EaTools, fake: SettingsFake) -> None:
    bad = await tools.call("update_channel", {"channel": "uptime", "mapping": ["name=/a"]})
    assert not bad.ok
    assert bad.summary == "Bad mapping"
    _, done = await confirm(tools, "update_channel", {"channel": "uptime", "mapping": ["title=/alert/name"]})
    assert done.text == "Updated the webhook Uptime: it makes it read title from /alert/name."
    assert writes(fake) == [("PUT", f"/api/channels/{HOOK}", {"mapping": {"title": "/alert/name"}})]


async def test_archive_settings_sweep_and_list(tools: EaTools, fake: SettingsFake) -> None:
    read = await tools.call("get_archive_settings", {})
    assert read.text.splitlines() == [
        "Auto-archive is on: complete agents idle 3 days or more are archived.",
        "Archived agents are kept until deleted by hand.",
        "Agents a Seti restart cuts off get one message to check their work and go on, unless they were "
        "waiting on the user.",
        "An agent that runs the same call again after 2 identical results waits for the user to allow it.",
        "The rule would archive 1 agent: Old spike (idle since 7 days ago) now.",
        "The archive holds 4 agents in 2 MB, and their packed folders take 50 MB.",
    ]
    asked, done = await confirm(tools, "set_auto_archive", {"days": 1})
    assert "right now it would archive 5 agents" in asked.text
    assert done.text == (
        "Auto-archive is now on: complete agents idle 1 day or more are archived. "
        "Archived agents are kept until deleted by hand."
    )
    same = await tools.call("set_auto_archive", {"days": 1})
    assert same.summary == "Nothing to change"
    asked, done = await confirm(tools, "set_auto_archive", {"delete_after_days": 30})
    assert "Archived agents are deleted with their files 30 days after archiving." in asked.text
    assert fake.archive["delete_after_days"] == 30
    _, done = await confirm(tools, "set_auto_archive", {"delete_after_days": 0})
    assert fake.archive["delete_after_days"] is None
    asked, done = await confirm(tools, "set_auto_archive", {"resume_after_restart": False})
    assert "Agents a Seti restart cuts off wait for the user to retry or reply." in asked.text
    assert fake.archive["resume_after_restart"] is False
    assert done.text.endswith("Agents a Seti restart cuts off wait for the user to retry or reply.")
    off = "Agents may repeat a call that keeps giving the same result without asking."
    asked, done = await confirm(tools, "set_auto_archive", {"repeat_guard": False})
    assert f"What it would do: {off}" in asked.text
    assert "restart" not in asked.text
    assert fake.archive["repeat_guard"] is False
    assert fake.archive["resume_after_restart"] is False
    assert done.text.endswith(off)
    assert "restart" not in done.text
    _, swept = await confirm(tools, "run_archive_sweep", {})
    assert swept.text == "Archived 1 agent: Old spike."


async def test_context_file_write_uses_the_hash_it_read(tools: EaTools, fake: SettingsFake) -> None:
    asked, done = await confirm(tools, "write_context_file", {"file": "user", "append": "Always be brief."})
    assert "This changes user-level CLAUDE.md: it adds at its end" in asked.text
    assert "Every agent read it from their next session." in asked.text
    assert done.ok
    method, path, body = writes(fake)[0]
    assert (method, path, body["base_hash"]) == ("PUT", "/api/context/files/user", "h")
    assert body["content"].endswith("\n\nAlways be brief.\n")
    missing = await tools.call("write_context_file", {"file": "user"})
    assert missing.text == "Give the new content, or text to append."


async def test_changes_by_agents_are_listed_reverted_and_marked_seen(
    tools: EaTools, fake: SettingsFake
) -> None:
    change = {
        "id": 7,
        "at": "2026-09-27T10:00:00.000Z",
        "actor": "agent",
        "task_title": "Fix the login redirect bug",
        "kind": "updated",
        "before": {"body": "a", "name": "Triage sources"},
        "after": {"body": "b", "name": "Triage sources"},
        "reason": "tighter body",
    }
    fake.revisions[("context_pack", PACK_TRIAGE)] = [change]
    unseen = {"object_type": "context_pack", "object_id": PACK_TRIAGE, "revision_id": 7, "at": change["at"]}
    fake.unseen = [unseen]
    listed = await tools.call("list_changes", {})
    assert listed.text.splitlines()[1] == (
        "- context pack Triage sources: change 7, 2 hours ago: the agent in Fix the login redirect "
        'bug changed its body, saying "tighter body"'
    )
    asked, done = await confirm(tools, "revert_change", {"pack": "triage"})
    assert "This undoes change 7" in asked.text
    assert done.ok
    _, seen = await confirm(tools, "mark_changes_seen", {})
    assert seen.ok
    assert writes(fake) == [
        ("POST", "/api/revisions/7/revert", {}),
        ("POST", "/api/revisions/seen", {"object_type": "context_pack", "object_id": PACK_TRIAGE}),
    ]


async def test_dream_memory_changes_are_listed_reverted_and_marked_seen(
    tools: EaTools, fake: SettingsFake
) -> None:
    memory = f"{TASK_LOGOUT}:MEMORY.md"
    change: dict[str, Any] = {
        "id": 12,
        "at": "2026-09-27T10:00:00.000Z",
        "actor": "system",
        "task_id": TASK_LOGOUT,
        "task_title": "Fix the logout button",
        "object_type": "memory_file",
        "object_id": memory,
        "kind": "updated",
        "before": {"text": "- a", "sha256": "1"},
        "after": {"text": "- b", "sha256": "2"},
        "reason": "dream 2026-09-27",
    }
    created: dict[str, Any] = {
        **change,
        "id": 11,
        "object_id": f"{TASK_LOGOUT}:topics/new.md",
        "before": {"text": "", "sha256": "", "deleted": True},
    }
    fake.revisions[("memory_file", memory)] = [change]
    fake.revisions[("memory_file", f"{TASK_LOGOUT}:topics/new.md")] = [created]
    fake.unseen = [{"object_type": "memory_file", "object_id": memory, "revision_id": 12, "at": change["at"]}]
    listed = await tools.call("list_changes", {})
    assert listed.text.splitlines()[1] == (
        "- memory file MEMORY.md: change 12, 2 hours ago: Seti's dream rewrote memory file MEMORY.md, "
        'saying "dream 2026-09-27"'
    )
    history = await tools.call("list_changes", {"memory": "logout"})
    assert history.text.splitlines()[0] == "Changes to the memory of Fix the logout button, newest first:"
    assert "created memory file topics/new.md" in history.text.splitlines()[2]
    asked, done = await confirm(tools, "revert_change", {"memory": "logout"})
    assert "This undoes change 12" in asked.text
    assert done.ok
    _, seen = await confirm(tools, "mark_changes_seen", {"memory": "logout"})
    assert seen.ok
    assert writes(fake) == [
        ("POST", "/api/revisions/12/revert", {}),
        ("POST", "/api/revisions/seen", {"object_type": "memory_file", "object_id": memory}),
        (
            "POST",
            "/api/revisions/seen",
            {"object_type": "memory_file", "object_id": f"{TASK_LOGOUT}:topics/new.md"},
        ),
    ]


async def test_dreams_are_read_and_one_started_after_a_yes(tools: EaTools, fake: SettingsFake) -> None:
    none = await tools.call("dreams", {"task": "logout"})
    assert none.text == "Fix the logout button has not dreamt yet."
    fake.dreams = [
        {
            "night": "2026-11-23",
            "state": "done",
            "reason": None,
            "memory_changes": 2,
            "cost_usd": 0.24,
            "report": {"summary": "Merged the deploy notes", "tidied": ["MEMORY.md: one rule"], "asks": []},
        }
    ]
    read = await tools.call("dreams", {"task": "logout"})
    assert read.text.splitlines()[1:] == [
        "- Night of 2026-11-23: done, 2 memory files changed, $0.24",
        "  Merged the deploy notes",
        "  Tidied: MEMORY.md: one rule",
    ]
    asked, started = await confirm(tools, "dreams", {"task": "logout", "start": True})
    assert "sandboxed session" in asked.text
    assert started.ok
    assert writes(fake)[-1][0:2] == ("POST", f"/api/tasks/{TASK_LOGOUT}/dream")


async def test_dreaming_names_the_agents_and_workspaces_switched_out(
    tools: EaTools, fake: SettingsFake
) -> None:
    fake.dreams_off = {"tasks": [TASK_LOGOUT], "workspaces": ["w-client"]}
    read = await tools.call("dreams", {})
    assert "Switched out of Dreaming: agents Fix the logout button; workspaces Client." in read.text


async def test_dreaming_is_read_changed_and_switched_per_agent_and_workspace_after_a_yes(
    tools: EaTools, fake: SettingsFake
) -> None:
    read = await tools.call("dreams", {})
    assert read.text.startswith("Nightly Dreaming is off: window 01:00 to 05:00 (no zone chosen yet)")
    assert read.text.endswith(
        "No night has been planned yet. No agent or workspace is switched out of Dreaming. "
        "The trash is empty."
    )
    change = {"enabled": True, "zone": "Europe/Istanbul", "window_start": "00:30"}
    asked, changed = await confirm(tools, "dreams", change)
    assert "turns it on, sets window start to 00:30, sets zone to Europe/Istanbul." in asked.text
    assert changed.text.startswith("Nightly Dreaming is on: window 00:30 to 05:00 (Europe/Istanbul)")
    assert writes(fake)[-1] == ("PUT", "/api/dreams/settings", change)
    _, agent = await confirm(tools, "dreams", {"task": "logout", "dreaming": False})
    assert agent.text == "Switched nightly Dreaming off for Fix the logout button."
    assert writes(fake)[-1] == ("PUT", f"/api/tasks/{TASK_LOGOUT}/dreaming", {"on": False})
    _, group = await confirm(tools, "dreams", {"workspace": "client", "dreaming": True})
    assert group.text == "Switched nightly Dreaming on for the Client workspace."
    assert writes(fake)[-1] == ("PUT", "/api/workspaces/w-client/dreaming", {"on": True})
    fake.trash = [{"id": 4, "original_path": "/work/old-notes.md"}]
    assert (await tools.call("dreams", {})).text.endswith("The trash holds 1 item: 4: /work/old-notes.md.")
    _, restored = await confirm(tools, "dreams", {"restore": 4})
    assert restored.text == "Restored /work/old-notes.md."
    assert writes(fake)[-1][0:2] == ("POST", "/api/trash/4/restore")
    fake.proposals = [{"kind": "delete_branch", "target": "/work/app:done", "reason": "merged"}]
    fake.dreams = [{"night": "2026-11-24", "state": "done", "memory_changes": 0, "cost_usd": 0.1}]
    read = await tools.call("dreams", {"task": "logout"})
    assert read.text.endswith("- Clean-up waiting for the user: delete_branch /work/app:done (merged)")


async def test_a_dreams_unsubscribe_is_listed_and_undone_after_a_yes(
    tools: EaTools, fake: SettingsFake
) -> None:
    fake.dreams = [{"night": "2026-11-24", "state": "done", "memory_changes": 0, "cost_usd": 0.1}]
    fake.tidies = [
        {"id": 7, "label": "ci-alerts", "reason": "the release it watched shipped", "state": "applied"}
    ]
    read = await tools.call("dreams", {"task": "logout"})
    assert read.text.endswith(
        "- A dream unsubscribed it from ci-alerts (the release it watched shipped; undo id 7)"
    )
    asked, undone = await confirm(tools, "dreams", {"undo": 7})
    assert "subscribes the agent again" in asked.text
    assert undone.text == "Subscribed it again to ci-alerts."
    assert writes(fake)[-1][0:2] == ("POST", "/api/dreams/tidies/7/undo")


async def test_plugins_are_added_switched_and_removed(tools: EaTools, fake: SettingsFake) -> None:
    bad = await confirm(tools, "add_plugin", {"path": "relative"})
    assert bad[1].text == "Seti did not do it: path must be absolute"
    already = await tools.call("set_plugin_enabled", {"plugin": "acme", "enabled": True})
    assert already.summary.endswith("already on")
    _, off = await confirm(tools, "set_plugin_enabled", {"plugin": "acme", "enabled": False})
    assert off.ok
    assert writes(fake)[-1][0:2] == ("PATCH", f"/api/plugins/defaults/{fake.plugins['defaults'][0]['id']}")


async def test_a_shared_tool_is_turned_off_and_removed_but_never_turned_on(
    tools: EaTools, fake: SettingsFake
) -> None:
    fake.shared_tools = [
        {
            "name": "invoices",
            "enabled": True,
            "needs": [{"env": "BILLING_KEY", "hosts": ["api.billing.test"]}],
        }
    ]
    on = await tools.call("set_plugin_enabled", {"plugin": "invoices", "enabled": True, "confirmed": True})
    assert on.summary == "User only"
    asked, off = await confirm(tools, "set_plugin_enabled", {"plugin": "invoices", "enabled": False})
    assert "only the user turns it back on" in asked.text
    assert off.text == "Turned the shared tool invoices off."
    assert writes(fake)[-1] == ("PATCH", "/api/shared-tools/invoices", {"enabled": False})
    asked, removed = await confirm(tools, "remove_plugin", {"plugin": "invoices"})
    assert "its code is deleted from Seti" in asked.text
    assert removed.text == "Removed the shared tool invoices."
    assert writes(fake)[-1][0:2] == ("DELETE", "/api/shared-tools/invoices")
    missing = await tools.call("remove_plugin", {"plugin": "nothing-like-it"})
    assert missing.summary.startswith("No default plugin or shared tool matches")


async def test_mcp_servers_remote_only_and_sign_in_link_only_for_connectors(
    tools: EaTools, fake: SettingsFake
) -> None:
    stdio = await tools.call("add_mcp_server", {"name": "x", "url": "u", "transport": "stdio"})
    assert stdio.summary == "Remote servers only"
    project = await tools.call("add_mcp_server", {"name": "x", "url": "https://x", "scope": "project"})
    assert project.summary == "No repo"
    _, added = await confirm(
        tools, "add_mcp_server", {"name": "tracker", "url": "https://mcp.tracker.test/mcp"}
    )
    assert added.ok
    assert writes(fake)[-1][2] == {
        "name": "tracker",
        "scope": "user",
        "transport": "http",
        "url": "https://mcp.tracker.test/mcp",
        "headers": [],
    }
    reconnect = await tools.call("reconnect_mcp_server", {"server": "langfuse"})
    assert reconnect.text == "Checked langfuse again: it is failing: connection refused."
    http = await tools.call("start_mcp_sign_in", {"server": "langfuse"})
    assert http.summary == "Sign in from Settings"
    again = await tools.call("start_mcp_sign_in", {"server": "slack"})
    assert again.summary == "Sign in from Settings"
    connected = await tools.call("start_mcp_sign_in", {"server": "seti"})
    assert connected.text == "seti is already connected; no sign-in is needed."
    _, link = await confirm(tools, "start_mcp_sign_in", {"server": "claude.ai Gmail"})
    assert "https://claude.ai/a" in link.text


async def test_sessions_are_listed_and_imported(tools: EaTools, fake: SettingsFake) -> None:
    listed = await tools.call("list_sessions", {})
    assert listed.text.splitlines()[1] == (
        "- Fix flaky login test: web, branch fix/flaky, open PR web#12, active 2 hours ago"
    )
    asked, done = await confirm(tools, "import_sessions", {"sessions": ["flaky login"]})
    assert "This imports 1 session as agents: Fix flaky login test." in asked.text
    assert done.text == "Imported 1 session as agents: Fix flaky login test."


async def test_refreshes_resources_ea_settings_schedule_and_security(
    tools: EaTools, fake: SettingsFake
) -> None:
    await tools.call("account_status", {"refresh": True})
    await tools.call("list_mcp_servers", {"refresh": True})
    assert [p for p, _ in fake.posts()] == ["/api/account/refresh", "/api/capabilities/refresh"]
    usage = await tools.call("resource_usage", {})
    assert usage.text.splitlines()[0] == (
        "CPU 23 percent busy across 8 cores, load 1.2. Memory 50 percent used (8 GB of 16 GB); "
        "swap 0 bytes used."
    )
    assert "down: Redis" in usage.text
    assert "npm test" not in usage.text
    settings = await tools.call("get_ea_settings", {})
    assert settings.text.startswith('Your wake word is off; its phrase is "Hey Seti"')
    assert "Inbox relays are off; only the user turns them on or off" in settings.text
    bad = await confirm(tools, "update_ea_settings", {"wake_phrase": "one two three four five"})
    assert not bad[1].ok
    _, on = await confirm(tools, "update_ea_settings", {"wake_enabled": True, "keep_awake_seconds": 60})
    assert on.text.startswith(
        'Done. Your wake word is on: on a call you answer after hearing "Hey Seti", and stay awake 60 '
        "seconds after the last words."
    )
    assert on.text.endswith("You address the user with no title. You listen and speak in English.")
    asked, titled = await confirm(tools, "update_ea_settings", {"form_of_address": " ma'am "})
    assert asked.text.count('You address the user as "ma\'am" now and then.') == 1
    assert titled.ok
    assert fake.ea["form_of_address"] == "ma'am"
    assert fake.ea["wake_enabled"] is True
    long = await tools.call("update_ea_settings", {"form_of_address": "x" * 21})
    assert long.summary == "Too long"
    _, cleared = await confirm(tools, "update_ea_settings", {"form_of_address": ""})
    assert "You address the user with no title." in cleared.text
    security = await tools.call("get_security_settings", {})
    assert security.text.startswith("The sandbox is on")
    assert "Codex cannot start: Could not reach registry.npmjs.org; the user retries" in security.text
    assert "You cannot change them or see any secret." in security.text


async def test_the_ea_changes_its_language_by_code_or_name(tools: EaTools, fake: SettingsFake) -> None:
    asked, turkish = await confirm(tools, "update_ea_settings", {"language": "Turkish"})
    assert asked.text.count("You listen and speak in Turkish.") == 1
    assert turkish.text.endswith("You listen and speak in Turkish.")
    assert fake.ea["language"] == "tr"
    assert fake.ea["wake_phrase"] == "Hey Seti"
    same = await tools.call("update_ea_settings", {"language": "tr"})
    assert same.summary == "Nothing to change"
    _, kept = await confirm(tools, "update_ea_settings", {"keep_awake_seconds": 45})
    assert fake.ea["language"] == "tr"
    assert kept.text.endswith("You listen and speak in Turkish.")
    _, multi = await confirm(tools, "update_ea_settings", {"language": "multi"})
    assert multi.text.endswith(
        "You listen in any of your languages and answer in the one the user last used."
    )
    unknown = await tools.call("update_ea_settings", {"language": "Klingon"})
    assert unknown.summary == "Unknown language"
    assert "You can speak: English, Multilingual, Arabic" in unknown.text
    assert fake.ea["language"] == "multi"


async def test_seti_refusing_the_ea_reads_plainly(tools: EaTools, fake: SettingsFake) -> None:
    fake.fail[("POST", "/api/mcp/servers")] = (
        403,
        {"error": {"title": "Forbidden", "detail": "The EA cannot add a server; the user does that in Seti"}},
    )
    _, done = await confirm(tools, "add_mcp_server", {"name": "t", "url": "https://t.test"})
    assert not done.ok
    assert done.text == "Seti did not do it: The EA cannot add a server; the user does that in Seti"


def test_the_prompt_keeps_security_and_secrets_with_the_user() -> None:
    assert "Security is the user's alone" in SYSTEM_PROMPT
    assert "You never see a secret value." in SYSTEM_PROMPT
    assert SYSTEM_PROMPT.isascii()


async def test_warm_caches_are_read_with_the_typecheck_hint(tools: EaTools) -> None:
    seti = await tools.call("get_warm_caches", {"repo": "seti"})
    assert seti.ok
    assert "on: new worktrees get **/*.tsbuildinfo, **/.next/cache and **/.turbo, up to 2048 MB" in seti.text
    assert "cannot be warmed" in seti.text
    web = await tools.call("get_warm_caches", {"repo": "web"})
    assert "cannot be warmed" not in web.text


async def test_warm_cache_patterns_are_added_and_removed_after_a_yes(
    tools: EaTools, fake: SettingsFake
) -> None:
    args = {"repo": "web", "add_patterns": ["**/.vite"], "remove_patterns": ["**/.turbo"], "max_mb": 512}
    asked, done = await confirm(tools, "set_warm_caches", args)
    assert "**/.vite" in asked.text
    assert "512 MB" in asked.text
    assert done.ok, done.text
    assert writes(fake) == [
        (
            "PUT",
            f"/api/repos/{REPO_WEB}/warm-caches",
            {"enabled": True, "patterns": ["**/*.tsbuildinfo", "**/.next/cache", "**/.vite"], "max_mb": 512},
        )
    ]
    assert "now on" in done.text


async def test_warm_cache_changes_that_change_nothing_or_name_unknown_patterns_are_refused(
    tools: EaTools, fake: SettingsFake
) -> None:
    same = await tools.call("set_warm_caches", {"repo": "web", "enabled": True})
    assert not same.ok
    assert "already on" in same.text
    unknown = await tools.call("set_warm_caches", {"repo": "web", "remove_patterns": ["dist"]})
    assert not unknown.ok
    assert "dist is not among the patterns" in unknown.text
    cap = await tools.call("set_warm_caches", {"repo": "web", "max_mb": 0})
    assert not cap.ok
    _, refused = await confirm(tools, "set_warm_caches", {"repo": "web", "add_patterns": [".env.local"]})
    assert not refused.ok
    assert ".env files are never copied" in refused.text
    assert fake.warm == {}


async def test_the_memory_cap_is_read_for_every_agent_and_for_one_with_its_use(
    tools: EaTools, fake: SettingsFake
) -> None:
    every = await tools.call("get_memory_cap", {})
    assert every.ok
    assert "6 GB, with 1 GB swap" in every.text
    fake.processes[TASK_LOGOUT] = {"memory": [{"current_bytes": 1536 * 1024 * 1024, "oom_kills": 1}]}
    one = await tools.call("get_memory_cap", {"agent": "logout"})
    assert one.ok, one.text
    assert "the default memory cap" in one.text
    assert "uses 1.5 GB now" in one.text
    assert "1 of its processes were stopped" in one.text


async def test_the_memory_cap_changes_after_a_yes_for_every_agent_or_one(
    tools: EaTools, fake: SettingsFake
) -> None:
    asked, done = await confirm(tools, "set_memory_cap", {"cap_gb": "8", "throttle_gb": "6"})
    assert "every agent's memory cap" in asked.text
    assert done.ok, done.text
    assert writes(fake) == [
        ("PUT", "/api/resources/memory", {"high_mb": 6144, "max_mb": 8192, "swap_max_mb": 1024})
    ]
    _, own = await confirm(tools, "set_memory_cap", {"agent": "logout", "cap_gb": "2"})
    assert own.ok, own.text
    assert fake.task_memory[TASK_LOGOUT] == {"high_mb": 2048, "max_mb": 2048, "swap_max_mb": 1024}
    assert "throttled" not in own.text
    _, back = await confirm(tools, "set_memory_cap", {"agent": "logout", "default": True})
    assert back.ok, back.text
    assert fake.task_memory == {}
    nothing = await tools.call("set_memory_cap", {"agent": "logout"})
    assert not nothing.ok
    _, refused = await confirm(tools, "set_memory_cap", {"cap_gb": "2", "throttle_gb": "3"})
    assert not refused.ok
    assert "cannot be above" in refused.text


async def test_the_memory_cap_read_carries_the_cpu_cap_and_what_an_agent_uses(
    tools: EaTools, fake: SettingsFake
) -> None:
    every = await tools.call("get_memory_cap", {})
    assert "Every agent's CPU cap is 3 cores of this machine's 8 cores." in every.text
    fake.cpu = {**fake.cpu, "cap": {"quota_percent": None}, "enforced": False}
    off = await tools.call("get_memory_cap", {})
    assert "Agents have no CPU cap and may use all 8 cores of this machine." in off.text
    assert "This machine cannot enforce a CPU cap." in off.text
    fake.task_cpu[TASK_LOGOUT] = {"quota_percent": 150}
    fake.processes[TASK_LOGOUT] = {
        "memory": [],
        "cpu": [{"usage_percent": 149.6, "throttled_now": True, "nr_throttled": 40}],
    }
    one = await tools.call("get_memory_cap", {"agent": "logout"})
    assert one.ok, one.text
    assert "It has its own CPU cap: 1.5 cores." in one.text
    assert "It uses 1.5 cores now, held at its CPU cap so it runs slower." in one.text
    fake.processes[TASK_LOGOUT] = {"memory": [], "cpu": [{"usage_percent": 20, "throttled_now": False}]}
    calm = await tools.call("get_memory_cap", {"agent": "logout"})
    assert "It uses 0.2 cores now." in calm.text


async def test_the_cpu_cap_changes_after_a_yes_for_every_agent_or_one(
    tools: EaTools, fake: SettingsFake
) -> None:
    asked, done = await confirm(tools, "set_memory_cap", {"cpu_cores": "2.5"})
    assert "every agent a CPU cap of 2.5 cores" in asked.text
    assert done.ok, done.text
    assert writes(fake) == [("PUT", "/api/resources/cpu", {"quota_percent": 250})]
    _, off = await confirm(tools, "set_memory_cap", {"agent": "logout", "cpu_cores": "off"})
    assert off.ok, off.text
    assert fake.task_cpu[TASK_LOGOUT] == {"quota_percent": None}
    assert "no CPU cap" in off.text
    _, back = await confirm(tools, "set_memory_cap", {"agent": "logout", "cpu_default": True})
    assert back.ok, back.text
    assert fake.task_cpu == {}
    _, reset = await confirm(tools, "set_memory_cap", {"cpu_default": True})
    assert reset.ok, reset.text
    assert fake.cpu["cap"] == CPU_DEFAULTS
    both = await tools.call("set_memory_cap", {"cap_gb": "8", "cpu_cores": "2"})
    assert not both.ok
    bad = await tools.call("set_memory_cap", {"cpu_cores": "lots"})
    assert not bad.ok
    _, refused = await confirm(tools, "set_memory_cap", {"cpu_cores": "16"})
    assert not refused.ok
    assert "cannot be above" in refused.text


async def test_the_memory_cap_read_says_how_agents_compact(tools: EaTools, fake: SettingsFake) -> None:
    every = await tools.call("get_memory_cap", {})
    assert "compacts on its own at the point Claude Code picks" in every.text
    fake.processes[TASK_LOGOUT] = {"memory": []}
    fake.task_compact[TASK_LOGOUT] = {
        "auto": True,
        "window_k": 200,
        "threshold_pct": 70,
        "instructions": "Keep the files changed.",
    }
    one = await tools.call("get_memory_cap", {"agent": "logout"})
    assert one.ok, one.text
    assert "By its own rule, its conversation compacts on its own against a 200k token window" in one.text
    assert 'at 70% of it, keeping "Keep the files changed."' in one.text


async def test_compaction_changes_after_a_yes_for_every_agent_or_one(
    tools: EaTools, fake: SettingsFake
) -> None:
    args = {"compact_window_k": 200, "compact_instructions": "Keep open decisions."}
    asked, done = await confirm(tools, "set_memory_cap", args)
    assert "every agent compact on its own against a 200k token window" in asked.text
    assert done.ok, done.text
    rule = {"auto": True, "window_k": 200, "threshold_pct": None, "instructions": "Keep open decisions."}
    assert writes(fake) == [("PUT", "/api/compact", rule)]
    _, own = await confirm(tools, "set_memory_cap", {"agent": "logout", "auto_compact": False})
    assert own.ok, own.text
    assert fake.task_compact[TASK_LOGOUT] == {**rule, "auto": False}
    assert "compacts only on /compact" in own.text
    _, back = await confirm(tools, "set_memory_cap", {"agent": "logout", "compact_default": True})
    assert back.ok, back.text
    assert fake.task_compact == {}
    _, reset = await confirm(tools, "set_memory_cap", {"compact_default": True})
    assert reset.ok, reset.text
    assert fake.compact["rule"] == COMPACT_DEFAULTS
    both = await tools.call("set_memory_cap", {"cap_gb": "8", "auto_compact": False})
    assert not both.ok
    _, refused = await confirm(tools, "set_memory_cap", {"compact_window_k": 0, "compact_at_pct": 70})
    assert not refused.ok
    assert "only to a window you set" in refused.text


async def test_storage_overview_is_read_from_resource_usage(tools: EaTools) -> None:
    read = await tools.call("resource_usage", {"storage": True})
    assert read.text.splitlines() == [
        "Agents' folders and orphans take 40 GB; Clean could free 9 GB of rebuildable folders.",
        "The disk holding /home/u/work has 120 GB free of 500 GB.",
        "Largest agents: Fix the logout button about 30 GB, 9 GB rebuildable "
        "(idle, last active 2 hours ago).",
        "1 orphan folder no agent owns, 3 GB in all. 1 of them stays when orphans are removed, such as "
        "/home/u/work/old-clone because it has 2 commit(s) that are not pushed. Only the user removes "
        "orphans, in Settings, Storage.",
        "The automatic clean is off; only the user turns it on.",
    ]


async def test_an_agents_tree_is_read_with_sizes_and_git(tools: EaTools) -> None:
    read = await tools.call("resource_usage", {"agent": "logout button", "path": "logout"})
    assert read.text.splitlines() == [
        "Folders of Fix the logout button:",
        "logout: about 3 GB, 3 entries.",
        "- node_modules/: 900 MB, 12000 files, rebuildable",
        "- app/: about 2 GB, 30 files, git on main, 2 changed files, 1 ahead",
        "- notes.md: 2 KB",
    ]
    missing = await tools.call("resource_usage", {"agent": "logout button", "path": "Nowhere/x"})
    assert missing.text == "No root of that agent is called that; its roots: logout and Workspace."


async def test_clean_asks_first_and_removes_exactly_the_planned_folders(
    tools: EaTools, fake: SettingsFake
) -> None:
    asked, done = await confirm(tools, "run_archive_sweep", {"clean_agent": "logout button"})
    assert "removes 2 rebuildable folders of Fix the logout button, freeing about 900 MB" in asked.text
    assert done.text == (
        "Cleaned 1 rebuildable folder of Fix the logout button, freeing 900 MB. Kept 1 folder: "
        "/home/u/work/logout/app/dist because process 7 works in it."
    )
    posts = [w for w in writes(fake) if w[0] == "POST"]
    assert posts == [
        (
            "POST",
            f"/api/storage/agents/{TASK_LOGOUT}/clean",
            {"dirs": [t["dir"] for t in CLEAN_TARGETS], "confirm": True},
        )
    ]


async def test_clean_reports_a_refused_or_empty_plan(tools: EaTools, fake: SettingsFake) -> None:
    fake.clean_plan = {
        **CLEAN_PLAN,
        "refused": 'Agent "Fix the logout button" is running; Clean waits until it stops',
    }
    refused = await tools.call("run_archive_sweep", {"clean_agent": "logout button"})
    assert (
        refused.text == 'Not cleaned: Agent "Fix the logout button" is running; Clean waits until it stops.'
    )
    fake.clean_plan = {**CLEAN_PLAN, "targets": [], "bytes": 0}
    empty = await tools.call("run_archive_sweep", {"clean_agent": "logout button"})
    assert empty.text == "Fix the logout button has no rebuildable folder to clean."
    assert not [w for w in writes(fake) if w[0] == "POST"]
