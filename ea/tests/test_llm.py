import asyncio
import contextlib
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from fakes import settings
from openai import APIConnectionError, BadRequestError
from pipecat.adapters.llm.services.open_ai_adapter import OpenAILLMInvocationParams
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.services.openai.llm import OpenAILLMService
from test_chat import Script, ScriptedResponsesLLM, client_for, events_of, make_chat, stored, texts

from seti_ea import server
from seti_ea.chat import run_reply
from seti_ea.config import load_settings
from seti_ea.conversation import Conversation
from seti_ea.llm import (
    REASONING_HEADROOM_TOKENS,
    ResponsesLLM,
    answered_reasoning,
    check_endpoint,
    model_llm,
    openai_client,
)
from seti_ea.seti import SetiClient
from seti_ea.usage import UsageObserver, UsageRecorder

KEYS_ENV = {"OPENAI_API_KEY": "sk-openai-key-123456"}
ENDPOINT = "https://models.example.test/openai/v1/"
RESPONSES = {"llm_api": "responses", "llm_base_url": ENDPOINT, "llm_api_key": "endpoint-key-123456"}


def test_without_the_new_settings_the_ea_talks_to_openai_on_chat_completions(tmp_path: Path) -> None:
    config = load_settings({"SETI_EA_ENV": str(tmp_path / "absent.env"), **KEYS_ENV})
    assert (config.llm_api, config.llm_base_url, config.llm_host) == ("chat", "", "api.openai.com")
    assert config.model_api_key == config.openai_api_key
    assert config.config_error is None
    llm = model_llm(config, config.model)
    assert type(llm) is OpenAILLMService
    client = llm._client  # pyright: ignore[reportPrivateUsage]
    assert str(client.base_url) == "https://api.openai.com/v1/"
    assert client.api_key == config.openai_api_key
    invocation = cast(OpenAILLMInvocationParams, {"messages": []})
    params = llm.build_chat_completion_params(invocation)
    assert (params["model"], params["reasoning_effort"]) == ("gpt-6-sol", "none")
    assert "reasoning" not in params
    assert "store" not in params


def test_another_endpoint_takes_its_own_key_and_never_the_openai_one(tmp_path: Path) -> None:
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    (credentials / "ea-llm-api-key").write_text("endpoint-key-123456\n")
    env = {
        "SETI_EA_ENV": str(tmp_path / "absent.env"),
        "CREDENTIALS_DIRECTORY": str(credentials),
        "OPENAI_API_KEY": "sk-openai-key-123456",
        "EA_LLM_API": "Responses",
        "EA_LLM_BASE_URL": ENDPOINT,
    }
    config = load_settings(env)
    assert (config.llm_api, config.llm_host) == ("responses", "models.example.test")
    assert config.model_api_key == "endpoint-key-123456"
    assert "endpoint-key-123456" not in repr(config)
    assert "models.example.test" in repr(config)
    unkeyed = load_settings({**env, "CREDENTIALS_DIRECTORY": str(tmp_path / "none")})
    assert unkeyed.chat_missing == ["EA_LLM_API_KEY"]
    assert "EA_LLM_API_KEY" in unkeyed.missing
    assert openai_client(config).api_key == "endpoint-key-123456"
    assert str(openai_client(config).base_url) == ENDPOINT


def test_an_unknown_api_or_a_base_url_without_a_scheme_stops_the_start(tmp_path: Path) -> None:
    env = {"SETI_EA_ENV": str(tmp_path / "absent.env")}
    assert "EA_LLM_API" in str(load_settings({**env, "EA_LLM_API": "completions"}).config_error)
    assert "EA_LLM_BASE_URL" in str(load_settings({**env, "EA_LLM_BASE_URL": "models.test/v1"}).config_error)


