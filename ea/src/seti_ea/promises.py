"""Keeps the EA to its word: a reply that promises to pass something on gets the tool call for it.

The model runs without reasoning, and now and then it ends a reply with "I'll pass that to the
agent" and calls nothing, or asks whether to send what the user just told it to send. After every
finished reply this module reads the turn back, with no model call: when the reply promised or
claimed a relay, or re-asked one the user gave, and no tool that messages or starts an agent ran,
it adds a developer note and runs the EA once more, so it acts or says plainly why it cannot.
"""

import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage, LLMSpecificMessage

from seti_ea.clock import CALL_NOTE_PREFIX
from seti_ea.history import ends_with_user, is_summary

# Each of these carries words to an agent or starts one, so it keeps a promise to pass something on.
RELAY_TOOLS = frozenset(
    {"post_team_chat", "reply_team_chat", "start_task", "hand_over_updates", "confirm_asked"}
)
NOTE_PREFIX = "Seti checked your last reply:"
# Developer notes that open a turn the user did not start: an inbox report or a new call.
INBOX_PREFIX = "Inbox:"
OPENINGS = (INBOX_PREFIX, CALL_NOTE_PREFIX)

_NOT_THE_USER = r"(?!(?:you|yourself|me|us|everyone|everybody|all)\b)"
_FILLER = r"(?:(?!not\b|never\b)[\w-]+\s+){0,3}?"
_VERBS = r"pass|relay|forward|tell|ask|send|remind|nudge|instruct"
# Also nouns, so they count only right after "I'll": "I'll message him", not "I'll read the message".
_NOUNISH = r"message|ping|brief"
_PAST = r"passed|relayed|forwarded|told|asked|messaged|sent|reminded|nudged|pinged|briefed|instructed"
_LET = rf"let\s+{_NOT_THE_USER}\S+\s+know\b"
_AN = r"(?:a|an|another|the|new|fresh)\s+(?:[\w-]+\s+){0,2}?(?:agent|task)\b"
_WILL = r"\b(?:i'll|i\s+will|i'm\s+going\s+to|i\s+am\s+going\s+to|i\s+shall|let\s+me)\s+"
_DID = r"\b(?:i've|i\s+have|i)\s+(?:just\s+|also\s+|now\s+)?"

PROMISE = re.compile(
    rf"{_WILL}(?:(?:also\s+|now\s+|just\s+)?(?:{_NOUNISH})\s+{_NOT_THE_USER}|{_FILLER}"
    rf"(?:(?:{_VERBS})\s+{_NOT_THE_USER}|{_LET}|(?:start|spin\s+up|kick\s+off|launch)\s+{_AN}))",
    re.IGNORECASE,
)
CLAIM = re.compile(
    rf"{_DID}(?:(?:{_PAST})\s+{_NOT_THE_USER}|{_LET}|(?:started|spun\s+up|kicked\s+off|launched)\s+{_AN})",
    re.IGNORECASE,
)
# A sentence that offers rather than commits, or points back at an earlier turn.
HEDGE = re.compile(
    r"\b(?:if|unless|would\s+you|want\s+me|shall\s+i|should\s+i|whether\s+you)\b", re.IGNORECASE
)
EARLIER = re.compile(r"\b(?:earlier|before|already|yesterday|ago|last\s+time)\b", re.IGNORECASE)
ASKS_FOR_YES = re.compile(
    r"\b(?:shall\s+i|should\s+i|may\s+i|can\s+i|want\s+me\s+to|would\s+you\s+like\s+me\s+to|"
    r"go\s+ahead)\b",
    re.IGNORECASE,
)
OFFERS_RELAY = re.compile(
    rf"\b(?:{_VERBS}|{_NOUNISH}|let\s+\S+\s+know)\b|\bkeep\s+\S+\s+(?:\S+\s+)?going\b", re.IGNORECASE
)
CHOICE = re.compile(r"\b(?:which|who|or)\b", re.IGNORECASE)
UNSURE = re.compile(
    r"(?:\bnot|n't)\s+(?:quite\s+)?(?:catch|catching|hear|hearing|understand|sure)\b", re.IGNORECASE
)

