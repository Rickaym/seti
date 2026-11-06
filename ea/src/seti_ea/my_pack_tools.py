"""The EA's own context packs: the role and reference packs Seti adds after its base prompt."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import and_list, clip, plural
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_str, dicts, name_of, only, pick

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]

PACK_NAME = {"type": "string", "description": "The context pack's name as the user said it."}

LIST_MY_PACKS_SPEC = ToolSpec(
    "list_my_context_packs",
    "Your own context packs: the role pack and the reference packs the user linked to you, which Seti "
    "adds to your system prompt after your base prompt, and whether their text fits. Your base prompt "
    "is part of Seti's code; nobody changes it here.",
)

CHANGE_MY_PACKS_SPEC = ToolSpec(
    "change_my_context_packs",
    "Change your own context packs when the user asks: link a reference pack to yourself, unlink one, "
    "give yourself a role pack in place of your current one, or remove your role. It applies from your "
    "next turn, and on a call from the user's next words. Your base prompt cannot be changed. Needs "
    "the user's yes.",
    {
        "link": {**PACK_NAME, "description": "A reference pack to add to your prompt."},
        "unlink": {**PACK_NAME, "description": "A reference pack to take out of your prompt."},
        "role": {**PACK_NAME, "description": "A role pack to take in place of your current role."},
        "clear_role": {"type": "boolean", "description": "true to remove your role."},
        "confirmed": CONFIRMED,
    },
    [],
)


def _refused(e: SetiError) -> ToolError:
    return ToolError(
        f"Seti did not change your packs: {e.detail or e.title}", clip(f"Not done: {e.detail or e.title}", 70)
    )


def _pick(packs: list[dict[str, Any]], ref: str, hint: str) -> dict[str, Any]:
    found = pick(packs, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: [])
    return only(found, ref, "context pack", name_of, hint)


class MyPackTools:
    """The EA's tools for its own packs, through the routes the EA page's settings call."""

    def __init__(self, seti: SetiClient, confirmations: Confirmations) -> None:
        self._seti = seti
        self._gate = confirmations
        self.handlers: dict[str, Handler] = {
            "list_my_context_packs": self.list_my_context_packs,
            "change_my_context_packs": self.change_my_context_packs,
        }

    async def _linked(self) -> list[dict[str, Any]]:
        return dicts(await self._seti.get("/ea/context-packs"))

    async def list_my_context_packs(self, args: Mapping[str, Any]) -> ToolResult:
        linked, prompt = await asyncio.gather(self._linked(), self._seti.get("/ea/context-packs/prompt"))
        role = next((p for p in linked if p.get("kind") == "role"), None)
        references = [name_of(p) for p in linked if p.get("kind") != "role"]
        lines = [
            "Your base prompt is part of Seti's code and stays as it is; the user adds to it with packs.",
            f"Role: the role pack {name_of(role)}." if role is not None else "No role.",
            f"Reference packs: {and_list(references)}." if references else "No reference packs.",
        ]
        chars = prompt.get("chars", 0) if isinstance(prompt, dict) else 0
        limit = prompt.get("max_chars", 0) if isinstance(prompt, dict) else 0
        if isinstance(chars, int) and isinstance(limit, int) and chars > limit:
            lines.append(
                f"Their text runs to {chars:,} characters, past the {limit:,} your prompt takes, so the end "
                "is cut; the EA page warns the user."
            )
        if linked:
            lines.append("get_context_pack reads one.")
        summary = f"Listed {plural(len(linked), 'pack')} of yours" if linked else "No packs of yours"
        return ToolResult("\n".join(lines), summary)

    async def change_my_context_packs(self, args: Mapping[str, Any]) -> ToolResult:
        link = arg_str(args, "link", required=False)
        unlink = arg_str(args, "unlink", required=False)
        role = arg_str(args, "role", required=False)
        clear = arg_bool(args, "clear_role")
        if sum([bool(link), bool(unlink), bool(role), clear]) != 1:
            raise ToolError(
                "The change is unclear: pass one of link, unlink or role, each a pack name, "
                "or clear_role true.",
                "Unclear change",
            )
        linked = await self._linked()
        if link:
            return await self._link(args, link, linked)
        if unlink:
            return await self._unlink(args, unlink, linked)
        return await self._role(args, role or None, linked)

    async def _apply(self, path: str, body: dict[str, Any], done: str) -> ToolResult:
        try:
            await self._seti.put(path, body)
        except SetiError as e:
            if e.status in (400, 404):
                raise _refused(e) from e
            raise
        return ToolResult(f"{done}; it applies from your next turn.", clip(done, 70))

    async def _asked(self, args: Mapping[str, Any], *key: Any) -> bool:
        return await self._gate.cleared(
            gate_key("change_my_context_packs", *key), arg_bool(args, "confirmed")
        )

    async def _link(self, args: Mapping[str, Any], ref: str, linked: list[dict[str, Any]]) -> ToolResult:
        pack = _pick(dicts(await self._seti.get("/context/packs")), ref, "Call list_context_packs.")
        name = name_of(pack)
        if pack.get("kind") == "role":
            raise ToolError(
                f"{name} is a role; pass it as role, which replaces your current one.", "Role pack"
            )
        ids = [p.get("id") for p in linked]
        if pack.get("id") in ids:
            return ToolResult(f"The pack {name} is already in your prompt.", "Already linked")
        if not await self._asked(args, "link", pack.get("id")):
            effect = f"This adds the context pack {name} to your system prompt from your next turn."
            return ask("change_my_context_packs", args, effect, f"link pack {name} to the EA")
        return await self._apply(
            "/ea/context-packs", {"pack_ids": [*ids, pack.get("id")]}, f"Linked {name} to you"
        )

    async def _unlink(self, args: Mapping[str, Any], ref: str, linked: list[dict[str, Any]]) -> ToolResult:
        references = [p for p in linked if p.get("kind") != "role"]
        if not references:
            raise ToolError("No reference packs are linked to you.", "No packs linked")
        names = and_list([name_of(p) for p in references])
        pack = _pick(references, ref, f"Yours are {names}; remove a role with clear_role.")
        name = name_of(pack)
        if not await self._asked(args, "unlink", pack.get("id")):
            effect = (
                f"This takes the context pack {name} out of your system prompt from your next turn; it stays."
            )
            return ask("change_my_context_packs", args, effect, f"unlink pack {name} from the EA")
        rest = [p.get("id") for p in linked if p.get("id") != pack.get("id")]
        return await self._apply("/ea/context-packs", {"pack_ids": rest}, f"Unlinked {name} from you")

    async def _role(
        self, args: Mapping[str, Any], ref: str | None, linked: list[dict[str, Any]]
    ) -> ToolResult:
        current = next((p for p in linked if p.get("kind") == "role"), None)
        if ref is None:
            if current is None:
                return ToolResult("You have no role.", "No role")
            if not await self._asked(args, "role", None):
                effect = f"This removes your role {name_of(current)} from your next turn; the pack stays."
                return ask("change_my_context_packs", args, effect, "remove the EA's role")
            return await self._apply("/ea/role", {"pack_id": None}, f"Removed your role {name_of(current)}")
        roles = [p for p in dicts(await self._seti.get("/context/packs")) if p.get("kind") == "role"]
        hint = f"The roles are {and_list([name_of(p) for p in roles])}." if roles else "There are no roles."
        pack = only(
            pick(roles, ref, lambda p: str(p.get("id", "")), name_of, lambda _p: []),
            ref,
            "role pack",
            name_of,
            hint,
        )
        name = name_of(pack)
        if current is not None and current.get("id") == pack.get("id"):
            return ToolResult(f"Your role is already {name}.", "Role unchanged")
        if not await self._asked(args, "role", pack.get("id")):
            instead = f" in place of {name_of(current)}" if current is not None else ""
            effect = f"This gives you the role {name}{instead} from your next turn."
            return ask("change_my_context_packs", args, effect, f"give the EA the role {name}")
        return await self._apply("/ea/role", {"pack_id": pack.get("id")}, f"Took the role {name}")
