"""A Responses API stream played from a script, for the EA's Responses path."""

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Any, cast

from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseReasoningItem,
    ResponseTextDeltaEvent,
)


@dataclass(frozen=True)
class Thought:
    """A reasoning item the fake model sends before anything else in its reply."""

    id: str


def text_event(delta: str) -> ResponseTextDeltaEvent:
    return ResponseTextDeltaEvent.model_construct(
        type="response.output_text.delta", delta=delta, item_id="msg"
    )


def reasoning_event(item_id: str) -> ResponseOutputItemDoneEvent:
    item = ResponseReasoningItem.model_construct(
        id=item_id, type="reasoning", summary=[], encrypted_content=f"enc-{item_id}"
    )
    return ResponseOutputItemDoneEvent.model_construct(type="response.output_item.done", item=item)


def call_events(call_id: str, name: str, arguments: dict[str, Any]) -> list[Any]:
    added = ResponseFunctionToolCall.model_construct(
        id=f"fc-{call_id}", call_id=call_id, name=name, arguments="", type="function_call"
    )
    done = ResponseFunctionToolCall.model_construct(
        id=f"fc-{call_id}", call_id=call_id, name=name, arguments=json.dumps(arguments), type="function_call"
    )
    return [
        ResponseOutputItemAddedEvent.model_construct(type="response.output_item.added", item=added),
        ResponseOutputItemDoneEvent.model_construct(type="response.output_item.done", item=done),
    ]


def completed_event() -> ResponseCompletedEvent:
    response = Response.model_construct(id="resp", model="gpt-test", output=[], usage=None)
    return ResponseCompletedEvent.model_construct(type="response.completed", response=response)


async def play(steps: Sequence[object]) -> AsyncIterator[Any]:
    """Streams text, `(call_id, name, arguments)` calls, thoughts, and waits on events."""
    for step in steps:
        if isinstance(step, asyncio.Event):
            await step.wait()
        elif isinstance(step, Thought):
            yield reasoning_event(step.id)
        elif isinstance(step, str):
            yield text_event(step)
        else:
            call_id, name, arguments = cast(tuple[str, str, dict[str, Any]], step)
            for event in call_events(call_id, name, arguments):
                yield event
    yield completed_event()
