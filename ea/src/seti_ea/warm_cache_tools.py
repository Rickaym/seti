"""Tools for a repo's warm caches: build caches Seti copies into each new worktree of it."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import and_list, plural, repo_name
from seti_ea.gate import CONFIRMED, Confirmations, ask, gate_key
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_list, arg_str, dicts, resolve_repo

MAX_MB = 20480
REPO_REF = {"type": "string", "description": "The repo's name as the user said it."}
PATTERNS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Globs relative to the checkout, such as **/*.tsbuildinfo or **/.next/cache; ** spans "
    "folders and a name alone matches at any depth.",
}

WARM_CACHE_SPECS: list[ToolSpec] = [
    ToolSpec(
        "get_warm_caches",
        "A repo's warm caches: whether Seti copies gitignored build caches, such as tsc's tsbuildinfo, "
        "into each new worktree so an agent's first typecheck starts warm, which patterns, the size cap, "
        "and whether its typecheck can be warmed at all.",
        {"repo": REPO_REF},
        ["repo"],
    ),
    ToolSpec(
        "set_warm_caches",
        "Change a repo's warm caches: turn them on or off, add or remove cache patterns, go back to the "
        "default patterns, or set the size cap. New worktrees use the change; existing ones keep what "
        "they have. Needs the user's yes.",
        {
            "repo": REPO_REF,
            "enabled": {"type": "boolean", "description": "true to copy caches into new worktrees."},
            "add_patterns": PATTERNS,
            "remove_patterns": PATTERNS,
            "default_patterns": {
                "type": "boolean",
                "description": "true to go back to the default patterns before adding or removing any.",
            },
            "max_mb": {"type": "integer", "description": f"Size cap per worktree in MB, 1 to {MAX_MB}."},
            "confirmed": CONFIRMED,
        },
        ["repo"],
    ),
]


def _words(settings: Mapping[str, Any]) -> str:
    patterns = [str(p) for p in settings.get("patterns") or []]
    cap = f"{settings.get('max_mb')} MB"
    if settings.get("enabled") is not True:
        return f"off; when on, it copies {and_list(patterns) or 'nothing'} up to {cap}"
    return f"on: new worktrees get {and_list(patterns) or 'nothing'}, up to {cap}"


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


class WarmCacheTools:
    """The EA's warm cache tools, through the routes the repo settings use."""

    def __init__(self, seti: SetiClient, confirmations: Confirmations) -> None:
        self._seti = seti
        self._gate = confirmations
        self.handlers: dict[str, Callable[[Mapping[str, Any]], Awaitable[ToolResult]]] = {
            "get_warm_caches": self.get_warm_caches,
            "set_warm_caches": self.set_warm_caches,
        }

    async def _status(self, args: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        repo = resolve_repo(dicts(await self._seti.get("/repos")), arg_str(args, "repo"))
        status = await self._seti.get(f"/repos/{repo.get('id')}/warm-caches")
        return repo, status if isinstance(status, dict) else {}

    async def get_warm_caches(self, args: Mapping[str, Any]) -> ToolResult:
        repo, status = await self._status(args)
        name = repo_name(str(repo.get("slug", "")))
        text = f"Warm caches for {name} are {_words(_dict(status.get('settings')))}."
        hint = status.get("hint")
        if isinstance(hint, str) and hint:
            text += f" {hint}"
        return ToolResult(text, f"Read warm caches of {name}")

    @staticmethod
    def _patterns(args: Mapping[str, Any], current: list[str], defaults: list[str]) -> list[str]:
        base = list(defaults) if arg_bool(args, "default_patterns") else list(current)
        removing = arg_list(args, "remove_patterns")
        unknown = [p for p in removing if p not in base]
        if unknown:
            raise ToolError(
                f"{and_list(unknown)} {'is' if len(unknown) == 1 else 'are'} not among the patterns: "
                f"{and_list(base) or 'none'}.",
                "Unknown pattern",
            )
        kept = [p for p in base if p not in removing]
        return kept + [p for p in arg_list(args, "add_patterns") if p not in kept]

    def _body(self, args: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
        settings = _dict(status.get("settings"))
        defaults = _dict(status.get("defaults"))
        current = [str(p) for p in settings.get("patterns") or []]
        body = {
            "enabled": arg_bool(args, "enabled") if "enabled" in args else settings.get("enabled") is True,
            "patterns": self._patterns(args, current, [str(p) for p in defaults.get("patterns") or []]),
            "max_mb": int(settings.get("max_mb") or 2048),
        }
        if "max_mb" in args:
            mb = _int(args.get("max_mb"))
            if mb is None or not 1 <= mb <= MAX_MB:
                raise ToolError(f"The size cap is 1 to {MAX_MB} MB.", "Bad size cap")
            body["max_mb"] = mb
        if all(body[k] == settings.get(k) for k in body):
            raise ToolError(f"Warm caches are already {_words(settings)}.", "Nothing to change")
        return body

    async def set_warm_caches(self, args: Mapping[str, Any]) -> ToolResult:
        repo, status = await self._status(args)
        name = repo_name(str(repo.get("slug", "")))
        body = self._body(args, status)
        if not await self._gate.cleared(
            gate_key("set_warm_caches", repo.get("id"), body), arg_bool(args, "confirmed")
        ):
            effect = (
                f"Warm caches for {name} become {_words(body)}. Only new worktrees change; "
                f"{plural(len(body['patterns']), 'pattern')} in all."
            )
            return ask("set_warm_caches", args, effect, f"change warm caches of {name}")
        try:
            saved = await self._seti.put(f"/repos/{repo.get('id')}/warm-caches", body)
        except SetiError as e:
            if e.status in (400, 404):
                raise ToolError(f"Seti did not do it: {e.detail or e.title}", "Not changed") from e
            raise
        after = _dict(saved).get("settings")
        return ToolResult(
            f"Warm caches for {name} are now {_words(_dict(after) or body)}.",
            f"Changed warm caches of {name}",
        )
