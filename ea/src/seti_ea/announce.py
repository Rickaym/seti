"""Short spoken lines that cover the silence while the EA's tools run."""

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from seti_ea.actions import CONFIRM_TOOLS
from seti_ea.think import THINK_TOOL

PHRASES = (
    "One moment.",
    "Checking.",
    "Looking now.",
    "Just a second.",
    "On it.",
)

ACTION_LINES = {
    "start_task": "Starting it.",
    "stop_task": "Stopping it.",
    "hand_over_updates": "Handing those over.",
    "post_team_chat": "Posting it.",
    "reply_team_chat": "Passing that on.",
    "send_file": "Handing the files over.",
    "propose_knowledge": "Proposing the note.",
    "answer_question": "Passing your answer on.",
    "rename_agent": "Renaming it.",
    "pin_agent": "Pinning it.",
    "set_agent_color": "Changing its colour.",
    "delete_agent": "Deleting it.",
    "archive_agent": "Archiving it.",
    "restore_agent": "Bringing it back.",
    "set_update_mode": "Changing how it takes PR updates.",
    "rewind_agent": "Rewinding it.",
    "take_back_message": "Taking that message back.",
    "dismiss_updates": "Dismissing those.",
    "stop_background_work": "Stopping its background work.",
    "restart_agent_session": "Restarting its session.",
    "dreams": "Doing that.",
    "retry_agent_turn": "Sending its last message again.",
    "stop_subagent": "Stopping that subagent.",
    "stop_process": "Stopping that process.",
    "set_agent_group_chat": "Changing its group chat settings.",
    "set_notifications": "Changing the notifications.",
    "link_pr": "Linking the PR.",
    "unlink_pr": "Unlinking the PR.",
    "start_agent_from_pr": "Starting an agent on that PR.",
    "request_preview": "Adding the preview label.",
    "link_context_pack": "Adding that pack.",
    "unlink_context_pack": "Removing that pack.",
    "create_context_pack": "Creating the pack.",
    "update_context_pack": "Updating the pack.",
    "delete_context_pack": "Deleting the pack.",
    "add_repo": "Registering the repo.",
    "update_repo": "Updating the repo.",
    "remove_repo": "Removing the repo.",
    "set_agent_role": "Setting its role.",
    "change_my_context_packs": "Changing my context packs.",
    "set_mcp_default": "Changing that default.",
    "set_agent_access": "Changing its access.",
    "set_agent_profile": "Switching its credentials.",
    "create_channel": "Creating the webhook.",
    "update_channel": "Updating the channel.",
    "subscribe_channel": "Routing its events.",
    "unsubscribe_channel": "Stopping its events there.",
    "delete_channel": "Deleting the webhook.",
    "test_channel": "Sending a test event.",
    "rotate_channel_secret": "Rotating its secret.",
    "create_poller": "Creating the poller.",
    "update_poller": "Updating the poller.",
    "run_channel": "Running it.",
    "create_reminder": "Creating the reminder.",
    "set_auto_archive": "Changing auto-archive.",
    "run_archive_sweep": "Archiving them.",
    "write_context_file": "Writing the file.",
    "revert_change": "Reverting that change.",
    "mark_changes_seen": "Marking them as seen.",
    "add_plugin": "Adding the plugin.",
    "remove_plugin": "Removing the plugin.",
    "set_plugin_enabled": "Switching the plugin.",
    "set_mod_enabled": "Switching the mod.",
    "run_mod_action": "Running it.",
    "add_mcp_server": "Adding the server.",
    "remove_mcp_server": "Removing the server.",
    "start_mcp_sign_in": "Starting the sign-in.",
    "import_sessions": "Importing them.",
    "update_ea_settings": "Changing my settings.",
    "set_warm_caches": "Changing the warm caches.",
    "set_memory_cap": "Changing the memory settings.",
    "change_workspace": "Changing the workspace.",
    "move_agent_to_workspace": "Moving it there.",
    "confirm_asked": "Going ahead.",
    "cancel_think": "Dropping that one.",
}
# A think can take a minute, so it is always acknowledged, in words that vary from one to the next.
THINK_LINES = (
    "Let me think that through.",
    "Weighing it up.",
    "Working that out.",
    "Give me a moment on that one.",
)
GROUP_CHAT_LINES = {
    True: "Muting it in the group chat.",
    False: "Unmuting it.",
}

SLEEP_TOOL = "go_to_sleep"
SLEEP_LINE = "Standing by."

COOLDOWN_SECS = 6.0


DIRECT_LINE = "Sending it."


@dataclass(frozen=True)
class ToolCall:
    """The part of an LLM function call that decides what to say."""

    name: str
    arguments: Mapping[str, Any]


def action_line(call: ToolCall) -> str | None:
    """What to say before a tool that changes something; None for lookups and questions."""
    if call.name == "post_team_chat" and call.arguments.get("to"):
        return DIRECT_LINE
    # Without the user's yes a destructive tool only asks, so it must not sound like acting.
    if call.name in CONFIRM_TOOLS and call.arguments.get("confirmed") is not True:
        return None
    muted = call.arguments.get("muted")
    if call.name == "set_agent_group_chat" and isinstance(muted, bool) and not call.arguments.get("handle"):
        return GROUP_CHAT_LINES[muted]
    return ACTION_LINES.get(call.name)


class ToolAnnouncer:
    """Says what is happening when tools start, quiet for chained calls within the cooldown."""

    def __init__(
        self,
        phrases: Sequence[str] = PHRASES,
        cooldown_secs: float = COOLDOWN_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._phrases = phrases
        self._cooldown = cooldown_secs
        self._clock = clock
        self._next = 0
        self._thinks = 0
        self._last: float | None = None

    def phrase(self, calls: Sequence[ToolCall] = ()) -> str | None:
        now = self._clock()
        # The sleep line is the only reply the user hears, so the cooldown never silences it.
        if any(call.name == SLEEP_TOOL for call in calls):
            self._last = now
            return SLEEP_LINE
        if any(call.name == THINK_TOOL for call in calls):
            self._last = now
            self._thinks += 1
            return THINK_LINES[(self._thinks - 1) % len(THINK_LINES)]
        if self._last is not None and now - self._last < self._cooldown:
            return None
        self._last = now
        action = next((line for line in map(action_line, calls) if line is not None), None)
        if action is not None:
            return action
        text = self._phrases[self._next % len(self._phrases)]
        self._next += 1
        return text
