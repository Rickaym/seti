"""Where an agent works, for the EA to read out: its folder and what an older agent was given."""

from collections.abc import Mapping
from typing import Any

from seti_ea.format import repo_name
from seti_ea.toolkit import dicts


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
