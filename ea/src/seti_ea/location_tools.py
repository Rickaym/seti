"""Tools that change where an agent works: its repos, its directories and its working directory."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import clip, repo_name
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
    pick,
    resolve_repo,
    title_of,
)

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]
TaskResolver = Callable[[str], Awaitable[dict[str, Any]]]

PLACE_REF = {
    "type": "string",
    "description": "One of the agent's repos by name, or one of its directories by path.",
}
NEXT_TURN = "from its next turn"

LOCATION_SPECS: list[ToolSpec] = [
    ToolSpec(
        "add_agent_repo",
        "Let an agent read and edit a registered repo besides where it works, from its next turn: the "
        "checkout itself, or a fresh worktree of its own. Needs the user's yes.",
        {
            "task": TASK_REF,
            "repo": {"type": "string", "description": "The registered repo's name or owner/name slug."},
            "worktree": {
                "type": "boolean",
                "description": "Give the agent its own git worktree instead of the shared checkout.",
            },
            "ref": {"type": "string", "description": "Worktree only: the branch to start from."},
            "confirmed": CONFIRMED,
        },
        ["task", "repo"],
    ),
    ToolSpec(
        "add_agent_directory",
        "Let an agent read and edit an existing directory that is not a registered repo, from its next "
        "turn. Not the home directory, a dot folder or Seti's own data. Needs the user's yes.",
        {
            "task": TASK_REF,
            "path": {"type": "string", "description": "An absolute path, or one starting with ~/."},
            "confirmed": CONFIRMED,
        },
        ["task", "path"],
    ),
    ToolSpec(
        "remove_from_agent",
        "Take a repo or directory off an agent from its next turn. Nothing on disk is deleted; not "
        "possible for its working directory. Needs the user's yes.",
        {"task": TASK_REF, "what": PLACE_REF, "confirmed": CONFIRMED},
        ["task", "what"],
    ),
    ToolSpec(
        "set_agent_working_directory",
        "Make one of an agent's repos or directories its working directory, such as a repo added to an "
        "agent that started without one. The old one stays attached and the conversation carries on "
        "at the next turn. Needs the user's yes.",
        {"task": TASK_REF, "where": PLACE_REF, "confirmed": CONFIRMED},
        ["task", "where"],
    ),
]


def places_of(task: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The agent's repos and plain directories, each with the directory it has."""
    repos = [
        {"repo_id": r.get("id"), "name": repo_name(str(r.get("slug", ""))), "dir": str(r.get("dir", ""))}
        for r in dicts(task.get("repos"))
    ]
    plain = [{"repo_id": None, "name": str(d), "dir": str(d)} for d in task.get("dirs") or []]
    return [*repos, *plain]


def location_lines(task: Mapping[str, Any]) -> list[str]:
    """Where the agent works and what else it can edit, for get_task."""
    cwd = str(task.get("cwd", ""))
    lines = [f"Working directory: {cwd}."]
    extra = []
    for place in places_of(task):
        if place["dir"] == cwd:
            continue
        worktree = any(r.get("dir") == place["dir"] and r.get("worktree") for r in dicts(task.get("repos")))
        where = place["dir"] if place["repo_id"] is None else f"{place['name']} at {place['dir']}"
        extra.append(f"{where}{' (worktree)' if worktree else ''}")
    if extra:
        lines.append(f"It can also edit {', '.join(extra)}.")
    return lines


def _find_place(task: Mapping[str, Any], ref: str) -> dict[str, Any]:
    places = places_of(task)
    key = ref.strip().rstrip("/") or ref.strip()
    by_dir = [p for p in places if p["dir"] == key]
    found = by_dir or pick(
        places, ref, lambda p: str(p["repo_id"] or ""), lambda p: p["name"], lambda p: [p["dir"]]
    )
    title = title_of(task)
    if not found:
        known = ", ".join(p["name"] for p in places) or "nothing besides its working directory"
        raise ToolError(f'{title} has no repo or directory matching "{ref}". It has {known}.', "Not found")
    if len(found) > 1:
        names = ", ".join(p["name"] for p in found)
        raise ToolError(f'"{ref}" matches several: {names}. Ask the user which one.', "Ambiguous")
    return found[0]


def _refused(e: SetiError, what: str) -> ToolError:
    return ToolError(
        f"Seti did not {what}: {e.detail or e.title}", clip(f"Not done: {e.detail or e.title}", 70)
    )


