"""The tool that hands files from one agent to another, through the route agents' send_file uses."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import and_list, clip, plural
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import TASK_REF, ToolError, ToolResult, ToolSpec, arg_list, arg_str, dicts, title_of

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]
TaskResolver = Callable[[str], Awaitable[dict[str, Any]]]

FILES_MAX = 10

SEND_FILE_SPEC = ToolSpec(
    "send_file",
    "Hand files from one agent to another. Seti copies them into the receiving agent's workspace at "
    "inbox/<sender handle>/ and posts one group chat message from the sending agent that mentions the "
    "receiver with each file's path, which wakes it. Seti takes only files the sending agent can reach "
    f"itself, never secrets, at most {FILES_MAX} files of 50 MB each. Use it instead of pasting a "
    "file's contents into the chat.",
    {
        "from_task": {**TASK_REF, "description": "The agent the files come from: its id or title."},
        "to": {"type": "string", "description": "The receiving agent's @handle, id or title."},
        "paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": "The files as the sending agent names them: absolute, or relative to its "
            "working directory.",
        },
        "note": {"type": "string", "description": "What the files are for, in a sentence."},
    },
    ["from_task", "to", "paths"],
)


class HandoffTools:
    """The EA's file handoff, held to the sending agent's own folders by the server."""

    def __init__(self, seti: SetiClient, resolve_task: TaskResolver) -> None:
        self._seti = seti
        self._resolve_task = resolve_task
        self.handlers: dict[str, Handler] = {"send_file": self.send_file}

    async def _handle(self, ref: str) -> str:
        """The group chat handle ref names: a handle as it is, else the handle of the agent it names."""
        members = dicts(await self._seti.get("/team/members"))
        wanted = ref.strip().lstrip("@").lower()
        if any(m.get("handle") == wanted for m in members):
            return wanted
        task = await self._resolve_task(ref)
        member = next((m for m in members if m.get("task_id") == task.get("id")), None)
        if member is None:
            raise ToolError(f'"{title_of(task)}" has no group chat handle.', "No handle")
        return str(member.get("handle"))

    async def send_file(self, args: Mapping[str, Any]) -> ToolResult:
        sender = await self._resolve_task(arg_str(args, "from_task"))
        to = await self._handle(arg_str(args, "to"))
        paths = arg_list(args, "paths")
        if not paths:
            raise ToolError("The paths argument is missing.", "Missing paths")
        if len(paths) > FILES_MAX:
            raise ToolError(f"Send at most {FILES_MAX} files at once.", "Too many files")
        body: dict[str, Any] = {"from": sender.get("id"), "to": to, "paths": paths}
        note = arg_str(args, "note", required=False)
        if note:
            body["note"] = note
        try:
            sent = await self._seti.post("/team/files", body)
        except SetiError as e:
            if e.status in (400, 403, 404, 409, 413):
                raise ToolError(f"Seti did not send them: {e.detail or e.title}", "Not sent") from e
            raise
        fields = sent if isinstance(sent, dict) else {}
        files = dicts(fields.get("files"))
        where = and_list([str(f.get("path")) for f in files])
        sender_handle = f"@{fields.get('from')}"
        text = (
            f"Sent {plural(len(files), 'file')} from {sender_handle} to @{to}: {where}. "
            f"The group chat message from {sender_handle} names them."
        )
        summary = clip(f"Sent {plural(len(files), 'file')} to @{to}", 70)
        return ToolResult(text, summary)