async def test_the_responses_path_sends_its_effort_as_reasoning_and_stores_nothing() -> None:
    llm = model_llm(settings(**RESPONSES, reasoning_effort="low"), "deployment-a")
    assert isinstance(llm, ResponsesLLM)
    assert str(llm._client.base_url) == ENDPOINT  # pyright: ignore[reportPrivateUsage]
    assert llm._client.api_key == "endpoint-key-123456"  # pyright: ignore[reportPrivateUsage]
    invocation = await llm.get_llm_adapter().get_llm_invocation_params(
        LLMContext(messages=[{"role": "user", "content": "Hi"}]), system_instruction="Be brief."
    )
    params = llm._build_response_params(invocation)  # pyright: ignore[reportPrivateUsage]
    assert params["reasoning"] == {"effort": "low"}
    assert params["include"] == ["reasoning.encrypted_content"]
    assert (params["store"], params["model"], params["instructions"]) == (False, "deployment-a", "Be brief.")
    assert "reasoning_effort" not in params


async def test_default_effort_on_the_responses_path_leaves_reasoning_to_the_model() -> None:
    llm = model_llm(settings(**RESPONSES, reasoning_effort="default"), "gpt-6-sol")
    assert isinstance(llm, ResponsesLLM)
    invocation = await llm.get_llm_adapter().get_llm_invocation_params(
        LLMContext(messages=[{"role": "user", "content": "Hi"}])
    )
    assert "reasoning" not in llm._build_response_params(invocation)  # pyright: ignore[reportPrivateUsage]


def test_reasoning_with_no_answer_after_it_is_left_out() -> None:
    user = {"role": "user", "content": "Hi"}
    thought = {"type": "reasoning", "id": "rs-1"}
    call = {"type": "function_call", "call_id": "c1", "name": "x", "arguments": "{}"}
    answer = {"role": "assistant", "content": "Hello"}
    assert answered_reasoning([user, thought, user]) == [user, user]
    assert answered_reasoning([user, thought]) == [user]
    assert answered_reasoning([user, thought, thought, user]) == [user, user]
    assert answered_reasoning([user, thought, call]) == [user, thought, call]
    assert answered_reasoning([user, thought, thought, answer]) == [user, thought, thought, answer]


async def test_a_call_cut_off_before_its_first_word_leaves_no_reasoning_behind(fake_seti: Any) -> None:
    hold = asyncio.Event()
    script = Script([[hold], ["Three tasks."]])
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
    usage = UsageObserver(UsageRecorder(seti), "voice")
    context = LLMContext(messages=[{"role": "user", "content": "How busy are we?"}])

    cut = asyncio.ensure_future(run_reply(context, ScriptedResponsesLLM(script, "a"), print, usage, print))
    await asyncio.sleep(0.2)
    cut.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await cut
    assert isinstance(context.messages[-1], LLMSpecificMessage)
    context.add_message({"role": "user", "content": "And now?"})
    said: list[dict[str, Any]] = []
    await run_reply(context, ScriptedResponsesLLM(script, "a"), said.append, usage, print)

    assert [event["delta"] for event in said if event["type"] == "text"] == ["Three tasks."]
    assert [item.get("type") or item.get("role") for item in script.inputs[1]] == ["user", "user"]


async def test_words_said_before_a_tool_call_reach_the_next_request_and_the_history(fake_seti: Any) -> None:
    script = Script([["Let me look. ", ("call-1", "list_tasks", {"status": "running"})], ["One is running."]])
    chat = make_chat(fake_seti, script, Conversation(), llm_api="responses")

    events = await events_of(chat, "What is running?")

    assert texts(events) == "Let me look. One is running."
    second = script.inputs[1]
    kinds = [item.get("type") or item.get("role") for item in second]
    assert kinds[-5:] == ["user", "reasoning", "assistant", "function_call", "function_call_output"]
    assert second[-3] == {"role": "assistant", "content": "Let me look."}
    assert {"role": "assistant", "content": "Let me look."} in [m for _, m in stored(fake_seti)]


