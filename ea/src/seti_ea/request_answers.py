"""Held tool calls and plans: the EA allows one once or denies it, only on the user's yes to its read-back.

Seti binds the yes to the request's digest and uses it once (ea-guard.ts), so a request that
changed after the read-back, a yes from another turn or a notification Allow does not count.
"""

import json
from collections.abc import Mapping
from typing import Any

from seti_ea.consent import own_words
from seti_ea.gate import ANSWER, Confirmations, Heard, ask_word, gate_key
from seti_ea.question_tools import ID_CHARS, INPUT_CHARS, PROMPT_CHARS, data, pr_line
from seti_ea.request_gist import body_of, call_gist
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, arg_bool, arg_str, dicts

TOOL = "answer_question"
ASK_HEADER = "x-seti-ea-ask"
# Seti's EA_READ_BACK_CHARS: a longer call is allowed in Seti, where the user reads all of it.
READ_BACK_CHARS = 600
AGREES = {"allow": ("allow", "approve", "send"), "deny": ("deny",)}
HEARD: tuple[Heard, ...] = ("yes", "word", "no")
USER_ONLY = (
    "Only allow once or deny. Always allow, a rule for every agent and edited fields stay the "
    "user's, in Seti, Requests."
)
NOT_ANNOUNCED = (
    "Not done: heard and announced belong to the questions Seti records when it announces a request on "
    "a call. Leave them out."
)
CHANGED = (
    "Not done: the request changed since you read it back. Read it to the user again and ask for a new yes."
)


def _is_plan(request: Mapping[str, Any]) -> bool:
    return request.get("tool_name") == "ExitPlanMode"


def whole_input(text: str) -> str | None:
    """The call's input on one line when it can be read back whole: not cut short, within the bound."""
    try:
        json.loads(text)
    except ValueError:
        return None
    flat = " ".join(text.split())
    return flat if len(flat) <= READ_BACK_CHARS else None


def _what(request: Mapping[str, Any], decision: str) -> str:
    """The question's short summary, as notes and the audit log show it."""
    short = str(request.get("id", ""))[:ID_CHARS]
    title = request.get("task_title")
    if _is_plan(request):
        return f"{'approve' if decision == 'allow' else 'deny'} the plan of {title} (request {short})"
    return f"{decision} {request.get('tool_name')} request {short} of {title}"


def _plan_first(request: Mapping[str, Any]) -> str:
    """What the EA says before an approval's read-back: the plan in one sentence of its own."""
    plan = data(request.get("input") or request.get("summary"), limit=INPUT_CHARS)
    return f"Say in one sentence what this plan does: {plan}"


def _allow_text(request: Mapping[str, Any]) -> str:
    title = request.get("task_title")
    if _is_plan(request):
        return f"That approves {title}'s plan, so it starts work on it. Shall I?"
    flat = whole_input(str(request.get("input", "")))
    if flat is None:
        raise ToolError(
            "That call is too long to read back whole, so only the user allows it, in Seti, Requests. "
            "You may still deny it if the user says so.",
            "Too long to read back",
        )
    gist, outward, _ = call_gist(request)
    body = body_of(request) if outward else None
    if body is not None:
        lines = [f"That allows {title} to {gist}. The text: {data(body, limit=READ_BACK_CHARS)}."]
    else:
        lines = [
            f"That allows {title} to run {request.get('tool_name')}: {data(flat, limit=READ_BACK_CHARS)}."
        ]
    if request.get("reason"):
        lines.append(f"Seti asked because: {data(request.get('reason'), 'Seti', PROMPT_CHARS)}.")
    prs = dicts(request.get("prs"))
    if prs:
        lines.append(f"PRs it names: {'; '.join(pr_line(pr) for pr in prs)}.")
    return " ".join([*lines, "Shall I?"])


