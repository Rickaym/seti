"""What agents' folders take on disk, and Clean, which removes one agent's rebuildable folders."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any
from urllib.parse import quote

from seti_ea.format import ago, and_list, plural, size_words
from seti_ea.gate import Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, arg_bool, arg_str, dicts, title_of

SHOWN = 5
TREE_SHOWN = 20
REFUSALS = (400, 403, 404, 409)

STORAGE_ARGS: dict[str, Any] = {
    "storage": {
        "type": "boolean",
        "description": "true for the disk Seti's folders take instead: each agent's size and what Clean "
        "would free, the orphan folders no agent owns, free disk space and the automatic clean.",
    },
    "agent": {
        "type": "string",
        "description": "An agent's title as the user said it, to read its folders as a tree with sizes.",
    },
    "path": {
        "type": "string",
        "description": "With agent: one folder of its tree as Root label/sub/folder, such as "
        "Workspace/notes; leave out for the top of every root.",
    },
}

CLEAN_ARG: dict[str, Any] = {
    "clean_agent": {
        "type": "string",
        "description": "An agent's title: instead of archiving, remove that agent's rebuildable folders "
        "(dependencies, build output, caches) to free disk. Never source or what git tracks.",
    },
}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def size_phrase(size: Any) -> str:
    """A measured size, about when the walk was capped; or that it is not measured yet."""
    if not isinstance(size, dict):
        return "not measured yet"
    words = size_words(size.get("bytes"))
    return f"about {words}" if size.get("capped") else words


def _git_words(git: Any) -> str:
    if not isinstance(git, dict):
        return ""
    branch = git.get("branch") or "a detached HEAD"
    dirty = int(git.get("dirty") or 0)
    parts = [f"git on {branch}"]
    if dirty:
        parts.append(f"{plural(dirty, 'changed file')}")
    if git.get("ahead"):
        parts.append(f"{git.get('ahead')} ahead")
    if git.get("behind"):
        parts.append(f"{git.get('behind')} behind")
    return ", " + ", ".join(parts)


def entry_line(entry: Mapping[str, Any]) -> str:
    """One tree entry: a folder with its size, files, rebuildable mark and git badge; a file's size."""
    if entry.get("type") != "dir":
        return f"- {entry.get('name')}: {size_phrase(entry.get('size'))}"
    size = entry.get("size")
    files = f", {plural(int(size.get('files') or 0), 'file')}" if isinstance(size, dict) else ""
    rebuildable = ", rebuildable" if entry.get("rebuildable") else ""
    return f"- {entry.get('name')}/: {size_phrase(size)}{files}{rebuildable}{_git_words(entry.get('git'))}"


