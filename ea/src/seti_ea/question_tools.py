"""Questions agents ask the user: the EA reads them out and passes on only what the user said."""

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime
from typing import Any

from seti_ea.format import ago, and_list, clip, plural
from seti_ea.seti import SetiClient, SetiError
from seti_ea.toolkit import ToolError, ToolResult, ToolSpec, arg_bool, arg_list, arg_str, dicts, normalize

Handler = Callable[[Mapping[str, Any]], Awaitable[ToolResult]]

PROMPT_CHARS = 200
ID_CHARS = 8

ANSWER_QUESTION_SPEC = ToolSpec(
    "answer_question",
    "Pass the user's answer to a question an agent asked, or dismiss it when the user says to skip "
    "it. Use only what the user said; never answer on your own judgment, and ask the user when "
    "their answer is unclear. A secret question only the user answers, in Seti; you may dismiss it. "
    "List the open questions with search_seti in questions first.",
    {
        "question": {"type": "string", "description": "The question's id from search_seti, or its header."},
        "choices": {
            "type": "array",
            "items": {"type": "string"},
            "description": "The option labels the user picked, as listed; Yes or No for yes or no.",
        },
        "words": {
            "type": "string",
            "description": "The user's answer in their own words, when no option fits.",
        },
        "dismiss": {"type": "boolean", "description": "True to dismiss it unanswered, as the user asked."},
    },
    ["question"],
)


def _labels(question: Mapping[str, Any]) -> list[str]:
    return [str(option.get("label", "")) for option in dicts(question.get("options"))]


def answer_type(question: Mapping[str, Any]) -> str:
    """How the question is answered, in words a call can read out."""
    if question.get("kind") == "yes_no":
        return "yes or no"
    labels = _labels(question)
    if question.get("multi"):
        return f"any of {and_list(labels)}"
    return (
        f"one of {and_list(labels[:-1])} or {labels[-1]}" if len(labels) > 1 else f"one of {and_list(labels)}"
    )


SECRET_IN_SETI = (
    "{name} is a secret the agent asked for; only the user enters it, on the Questions page in Seti. "
    "Tell the user to answer it there; you can only dismiss it."
)


def _question_line(question: Mapping[str, Any]) -> str:
    short = str(question.get("id", ""))[:ID_CHARS]
    prompt = clip(str(question.get("prompt", "")), PROMPT_CHARS)
    if question.get("kind") == "secret":
        return f"- [{short}] secret {question.get('header')} (the user enters it in Seti, never through you): {prompt}"
    return f"- [{short}] {question.get('header')} ({answer_type(question)}, or own words): {prompt}"


async def list_questions(seti: SetiClient, now: datetime) -> ToolResult:
    """The open questions by agent, oldest first, for search_seti's questions scope."""
    open_questions = dicts(await seti.get("/questions"))
    if not open_questions:
        return ToolResult("No agent has a question open for the user.", "No questions")
    by_task: dict[str, list[dict[str, Any]]] = {}
    for question in open_questions:
        by_task.setdefault(str(question.get("task_title")), []).append(question)
    lines = [
        f"{plural(len(open_questions), 'question')} wait for the user; each agent waits until all of its "
        "questions are settled. Read them out briefly and pass on only what the user answers:"
    ]
    for title, asked in by_task.items():
        lines.append(
            f"{title} asks {plural(len(asked), 'question')}, since {ago(asked[0].get('created_at'), now)}:"
        )
        lines += [_question_line(question) for question in asked]
    return ToolResult("\n".join(lines), f"{plural(len(open_questions), 'question')} open")


def _find(open_questions: list[dict[str, Any]], ref: str) -> dict[str, Any]:
    by_id = [q for q in open_questions if str(q.get("id", "")).startswith(ref.lower())]
    found = by_id or [q for q in open_questions if normalize(str(q.get("header", ""))) == normalize(ref)]
    if len(found) == 1:
        return found[0]
    if not found:
        raise ToolError(
            f"No open question matches {ref}. List them with search_seti in questions.", "No question"
        )
    names = and_list(
        [f"{q.get('header')} [{str(q.get('id'))[:ID_CHARS]}] of {q.get('task_title')}" for q in found]
    )
    raise ToolError(f"Several open questions match {ref}: {names}. Use the id.", "Several questions")


def _picked(question: Mapping[str, Any], choices: list[str]) -> list[str]:
    labels = {normalize(label): label for label in _labels(question)}
    picked = [labels.get(normalize(choice)) for choice in choices]
    unknown = [choice for choice, label in zip(choices, picked, strict=True) if label is None]
    if unknown:
        options = and_list(list(labels.values()))
        raise ToolError(f"{and_list(unknown)} is not an option; the options are {options}.", "Not an option")
    return [label for label in picked if label is not None]


class QuestionTools:
    """Answers and dismissals the user gives on a call, through the route Submit all uses."""

    def __init__(self, seti: SetiClient) -> None:
        self._seti = seti
        self.handlers: dict[str, Handler] = {"answer_question": self.answer_question}

    def _item(self, question: Mapping[str, Any], args: Mapping[str, Any]) -> dict[str, Any]:
        if arg_bool(args, "dismiss"):
            return {"action": "dismiss", "id": question["id"]}
        if question.get("kind") == "secret":
            raise ToolError(SECRET_IN_SETI.format(name=question.get("header")), "Answer in Seti")
        selected = _picked(question, arg_list(args, "choices"))
        words = arg_str(args, "words", required=False)
        if not selected and not words:
            raise ToolError("Give the options the user picked or their own words.", "No answer")
        return {"action": "answer", "id": question["id"], "selected": selected, "other": words or None}

    async def answer_question(self, args: Mapping[str, Any]) -> ToolResult:
        question = _find(dicts(await self._seti.get("/questions")), arg_str(args, "question"))
        item = self._item(question, args)
        try:
            result = await self._seti.post("/questions/answers", {"items": [item]})
        except SetiError as e:
            raise ToolError(f"Seti did not take the answer: {e.detail or e.title}", "Not answered") from e
        done = "Dismissed" if item["action"] == "dismiss" else "Answered"
        title = question.get("task_title")
        if result.get("skipped"):
            return ToolResult(f"{title} no longer waits on that question.", "No longer open", ok=False)
        if dicts(result.get("resumed")):
            return ToolResult(f"{done}. {title} has all its answers and goes on.", done)
        return ToolResult(f"{done}. {title} still waits on its other questions.", done)
