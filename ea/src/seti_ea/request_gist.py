"""A request said in a few spoken words, from Seti's own fields: never the agent's description."""

import json
import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from seti_ea.toolkit import dicts

Kind = Literal["call", "plan", "question", "secret", "access"]
# How the short line ends: a plain yes, an either-or that needs the side's own word, or no question.
Asks = Literal["yes", "word", "none"]

# Seti's EA_READ_BACK_CHARS: a longer call is allowed in Seti only.
READ_BACK_CHARS = 600
PLAIN_COMMAND_CHARS = 80
NAME_CHARS = 40
TITLE_CHARS = 60
PROMPT_WORDS = 20
SHELL_OPERATORS = re.compile(r"[;&|`<>]|\$\(")
OUTWARD_WORDS = frozenset(
    {"send", "post", "reply", "comment", "email", "mail", "message", "publish", "review", "draft", "schedule"}
)
READ_WORDS = frozenset({"get", "list", "read", "search", "find", "fetch", "view", "show", "lookup"})
BODY_KEYS = ("text", "message", "body", "content", "comment")
SLACK_SEND = re.compile(
    r"^(?:(?P<verb>Send|Draft|Schedule) (?:a )?(?P<dm>DM )?to|(?P<dm2>DM) to) (?P<place>.+?)"
    r"(?P<thread>, in a thread)?(?: \(name seen [\d-]+\))?: "
)
GH_TEXT = {
    ("pr", "create"): "open a pull request",
    ("pr", "comment"): "comment on a pull request",
    ("pr", "review"): "review a pull request",
    ("pr", "edit"): "edit a pull request",
    ("issue", "create"): "open an issue",
    ("issue", "comment"): "comment on an issue",
    ("issue", "edit"): "edit an issue",
    ("release", "create"): "publish a release",
}
GH_PLAIN = {
    ("pr", "merge"): "merge a pull request",
    ("pr", "close"): "close a pull request",
    ("issue", "close"): "close an issue",
}


@dataclass(frozen=True)
class Pending:
    """One request that holds an agent, as the EA announces it on a call."""

    id: str
    kind: Kind
    task_id: str
    title: str
    gist: str
    asks: Asks
    digest: str = ""
    created_at: str = ""
    timeout_at: str = ""

    @property
    def answerable(self) -> bool:
        """The user may allow or deny it by voice on the line that announces it."""
        return self.kind in ("call", "plan") and self.asks != "none"


def spoken(text: object, limit: int = NAME_CHARS) -> str:
    """Agent or code-host text as a few plain words: no symbols, ids or URLs survive."""
    words = re.sub(r"https?://\S+", " ", str(text))
    words = re.sub(r"[/_\-:#@]+", " ", words)
    words = " ".join(re.sub(r"[^\w .,'&]", " ", words).split())
    return words[:limit].rsplit(" ", 1)[0] if len(words) > limit else words


def _repo(text: str) -> str:
    """`owner/repo` as "the repo repo"; empty when there is none."""
    name = text.strip().rstrip(",").split("/")[-1].removesuffix(".git")
    return f"the {spoken(name)} repo" if name else ""


