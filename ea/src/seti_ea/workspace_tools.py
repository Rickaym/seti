"""Tools for workspaces: named groups of agents, each with its own pinned and other agents."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import clip, plural
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import (
    TASK_REF,
    ToolError,
    ToolResult,
    ToolSpec,
    arg_bool,
    arg_str,
    dicts,
    name_of,
    only,
    pick,
    title_of,
)

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]
TaskMatcher = Callable[[str], Awaitable[list[dict[str, Any]]]]

WORKSPACE_REF = {"type": "string", "description": "The workspace's name as the user said it, or its id."}
CHANGES = ("create", "rename", "delete")

LIST_WORKSPACES_SPEC = ToolSpec(
    "list_workspaces",
    "List the workspaces, the named groups every agent belongs to, in order, with how many active "
    "agents each holds and how many of those need the user. The first takes new agents by default.",
)

WORKSPACE_SPECS: list[ToolSpec] = [
    ToolSpec(
        "change_workspace",
        "Create, rename or delete a workspace: a named group of agents with its own pinned and other "
        "agents. Names are unique whatever their case. Seti refuses to delete a workspace that holds "
        "agents, archived ones included, and keeps the last one. Needs the user's yes.",
        {
            "action": {"type": "string", "enum": list(CHANGES), "description": "What to do."},
            "workspace": {
                **WORKSPACE_REF,
                "description": "With rename or delete: the workspace's name or id.",
            },
            "name": {
                "type": "string",
                "description": "With create or rename: the new name, at most 60 characters.",
            },
            "confirmed": CONFIRMED,
        },
        ["action"],
    ),
    ToolSpec(
        "move_agent_to_workspace",
        "Move an agent, archived or not, to another workspace. It keeps its pin, transcript and work.",
        {"task": TASK_REF, "workspace": WORKSPACE_REF},
        ["task", "workspace"],
    ),
]


async def workspace_list(seti: SetiClient) -> list[dict[str, Any]]:
    return dicts(await seti.get("/workspaces"))


async def workspace_names(seti: SetiClient) -> dict[str, str]:
    """Workspace names by id, for saying where agents are; empty when Seti cannot list them."""
    try:
        return {str(w.get("id")): name_of(w) for w in await workspace_list(seti)}
    except SetiError:
        return {}


def resolve_workspace(workspaces: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    """The one workspace ref names by name or id."""
    found = pick(workspaces, ref, lambda w: str(w.get("id", "")), name_of, lambda _w: [])
    return only(found, ref, "workspace", name_of, "Call list_workspaces to see them.")


class WorkspaceTools:
    """The EA's workspace tools, through the routes the agent list's workspace menu uses."""

    def __init__(self, seti: SetiClient, match_tasks: TaskMatcher, confirmations: Confirmations) -> None:
        self._seti = seti
        self._match_tasks = match_tasks
        self._gate = confirmations
        self.handlers: dict[str, Handler] = {
            "list_workspaces": self.list_workspaces,
            "change_workspace": self.change_workspace,
            "move_agent_to_workspace": self.move_agent_to_workspace,
        }

    async def _workspace(self, args: Mapping[str, Any]) -> dict[str, Any]:
        return resolve_workspace(await workspace_list(self._seti), arg_str(args, "workspace"))

    async def list_workspaces(self, args: Mapping[str, Any]) -> ToolResult:
        workspaces = await workspace_list(self._seti)
        lines = [f"{plural(len(workspaces), 'workspace')}, the first takes new agents:"]
        for w in workspaces:
            waiting = w.get("needs_you")
            need = f", {waiting} need you" if isinstance(waiting, int) and waiting > 0 else ""
            lines.append(f"- {name_of(w)}: {plural(int(w.get('agents') or 0), 'agent')}{need}")
        return ToolResult("\n".join(lines), f"Listed {plural(len(workspaces), 'workspace')}")

    async def _plan(self, args: Mapping[str, Any]) -> tuple[str, dict[str, Any], str, str]:
        """The change asked for: its action, the workspace it touches, the new name, and in words."""
        action = arg_str(args, "action")
        if action not in CHANGES:
            raise ToolError(f"Unknown action {action}. Use one of {', '.join(CHANGES)}.", "Bad action")
        if action == "create":
            name = arg_str(args, "name")
            return action, {}, name, f'This creates the workspace "{name}".'
        workspace = await self._workspace(args)
        old = name_of(workspace)
        if action == "delete":
            return (
                action,
                workspace,
                "",
                f'This deletes the workspace "{old}". Seti refuses while it holds agents.',
            )
        name = arg_str(args, "name")
        if name == old:
            raise ToolError(f'The workspace is already called "{old}".', clip(f"{old} kept its name", 70))
        return action, workspace, name, f'This renames the workspace "{old}" to "{name}".'

    async def change_workspace(self, args: Mapping[str, Any]) -> ToolResult:
        action, workspace, name, effect = await self._plan(args)
        key = gate_key("change_workspace", action, workspace.get("id"), name)
        if not await self._gate.cleared(key, arg_bool(args, "confirmed")):
            return ask("change_workspace", args, effect, f"{action} workspace {name or name_of(workspace)}")
        path = f"/workspaces/{workspace.get('id')}"
        try:
            if action == "create":
                await self._seti.post("/workspaces", {"name": name})
            elif action == "rename":
                await self._seti.patch(path, {"name": name})
            else:
                await self._seti.delete(path)
        except SetiError as e:
            if e.status in (400, 404, 409):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Not changed") from e
            raise
        done = {
            "create": f'Created the workspace "{name}".',
            "rename": f'Renamed the workspace "{name_of(workspace)}" to "{name}".',
            "delete": f'Deleted the workspace "{name_of(workspace)}".',
        }[action]
        return ToolResult(done, clip(done.rstrip("."), 70))

    async def _any_task(self, ref: str) -> dict[str, Any]:
        found = await self._match_tasks(ref)
        if not found:
            archived = dicts(await self._seti.get("/tasks/archived"))
            found = pick(archived, ref, lambda t: str(t.get("id", "")), title_of, lambda _t: [])
        return only(found, ref, "task", title_of, "Call list_tasks to see the task titles.")

    async def move_agent_to_workspace(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._any_task(arg_str(args, "task"))
        workspace = await self._workspace(args)
        title = title_of(task)
        name = name_of(workspace)
        if task.get("workspace_id") == workspace.get("id"):
            return ToolResult(f'"{title}" is already in {name}.', clip(f"{title} already in {name}", 70))
        await self._seti.patch(f"/tasks/{task.get('id')}", {"workspace_id": workspace.get("id")})
        return ToolResult(f'Moved "{title}" to the workspace {name}.', clip(f"Moved {title} to {name}", 70))
