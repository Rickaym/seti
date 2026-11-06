from typing import Any, cast

from fakes import FakeSeti
from pipecat.processors.aggregators.llm_context import LLMContext, LLMContextMessage
from test_chat import Script, events_of, make_chat, stored, texts

from seti_ea.clock import CALL_NOTE_PREFIX
from seti_ea.conversation import Conversation
from seti_ea.history import SUMMARY_PREFIX
from seti_ea.promises import NOTE_PREFIX, PromiseCheck, unkept
from seti_ea.prompt import SYSTEM_PROMPT, VOICE_HELD_NOTE

Message = dict[str, Any]


def user(text: str) -> Message:
    return {"role": "user", "content": text}


def said(text: str) -> Message:
    return {"role": "assistant", "content": text}


def developer(text: str) -> Message:
    return {"role": "developer", "content": text}


def called(name: str, call_id: str = "call-1") -> list[Message]:
    call = {"id": call_id, "type": "function", "function": {"name": name, "arguments": "{}"}}
    return [
        {"role": "assistant", "tool_calls": [call]},
        {"role": "tool", "tool_call_id": call_id, "content": "Done."},
    ]


def team_posts(fake: FakeSeti) -> list[Any]:
    return [body for path, body in fake.posts() if path == "/api/team/messages"]


def check(*messages: Message) -> str | None:
    return unkept(cast(list[LLMContextMessage], list(messages)))


# The voice call of the dropped promise, as the EA history stored it.
DECISIONS = [
    said(
        "The agent found the 300-call limit in the MCP's daily quota. He needs two decisions "
        "from you: should the bot have its own token, and should reading all tasks require a flag?"
    ),
    user("No need for explicit flags, and I will make a token for the bot, from the existing secrets"),
    user("as it is deployed?"),
]
FIRST_PROMISE = said(
    "No. The change is still a proposal; nothing has been deployed. You\u2019ll provide the token "
    "through the existing secrets setup, and I\u2019ll pass on that no explicit flag is needed."
)
BARGE_IN = [
    user("Okay. Just keep keep keep it going."),
    user("Excuse me for a minute."),
    user("No. Hello?"),
    said("I\u2019m here."),
    user("Okay. I can hear you now."),
]
SECOND_PROMISE = said(
    "I\u2019m here. I\u2019ll pass your decisions to the agent so he can keep the work moving."
)


def test_a_spoken_promise_with_no_tool_call_is_caught_each_time() -> None:
    first = check(*DECISIONS, FIRST_PROMISE)
    assert first is not None
    assert first.startswith(NOTE_PREFIX)
    assert "I'll pass on that no explicit flag is needed" in first
    assert "post_team_chat" in first

    second = check(*DECISIONS, FIRST_PROMISE, *BARGE_IN, SECOND_PROMISE)
    assert second is not None
    assert "I'll pass your decisions to the agent" in second


def test_the_promise_is_checked_once_and_a_kept_one_passes() -> None:
    nudged = [*DECISIONS, SECOND_PROMISE, developer(check(*DECISIONS, SECOND_PROMISE) or "")]
    assert check(*nudged, *called("post_team_chat"), said("Sent.")) is None
    assert check(*nudged, said("I could not reach the agent.")) is None
    assert check(*DECISIONS, *called("post_team_chat"), said("I've passed that on.")) is None


def test_a_note_left_by_a_cut_off_reply_does_not_mark_the_next_turn_checked() -> None:
    held = developer(check(*DECISIONS, SECOND_PROMISE) or "")
    later = [*DECISIONS, SECOND_PROMISE, held, user("Sorry, go on."), said("I'll tell the agent now.")]
    assert check(*later) is not None


def test_a_claim_with_no_tool_call_is_caught_but_an_earlier_one_is_not() -> None:
    assert check(user("Remind him."), said("I've reminded the agent.")) is not None
    assert check(user("Did you?"), said("Yes, I told him earlier.")) is None


def test_offers_questions_and_words_for_the_user_are_not_promises() -> None:
    assert check(user("Fix it."), said("I'll start an agent to fix it. Shall I go ahead?")) is None
    assert check(user("How long?"), said("I'll let you know when it finishes.")) is None
    assert check(user("Ideas?"), said("If you like, I'll tell the docs agent.")) is None
    assert check(user("What did it say?"), said('It said: "I\'ll tell the docs agent."')) is None
    assert check(user("Status?"), said("He'll ask the reviewer next.")) is None


def test_nouns_that_double_as_verbs_and_restated_sends_are_not_promises() -> None:
    assert check(user("Is it ready?"), said("I'll check the brief before asking you to approve it.")) is None
    assert check(user("And?"), said("I'll read the message it sent.")) is None
    assert check(user("Ping it."), said("I'll ping the docs agent now.")) is not None
    sent = [user("Send it."), *called("post_team_chat"), said("Sent. Shall I check back?")]
    assert (
        check(*sent, user("Go for it."), *called("schedule_followup", "call-2"), said("I've sent it."))
        is None
    )


def test_asking_the_user_to_repeat_unclear_words_is_left_alone() -> None:
    unclear = said("I'm not catching the last part. Do you want me to tell the docs agent to rebase?")
    assert check(user("Just ask with the act and follow"), unclear) is None


