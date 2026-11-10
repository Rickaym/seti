from typing import Any

from fakes import FakeSeti

from seti_ea.prompt import SYSTEM_PROMPT
from seti_ea.tools import EaTools


def question(qid: str, header: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": qid,
        "group_id": extra.pop("group_id", "g1"),
        "task_id": "t1",
        "task_title": "Builder",
        "header": header,
        "prompt": f"{header}?",
        "kind": "choice",
        "multi": False,
        "options": [{"label": "Unit"}, {"label": "Lint"}, {"label": "E2E"}],
        "status": "open",
        "created_at": "2026-09-27T11:00:00.000Z",
        **extra,
    }


PUSH = question(
    "1a2b3c4d-0000-4000-8000-000000000001",
    "Push",
    kind="yes_no",
    options=[{"label": "Yes"}, {"label": "No"}],
)
CHECKS = question("5e6f7a8b-0000-4000-8000-000000000002", "Checks", multi=True)


async def test_search_seti_lists_open_questions_by_agent_with_their_type(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    empty = await tools.call("search_seti", {"in": "questions"})
    assert empty.text == "No agent has a question open for the user."
    fake_seti.questions = [dict(PUSH), dict(CHECKS)]
    result = await tools.call("search_seti", {"in": "questions"})
    lines = result.text.splitlines()
    assert lines[0].startswith("2 questions wait for the user")
    assert lines[1].startswith("Builder asks 2 questions, since")
    assert lines[2] == "- [1a2b3c4d] Push (yes or no, or own words): Push?"
    assert lines[3] == "- [5e6f7a8b] Checks (any of Unit, Lint and E2E, or own words): Checks?"


async def test_answer_question_maps_the_user_words_to_options(tools: EaTools, fake_seti: FakeSeti) -> None:
    fake_seti.questions = [dict(PUSH), dict(CHECKS)]
    first = await tools.call("answer_question", {"question": "1a2b3c4d", "choices": ["yes"]})
    assert first.ok
    assert first.text == "Answered. Builder still waits on its other questions."
    assert fake_seti.posts()[-1] == (
        "/api/questions/answers",
        {"items": [{"action": "answer", "id": PUSH["id"], "selected": ["Yes"], "other": None}]},
    )
    second = await tools.call(
        "answer_question", {"question": "checks", "choices": ["unit"], "words": "and the build"}
    )
    assert second.text == "Answered. Builder has all its answers and goes on."
    assert fake_seti.posts()[-1][1]["items"][0]["other"] == "and the build"


async def test_answer_question_refuses_a_guess_outside_the_options(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.questions = [dict(PUSH)]
    result = await tools.call("answer_question", {"question": "push", "choices": ["maybe"]})
    assert not result.ok
    assert result.text == "maybe is not an option; the options are Yes and No."
    nothing = await tools.call("answer_question", {"question": "push"})
    assert nothing.text == "Give the options the user picked or their own words."
    assert fake_seti.posts() == []


async def test_answer_question_dismisses_and_reports_refused_secrets(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.questions = [dict(PUSH), dict(CHECKS)]
    token = "".join(["gh", "p_", "0" * 36])
    refused = await tools.call("answer_question", {"question": "checks", "words": token})
    assert not refused.ok
    assert refused.text.startswith("Seti did not take the answer: That answer looks like a secret")
    dismissed = await tools.call("answer_question", {"question": "push", "dismiss": True})
    assert dismissed.text == "Dismissed. Builder still waits on its other questions."
    missing = await tools.call("answer_question", {"question": "deploy"})
    assert missing.text.startswith("No open question matches deploy.")


async def test_answer_question_names_the_matches_when_several_fit(
    tools: EaTools, fake_seti: FakeSeti
) -> None:
    fake_seti.questions = [
        dict(CHECKS),
        question("9c9c9c9c-0000-4000-8000-000000000003", "Checks", group_id="g2"),
    ]
    result = await tools.call("answer_question", {"question": "checks", "choices": ["Unit"]})
    assert result.text.startswith("Several open questions match checks: Checks [5e6f7a8b] of Builder and")


def test_prompt_says_the_ea_answers_only_with_what_the_user_said() -> None:
    assert "Answer with answer_question only with what the user said" in SYSTEM_PROMPT
    assert "never answer on your own judgment or guess" in SYSTEM_PROMPT
