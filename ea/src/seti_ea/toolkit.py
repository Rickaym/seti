"""What every EA tool shares: its spec and result types, argument parsing and name matching."""

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from seti_ea.format import clip, repo_name

STOPWORDS = frozenset(
    {"the", "a", "an", "task", "one", "that", "on", "for", "of", "to", "my", "pack", "subagent"}
)
NON_WORD = re.compile(r"[^a-z0-9]+")
ID_LIKE = re.compile(r"^[0-9a-f-]{4,}$")
USER_FILE_WORDS = frozenset(
    {"claude", "md", "file", "context", "user", "level", "global", "personal", "home", "mine", "own"}
)


@dataclass(frozen=True)
class ToolResult:
    """What the LLM reads back, plus a short summary and outcome for the UI."""

    text: str
    summary: str
    ok: bool = True
    # What a gated tool asks the user to allow, such as "delete agent Voicemail retry".
    asked: str | None = None


@dataclass(frozen=True)
class ToolSpec:
    """A tool's name, description and JSON schema properties."""

    name: str
    description: str
    properties: dict[str, Any] = field(default_factory=dict)
    required: list[str] = field(default_factory=list)


class ToolError(Exception):
    """A tool that cannot go ahead; the text tells the LLM why."""

    def __init__(self, text: str, summary: str) -> None:
        super().__init__(text)
        self.text = text
        self.summary = summary


TASK_REF = {
    "type": "string",
    "description": "The task's id, or its title as the user said it; approximate titles work.",
}


def normalize(text: str) -> str:
    return NON_WORD.sub(" ", text.lower()).strip()


def key_words(text: str) -> list[str]:
    return [w for w in normalize(text).split() if w not in STOPWORDS]


def word_score(ref_words: list[str], title: str) -> float:
    title_words = normalize(title).split()
    if not ref_words or not title_words:
        return 0.0
    hits = sum(
        1 for w in ref_words if any(t.startswith(w) or (len(t) > 2 and w.startswith(t)) for t in title_words)
    )
    return hits / len(ref_words)


def pick[T](
    items: list[T],
    ref: str,
    ident: Callable[[T], str],
    name: Callable[[T], str],
    aliases: Callable[[T], list[str]],
) -> list[T]:
    """Candidates for ref, from the most exact rule that matches anything."""
    key = ref.strip()
    low = key.lower()
    norm = normalize(key)
    if key == "":
        return []
    rules: list[Callable[[T], bool]] = [
        lambda i: ident(i) == key,
        lambda i: bool(ID_LIKE.match(low)) and ident(i).lower().startswith(low),
        lambda i: normalize(name(i)) == norm or any(normalize(a) == norm for a in aliases(i)),
        lambda i: (
            norm != "" and (norm in normalize(name(i)) or any(norm in normalize(a) for a in aliases(i)))
        ),
    ]
    for rule in rules:
        found = [i for i in items if rule(i)]
        if found:
            return found
    ref_words = key_words(key)
    scored = [(word_score(ref_words, name(i)), i) for i in items]
    best = max((s for s, _ in scored), default=0.0)
    if best < 0.5:
        return []
    return [i for s, i in scored if s == best]


def only[T](found: list[T], ref: str, noun: str, label: Callable[[T], str], hint: str) -> T:
    """The single match, or a ToolError saying none or several match."""
    if len(found) == 1:
        return found[0]
    if not found:
        raise ToolError(f'No {noun} matches "{ref}". {hint}', f'No {noun} matches "{clip(ref, 40)}"')
    shown = "; ".join(label(i) for i in found[:5])
    more = f" and {len(found) - 5} more" if len(found) > 5 else ""
    raise ToolError(
        f'"{ref}" matches {len(found)} {noun}s: {shown}{more}. Ask the user which one.',
        f'"{clip(ref, 40)}" is ambiguous',
    )


