"""The EA's system prompt: its base prompt from code, then the context packs the user linked."""

import asyncio
from collections.abc import Mapping
from typing import Any, cast

from loguru import logger

from seti_ea.prompt import base_prompt
from seti_ea.seti import SetiClient, SetiError

VOICE_TIMEOUT_SECS = 0.3
CHAT_TIMEOUT_SECS = 2.0


def system_prompt(packs: str, actions: str = "", form_of_address: str = "") -> str:
    """The base prompt, the role and reference packs as Seti rendered them, then mod actions."""
    base = base_prompt(form_of_address)
    return "\n\n".join(part for part in (base, packs.strip(), actions.strip()) if part)


class PackPrompt:
    """Reads the linked packs for each turn; keeps the last text while Seti is slow or down."""

    def __init__(self, seti: SetiClient, *, timeout_secs: float) -> None:
        self._seti = seti
        self._timeout = timeout_secs
        self._text = ""
        self._actions = ""
        self._address = ""

    async def system_prompt(self) -> str:
        try:
            data = await asyncio.wait_for(self._seti.get("/ea/context-packs/prompt"), self._timeout)
        except (SetiError, TimeoutError) as e:
            logger.debug(f"EA context packs not refreshed: {e or type(e).__name__}")
            return self._prompt()
        if isinstance(data, dict):
            prompt = cast(Mapping[str, Any], data)
            self._text = str(prompt.get("text") or "")
            self._actions = str(prompt.get("mod_actions") or "")
            self._address = str(prompt.get("form_of_address") or "")
        return self._prompt()

    def _prompt(self) -> str:
        return system_prompt(self._text, self._actions, self._address)


class SystemPromptUpdates:
    """The system prompt a call's LLM runs with, and whether the linked packs have changed it."""

    def __init__(self, packs: PackPrompt, current: str) -> None:
        self._packs = packs
        self.current = current

    async def changed(self) -> str | None:
        """The new system prompt when a pack link or a pack's text changed since the last turn."""
        prompt = await self._packs.system_prompt()
        if prompt == self.current:
            return None
        self.current = prompt
        return prompt