_NOT_A_NAME = r"(?!(?:about|whether|if|what|why|how|for|something|anything|that|this|it|a|an|the)\b)"
_AGENT = rf"(?:him|her|them|(?:the\s+)?{_NOT_THE_USER}{_NOT_A_NAME}[a-z][\w-]*)"
DIRECTIVE = re.compile(
    rf"\b(?:tell|ask|remind|message|ping|nudge|instruct)\s+{_AGENT}\b"
    rf"|\blet\s+{_AGENT}\s+know\b"
    rf"|\bkeep\s+(?:it|{_AGENT})(?:\s+[\w-]+){{0,2}}\s+(?:going|moving|working|at\s+it|on\s+it)\b"
    r"|\bpass\s+(?:(?:it|this|that|these|them|those)\s+)?(?:on|along)\b"
    rf"|\b(?:have|get)\s+{_AGENT}\s+to\b",
    re.IGNORECASE,
)
APOSTROPHES = str.maketrans({"\u2018": "'", "\u2019": "'"})
SENTENCE_END = re.compile(r"(?<=[.!?])\s+|\n+")
QUOTED = re.compile(r"\"[^\"]*\"|\u201c[^\u201d]*\u201d|^>.*$", re.MULTILINE)


def promise_note(sentence: str) -> str:
    """What the EA hears after a reply that said it did or will do a relay without the tool call."""
    return (
        f'{NOTE_PREFIX} you told the user "{sentence}" but called no tool for it, so nothing reached '
        "the agent. Do it now with the tool for it, such as post_team_chat with to for a direct "
        "message, then say in a line what you sent to whom. If the user's words since then change "
        "it, or you cannot do it, say so in one sentence instead. Never say you did or will do "
        "something without its tool call in the same reply."
    )


def relay_note(directive: str, question: str) -> str:
    """What the EA hears after it asked whether to send what the user had just told it to send."""
    return (
        f'{NOTE_PREFIX} the user told you to pass this on ("{directive}"), and you asked again '
        f'instead: "{question}". A direct message to an agent needs no yes. Send it now with '
        "post_team_chat and to, then say in a line what you sent to whom. Ask only when it is "
        "unclear which agent or what to say; a public post to every agent still needs the yes."
    )


@dataclass
class Turn:
    """The latest turn read back: the user's words, the EA's words and the tools it called.

    `whole` is False when a summary cut into the turn, so a tool call it made may be out of view.
    """

    said: list[str] = field(default_factory=list)
    heard: list[str] = field(default_factory=list)
    tools: set[str] = field(default_factory=set)
    checked: bool = False
    whole: bool = False
    start: int = 0


def _tool_names(message: Mapping[str, Any]) -> set[str]:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return set()
    names: set[str] = set()
    for raw in cast(list[object], calls):
        function = cast(Mapping[str, Any], raw).get("function") if isinstance(raw, dict) else None
        if isinstance(function, dict):
            names.add(str(cast(Mapping[str, Any], function).get("name")))
    return names


def _opens_turn(messages: Sequence[LLMContextMessage], index: int, heard: bool) -> bool:
    """An older reply after the user's words, or the inbox or call note that opened a turn alone.

    An inbox note right after the user's words waited for their turn on a call, so it opens nothing.
    """
    message = cast(Mapping[str, Any], messages[index])
    if message.get("role") in ("assistant", "tool"):
        return heard
    content = message.get("content")
    if message.get("role") != "developer" or not isinstance(content, str) or not content.startswith(OPENINGS):
        return False
    return not (content.startswith(INBOX_PREFIX) and ends_with_user(messages[:index]))


