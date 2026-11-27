"""Manual check, not run in CI: three real EA turns against a model endpoint on the Responses API.

Usage (from ea/): uv run python scripts/endpoint_check.py --key-file <file.json> --model <deployment>

The key file is JSON with `endpoint` (the resource URL) and `key1` or `key`. The key is read here
only, sent only to that endpoint, and scrubbed from anything printed. Usage reaches no Seti.
"""

import argparse
import asyncio
import contextlib
import json
import time
from pathlib import Path
from typing import Any

import httpx
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.services.llm_service import FunctionCallParams

from seti_ea.chat import run_reply
from seti_ea.config import Settings
from seti_ea.llm import check_endpoint, model_llm
from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.tools import TOOL_SPECS
from seti_ea.usage import UsageObserver, UsageRecorder

RELAY_RESULT = "Sent a direct message to Dashboard release; it joins its running turn."
CUT_AFTER_SECS = 20.0


def load_key(path: Path) -> tuple[str, str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return str(data["endpoint"]).rstrip("/"), str(data.get("key1") or data["key"])


def settings_for(endpoint: str, key: str, model: str, effort: str) -> Settings:
    return Settings(
        deepgram_api_key="",
        openai_api_key="",
        elevenlabs_api_key="",
        elevenlabs_voice_id="",
        elevenlabs_model="",
        model=model,
        turn_key_id="",
        turn_api_token="",
        seti_api="http://127.0.0.1:9",
        port=0,
        env_file=Path("/nonexistent"),
        reasoning_effort=effort,
        think_model=model,
        think_effort=effort,
        llm_api="responses",
        llm_base_url=f"{endpoint}/openai/v1/",
        llm_api_key=key,
    )


def relay_tools(calls: list[list[Any]]) -> ToolsSchema:
    async def handler(params: FunctionCallParams) -> None:
        calls.append([params.function_name, dict(params.arguments)])
        await params.result_callback(RELAY_RESULT)

    schemas = [
        FunctionSchema(
            name=spec.name,
            description=spec.description,
            properties=spec.properties,
            required=spec.required,
            handler=handler,
        )
        for spec in TOOL_SPECS
        if spec.name in ("post_team_chat", "list_tasks")
    ]
    return ToolsSchema(standard_tools=list(schemas))


class Turn:
    """Runs one reply and times its first word and its end."""

    def __init__(self, settings: Settings, usage: UsageObserver, scrub: Any) -> None:
        self._settings = settings
        self._usage = usage
        self._scrub = scrub
        self.first_text = asyncio.Event()

    async def run(self, context: LLMContext) -> dict[str, Any]:
        texts: list[str] = []
        start = time.perf_counter()
        first: list[int] = []

        def emit(event: dict[str, Any]) -> None:
            if event.get("type") == "text":
                if not first:
                    first.append(round((time.perf_counter() - start) * 1000))
                    self.first_text.set()
                texts.append(str(event.get("delta", "")))

        llm = model_llm(self._settings, self._settings.model, SYSTEM_PROMPT)
        error = await run_reply(context, llm, emit, self._usage, lambda _note: None)
        return {
            "first_text_ms": first[0] if first else None,
            "total_ms": round((time.perf_counter() - start) * 1000),
            "error": self._scrub(error) if error else None,
            "reply": "".join(texts),
        }


async def cut_point(context: LLMContext, first_text: asyncio.Event) -> None:
    """Returns once the model's reasoning reached the context or it began to speak: a barge-in."""
    while not first_text.is_set():
        if any(isinstance(m, LLMSpecificMessage) for m in context.messages):
            return
        await asyncio.sleep(0.005)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key-file", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--effort", default="low")
    args = parser.parse_args()
    endpoint, key = load_key(args.key_file)

    def scrub(text: str) -> str:
        return str(text).replace(key, "<key>")

    settings = settings_for(endpoint, key, args.model, args.effort)
    seti = SetiClient(
        settings.seti_api, transport=httpx.MockTransport(lambda _r: httpx.Response(200, json={}))
    )
    turn = Turn(settings, UsageObserver(UsageRecorder(seti), "chat"), scrub)
    report: dict[str, Any] = {"host": settings.llm_host, "model": args.model, "effort": args.effort}

    start = time.perf_counter()
    problem = await check_endpoint(settings)
    report["start_check"] = {"ms": round((time.perf_counter() - start) * 1000), "problem": problem}

    plain = LLMContext(messages=[{"role": "user", "content": "In one sentence, what does a merge queue do?"}])
    report["plain"] = await turn.run(plain)

    calls: list[list[Any]] = []
    relay = LLMContext(
        messages=[{"role": "user", "content": "Tell Dashboard release to rebase on main."}],
        tools=relay_tools(calls),
    )
    report["relay"] = {**await turn.run(relay), "calls": calls}

    context = LLMContext(messages=[{"role": "user", "content": "Give me a long history of version control."}])
    turn.first_text = asyncio.Event()
    cut_at = time.perf_counter()
    cut = asyncio.ensure_future(turn.run(context))
    waiter = asyncio.ensure_future(cut_point(context, turn.first_text))
    await asyncio.wait([cut, waiter], timeout=CUT_AFTER_SECS, return_when=asyncio.FIRST_COMPLETED)
    report["cut"] = {
        "before_text": not turn.first_text.is_set(),
        "ms": round((time.perf_counter() - cut_at) * 1000),
        "reasoning_items": sum(isinstance(m, LLMSpecificMessage) for m in context.messages),
    }
    cut.cancel()
    waiter.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await cut
    left = [m.message.get("type") for m in context.messages if isinstance(m, LLMSpecificMessage)]
    context.add_message({"role": "user", "content": "Stop. Just tell me what git is, in one sentence."})
    report["interrupted_then_next"] = {**await turn.run(context), "reasoning_items_left": left}
    print(scrub(json.dumps(report, indent=1)))


if __name__ == "__main__":
    asyncio.run(main())