def test_a_greeting_after_a_new_call_reads_only_its_own_turn() -> None:
    chat_question = said("Shall I tell him to continue his other open work?")
    messages = [user("keep him going"), chat_question, developer(f"{CALL_NOTE_PREFIX} Noon.")]
    assert check(*messages, said("Welcome back.")) is None


def test_a_summary_that_cut_into_the_turn_stands_the_check_down() -> None:
    summary = user(f"{SUMMARY_PREFIX} The user asked to pass the decisions on; it was sent.")
    assert check(summary, said("I've told the agent.")) is None


def test_an_inbox_report_that_claims_a_relay_is_caught() -> None:
    inbox = developer("Inbox: a follow-up is due: check the docs agent.")
    claim = said("I've told the docs agent to rebase.")
    assert check(user("Earlier words."), said("Done."), inbox, claim) is not None


def test_updates_held_for_the_users_turn_leave_their_words_in_the_check() -> None:
    held = [developer("Inbox: @atlas mentioned you in the group chat."), developer(VOICE_HELD_NOTE)]
    question = said("Also, Atlas is on it. Shall I tell the SDLC agent to open a PR?")
    note = check(said("Done."), user("Tell the SDLC agent to open a PR."), *held, question)
    assert note is not None
    assert "needs no yes" in note


def test_re_asking_a_relay_the_user_gave_is_caught() -> None:
    question = said(
        "Understood. I won\u2019t send that issue back. He\u2019s idle now; shall I tell him to "
        "leave that issue closed and continue his other open work?"
    )
    note = check(user("I finished the issue myself keep the logout agent going"), question)
    assert note is not None
    assert "keep the logout agent going" in note
    assert "needs no yes" in note


def test_asking_which_agent_or_asking_unprompted_is_left_alone() -> None:
    which = said("Shall I tell the logout agent or the docs agent?")
    assert check(user("Tell him to rebase."), which) is None
    unprompted = said("The docs agent is idle. Shall I tell it to rebase?")
    assert check(user("What is idle?"), unprompted) is None


async def test_the_check_reruns_a_finished_reply_and_holds_the_note_for_a_cut_off_one() -> None:
    def setup() -> tuple[PromiseCheck, LLMContext, list[str]]:
        context = LLMContext(messages=cast(list[LLMContextMessage], [*DECISIONS, SECOND_PROMISE]))
        notes: list[str] = []
        return PromiseCheck(context, notes.append, rerun), context, notes

    reruns: list[int] = []

    async def rerun() -> None:
        reruns.append(1)

    promises, _, notes = setup()
    assert await promises.reply_ended() is True
    assert len(notes) == 1
    assert reruns == [1]

    promises, _, notes = setup()
    assert await promises.reply_ended(interrupted=True) is True
    assert len(notes) == 1
    assert reruns == [1]

    kept = PromiseCheck(LLMContext(messages=[]), notes.append, rerun)
    assert await kept.reply_ended() is False


async def test_a_typed_promise_is_carried_out_in_the_same_reply(fake_seti: FakeSeti) -> None:
    script = Script(
        [
            ["I'm here. I'll pass your decisions to the logout agent so it keeps moving."],
            [("call-1", "post_team_chat", {"to": "logout button", "text": "No flag is needed."})],
            ["Sent: no flag is needed."],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())

    events = await events_of(chat, "No need for explicit flags. Okay, I can hear you now.")

    assert team_posts(fake_seti) == [{"text": "No flag is needed.", "to": "button"}]
    note = script.seen[1][-1]
    assert note["role"] == "developer"
    assert note["content"].startswith(NOTE_PREFIX)
    assert texts(events).endswith("moving.\n\nSent: no flag is needed.")
    assert events[-1]["type"] == "done"
    assert not any(NOTE_PREFIX in str(message.get("content")) for _, message in stored(fake_seti))


async def test_keep_it_going_sends_the_direct_message_without_a_yes(fake_seti: FakeSeti) -> None:
    script = Script(
        [
            [
                "Understood. The logout agent is idle now; shall I tell it to leave that issue "
                "closed and continue its other open work?"
            ],
            [("call-1", "post_team_chat", {"to": "logout button", "text": "Carry on with your work."})],
            ["Sent."],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())

    await events_of(chat, "I finished the issue myself keep the logout button going")

    assert team_posts(fake_seti) == [{"text": "Carry on with your work.", "to": "button"}]
    assert "needs no yes" in script.seen[1][-1]["content"]
    assert len(script.seen) == 3


async def test_a_reply_that_keeps_its_word_runs_once(fake_seti: FakeSeti) -> None:
    script = Script(
        [
            [("call-1", "post_team_chat", {"to": "logout button", "text": "Rebase please."})],
            ["I've told the logout agent to rebase."],
        ]
    )
    chat = make_chat(fake_seti, script, Conversation())

    await events_of(chat, "Tell the logout agent to rebase.")

    assert len(script.seen) == 2


def test_the_prompt_forbids_empty_promises_and_re_asking_relays() -> None:
    assert "Never say you did, or will do, something unless its tool call is in the same reply" in (
        SYSTEM_PROMPT
    )
    assert "send the direct message in the same reply, without asking first" in SYSTEM_PROMPT
    assert "show them in a quote block before sending" not in SYSTEM_PROMPT
