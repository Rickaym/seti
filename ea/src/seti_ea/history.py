"""The EA's one conversation across calls: loaded from Seti at call start, appended as it grows."""

import asyncio
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from loguru import logger
from pipecat.processors.aggregators.llm_context import (
    LLMContext,
    LLMContextMessage,
    LLMSpecificMessage,
)
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

from seti_ea.live_context import is_live_note
from seti_ea.seti import SetiClient, SetiError

Kind = Literal["message", "call", "chat"]
Message = dict[str, Any]

SUMMARY_PREFIX = "Summary of the earlier conversation with the user:"
SUMMARY_TEMPLATE = SUMMARY_PREFIX + " {summary}"
PENDING_RESULT = "IN_PROGRESS"
CONTENT_MAX = 60_000
KEEP_RECENT_MESSAGES = 6
SUMMARY_MIN_TOKENS = 256
SUMMARY_MAX_TOKENS = 2000
SUMMARY_TIMEOUT_SECS = 60.0

SUMMARY_PROMPT = """\
You compact the running conversation between a user and their voice executive assistant, which \
reads and steers Claude Code agent tasks and pull requests in Seti.

Write a short factual summary the assistant can rely on in later calls. Keep:
- What the user asked for and what was decided or done, with task titles, repo names and PR numbers.
- Actions the assistant took and their outcome, and anything still waiting on the user.
- Anything the assistant said it would do but has not done yet, so it is not dropped.
- Preferences the user stated.
Leave out greetings, small talk and tool output that no longer matters. States such as running or \
failing CI go stale, so say when they were observed rather than presenting them as current.
Write plain sentences, no markdown. Output only the summary."""


