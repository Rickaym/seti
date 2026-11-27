"""The EA's model service and client: Chat Completions or the Responses API, at the chosen endpoint."""

from collections.abc import Mapping, Sequence
from typing import Any, cast

from loguru import logger
from openai import (
    AsyncOpenAI,
    AuthenticationError,
    BadRequestError,
    NotFoundError,
    OpenAIError,
    PermissionDeniedError,
)
from pipecat.adapters.llm.services.open_ai_responses_adapter import OpenAIResponsesLLMAdapter
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage, LLMSpecificMessage
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.responses.llm import OpenAIResponsesHttpLLMService

from seti_ea.config import MODEL_DEFAULT_EFFORT, Settings
from seti_ea.prompt import SYSTEM_PROMPT

# Reasoning tokens count against a Responses reply's output cap, so a short summary needs room.
REASONING_HEADROOM_TOKENS = 4000

PROBE_TOOL: Any = {
    "type": "function",
    "name": "probe",
    "description": "Does nothing.",
    "parameters": {"type": "object", "properties": {}},
    "strict": False,
}
REFUSALS = (BadRequestError, AuthenticationError, PermissionDeniedError, NotFoundError)

ResponsesSettings = OpenAIResponsesHttpLLMService.Settings
ReasoningConfig = OpenAIResponsesHttpLLMService.ReasoningConfig


def openai_client(settings: Settings) -> AsyncOpenAI:
    """A client for the chosen endpoint with its own key; OpenAI's when no base URL is set."""
    return AsyncOpenAI(api_key=settings.model_api_key, base_url=settings.llm_base_url or None)


def reasoning_of(settings: Settings) -> ReasoningConfig | None:
    """The Responses reasoning setting; None leaves the effort to the model."""
    if settings.reasoning_effort == MODEL_DEFAULT_EFFORT:
        return None
    return ReasoningConfig(effort=cast(Any, settings.reasoning_effort))


def _is_reasoning(item: object) -> bool:
    return isinstance(item, Mapping) and cast(Mapping[str, Any], item).get("type") == "reasoning"


def _is_output(item: object) -> bool:
    if not isinstance(item, Mapping):
        return False
    entry = cast(Mapping[str, Any], item)
    return entry.get("type") == "function_call" or entry.get("role") == "assistant"


def answered_reasoning(items: Sequence[object]) -> list[object]:
    """Drops reasoning items no answer follows, as a reply cut off before its first word leaves.

    The Responses API refuses a reasoning item that is not followed by the output it produced.
    """
    kept: list[object] = []
    answered = False
    for item in reversed(items):
        if _is_reasoning(item):
            if answered:
                kept.append(item)
            continue
        answered = _is_output(item)
        kept.append(item)
    kept.reverse()
    return kept


def _said_beside_calls(message: LLMContextMessage) -> str | None:
    if isinstance(message, LLMSpecificMessage):
        return None
    entry = cast(Mapping[str, Any], message)
    content = entry.get("content")
    if entry.get("role") == "assistant" and entry.get("tool_calls") and isinstance(content, str) and content:
        return content
    return None


class ResponsesAdapter(OpenAIResponsesLLMAdapter):
    """Pipecat's Responses adapter, keeping words an assistant message holds beside its tool calls."""

    def _convert_messages_to_input(self, messages: list[LLMContextMessage]) -> Any:
        split: list[LLMContextMessage] = []
        for message in messages:
            said = _said_beside_calls(message)
            if said is not None:
                split.append(cast(LLMContextMessage, {"role": "assistant", "content": said}))
                message = cast(LLMContextMessage, {**cast(Mapping[str, Any], message), "content": None})
            split.append(message)
        return super()._convert_messages_to_input(split)


class ResponsesLLM(OpenAIResponsesHttpLLMService):
    """Pipecat's Responses HTTP service, sending only reasoning that an answer follows."""

    adapter_class = ResponsesAdapter

    def _build_response_params(self, invocation_params: Any) -> dict[str, Any]:
        params = super()._build_response_params(invocation_params)
        params["input"] = answered_reasoning(params["input"])
        return params

    async def run_inference(
        self,
        context: LLMContext,
        max_tokens: int | None = None,
        system_instruction: str | None = None,
        response_schema: dict[str, Any] | None = None,
    ) -> str | None:
        room = None if max_tokens is None else max_tokens + REASONING_HEADROOM_TOKENS
        return await super().run_inference(context, room, system_instruction, response_schema)


ModelLLM = OpenAILLMService | ResponsesLLM


def model_llm(settings: Settings, model: str, system: str = SYSTEM_PROMPT) -> ModelLLM:
    """The EA's service for `model` on the chosen API and endpoint, with its reasoning effort."""
    base_url = settings.llm_base_url or None
    if settings.llm_api == "responses":
        reasoning = reasoning_of(settings)
        return ResponsesLLM(
            api_key=settings.model_api_key,
            base_url=base_url,
            settings=ResponsesSettings(
                model=model,
                system_instruction=system,
                reasoning=reasoning,
                use_provider_thinking_default=reasoning is None,
            ),
        )
    return OpenAILLMService(
        api_key=settings.model_api_key,
        base_url=base_url,
        settings=OpenAILLMService.Settings(model=model, system_instruction=system, extra=settings.llm_params),
    )


def _probes(settings: Settings) -> list[tuple[str, str]]:
    pairs = [
        (settings.model, settings.reasoning_effort),
        (settings.chat_model, settings.reasoning_effort),
        (settings.think_model, settings.think_effort),
    ]
    return list(dict.fromkeys(pairs))


async def check_endpoint(settings: Settings, client: AsyncOpenAI | None = None) -> str | None:
    """On the Responses API, asks once per model and effort the EA uses; why one was refused.

    An endpoint that cannot be reached is only logged, so a network blip does not stop the EA.
    """
    if settings.llm_api != "responses" or settings.model_api_key == "":
        return None
    api = client or openai_client(settings)
    for model, effort in _probes(settings):
        reasoning: Any = {} if effort == MODEL_DEFAULT_EFFORT else {"reasoning": {"effort": effort}}
        try:
            await api.responses.create(
                model=model,
                input="Say OK.",
                max_output_tokens=16,
                store=False,
                tools=[PROBE_TOOL],
                **reasoning,
            )
        except REFUSALS as e:
            return (
                f"{settings.llm_host} refused model {model} at reasoning effort {effort}: {e.message} "
                "Check EA_MODEL, EA_TEXT_MODEL, EA_THINK_MODEL and the efforts in EA_REASONING_EFFORT "
                "and EA_THINK_EFFORT; the lowest effort a model accepts is often low."
            )
        except OpenAIError as e:
            logger.warning(f"EA model endpoint {settings.llm_host} not checked: {type(e).__name__}")
            return None
    return None
