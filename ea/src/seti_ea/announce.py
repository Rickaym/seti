"""Short spoken lines that cover the silence while the EA's tools run."""

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from seti_ea.actions import CONFIRM_TOOLS

PHRASES = (
    "One moment.",
    "Checking now.",
    "Certainly. Let me look.",
    "Just a moment, I'm checking.",
    "Of course. One moment.",
)

ACTION_LINES = {
    "start_task": "Right away. Starting it now.",
    "stop_task": "Very good. Stopping it now.",
    "hand_over_updates": "Certainly. Handing those over.",
    "post_team_chat": "Very good. Posting it now.",
    "reply_team_chat": "Very good. Passing that on.",
    "send_file": "Of course. Handing the files over.",
    "rename_agent": "Certainly. Renaming it now.",
    "pin_agent": "Certainly.",
    "set_agent_color": "Certainly. Changing its colour.",
    "delete_agent": "Very good. Deleting it now.",
    "archive_agent": "Very good. Archiving it now.",
    "restore_agent": "Certainly. Bringing it back.",
    "set_update_mode": "Of course. Changing how it takes PR updates.",
    "rewind_agent": "Very good. Rewinding it now.",
    "take_back_message": "Certainly. Taking that message back.",
    "dismiss_updates": "Very good. Dismissing those.",
    "stop_background_work": "Very good. Stopping its background work.",
    "restart_agent_session": "Very good. Restarting its session.",
    "retry_agent_turn": "Certainly. Sending its last message again.",
    "stop_subagent": "Very good. Stopping that subagent.",
    "stop_process": "Very good. Stopping that process.",
    "set_agent_group_chat": "Certainly. Changing its group chat settings.",
    "set_notifications": "Certainly. Changing the notifications.",
    "link_pr": "Of course. Linking the PR.",
    "unlink_pr": "Very good. Unlinking the PR.",
    "start_agent_from_pr": "Right away. Starting an agent on that PR.",
    "request_preview": "Very good. Adding the preview label.",
    "link_context_pack": "Of course. Adding that pack.",
    "unlink_context_pack": "Very good. Removing that pack.",
    "create_context_pack": "Of course. Creating the pack.",
    "update_context_pack": "Very good. Updating the pack.",
    "delete_context_pack": "Very good. Deleting the pack.",
    "add_repo": "Certainly. Registering the repo.",
    "update_repo": "Very good. Updating the repo.",
    "remove_repo": "Very good. Removing the repo.",
    "add_agent_repo": "Certainly. Adding the repo to it.",
    "add_agent_directory": "Certainly. Adding the directory to it.",
    "remove_from_agent": "Very good. Taking that off it.",
    "set_agent_working_directory": "Very good. Moving it there.",
    "set_agent_role": "Very good. Setting its role.",
    "change_my_context_packs": "Very good. Changing my context packs.",
    "set_mcp_default": "Of course. Changing that default.",
    "set_agent_access": "Very good. Changing its access.",
    "set_agent_profile": "Of course. Switching its credentials.",
    "create_channel": "Right away. Creating the webhook.",
    "update_channel": "Very good. Updating the channel.",
    "subscribe_channel": "Very good. Routing its events.",
    "unsubscribe_channel": "Very good. Stopping its events there.",
    "delete_channel": "Very good. Deleting the webhook.",
    "test_channel": "Certainly. Sending a test event.",
    "rotate_channel_secret": "Very good. Rotating its secret.",
    "create_poller": "Right away. Creating the poller.",
    "update_poller": "Very good. Updating the poller.",
    "run_channel": "Certainly. Running it now.",
    "create_reminder": "Right away. Creating the reminder.",
    "set_auto_archive": "Very good. Changing auto-archive.",
    "run_archive_sweep": "Very good. Archiving them now.",
    "write_context_file": "Of course. Writing the file.",
    "revert_change": "Very good. Reverting that change.",
    "mark_changes_seen": "Certainly. Marking them as seen.",
    "add_plugin": "Certainly. Adding the plugin.",
    "remove_plugin": "Very good. Removing the plugin.",
    "set_plugin_enabled": "Of course. Switching the plugin.",
    "set_mod_enabled": "Certainly. Switching the mod.",
    "run_mod_action": "Certainly. Running it now.",
    "add_mcp_server": "Right away. Adding the server.",
    "remove_mcp_server": "Very good. Removing the server.",
    "start_mcp_sign_in": "Certainly. Starting the sign-in.",
    "import_sessions": "Right away. Importing them now.",
    "update_ea_settings": "Of course. Changing my settings.",
    "set_warm_caches": "Certainly. Changing the warm caches.",
    "set_memory_cap": "Very good. Changing the memory settings.",
    "change_workspace": "Very good. Changing the workspace.",
    "move_agent_to_workspace": "Certainly. Moving it there.",
    "confirm_asked": "Very good. Going ahead.",
}
GROUP_CHAT_LINES = {
    True: "Certainly. Muting it in the group chat.",
    False: "Certainly. Unmuting it.",
}

SLEEP_TOOL = "go_to_sleep"
SLEEP_LINE = "Very good. I'll be here when you need me."

COOLDOWN_SECS = 6.0


DIRECT_LINE = "Of course. Sending that over."


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
        self._last: float | None = None

    def phrase(self, calls: Sequence[ToolCall] = ()) -> str | None:
        now = self._clock()
        # The sleep line is the only reply the user hears, so the cooldown never silences it.
        if any(call.name == SLEEP_TOOL for call in calls):
            self._last = now
            return SLEEP_LINE
        if self._last is not None and now - self._last < self._cooldown:
            return None
        self._last = now
        action = next((line for line in map(action_line, calls) if line is not None), None)
        if action is not None:
            return action
        text = self._phrases[self._next % len(self._phrases)]
        self._next += 1
        return text