def summarization_config(max_tokens: int) -> LLMAutoContextSummarizationConfig:
    """Pipecat's auto summarization: past `max_tokens`, older turns fold into one summary."""
    return LLMAutoContextSummarizationConfig(
        max_context_tokens=max_tokens,
        max_unsummarized_messages=None,
        summary_config=LLMContextSummaryConfig(
            target_context_tokens=max(SUMMARY_MIN_TOKENS, min(SUMMARY_MAX_TOKENS, max_tokens // 4)),
            min_messages_after_summary=KEEP_RECENT_MESSAGES,
            summarization_prompt=SUMMARY_PROMPT,
            summary_message_template=SUMMARY_TEMPLATE,
            summarization_timeout=SUMMARY_TIMEOUT_SECS,
        ),
    )


def _text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            cast(Mapping[str, Any], part) for part in cast(list[object], content) if isinstance(part, dict)
        ]
        return " ".join(str(part.get("text", "")) for part in parts if part.get("type") == "text")
    return ""


def _tool_calls(message: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    calls = message.get("tool_calls")
    if not isinstance(calls, list):
        return []
    return [cast(Mapping[str, Any], call) for call in cast(list[object], calls) if isinstance(call, dict)]


def is_pending_result(content: object) -> bool:
    """A tool result pipecat has not filled in yet."""
    if content == PENDING_RESULT:
        return True
    if not isinstance(content, str) or not content.startswith("{"):
        return False
    try:
        parsed = json.loads(content)
    except ValueError:
        return False
    return (
        isinstance(parsed, dict) and parsed.get("type") == "async_tool" and parsed.get("status") == "started"
    )


def is_summary(message: Mapping[str, Any]) -> bool:
    content = message.get("content")
    return message.get("role") == "user" and isinstance(content, str) and content.startswith(SUMMARY_PREFIX)


def ends_with_user(messages: Sequence[LLMContextMessage]) -> bool:
    """Whether the messages end with the user's words, past any developer notes after them."""
    for raw in reversed(messages):
        if isinstance(raw, LLMSpecificMessage):
            continue
        message = cast(Mapping[str, Any], raw)
        if message.get("role") != "developer":
            return message.get("role") == "user" and not is_summary(message)
    return False


def valid_tool_pairs[K](items: Sequence[tuple[K, Message]]) -> list[tuple[K, Message]]:
    """What OpenAI accepts: each tool call answered by the tool messages right after it, no strays.

    Calls without a finished result lose their call; results without their call are dropped.
    """
    kept: list[tuple[K, Message]] = []
    i = 0
    while i < len(items):
        key, message = items[i]
        role = message.get("role")
        calls = _tool_calls(message) if role == "assistant" else []
        if role == "tool":
            i += 1
            continue
        if not calls:
            kept.append((key, message))
            i += 1
            continue
        end = i + 1
        while end < len(items) and items[end][1].get("role") == "tool":
            end += 1
        ids = {str(call.get("id")) for call in calls}
        answered: dict[str, tuple[K, Message]] = {}
        for result in items[i + 1 : end]:
            call_id = str(result[1].get("tool_call_id"))
            if call_id in ids and not is_pending_result(result[1].get("content")):
                answered.setdefault(call_id, result)
        done = [dict(call) for call in calls if str(call.get("id")) in answered]
        if done:
            kept.append((key, {**message, "tool_calls": done}))
            kept.extend(answered[str(call["id"])] for call in done)
        elif _text(message.get("content")).strip() != "":
            kept.append((key, {"role": "assistant", "content": message.get("content")}))
        i = end
    return kept


def wire_message(message: Mapping[str, Any]) -> Message | None:
    """The message as Seti stores it, or None when there is nothing to keep."""
    role = message.get("role")
    content = _text(message.get("content"))[:CONTENT_MAX]
    if role in ("user", "developer"):
        return {"role": role, "content": content}
    if role == "tool":
        return {"role": "tool", "tool_call_id": str(message.get("tool_call_id")), "content": content}
    if role != "assistant":
        return None
    calls = [
        {
            "id": str(call.get("id")),
            "type": "function",
            "function": {
                "name": str(cast(Mapping[str, Any], call.get("function") or {}).get("name", "")),
                "arguments": str(cast(Mapping[str, Any], call.get("function") or {}).get("arguments", "{}")),
            },
        }
        for call in _tool_calls(message)
    ]
    if not calls and content.strip() == "":
        return None
    wired: Message = {"role": "assistant", "content": content or None}
    if calls:
        wired["tool_calls"] = calls
    return wired


@dataclass(frozen=True)
class Entry:
    """One stored entry of the conversation."""

    id: int
    kind: str
    message: Message
    through_id: int | None = None


def parse_entries(data: object) -> list[Entry]:
    """Entries from Seti's history page, skipping anything malformed."""
    raw = cast(Mapping[str, Any], data).get("entries") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    entries: list[Entry] = []
    for item in cast(list[object], raw):
        if not isinstance(item, dict):
            continue
        fields = cast(Mapping[str, Any], item)
        entry_id, message, through = fields.get("id"), fields.get("message"), fields.get("through_id")
        if isinstance(entry_id, int) and isinstance(message, dict):
            payload = dict(cast(Mapping[str, Any], message))
            kind = str(fields.get("kind"))
            entries.append(Entry(entry_id, kind, payload, through if isinstance(through, int) else None))
    return entries


class HistorySync:
    """Mirrors one call's or one chat reply's LLM context into Seti's EA history.

    Messages are appended in order at turn boundaries; a tool call waits until its results are in,
    so a hang-up mid-turn never stores half a tool exchange. Summaries from pipecat's compaction
    replace the entries they cover. Writers that share `lock` never interleave their appends.
    """

    def __init__(
        self,
        seti: SetiClient,
        context: LLMContext,
        *,
        lock: asyncio.Lock | None = None,
        kind: Kind = "message",
    ) -> None:
        self._seti = seti
        self._context = context
        self._kind: Kind = kind
        self._stored: dict[int, tuple[LLMContextMessage, int | None]] = {}
        self._calls: dict[int, LLMContextMessage] = {}
        self._covers: dict[int, int] = {}
        self._lock = lock or asyncio.Lock()

    async def load(self) -> bool:
        """Put the stored conversation into the context; True when there was one."""
        try:
            data = await self._seti.get("/ea/history", {"scope": "context"})
        except SetiError as e:
            logger.warning(f"EA history not loaded: {e}")
            return False
        entries = parse_entries(data)
        self._covers = {
            e.id: e.through_id for e in entries if e.kind == "summary" and e.through_id is not None
        }
        items = valid_tool_pairs([(entry.id, entry.message) for entry in entries])
        messages = [cast(LLMContextMessage, message) for _, message in items]
        async with self._lock:
            self._context.set_messages(messages)
            self._stored = {
                id(message): (message, entry_id)
                for (entry_id, _), message in zip(items, messages, strict=True)
            }
        return bool(items)

    def add_call(self, note: str) -> None:
        """The developer note that opens a call; stored as the call's marker."""
        message = cast(LLMContextMessage, {"role": "developer", "content": note})
        self._calls[id(message)] = message
        self._context.add_message(message)

    def add_unstored(self, note: str) -> None:
        """A developer note for this call only, such as the greeting instruction."""
        message = cast(LLMContextMessage, {"role": "developer", "content": note})
        self._stored[id(message)] = (message, None)
        self._context.add_message(message)

    def _unsaved(self, final: bool) -> list[tuple[LLMContextMessage, Kind, Message]]:
        messages = self._context.messages
        results = {
            str(m.get("tool_call_id")): m.get("content")
            for m in (
                cast(Mapping[str, Any], raw) for raw in messages if not isinstance(raw, LLMSpecificMessage)
            )
            if m.get("role") == "tool"
        }
        dropped: set[str] = set()
        batch: list[tuple[LLMContextMessage, Kind, Message]] = []
        for raw in messages:
            if id(raw) in self._stored:
                continue
            if isinstance(raw, LLMSpecificMessage):
                self._stored[id(raw)] = (raw, None)
                continue
            message = cast(Mapping[str, Any], raw)
            if is_summary(message) or is_live_note(message):
                continue
            call_ids = [str(call.get("id")) for call in _tool_calls(message)]
            unfinished = any(c not in results or is_pending_result(results[c]) for c in call_ids)
            pending = message.get("role") == "tool" and (
                is_pending_result(message.get("content")) or str(message.get("tool_call_id")) in dropped
            )
            if unfinished or pending:
                if not final:
                    break
                dropped.update(call_ids)
                self._stored[id(raw)] = (raw, None)
                continue
            wired = wire_message(message)
            if wired is None:
                self._stored[id(raw)] = (raw, None)
                continue
            batch.append((raw, "call" if id(raw) in self._calls else self._kind, wired))
        return batch

    async def flush(
        self, *, final: bool = False, notify: bool = False, asks: Sequence[int] = ()
    ) -> list[Entry]:
        """Append what the context gained since the last flush; at the end, drop unfinished calls.

        With `notify`, Seti keeps the batch's last reply unseen for the user, with the questions in
        `asks`. Returns the entries Seti stored, oldest first; none when there was nothing or it failed.
        """
        async with self._lock:
            batch = self._unsaved(final)
            if not batch:
                return []
            body: dict[str, Any] = {"entries": [{"kind": kind, "message": wired} for _, kind, wired in batch]}
            if notify:
                body["notify"] = True
            if asks:
                body["asks"] = list(asks)
            try:
                data = await self._seti.post("/ea/history/messages", body)
            except SetiError as e:
                logger.warning(f"EA history not saved: {e}")
                return []
            ids = cast(Mapping[str, Any], data).get("ids") if isinstance(data, dict) else None
            if not isinstance(ids, list) or len(cast(list[object], ids)) != len(batch):
                logger.warning("EA history save answered without ids")
                return []
            stored: list[Entry] = []
            for (raw, kind, wired), entry_id in zip(batch, cast(list[int], ids), strict=True):
                self._stored[id(raw)] = (raw, entry_id)
                self._calls.pop(id(raw), None)
                stored.append(Entry(entry_id, kind, wired))
            return stored

    async def merge(self, entries: Sequence[Entry]) -> bool:
        """Add entries the other channel stored to this context; True when any were new here."""
        async with self._lock:
            known = {entry_id for _, entry_id in self._stored.values() if entry_id is not None}
            fresh = [(e.id, e.message) for e in entries if e.id not in known and e.kind != "summary"]
            items = valid_tool_pairs(fresh)
            for entry_id, message in items:
                raw = cast(LLMContextMessage, dict(message))
                self._context.add_message(raw)
                self._stored[id(raw)] = (raw, entry_id)
            return bool(items)

    async def summary_applied(self) -> None:
        """Store the summary pipecat just put in place of the older messages."""
        async with self._lock:
            messages = self._context.messages
            present = {id(m) for m in messages}
            removed = [entry_id for key, (_, entry_id) in self._stored.items() if key not in present]
            self._stored = {key: value for key, value in self._stored.items() if key in present}
            self._calls = {key: value for key, value in self._calls.items() if key in present}
            summary = next(
                (
                    m
                    for m in messages
                    if not isinstance(m, LLMSpecificMessage)
                    and id(m) not in self._stored
                    and is_summary(cast(Mapping[str, Any], m))
                ),
                None,
            )
            if summary is None:
                return
            self._stored[id(summary)] = (summary, None)
            # A summary's own id comes after entries it precedes, so it counts as what it covers.
            covered = [self._covers.get(entry_id, entry_id) for entry_id in removed if entry_id is not None]
            through = max(covered, default=None)
            if through is None:
                return
            content = str(cast(Mapping[str, Any], summary).get("content"))
            try:
                data = await self._seti.put(
                    "/ea/history/summary", {"summary": content, "through_id": through}
                )
            except SetiError as e:
                logger.warning(f"EA history summary not saved: {e}")
                return
            entry_id = cast(Mapping[str, Any], data).get("id") if isinstance(data, dict) else None
            if isinstance(entry_id, int):
                self._stored[id(summary)] = (summary, entry_id)
                self._covers[entry_id] = through
            logger.info(f"EA history compacted through entry {through}")

    async def reset(self) -> None:
        """Forget the conversation after the user started a new one."""
        async with self._lock:
            self._context.set_messages([])
            self._stored.clear()
            self._calls.clear()
            self._covers.clear()