async def test_words_beside_tool_calls_in_restored_history_are_not_dropped(fake_seti: Any) -> None:
    call = {"id": "call-0", "type": "function", "function": {"name": "list_tasks", "arguments": "{}"}}
    fake_seti.ea_append("message", {"role": "user", "content": "Anything running?"})
    fake_seti.ea_append("message", {"role": "assistant", "content": "Checking.", "tool_calls": [call]})
    fake_seti.ea_append("message", {"role": "tool", "tool_call_id": "call-0", "content": "None."})
    fake_seti.ea_append("message", {"role": "assistant", "content": "Nothing runs."})
    script = Script([["Still nothing."]])
    chat = make_chat(fake_seti, script, Conversation(), llm_api="responses")

    await events_of(chat, "And now?")

    first = script.inputs[0]
    said = first.index({"role": "assistant", "content": "Checking."})
    assert first[said + 1]["type"] == "function_call"
    assert first[said + 2] == {"type": "function_call_output", "call_id": "call-0", "output": "None."}


async def test_a_summary_on_the_responses_path_leaves_room_for_reasoning() -> None:
    llm = model_llm(settings(**RESPONSES, reasoning_effort="low"), "deployment-a")
    sent: list[dict[str, Any]] = []

    async def create(**params: Any) -> Any:
        sent.append(params)
        return SimpleNamespace(output_text="A summary.")

    llm._client.responses.create = create  # pyright: ignore[reportPrivateUsage, reportAttributeAccessIssue]
    context = LLMContext(messages=[{"role": "user", "content": "History"}])
    assert await llm.run_inference(context, max_tokens=256, system_instruction="Summarise.") == "A summary."
    assert sent[0]["max_output_tokens"] == 256 + REASONING_HEADROOM_TOKENS
    assert (sent[0]["stream"], sent[0]["reasoning"]) == (False, {"effort": "low"})


class FakeResponses:
    def __init__(self, refuse: str | None = None, offline: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self._refuse = refuse
        self._offline = offline

    async def create(self, **params: Any) -> Any:
        self.calls.append(params)
        request = httpx.Request("POST", ENDPOINT + "responses")
        if self._offline:
            raise APIConnectionError(request=request)
        if params.get("reasoning", {}).get("effort") == self._refuse:
            response = httpx.Response(400, request=request)
            raise BadRequestError("Unsupported value: 'none'.", response=response, body=None)
        return SimpleNamespace(output_text="OK")


def fake_client(responses: FakeResponses) -> Any:
    return SimpleNamespace(responses=responses)


async def test_an_effort_the_endpoint_refuses_stops_the_start_with_the_setting_to_change() -> None:
    responses = FakeResponses(refuse="none")
    config = settings(**RESPONSES, reasoning_effort="none", think_model="deployment-a")
    problem = await check_endpoint(config, fake_client(responses))
    assert problem is not None
    assert "models.example.test refused model gpt-6-sol at reasoning effort none" in problem
    assert "EA_REASONING_EFFORT" in problem
    assert "endpoint-key" not in problem


async def test_the_start_check_asks_once_per_model_and_effort_and_passes_good_ones() -> None:
    responses = FakeResponses(refuse="none")
    config = settings(**RESPONSES, reasoning_effort="low", think_model="gpt-6-sol", think_effort="low")
    assert await check_endpoint(config, fake_client(responses)) is None
    assert [(c["model"], c["reasoning"]) for c in responses.calls] == [("gpt-6-sol", {"effort": "low"})]
    assert all(c["store"] is False and c["tools"] for c in responses.calls)


async def test_the_start_check_skips_chat_completions_and_survives_an_unreachable_endpoint() -> None:
    responses = FakeResponses(offline=True)
    assert await check_endpoint(settings(openai_api_key="sk-x"), fake_client(responses)) is None
    assert responses.calls == []
    assert await check_endpoint(settings(**RESPONSES), fake_client(responses)) is None
    assert len(responses.calls) == 1


@pytest.mark.parametrize(
    ("overrides", "api", "host"),
    [({}, "chat", "api.openai.com"), (RESPONSES, "responses", "models.example.test")],
)
async def test_health_names_the_api_and_only_the_host(overrides: dict[str, str], api: str, host: str) -> None:
    app = server.create_app(settings(**overrides))
    async with client_for(app) as client:
        body = (await client.get("/health")).json()
    assert (body["llm_api"], body["llm_host"]) == (api, host)
    assert "openai/v1" not in str(body)
