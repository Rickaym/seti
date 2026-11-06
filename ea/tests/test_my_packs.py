from typing import Any

import httpx
import pytest
from fakes import PACK_TRIAGE, FakeSeti
from pipecat.frames.frames import Frame, LLMContextFrame, LLMUpdateSettingsFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from test_chat import Script, events_of, make_chat

from seti_ea.conversation import Conversation
from seti_ea.live_context import LiveContext, LiveContextInjector
from seti_ea.packs import CHAT_TIMEOUT_SECS, PackPrompt, SystemPromptUpdates, system_prompt
from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.seti import SetiClient
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools

CHECKLIST = "3785dbaf-4f57-4752-ba91-9b95f4c6fc19"
STAFF = "4b2e8f6a-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
OTHER_ROLE = "5e710000-0000-4000-8000-000000000002"


@pytest.fixture(autouse=True)
def role_packs(fake_seti: FakeSeti) -> None:
    fake_seti.packs.extend(
        [
            {
                "id": STAFF,
                "name": "Chief of staff",
                "description": "",
                "body": "Plan the week.",
                "kind": "role",
            },
            {"id": OTHER_ROLE, "name": "Lead", "description": "", "body": "Delegate.", "kind": "role"},
        ]
    )


def client(fake_seti: FakeSeti) -> SetiClient:
    return SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))


async def confirm(tools: EaTools, args: dict[str, Any]) -> tuple[ToolResult, ToolResult]:
    asked = await tools.call("change_my_context_packs", args)
    tools.user_turn()
    done = await tools.call("change_my_context_packs", {**args, "confirmed": True})
    return asked, done


def test_the_base_prompt_comes_first_and_stands_alone_without_packs() -> None:
    assert system_prompt("") == SYSTEM_PROMPT
    assert system_prompt("  \n") == SYSTEM_PROMPT
    assert system_prompt("## Your role\n\nPlan.\n") == f"{SYSTEM_PROMPT}\n\n## Your role\n\nPlan."
    actions = "## Mod actions\n- sample count (Sample): Count."
    assert system_prompt("", actions) == f"{SYSTEM_PROMPT}\n\n{actions}"


async def test_packs_are_read_fresh_and_the_last_text_stays_while_seti_fails(fake_seti: FakeSeti) -> None:
    packs = PackPrompt(client(fake_seti), timeout_secs=CHAT_TIMEOUT_SECS)
    assert await packs.system_prompt() == SYSTEM_PROMPT
    fake_seti.ea_pack_ids = [STAFF, PACK_TRIAGE]
    first = await packs.system_prompt()
    assert first.startswith(SYSTEM_PROMPT)
    assert first.index("## Your role") < first.index("## Context pack: Triage sources")
    fake_seti.packs[-2]["body"] = "Plan the month."
    assert "Plan the month." in await packs.system_prompt()
    fake_seti.fail[("GET", "/api/ea/context-packs/prompt")] = (503, {"title": "Down"})
    assert "Plan the month." in await packs.system_prompt()


async def test_a_call_gets_the_new_system_prompt_only_when_the_packs_changed(fake_seti: FakeSeti) -> None:
    seti = client(fake_seti)
    packs = PackPrompt(seti, timeout_secs=CHAT_TIMEOUT_SECS)
    updates = SystemPromptUpdates(packs, await packs.system_prompt())
    injector = LiveContextInjector(LiveContext(seti), updates)
    pushed: list[Frame] = []

    async def push(frame: Frame, _direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed.append(frame)

    injector.push_frame = push  # type: ignore[method-assign]
    context = LLMContext(messages=[{"role": "user", "content": "Hello"}])
    await injector.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
    assert [type(frame) for frame in pushed] == [LLMContextFrame]

    fake_seti.ea_pack_ids = [PACK_TRIAGE]
    pushed.clear()
    await injector.process_frame(LLMContextFrame(context), FrameDirection.DOWNSTREAM)
    assert [type(frame) for frame in pushed] == [LLMUpdateSettingsFrame, LLMContextFrame]
    update = pushed[0]
    assert isinstance(update, LLMUpdateSettingsFrame)
    assert update.delta is not None
    assert update.delta.system_instruction == updates.current
    assert "## Context pack: Triage sources" in updates.current


async def test_a_typed_turn_runs_with_the_packs_linked_at_that_moment(fake_seti: FakeSeti) -> None:
    script = Script([["Noted."], ["Still noted."]])
    chat = make_chat(fake_seti, script, Conversation())
    await events_of(chat, "Hello")
    assert script.systems[0] == SYSTEM_PROMPT
    fake_seti.ea_pack_ids = [STAFF]
    await events_of(chat, "Hello again")
    assert script.systems[1] == f"{SYSTEM_PROMPT}\n\n## Your role\n\nPlan the week."


async def test_the_ea_lists_its_own_packs(tools: EaTools, fake_seti: FakeSeti) -> None:
    none = await tools.call("list_my_context_packs", {})
    assert none.summary == "No packs of yours"
    assert "Your base prompt is part of Seti's code" in none.text
    assert "No role.\nNo reference packs." in none.text
    fake_seti.ea_pack_ids = [STAFF, PACK_TRIAGE, CHECKLIST]
    fake_seti.ea_pack_max = 20
    mine = await tools.call("list_my_context_packs", {})
    assert "Role: the role pack Chief of staff." in mine.text
    assert "Reference packs: Release checklist and Triage sources." in mine.text
    assert "past the 20 your prompt takes, so the end is cut" in mine.text
    assert mine.summary == "Listed 3 packs of yours"


async def test_the_ea_links_and_unlinks_its_packs_only_after_a_yes(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    asked, done = await confirm(tools, {"link": "triage"})
    assert "adds the context pack Triage sources to your system prompt from your next turn" in asked.text
    assert done.text == "Linked Triage sources to you; it applies from your next turn."
    assert fake_seti.writes() == [("PUT", "/api/ea/context-packs", {}, {"pack_ids": [PACK_TRIAGE]})]
    again = await tools.call("change_my_context_packs", {"link": "triage"})
    assert again.text == "The pack Triage sources is already in your prompt."
    asked, done = await confirm(tools, {"unlink": "triage"})
    assert "takes the context pack Triage sources out of your system prompt" in asked.text
    assert done.ok
    assert fake_seti.ea_pack_ids == []
    unasked = await tools.call("change_my_context_packs", {"link": "release", "confirmed": True})
    assert unasked.text.startswith("You had not put this to the user yet.")


async def test_the_ea_takes_one_role_and_never_a_role_as_a_reference(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    asked, done = await confirm(tools, {"role": "chief of staff"})
    assert "gives you the role Chief of staff from your next turn" in asked.text
    assert done.ok
    asked, _ = await confirm(tools, {"role": "Lead"})
    assert "the role Lead in place of Chief of staff" in asked.text
    assert fake_seti.ea_pack_ids == [OTHER_ROLE]
    as_reference = await tools.call("change_my_context_packs", {"link": "Lead"})
    assert not as_reference.ok
    assert as_reference.text.startswith("Lead is a role; pass it as role")
    asked, done = await confirm(tools, {"clear_role": True})
    assert "removes your role Lead from your next turn; the pack stays" in asked.text
    assert fake_seti.ea_pack_ids == []
    both = await tools.call("change_my_context_packs", {"link": "triage", "role": "Lead"})
    assert not both.ok
