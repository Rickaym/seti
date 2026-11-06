import json
from types import SimpleNamespace
from typing import Any, cast

from fakes import NOW, FakeSeti, settings
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.adapters.services.open_ai_adapter import OpenAILLMAdapter, OpenAILLMInvocationParams
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.llm_service import FunctionCallParams
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy

from seti_ea.bot import (
    UNFINISHED_TURN_SECS,
    action_message,
    filler_frame,
    keyterms,
    openai_llm,
    put_to_sleep,
    sleep_schema,
    smart_turn,
    tool_schemas,
    turn_stop_strategies,
    voice_text_filter,
)
from seti_ea.clock import TimeNotes, parse_user_clock
from seti_ea.prompt import GREETING, SYSTEM_PROMPT
from seti_ea.toolkit import ToolResult
from seti_ea.tools import TOOL_SPECS, EaTools
from seti_ea.wake import WakeSettings, WakeStrategy, wake_message


async def test_tool_handlers_answer_the_llm_and_report_to_the_ui(tools: EaTools, fake_seti: FakeSeti) -> None:
    reports: list[dict[str, Any]] = []
    results: list[str] = []

    async def report(tool: str, result: ToolResult, _call_id: str) -> None:
        reports.append(action_message(tool, result))

    async def result_callback(result: str) -> None:
        results.append(result)

    schemas = {schema.name: schema for schema in tool_schemas(tools, report)}
    assert list(schemas) == [spec.name for spec in TOOL_SPECS]
    handler = schemas["stop_task"].handler
    assert handler is not None

    params = SimpleNamespace(
        arguments={"task": "logout"}, tool_call_id="call-1", result_callback=result_callback
    )
    await handler(cast(FunctionCallParams, params))
    params = SimpleNamespace(
        arguments={"task": "login"}, tool_call_id="call-1", result_callback=result_callback
    )
    await handler(cast(FunctionCallParams, params))

    assert reports == [
        {
            "type": "ea-action",
            "tool": "stop_task",
            "summary": "Fix the logout button was not running",
            "ok": False,
        },
        {
            "type": "ea-action",
            "tool": "stop_task",
            "summary": "Stopped Fix the login redirect bug",
            "ok": True,
        },
    ]
    assert results == [
        "Fix the logout button is not running; it is idle. Nothing to stop.",
        "Stopped Fix the login redirect bug. It is now stopped.",
    ]
    assert len(fake_seti.posts()) == 1


async def test_unexpected_tool_errors_are_reported_not_raised() -> None:
    reports: list[dict[str, Any]] = []
    results: list[str] = []

    class Broken(EaTools):
        async def call(self, name: str, args: Any) -> ToolResult:
            raise RuntimeError("bug")

    async def report(tool: str, result: ToolResult, _call_id: str) -> None:
        reports.append(action_message(tool, result))

    async def result_callback(result: str) -> None:
        results.append(result)

    broken = Broken(cast(Any, None))
    handler = tool_schemas(broken, report)[0].handler
    assert handler is not None
    await handler(
        cast(
            FunctionCallParams,
            SimpleNamespace(arguments={}, tool_call_id="call-1", result_callback=result_callback),
        )
    )
    assert reports == [
        {"type": "ea-action", "tool": "list_tasks", "summary": "list_tasks failed", "ok": False}
    ]
    assert results == ["The tool failed unexpectedly."]


async def ignore_report(_tool: str, _result: ToolResult, _call_id: str) -> None:
    return None


def test_tools_convert_to_openai_function_definitions(tools: EaTools) -> None:
    schema = ToolsSchema(standard_tools=tool_schemas(tools, ignore_report))
    converted = [dict(tool) for tool in OpenAILLMAdapter().to_provider_tools_format(schema)]
    assert [tool["type"] for tool in converted] == ["function"] * len(TOOL_SPECS)
    functions = [cast(dict[str, Any], tool["function"]) for tool in converted]
    assert [f["name"] for f in functions] == [spec.name for spec in TOOL_SPECS]
    for spec, function in zip(TOOL_SPECS, functions, strict=True):
        assert function["description"] == spec.description
        assert function["parameters"] == {
            "type": "object",
            "properties": spec.properties,
            "required": spec.required,
        }
        assert set(spec.required) <= set(spec.properties)
        for prop in spec.properties.values():
            assert prop["type"] in {"string", "boolean", "array", "integer"}
            assert prop["description"]
            if prop["type"] == "array":
                assert prop["items"] in ({"type": "string"}, {"type": "integer"})
    assert json.loads(json.dumps(converted)) == converted


async def test_openai_request_carries_prompt_greeting_and_tools(tools: EaTools) -> None:
    context = LLMContext(tools=ToolsSchema(standard_tools=tool_schemas(tools, ignore_report)))
    started = TimeNotes(parse_user_clock({"timezone": "Asia/Singapore"})).call_started(NOW)
    context.add_message({"role": "developer", "content": started})
    context.add_message({"role": "developer", "content": GREETING})
    params = await OpenAILLMAdapter().get_llm_invocation_params(
        context, system_instruction=SYSTEM_PROMPT, convert_developer_to_user=False
    )
    assert params["messages"] == [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "developer",
            "content": "A new call started. The user's local time is Sunday 27 September 2026, 20:00 "
            "(Asia/Singapore), evening for them.",
        },
        {"role": "developer", "content": GREETING},
    ]
    sent = params["tools"]
    assert isinstance(sent, list)
    assert len(sent) == len(TOOL_SPECS)


