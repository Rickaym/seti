"""Seti's settings document as JSON for the EA: plain configuration, one part or all."""

import json
from typing import Any

from seti_ea.toolkit import ToolError, ToolResult

# A whole document runs to many kilobytes; past this the EA is told to ask for one part.
WHOLE_MAX = 6000


def _sections(doc: dict[str, Any]) -> list[str]:
    return [f"{group}.{page}" for group, pages in doc.items() if isinstance(pages, dict) for page in pages]


def _part(doc: dict[str, Any], path: str) -> Any:
    found: Any = doc
    for key in path.split("."):
        if not isinstance(found, dict) or key not in found:
            raise ToolError(
                f"Seti's settings have no {path}. Parts: {', '.join(_sections(doc))}.",
                "No such settings",
            )
        found = found[key]
    return found


def settings_text(doc: Any, path: str) -> ToolResult:
    """The settings at a path as indented JSON, or all of them while they stay short."""
    body = {k: v for k, v in doc.items() if k not in ("version", "revision")} if isinstance(doc, dict) else {}
    wanted = path.strip()
    if wanted.lower() in ("all", "*", "."):
        text = json.dumps(body, indent=1, ensure_ascii=False)
        if len(text) > WHOLE_MAX:
            return ToolResult(
                f"Seti's settings are long; ask for one part: {', '.join(_sections(body))}.",
                "Listed Seti's settings",
            )
        return ToolResult(text, "Read Seti's settings")
    text = json.dumps(_part(body, wanted), indent=1, ensure_ascii=False)
    return ToolResult(f"{wanted}:\n{text}", f"Read the {wanted} settings")