class LocationTools:
    """The EA's tools for an agent's repos and directories, through the routes the UI calls."""

    def __init__(self, seti: SetiClient, resolve_task: TaskResolver, confirmations: Confirmations) -> None:
        self._seti = seti
        self._resolve = resolve_task
        self._gate = confirmations
        self.handlers: dict[str, Handler] = {
            "add_agent_repo": self.add_agent_repo,
            "add_agent_directory": self.add_agent_directory,
            "remove_from_agent": self.remove_from_agent,
            "set_agent_working_directory": self.set_agent_working_directory,
        }

    async def _cleared(self, args: Mapping[str, Any], key: str) -> bool:
        return await self._gate.cleared(key, arg_bool(args, "confirmed"))

    async def _call(self, what: str, run: Callable[[], Awaitable[Any]]) -> None:
        try:
            await run()
        except SetiError as e:
            if e.status in (400, 404, 409):
                raise _refused(e, what) from e
            raise

    async def add_agent_repo(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        repo = resolve_repo(dicts(await self._seti.get("/repos")), arg_str(args, "repo"))
        name = repo_name(str(repo.get("slug")))
        worktree = arg_bool(args, "worktree")
        ref = arg_str(args, "ref", required=False) if worktree else ""
        body: dict[str, Any] = {
            "repo_id": repo.get("id"),
            "worktree": worktree,
            **({"ref": ref} if ref else {}),
        }
        how = (
            f"a fresh worktree of {name}" + (f" from {ref}" if ref else "")
            if worktree
            else f"the checkout {repo.get('path')}"
        )
        if not await self._cleared(args, gate_key("add_agent_repo", task.get("id"), body)):
            effect = f"This lets {title} read and edit {how} {NEXT_TURN}."
            return ask("add_agent_repo", args, effect, f"add {name} to {title}")
        await self._call("add it", lambda: self._seti.post(f"/tasks/{task.get('id')}/repos", body))
        return ToolResult(
            f"Added {name} to {title} as {how}; it applies {NEXT_TURN}.", clip(f"Added {name} to {title}", 70)
        )

    async def add_agent_directory(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        path = arg_str(args, "path")
        if not await self._cleared(args, gate_key("add_agent_directory", task.get("id"), path)):
            effect = f"This lets {title} read and edit the directory {path} {NEXT_TURN}."
            return ask("add_agent_directory", args, effect, f"add {path} to {title}")
        await self._call("add it", lambda: self._seti.post(f"/tasks/{task.get('id')}/dirs", {"path": path}))
        return ToolResult(
            f"Added the directory {path} to {title}; it applies {NEXT_TURN}.",
            clip(f"Added {path} to {title}", 70),
        )

    async def remove_from_agent(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        place = _find_place(task, arg_str(args, "what"))
        if place["dir"] == task.get("cwd"):
            raise ToolError(
                f"{place['name']} is where {title} works. Make another of its repos or directories its "
                "working directory first.",
                "That is its working directory",
            )
        if not await self._cleared(args, gate_key("remove_from_agent", task.get("id"), place["dir"])):
            effect = f"This takes {place['name']} off {title} {NEXT_TURN}. Nothing on disk is deleted."
            return ask("remove_from_agent", args, effect, f"remove {place['name']} from {title}")
        task_path = f"/tasks/{task.get('id')}"
        if place["repo_id"] is None:
            await self._call(
                "remove it", lambda: self._seti.delete(f"{task_path}/dirs", {"path": place["dir"]})
            )
        else:
            await self._call("remove it", lambda: self._seti.delete(f"{task_path}/repos/{place['repo_id']}"))
        return ToolResult(
            f"Took {place['name']} off {title}; its files stay.",
            clip(f"Removed {place['name']} from {title}", 70),
        )

    async def set_agent_working_directory(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve(arg_str(args, "task"))
        title = title_of(task)
        place = _find_place(task, arg_str(args, "where"))
        if place["dir"] == task.get("cwd"):
            return ToolResult(f"{title} already works in {place['dir']}.", "Already there")
        if not await self._cleared(
            args, gate_key("set_agent_working_directory", task.get("id"), place["dir"])
        ):
            effect = (
                f"This moves {title} to work in {place['dir']} from its next turn; it keeps its "
                f"conversation, and {task.get('cwd')} stays attached."
            )
            return ask("set_agent_working_directory", args, effect, f"move {title} to {place['name']}")
        await self._call(
            "move it", lambda: self._seti.patch(f"/tasks/{task.get('id')}", {"cwd": place["dir"]})
        )
        return ToolResult(
            f"{title} works in {place['dir']} from its next turn and keeps its conversation.",
            clip(f"Moved {title} to {place['name']}", 70),
        )