def test_keyterms_always_boost_seti_and_the_wake_phrase_while_it_is_on() -> None:
    assert keyterms(WakeSettings()) == ["Seti"]
    assert keyterms(WakeSettings(phrase="OK Computer")) == ["Seti"]
    assert keyterms(WakeSettings(enabled=True, phrase="Hey Seti")) == ["Seti", "Hey Seti"]
    assert keyterms(WakeSettings(enabled=True, phrase="seti")) == ["Seti"]


async def test_going_to_sleep_tells_the_ui_and_retunes_for_the_phrase() -> None:
    wake = WakeStrategy(WakeSettings())
    sent: list[dict[str, Any]] = []
    retuned: list[list[str]] = []

    async def announce() -> None:
        sent.append(wake_message(wake))

    async def retune(terms: list[str]) -> None:
        retuned.append(terms)

    result = await put_to_sleep(wake, announce, retune)
    assert result.summary == "Asleep for this call until Hey Seti"
    assert sent == [
        {"type": "ea-wake", "enabled": True, "awake": False, "phrase": "Hey Seti", "local": False}
    ]
    assert retuned == [["Seti", "Hey Seti"]]

    await put_to_sleep(wake, announce, retune)
    assert len(sent) == 2
    assert len(retuned) == 1


async def test_the_sleep_tool_reports_and_keeps_the_llm_quiet() -> None:
    reports: list[dict[str, Any]] = []
    answers: list[tuple[str, FunctionCallResultProperties | None]] = []

    async def fall_asleep() -> ToolResult:
        return ToolResult("The EA is asleep until the user says Hey Seti.", "Asleep until Hey Seti")

    async def report(tool: str, result: ToolResult, _call_id: str) -> None:
        reports.append(action_message(tool, result))

    async def result_callback(result: str, *, properties: FunctionCallResultProperties | None = None) -> None:
        answers.append((result, properties))

    schema = sleep_schema(fall_asleep, report)
    assert schema.name == "go_to_sleep"
    assert schema.properties == {}
    assert schema.handler is not None
    await schema.handler(
        cast(
            FunctionCallParams,
            SimpleNamespace(arguments={}, tool_call_id="call-1", result_callback=result_callback),
        )
    )
    assert reports == [
        {"type": "ea-action", "tool": "go_to_sleep", "summary": "Asleep until Hey Seti", "ok": True}
    ]
    [(text, properties)] = answers
    assert text == "The EA is asleep until the user says Hey Seti."
    assert properties is not None
    assert properties.run_llm is False


def test_the_prompt_covers_sleep_and_queued_messages() -> None:
    assert "call go_to_sleep on its own" in SYSTEM_PROMPT
    for said in ('"go to sleep"', '"that\'s all for now"', '"stand by"', '"thanks, that\'s it"'):
        assert said in SYSTEM_PROMPT
    assert "Messaging a task needs no confirmation, even while it runs a turn" in SYSTEM_PROMPT
    assert "Before start_task, stop_task or a public post_team_chat, say" in SYSTEM_PROMPT
    assert "send_to_task" not in SYSTEM_PROMPT
    assert "Messaging an idle task" not in SYSTEM_PROMPT


def test_filler_lines_are_spoken_but_kept_out_of_the_llm_context() -> None:
    frame = filler_frame("One moment.")
    assert frame.text == "One moment."
    assert frame.append_to_context is False


async def test_voice_filter_strips_markdown_before_speech() -> None:
    spoken = await voice_text_filter().filter(
        "**Service Resilience is mixed.** Its agent reported `#2248` ready; see **PII Issues**."
    )
    assert "*" not in spoken
    assert "`" not in spoken
    assert "Service Resilience is mixed." in spoken


def test_voice_rules_forbid_markdown_even_after_typed_turns() -> None:
    assert "even when earlier turns were typed in the chat" in SYSTEM_PROMPT
    assert "Never use markdown" in SYSTEM_PROMPT


def test_the_ea_is_told_to_sound_natural_and_not_copy_terse_notes() -> None:
    assert "# How you sound" in SYSTEM_PROMPT
    assert "Never copy their style" in SYSTEM_PROMPT


def test_the_llm_turns_reasoning_off_unless_left_to_the_model() -> None:
    invocation = cast(OpenAILLMInvocationParams, {"messages": []})
    params = openai_llm(settings(openai_api_key="op"), "gpt-6-luna").build_chat_completion_params(invocation)
    assert params["model"] == "gpt-6-luna"
    assert params["reasoning_effort"] == "none"
    legacy = settings(openai_api_key="op", reasoning_effort="default")
    assert "reasoning_effort" not in openai_llm(legacy, "gpt-4.1").build_chat_completion_params(invocation)


def test_smart_turn_ends_the_users_turn_and_waits_longer_on_an_unfinished_one() -> None:
    [strategy] = turn_stop_strategies()
    assert isinstance(strategy, TurnAnalyzerUserTurnStopStrategy)
    assert smart_turn().params.stop_secs == UNFINISHED_TURN_SECS > 3