class StorageTools:
    """Reads of the Storage page and an agent's tree, and Clean on one agent after the user's yes."""

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

    async def usage(self, args: Mapping[str, Any]) -> ToolResult | None:
        """The storage overview or one agent's tree when args ask for one; else None."""
        if arg_str(args, "agent", required=False):
            return await self._tree(args)
        if arg_bool(args, "storage"):
            return await self._overview()
        return None

    async def _overview(self) -> ToolResult:
        data = _dict(await self._seti.get("/storage"))
        lines = [
            f"Agents' folders and orphans take {size_words(data.get('total_bytes'))}; Clean could free "
            f"{size_words(data.get('rebuildable_bytes'))} of rebuildable folders."
        ]
        disk = data.get("disk")
        if isinstance(disk, dict):
            lines.append(
                f"The disk holding {disk.get('path')} has {size_words(disk.get('free_bytes'))} free of "
                f"{size_words(disk.get('total_bytes'))}."
            )
        lines.append(self._agents_line(dicts(data.get("agents"))))
        lines.append(self._orphans_line(dicts(data.get("orphans"))))
        lines.append(self._schedule_line(_dict(data.get("schedule"))))
        if data.get("measuring"):
            lines.append("Some sizes are still being measured; ask again shortly for the rest.")
        return ToolResult("\n".join(lines), "Read storage")

    def _agents_line(self, agents: list[dict[str, Any]]) -> str:
        if not agents:
            return "No agent has folders on disk."
        named = []
        for agent in agents[:SHOWN]:
            rebuildable = agent.get("rebuildable_bytes")
            free = f", {size_words(rebuildable)} rebuildable" if isinstance(rebuildable, int) else ""
            named.append(
                f"{title_of(agent)} {size_phrase(agent.get('size'))}{free} ({agent.get('state')}, "
                f"last active {ago(agent.get('last_activity'), self._now())})"
            )
        more = f"; and {len(agents) - SHOWN} smaller" if len(agents) > SHOWN else ""
        return f"Largest agents: {'; '.join(named)}{more}."

    @staticmethod
    def _orphans_line(orphans: list[dict[str, Any]]) -> str:
        if not orphans:
            return "No orphan folders: every folder in Seti's roots belongs to an agent."
        total = sum(int(_dict(o.get("size")).get("bytes") or 0) for o in orphans)
        kept = [o for o in orphans if o.get("kept")]
        text = f"{plural(len(orphans), 'orphan folder')} no agent owns, {size_words(total)} in all."
        if kept:
            first = kept[0]
            text += (
                f" {plural(len(kept), 'of them stays', 'of them stay')} when orphans are removed, such as "
                f"{first.get('path')} because {first.get('kept')}."
            )
        return f"{text} Only the user removes orphans, in Settings, Storage."

    @staticmethod
    def _schedule_line(schedule: Mapping[str, Any]) -> str:
        if not schedule.get("enabled"):
            return "The automatic clean is off; only the user turns it on."
        days = plural(int(schedule.get("idle_days") or 0), "day")
        text = f"The automatic clean is on, for agents idle {days} or more"
        if schedule.get("last_run_at"):
            text += f"; its last run freed {size_words(schedule.get('last_freed_bytes'))}"
        return f"{text}."

    async def _root_of(self, base: str, ref: str) -> tuple[dict[str, Any], str] | None:
        """The root a Label/path ref names and the path inside it; None for every root's top."""
        if not ref:
            return None
        roots = dicts(await self._seti.get(f"{base}/roots"))
        for root in sorted(roots, key=lambda r: -len(str(r.get("label")))):
            label = str(root.get("label"))
            if ref == label or ref.startswith(f"{label}/"):
                return root, ref.removeprefix(label).strip("/")
        names = and_list([str(r.get("label")) for r in roots if r.get("exists")])
        raise ToolError(f"No root of that agent is called that; its roots: {names}.", "No such folder")

    async def _listing(self, base: str, root: Mapping[str, Any], path: str) -> list[str]:
        try:
            data = _dict(await self._seti.get(f"{base}/tree", {"root": str(root.get("id")), "path": path}))
        except SetiError as e:
            if e.status in REFUSALS:
                raise ToolError(f"Seti did not open it: {e.detail or e.title}", "Not read") from e
            raise
        where = f"{root.get('label')}/{path}".rstrip("/")
        entries = dicts(data.get("entries"))
        lines = [f"{where}: {size_phrase(data.get('size'))}, {plural(len(entries), 'entry', 'entries')}."]
        lines.extend(entry_line(entry) for entry in entries[:TREE_SHOWN])
        if len(entries) > TREE_SHOWN:
            lines.append(f"And {len(entries) - TREE_SHOWN} more not listed.")
        if data.get("measuring"):
            lines.append("Some sizes are still being measured; ask again shortly.")
        return lines

    async def _tree(self, args: Mapping[str, Any]) -> ToolResult:
        task = await self._resolve_task(arg_str(args, "agent"))
        base = f"/tasks/{quote(str(task.get('id')), safe='')}/files"
        chosen = await self._root_of(base, arg_str(args, "path", required=False).strip("/"))
        lines = [f"Folders of {title_of(task)}:"]
        if chosen is None:
            for root in dicts(await self._seti.get(f"{base}/roots")):
                if root.get("exists"):
                    lines.extend(await self._listing(base, root, ""))
        else:
            lines.extend(await self._listing(base, chosen[0], chosen[1]))
        return ToolResult("\n".join(lines), f"Read the folders of {title_of(task)}"[:70])

    async def clean(self, args: Mapping[str, Any]) -> ToolResult:
        """Removes one agent's rebuildable folders, as the plan names them, after the user's yes."""
        task = await self._resolve_task(arg_str(args, "clean_agent"))
        path = f"/storage/agents/{quote(str(task.get('id')), safe='')}/clean"
        plan = _dict(await self._seti.get(path))
        if plan.get("refused"):
            raise ToolError(f"Not cleaned: {plan.get('refused')}.", "Not cleaned")
        targets = dicts(plan.get("targets"))
        if not targets:
            raise ToolError(f"{title_of(task)} has no rebuildable folder to clean.", "Nothing to clean")
        dirs = [str(t.get("dir")) for t in targets]
        if not await self._gate.cleared(
            gate_key("run_archive_sweep", {"clean_agent": task.get("id"), "dirs": dirs}),
            arg_bool(args, "confirmed"),
        ):
            return ask(
                "run_archive_sweep", args, self._effect(task, plan, targets), "clean rebuildable folders"
            )
        try:
            result = _dict(await self._seti.post(path, {"dirs": dirs, "confirm": True}))
        except SetiError as e:
            if e.status in REFUSALS:
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Not cleaned") from e
            raise
        removed = dicts(result.get("removed"))
        refused = dicts(result.get("refused"))
        text = (
            f"Cleaned {plural(len(removed), 'rebuildable folder')} of {title_of(task)}, freeing "
            f"{size_words(result.get('freed_bytes'))}."
        )
        if refused:
            first = refused[0]
            text += (
                f" Kept {plural(len(refused), 'folder')}: {first.get('path')} because {first.get('reason')}."
            )
        return ToolResult(text, f"Cleaned {title_of(task)}"[:70])

    @staticmethod
    def _effect(task: Mapping[str, Any], plan: Mapping[str, Any], targets: list[dict[str, Any]]) -> str:
        names = [str(t.get("path")) for t in targets[:SHOWN]]
        more = f" and {len(targets) - SHOWN} more" if len(targets) > SHOWN else ""
        measuring = (
            " Some sizes are still being measured, so it may free more." if plan.get("measuring") else ""
        )
        return (
            f"This removes {plural(len(targets), 'rebuildable folder')} of {title_of(task)}, freeing about "
            f"{size_words(plan.get('bytes'))}: {and_list(names)}{more}. They hold dependencies, build "
            "output and caches that a reinstall or build makes again; source and anything git tracks "
            f"stay.{measuring}"
        )
