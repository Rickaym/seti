from seti_ea.announce import ToolAnnouncer, ToolCall


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_rotates_phrases_and_stays_quiet_for_chained_calls() -> None:
    clock = Clock()
    announcer = ToolAnnouncer(phrases=("a", "b"), cooldown_secs=5, clock=clock)
    assert announcer.phrase() == "a"
    clock.now += 2
    assert announcer.phrase() is None
    clock.now += 4
    assert announcer.phrase() == "b"
    clock.now += 10
    assert announcer.phrase() == "a"


def test_default_phrases_are_short() -> None:
    announcer = ToolAnnouncer()
    first = announcer.phrase()
    assert first == "One moment."


def test_actions_say_what_they_do_and_lookups_say_checking() -> None:
    clock = Clock()
    announcer = ToolAnnouncer(cooldown_secs=5, clock=clock)
    assert announcer.phrase([ToolCall("stop_task", {"task": "x"})]) == "Very good. Stopping it now."
    clock.now += 10
    assert announcer.phrase([ToolCall("start_task", {})]) == "Right away. Starting it now."
    clock.now += 10
    direct = ToolCall("post_team_chat", {"to": "login", "text": "hi"})
    assert announcer.phrase([direct]) == "Of course. Sending that over."
    clock.now += 10
    assert announcer.phrase([ToolCall("post_team_chat", {"text": "hi"})]) == "Very good. Posting it now."
    clock.now += 10
    assert announcer.phrase([ToolCall("hand_over_updates", {})]) == "Certainly. Handing those over."
    clock.now += 10
    lookup_then_act = [ToolCall("get_task", {}), ToolCall("stop_task", {})]
    assert announcer.phrase(lookup_then_act) == "Very good. Stopping it now."
    clock.now += 10
    assert announcer.phrase([ToolCall("list_tasks", {})]) == "One moment."


def test_the_sleep_line_is_said_even_right_after_another_line() -> None:
    clock = Clock()
    announcer = ToolAnnouncer(cooldown_secs=5, clock=clock)
    assert announcer.phrase([ToolCall("list_tasks", {})]) == "One moment."
    clock.now += 1
    sleep = [ToolCall("get_task", {}), ToolCall("go_to_sleep", {})]
    assert announcer.phrase(sleep) == "Very good. I'll be here when you need me."
    clock.now += 1
    assert announcer.phrase([ToolCall("list_tasks", {})]) is None