def _input(request: Mapping[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(str(request.get("input") or ""))
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _place(place: str) -> str:
    if place.startswith("#"):
        return f"the {spoken(place[1:])} channel"
    if "name not known" in place:
        return (
            "a channel Seti cannot name yet"
            if place.startswith("channel")
            else "someone Seti cannot name yet"
        )
    return spoken(place)


def _slack(summary: str) -> str | None:
    found = SLACK_SEND.match(summary)
    if found is None:
        return None
    verb = (found["verb"] or "send").lower()
    where = _place(found["place"])
    if found["thread"]:
        return f"{verb} a Slack reply in a thread with {where}"
    return f"{verb} a Slack message to {where}"


def _segments(command: str) -> list[list[str]]:
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        tokens = command.split()
    segments: list[list[str]] = [[]]
    for token in tokens:
        if token in ("&&", "||", ";", "|"):
            segments.append([])
        else:
            segments[-1].append(token)
    return [[t for t in seg if not re.match(r"^\w+=", t)] for seg in segments if seg]


def _push(args: list[str], request: Mapping[str, Any]) -> str:
    force = any(a in ("-f", "--force") or a.startswith("--force-with-lease") for a in args)
    places = [a for a in args if not a.startswith("-")]
    branch = places[1].split(":")[-1].removeprefix("refs/heads/") if len(places) > 1 else ""
    reason = str(request.get("reason") or "")
    pushed = re.search(r"Push to ([\w.-]+/[\w.-]+)", reason)
    prs = dicts(request.get("prs"))
    repo = _repo(pushed[1]) if pushed else _repo(str(prs[0].get("repo", ""))) if prs else ""
    verb = "force-push" if force else "push"
    what = f"the {spoken(branch)} branch" if spoken(branch) else "its branch"
    return f"{verb} {what}{f' to {repo}' if repo else ''}"


def _gh(args: list[str], request: Mapping[str, Any]) -> tuple[str, bool]:
    pair = (args[0], args[1]) if len(args) > 1 else (args[0] if args else "", "")
    prs = dicts(request.get("prs"))
    on = f" on {_repo(str(prs[0].get('repo', '')))}" if prs else ""
    if pair in GH_TEXT:
        return f"{GH_TEXT[pair]}{on}", True
    if pair in GH_PLAIN:
        return f"{GH_PLAIN[pair]}{on}", False
    if args and args[0] == "api":
        return "write through the GitHub API", True
    return f"run gh {spoken(' '.join(args[:2]))}".strip(), False


def _shell(command: str, request: Mapping[str, Any]) -> tuple[str, bool]:
    """What a shell command does in words, and whether it sends text outward."""
    segments = _segments(command)
    for seg in segments:
        program = seg[0].rsplit("/", 1)[-1]
        if program == "git" and len(seg) > 1 and seg[1] == "push":
            return _push(seg[2:], request), False
        if program == "gh":
            return _gh(seg[1:], request)
    seg = segments[0] if segments else [""]
    program = spoken(seg[0].rsplit("/", 1)[-1], 20)
    sub = seg[1] if len(seg) > 1 and re.fullmatch(r"[a-z][a-z-]{1,14}", seg[1]) else ""
    if program == "rm":
        return "delete files", False
    return f"run {program} {spoken(sub)}".strip() if program else "run a command", False


def _mcp(tool: str) -> tuple[str, bool]:
    _, server, *rest = tool.split("__")
    words = spoken(" ".join(rest)).lower()
    names = set(words.split())
    outward = bool(names & OUTWARD_WORDS) and not names & READ_WORDS
    return f"use {spoken(server)} to {words}", outward


def _file(tool: str, inputs: Mapping[str, Any]) -> str:
    path = str(inputs.get("file_path") or inputs.get("notebook_path") or inputs.get("path") or "")
    name = spoken(path.rsplit("/", 1)[-1]) or "a file"
    if tool in ("Read", "Glob", "Grep", "LS"):
        return f"read {name}"
    return f"{'write' if tool == 'Write' else 'edit'} {name}"


def call_gist(request: Mapping[str, Any]) -> tuple[str, bool, bool]:
    """What a held call does in a few words, whether it sends text outward, and whether it is plain."""
    tool = str(request.get("tool_name") or "")
    inputs = _input(request)
    slack = _slack(str(request.get("summary") or ""))
    if slack is not None:
        return slack, True, False
    if tool == "Bash":
        command = str(inputs.get("command") or request.get("summary") or "")
        gist, outward = _shell(command, request)
        plain = len(command) <= PLAIN_COMMAND_CHARS and not SHELL_OPERATORS.search(command)
        return gist, outward, plain and not outward
    if tool.startswith("mcp__"):
        gist, outward = _mcp(tool)
        return gist, outward, not outward
    if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit", "Read", "Glob", "Grep", "LS"):
        return _file(tool, inputs), False, True
    if tool == "WebFetch":
        host = re.sub(r"^https?://([^/]+).*$", r"\1", str(inputs.get("url") or ""))
        return f"fetch a page from {host or 'the web'}", False, True
    if tool == "WebSearch":
        return "search the web", False, True
    return f"use {spoken(tool) or 'a tool'}", False, True


def whole(request: Mapping[str, Any]) -> bool:
    """The call's input is whole and short enough for the EA to read back and allow."""
    text = str(request.get("input") or "")
    try:
        json.loads(text)
    except ValueError:
        return False
    return len(" ".join(text.split())) <= READ_BACK_CHARS


def body_of(request: Mapping[str, Any]) -> str | None:
    """The text an outward call sends, such as a Slack message's; None when it has none."""
    inputs = _input(request)
    return next((str(inputs[k]) for k in BODY_KEYS if isinstance(inputs.get(k), str) and inputs[k]), None)


def _call(request: Mapping[str, Any]) -> tuple[Kind, str, Asks]:
    if request.get("tool_name") == "ExitPlanMode":
        return "plan", "has a plan ready", "word"
    gist, _, plain = call_gist(request)
    again = " again" if request.get("kind") == "repeat" else ""
    if not whole(request):
        return (
            "call",
            f"wants to {gist}{again}; it is too long to read out, so it waits for you in Seti",
            "none",
        )
    return "call", f"wants to {gist}{again}", "yes" if plain else "word"


def _change(change: Mapping[str, Any]) -> str:
    kind = change.get("kind")
    if kind == "allow_host":
        return f"access to {spoken(change.get('host'), 60).replace(' ', '')}"
    if kind == "api_key":
        return "an API key"
    if kind == "shared_tool":
        return "a shared tool for every agent"
    return f"the {spoken(change.get('server'))} MCP server"


def _prompt(text: object) -> str:
    words = spoken(text, 400).split()
    line = " ".join(words[:PROMPT_WORDS])
    return f"{line}{'...' if len(words) > PROMPT_WORDS else ''}".rstrip(".,") + "?"


def _base(row: Mapping[str, Any], kind: Kind, gist: str, asks: Asks) -> Pending:
    return Pending(
        id=str(row.get("id", "")),
        kind=kind,
        task_id=str(row.get("task_id", "")),
        title=spoken(row.get("task_title") or "An agent", TITLE_CHARS) or "An agent",
        gist=gist,
        asks=asks,
        digest=str(row.get("digest") or ""),
        created_at=str(row.get("created_at") or ""),
        timeout_at=str(row.get("timeout_at") or ""),
    )


def parse_pending(data: object) -> list[Pending]:
    """Every request that holds an agent, from GET /requests; knowledge notes hold none."""
    fields: Mapping[str, Any] = data if isinstance(data, dict) else {}
    rows: list[Pending] = []
    for request in dicts(fields.get("permissions")):
        rows.append(_base(request, *_call(request)))
    for question in dicts(fields.get("questions")):
        if question.get("kind") == "secret":
            rows.append(_base(question, "secret", "needs a secret, which you enter in Seti", "none"))
        else:
            rows.append(_base(question, "question", f"asks: {_prompt(question.get('prompt'))}", "none"))
    for change in dicts(fields.get("access")):
        thing = _change(change.get("change") or {})
        rows.append(_base(change, "access", f"asks for {thing}; that one is yours, in Seti", "none"))
    return [row for row in rows if row.id]


QUESTIONS: dict[Asks, dict[Kind, str]] = {
    "yes": {"call": "Shall I allow it?"},
    "word": {"call": "Shall I read it, or allow it?", "plan": "Shall I summarise it, or approve it?"},
}


def sentence(pending: Pending) -> str:
    """The request in one spoken sentence, with the question it takes."""
    line = f"{pending.title} {pending.gist}"
    question = QUESTIONS.get(pending.asks, {}).get(pending.kind)
    if question is None:
        return line if line.endswith("?") else f"{line}."
    return f"{line}. {question}"