def last_turn(messages: Sequence[LLMContextMessage]) -> Turn:
    """The turn since the user's last words, or since the inbox or call note that opened it."""
    turn = Turn()
    for index in range(len(messages) - 1, -1, -1):
        raw = messages[index]
        if isinstance(raw, LLMSpecificMessage):
            continue
        message = cast(Mapping[str, Any], raw)
        content = message.get("content")
        text = content if isinstance(content, str) else ""
        if is_summary(message) or _opens_turn(messages, index, bool(turn.heard)):
            turn.whole = bool(turn.heard) or not is_summary(message)
            turn.start = index if message.get("role") == "developer" else index + 1
            return turn
        role = message.get("role")
        if role == "user":
            turn.heard.insert(0, text)
        elif role == "developer":
            # A note before the user spoke came from a cut-off reply; this turn is not checked yet.
            turn.checked = turn.checked or (not turn.heard and text.startswith(NOTE_PREFIX))
        elif role == "assistant":
            turn.said.insert(0, text)
            turn.tools |= _tool_names(message)
    turn.whole = bool(turn.heard)
    return turn


def sentences(text: str) -> list[str]:
    """The sentences of a reply in order, without quoted text, which may be someone else's words."""
    plain = QUOTED.sub(" ", text.translate(APOSTROPHES))
    return [s.strip() for s in SENTENCE_END.split(plain) if s.strip()]


def broken_promise(said: str) -> tuple[str, bool] | None:
    """The first sentence that promises or claims a relay, and whether it claims one already done.

    None when there is none, or when the reply ends asking the user for a yes.
    """
    parts = sentences(said)
    if parts and parts[-1].endswith("?") and ASKS_FOR_YES.search(parts[-1]):
        return None
    for sentence in parts:
        if sentence.endswith("?") or HEDGE.search(sentence):
            continue
        if PROMISE.search(sentence):
            return sentence, False
        if CLAIM.search(sentence) and not EARLIER.search(sentence):
            return sentence, True
    return None


def relay_question(said: str) -> str | None:
    """A question that asks whether to pass something to an agent, not which agent to pick."""
    for sentence in sentences(said):
        if not sentence.endswith("?") or CHOICE.search(sentence):
            continue
        if ASKS_FOR_YES.search(sentence) and OFFERS_RELAY.search(sentence):
            return sentence
    return None


def unkept(messages: Sequence[LLMContextMessage]) -> str | None:
    """The note to hand the EA when its latest reply left a relay undone; None when it is kept.

    A turn is checked once: after the note, the EA's next reply stands, so this never loops.
    """
    turn = last_turn(messages)
    if turn.checked or not turn.whole or turn.tools & RELAY_TOOLS:
        return None
    said = " ".join(turn.said)
    promise = broken_promise(said)
    if promise is not None:
        sentence, claimed = promise
        # "I've sent it" may restate a message the turn before sent.
        if not (claimed and last_turn(messages[: turn.start]).tools & RELAY_TOOLS):
            return promise_note(sentence)
    question = None if UNSURE.search(said) else relay_question(said)
    directive = DIRECTIVE.search(" ".join(turn.heard).translate(APOSTROPHES))
    if question is not None and directive is not None:
        return relay_note(directive.group(0), question)
    return None


class PromiseCheck:
    """Runs after each finished reply of the EA and hands an unkept relay back to it once."""

    def __init__(
        self,
        context: LLMContext,
        add_note: Callable[[str], None],
        rerun: Callable[[], Awaitable[None]],
    ) -> None:
        self._context = context
        self._add_note = add_note
        self._rerun = rerun

    async def reply_ended(self, *, interrupted: bool = False) -> bool:
        """True when the reply left a relay undone; the note waits for the user's next words if cut off."""
        note = unkept(self._context.messages)
        if note is None:
            return False
        self._add_note(note)
        if not interrupted:
            await self._rerun()
        return True
