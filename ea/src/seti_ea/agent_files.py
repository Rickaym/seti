"""Reading one of an agent's files whole, through its Files view and the EA's read rules there."""

from collections.abc import Mapping
from typing import Any

from seti_ea.format import clip
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, dicts, title_of

FILE_READ_CHARS = 30_000
WORKSPACE_VAR = "$SETI_WORKSPACE/"
REFUSALS = (400, 403, 404, 409, 413, 415)


async def _locate(seti: SetiClient, task: Mapping[str, Any], ref: str) -> tuple[str, str, str]:
    """The Files base, root id and path ref names: Label/path from a search, else what Seti resolves."""
    base = f"/tasks/{task.get('id')}/files"
    if ref.startswith(WORKSPACE_VAR):
        return base, "workspace", ref.removeprefix(WORKSPACE_VAR)
    for root in dicts(await seti.get(f"{base}/roots")):
        label = f"{root.get('label')}/"
        if ref.startswith(label):
            return base, str(root.get("id")), ref.removeprefix(label)
    found = dicts(await seti.get(f"{base}/resolve", {"p": ref}))
    if not found:
        raise ToolError(f"{title_of(task)} has no file at {ref} that you may read.", "No such file")
    hit = found[0]
    if hit.get("type") == "dir":
        raise ToolError(f"{ref} is a folder; search its file names and read one file.", "A folder")
    owner = hit.get("task_id")
    where = base if owner is None else f"/tasks/{owner}/files"
    return where, str(hit.get("root")), str(hit.get("path"))


async def read_agent_file(seti: SetiClient, task: Mapping[str, Any], raw: str) -> ToolResult:
    """The text of one file an agent named or sent, whole up to FILE_READ_CHARS characters."""
    ref = raw.strip().strip("`").strip()
    if not ref:
        raise ToolError("Name the file to read in query.", "No file named")
    try:
        base, root, path = await _locate(seti, task, ref)
        data = await seti.get(f"{base}/text", {"root": root, "path": path})
    except SetiError as e:
        if e.status in REFUSALS:
            raise ToolError(f"Seti did not open {ref}: {e.detail or e.title}", "Not read") from e
        raise
    text = str(data.get("text", "")) if isinstance(data, dict) else ""
    name = path.rsplit("/", 1)[-1]
    if len(text) <= FILE_READ_CHARS:
        head = f"{path} of {title_of(task)}, all {len(text):,} characters, exactly as written:"
        return ToolResult(f"{head}\n{text}", clip(f"Read {name}", 70))
    head = (
        f"{path} of {title_of(task)} is clipped: the first {FILE_READ_CHARS:,} of {len(text):,} "
        "characters follow, and the rest is cut off. Do not use it as the whole file; ask the agent "
        "to split it into smaller files."
    )
    return ToolResult(f"{head}\n{text[:FILE_READ_CHARS]}", clip(f"Read part of {name}", 70))
