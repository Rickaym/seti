"""The tool that sets an agent's role: the one role pack Seti adds to its system prompt."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import and_list, clip
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
TaskResolver = Callable[[str], Awaitable[dict[str, Any]]]

NAME_MAX = 80

ROLE_SPECS: list[ToolSpec] = [
    ToolSpec(
        "set_agent_role",
        "Give an agent a role, replacing the one it has, or remove it. A role is a context pack of "
        "kind role, in its system prompt right after the Seti guide from its next turn: the built-in "
        "Lead, Reviewer and Watcher, or the user's own. Pass role to pick one by name, or text to "
        "create a new role pack and give it to the agent. get_task shows the current role. Only "
        "when the user asks. Needs the user's yes.",
        {
            "task": TASK_REF,
            "role": {"type": "string", "description": "The role pack's name as the user said it."},
            "text": {
                "type": "string",
                "description": "The whole text of a new role pack; its first line sums it up.",
            },
            "name": {
                "type": "string",
                "description": 'The new role pack\'s name with text; "<task title> role" when left out.',
            },
            "clear": {"type": "boolean", "description": "true to leave the agent without a role."},
            "confirmed": CONFIRMED,
        },
        ["task"],
    ),
]


async def role_of(seti: SetiClient, task: Mapping[str, Any]) -> dict[str, Any] | None:
    """The role pack linked to the agent, as the task's pack list names it."""
    linked = dicts(await seti.get(f"/tasks/{task.get('id')}/context-packs"))
    return next((p for p in linked if p.get("kind") == "role"), None)


async def role_lines(seti: SetiClient, task: Mapping[str, Any]) -> list[str]:
    """The agent's role, for get_task."""
    role = await role_of(seti, task)
    if role is None:
        return ["No role."]
    return [f"Role: the role pack {name_of(role)}, in its system prompt; get_context_pack reads it."]


def _refused(e: SetiError) -> ToolError:
    return ToolError(
        f"Seti did not change the role: {e.detail or e.title}",
        clip(f"Not done: {e.detail or e.title}", 70),
    )


class RoleTools:
    """The EA's tool for an agent's role pack, through the routes the UI calls."""

    def __init__(self, seti: SetiClient, resolve_task: TaskResolver, confirmations: Confirmations) -> None:
        self._seti = seti
        self._resolve = resolve_task
        self._gate = confirmations
        self.handlers: dict[str, Handler] = {"set_agent_role": self.set_agent_role}

    async def _role_pack(self, ref: str) -> dict[str, Any]:
        roles = [p for p in dicts(await self._seti.get("/context/packs")) if p.get("kind") == "role"]
        hint = f"The roles are {and_list([name_of(p) for p in roles])}." if roles else "There are no roles."
        found = pick(roles, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: [])
        return only(found, ref, "role pack", name_of, f"{hint} Pass text to create a new one.")

    async def _link(self, task: Mapping[str, Any], pack_id: Any) -> None:
        try:
            await self._seti.put(f"/tasks/{task.get('id')}/role", {"pack_id": pack_id})
        except SetiError as e:
            if e.status in (400, 404):
                raise _refused(e) from e
            raise

    async def set_agent_role(self, args: Mapping[str, Any]) -> ToolResult:
        ref = arg_str(args, "task")
        clear = arg_bool(args, "clear")
        role = arg_str(args, "role", required=False)
        text = arg_str(args, "text", required=False)
        if sum([clear, bool(role), bool(text)]) != 1:
            raise ToolError(
                "Pass exactly one of role (a role pack's name), text (a new role) or clear true.",
                "Unclear role",
            )
        task = await self._resolve(ref)
        title = title_of(task)
        current = await role_of(self._seti, task)
        if clear:
            return await self._clear(args, task, title, current)
        if text:
            return await self._create(args, task, title, text)
        pack = await self._role_pack(role)
        if current is not None and current.get("id") == pack.get("id"):
            return ToolResult(
                f"{title} already has the role {name_of(pack)}.", clip(f"{title} unchanged", 70)
            )
        if not await self._gate.cleared(
            gate_key("set_agent_role", task.get("id"), pack.get("id")), arg_bool(args, "confirmed")
        ):
            instead = f" in place of {name_of(current)}" if current is not None else ""
            effect = f"This gives {title} the role {name_of(pack)}{instead} from its next turn."
            return ask("set_agent_role", args, effect, f"give {title} the role {name_of(pack)}")
        await self._link(task, pack.get("id"))
        done = f"Gave {title} the role {name_of(pack)}"
        return ToolResult(f"{done}; it applies from its next turn.", clip(done, 70))

    async def _clear(
        self, args: Mapping[str, Any], task: Mapping[str, Any], title: str, current: Mapping[str, Any] | None
    ) -> ToolResult:
        if current is None:
            return ToolResult(f"{title} has no role.", clip(f"{title} unchanged", 70))
        if not await self._gate.cleared(
            gate_key("set_agent_role", task.get("id"), None), arg_bool(args, "confirmed")
        ):
            effect = (
                f"This removes the role {name_of(current)} from {title} from its next turn; the pack stays."
            )
            return ask("set_agent_role", args, effect, f"remove the role of {title}")
        await self._link(task, None)
        done = f"Removed the role of {title}"
        return ToolResult(f"{done}; it applies from its next turn.", clip(done, 70))

    async def _create(
        self, args: Mapping[str, Any], task: Mapping[str, Any], title: str, text: str
    ) -> ToolResult:
        name = (arg_str(args, "name", required=False) or f"{title} role")[:NAME_MAX]
        if not await self._gate.cleared(
            gate_key("set_agent_role", task.get("id"), name, text), arg_bool(args, "confirmed")
        ):
            effect = (
                f"This creates the role pack {name} and gives it to {title} from its next turn: "
                f'"{clip(text, 300)}"'
            )
            return ask("set_agent_role", args, effect, f"create the role {name} for {title}")
        try:
            pack = await self._seti.post(
                "/context/packs", {"name": name, "description": "", "body": text, "kind": "role"}
            )
        except SetiError as e:
            if e.status in (400, 409):
                raise _refused(e) from e
            raise
        await self._link(task, pack.get("id") if isinstance(pack, dict) else None)
        done = f"Created the role {name} and gave it to {title}"
        return ToolResult(f"{done}; it applies from its next turn.", clip(done, 70))