def _deny_text(request: Mapping[str, Any], message: str) -> str:
    title = request.get("task_title")
    if _is_plan(request):
        target = f"{title}'s plan"
    else:
        target = f"{title}'s {request.get('tool_name')} call: {data(request.get('summary'))}"
    told = f", and tells it: {data(message, 'the user')}" if message else ""
    return f"That denies {target}{told}. Shall I?"


def _heard(args: Mapping[str, Any]) -> Heard | None:
    """The answer an announced question takes; only Seti's own recorded question carries one."""
    heard = args.get("heard")
    if heard is None and "announced" not in args:
        return None
    if ANSWER.get() is None or heard not in HEARD:
        raise ToolError(NOT_ANNOUNCED, "Not an announced question")
    return next(kind for kind in HEARD if kind == heard)


class RequestAnswers:
    """Answers a held tool call or plan through the route the Requests page uses, on the user's word."""

    def __init__(self, seti: SetiClient, gate: Confirmations) -> None:
        self._seti = seti
        self._gate = gate

    async def _find(self, ref: str) -> dict[str, Any]:
        if len(ref) < ID_CHARS:
            raise ToolError(f"Give the request's id of at least {ID_CHARS} characters.", "Short id")
        pending = await self._seti.get("/requests")
        rows = dicts(pending.get("permissions")) if isinstance(pending, dict) else []
        found = [row for row in rows if str(row.get("id", "")).startswith(ref.lower())]
        if len(found) == 1:
            return found[0]
        if not found:
            raise ToolError(
                f"No held tool call or plan matches {ref}. List them with search_seti in requests.",
                "No request",
            )
        raise ToolError(f"Several requests match {ref}; use the full id.", "Several requests")

    async def answer(self, args: Mapping[str, Any]) -> ToolResult:
        if any(key in args for key in ("always", "scope", "fields")):
            raise ToolError(USER_ONLY, "Allow once or deny")
        decision = arg_str(args, "decision")
        if decision not in AGREES:
            raise ToolError(USER_ONLY, "Allow once or deny")
        heard = _heard(args)
        message = own_words(self._gate.said) if heard == "no" else arg_str(args, "message", required=False)
        if heard == "no" and decision != "deny":
            raise ToolError(NOT_ANNOUNCED, "Not an announced question")
        if message and decision != "deny":
            raise ToolError("A message goes only with a deny.", "Message with a deny")
        request = await self._find(arg_str(args, "request"))
        digest = str(request.get("digest") or "")
        read = args.get("digest")
        if isinstance(read, str) and read != digest:
            raise ToolError(CHANGED, "Request changed")
        read_back = _allow_text(request) if decision == "allow" else _deny_text(request, message)
        key = gate_key(TOOL, request.get("id"), decision, message, digest)
        ask_id = await self._gate.on_word(key, arg_bool(args, "confirmed"), AGREES[decision], heard or "yes")
        if ask_id is None:
            bound = {"request": request.get("id"), "decision": decision, "message": message, "digest": digest}
            before = _plan_first(request) if _is_plan(request) and decision == "allow" else ""
            return ask_word(read_back, _what(request, decision), bound, before)
        return await self._send(request, decision, message, ask_id)

    async def _send(self, request: Mapping[str, Any], decision: str, message: str, ask_id: int) -> ToolResult:
        body: dict[str, Any] = {"decision": decision}
        if message:
            body["message"] = message
        path = f"/tasks/{request.get('task_id')}/permission-requests/{request.get('id')}"
        try:
            await self._seti.post(path, body, headers={ASK_HEADER: str(ask_id)})
        except SetiError as e:
            raise ToolError(f"Seti did not take it: {e.detail or e.title}", "Not answered") from e
        title = request.get("task_title")
        if decision == "deny":
            return ToolResult(
                f"Denied. {title} was told no{' with your message' if message else ''}.", "Denied"
            )
        if _is_plan(request):
            return ToolResult(f"Approved. {title} starts work on its plan.", "Approved")
        return ToolResult(f"Allowed once. {title} goes on with that call.", "Allowed once")