def resolve_repo(repos: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    """The one registered repo ref names by slug, name or id."""
    found = pick(
        repos,
        ref,
        lambda r: str(r.get("id", "")),
        lambda r: str(r.get("slug", "")),
        lambda r: [repo_name(str(r.get("slug", "")))],
    )
    if not found:
        known = ", ".join(str(r.get("slug")) for r in repos) or "none"
        raise ToolError(
            f'No registered repo matches "{ref}". Registered repos: {known}.',
            f'No repo matches "{clip(ref, 40)}"',
        )
    if len(found) > 1:
        names = ", ".join(str(r.get("slug")) for r in found)
        raise ToolError(
            f'"{ref}" matches several repos: {names}. Ask the user which one.',
            f'"{clip(ref, 40)}" is ambiguous',
        )
    return found[0]


def arg_str(args: Mapping[str, Any], name: str, *, required: bool = True) -> str:
    value = args.get(name)
    if isinstance(value, str) and value.strip() != "":
        return value.strip()
    if required:
        raise ToolError(f"The {name} argument is missing.", f"Missing {name}")
    return ""


def arg_bool(args: Mapping[str, Any], name: str) -> bool:
    value = args.get(name)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1")
    return value is True


def arg_int(args: Mapping[str, Any], name: str, default: int, high: int) -> int:
    value = args.get(name)
    if isinstance(value, int | float) and not isinstance(value, bool):
        number = int(value)
    elif isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
    else:
        return default
    return max(1, min(high, number))


def arg_list(args: Mapping[str, Any], name: str) -> list[str]:
    """A list argument as its non-empty strings; a lone string counts as a list of one."""
    raw = args.get(name)
    items = raw if isinstance(raw, list) else [raw] if isinstance(raw, str) else []
    return [i.strip() for i in items if isinstance(i, str) and i.strip()]


def title_of(task: Mapping[str, Any]) -> str:
    return str(task.get("title", "untitled"))


def name_of(item: Mapping[str, Any]) -> str:
    return str(item.get("name", "unnamed"))


def dicts(value: Any) -> list[dict[str, Any]]:
    return [v for v in value if isinstance(v, dict)] if isinstance(value, list) else []


def running_subagents(task: Mapping[str, Any]) -> int:
    """Subagents running now, from the counts the task list carries."""
    counts = task.get("subtask_counts")
    running = counts.get("running") if isinstance(counts, dict) else None
    return running if isinstance(running, int) and not isinstance(running, bool) else 0


def queued_update_rows(messages: list[Any]) -> list[dict[str, Any]]:
    """Undismissed update rows after the last prompt that reached the model, as the Seti UI counts them."""
    queued: list[dict[str, Any]] = []
    for row in messages:
        if not isinstance(row, dict):
            continue
        payload = row.get("payload")
        if not isinstance(payload, dict):
            continue
        if row.get("kind") == "prompt":
            if not str(payload.get("text", "")).startswith("/") and payload.get("queued") != "removed":
                queued = []
        elif row.get("kind") == "input" and payload.get("dismissed_at") is None:
            queued.append(row)
    return queued


def context_file_name(f: Mapping[str, Any]) -> str:
    """A CLAUDE.md file as the user says it: the user-level one, or the repo and file name."""
    if f.get("key") == "user":
        return "user-level CLAUDE.md"
    return f"{repo_name(str(f.get('group', '')))} {f.get('label')}"


def find_context_file(files: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    """The one context file ref names: user for the user-level one, else a repo, adding local."""

    def aliases(f: Mapping[str, Any]) -> list[str]:
        if f.get("key") == "user":
            return ["user"]
        return [str(f.get("group", "")), f"{f.get('group')} {f.get('label')}"]

    if not [w for w in key_words(ref) if w not in USER_FILE_WORDS]:
        found = [f for f in files if f.get("key") == "user"]
    else:
        found = pick(files, ref, lambda f: str(f.get("key", "")), context_file_name, aliases)
    if len(found) > 1 and "local" not in ref.lower():
        found = [f for f in found if "local" not in str(f.get("label", "")).lower()] or found
    return only(found, ref, "context file", context_file_name, "Call list_context_files to see which exist.")
