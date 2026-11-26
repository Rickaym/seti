import asyncio
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from aiortc import RTCConfiguration, RTCPeerConnection
from call_rig import address_change, blackout, no_ice_servers, run_call
from fakes import NOW, FakeSeti, settings
from test_chat import Script, events_of, factory
from test_request_answers import answer, confirm, held
from test_server import idle_bot

from seti_ea import link, server
from seti_ea.chat import TextChat
from seti_ea.conversation import Conversation
from seti_ea.ice import IceProvider
from seti_ea.link import HEARD_WINDOW_SECS, HOLD_SECS, CallTransport, LinkWatch
from seti_ea.seti import SetiClient
from seti_ea.toolkit import ToolResult
from seti_ea.tools import EaTools


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def watched(state: str = "connected", pinged: bool = False) -> tuple[LinkWatch, Any, Clock]:
    connection = SimpleNamespace(pc=SimpleNamespace(connectionState=state), is_connected=lambda: pinged)
    clock = Clock()
    return LinkWatch(connection, clock), connection, clock  # type: ignore[arg-type]


def test_before_any_audio_the_link_follows_pipecats_pings() -> None:
    assert not watched(pinged=False)[0].up()
    watch, connection, _clock = watched(pinged=True)
    assert watch.up()
    assert connection.is_connected == watch.up


def test_once_audio_flows_its_absence_is_a_drop_whatever_the_pings_say() -> None:
    watch, _connection, clock = watched(pinged=True)
    watch.heard()
    clock.now += HEARD_WINDOW_SECS - 0.1
    assert watch.up()
    clock.now += 0.2
    assert not watch.up()


def test_audio_without_a_connected_peer_connection_is_no_link() -> None:
    watch, _connection, _clock = watched(state="connecting")
    watch.heard()
    assert not watch.up()


async def test_speech_waits_for_the_link_then_goes_on(monkeypatch: pytest.MonkeyPatch) -> None:
    watch, _connection, clock = watched()
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.now += seconds
        if len(sleeps) == 20:
            watch.heard()

    monkeypatch.setattr(link.asyncio, "sleep", sleep)
    assert await watch.wait()
    assert len(sleeps) == 20


async def test_speech_waits_no_longer_than_the_hold_per_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    watch, _connection, clock = watched()

    async def sleep(seconds: float) -> None:
        clock.now += seconds

    monkeypatch.setattr(link.asyncio, "sleep", sleep)
    start = clock.now
    assert not await watch.wait()
    assert clock.now - start == pytest.approx(HOLD_SECS, abs=0.1)
    assert not await watch.wait()
    assert clock.now - start == pytest.approx(HOLD_SECS, abs=0.1)


async def test_each_silence_reports_one_loss() -> None:
    watch, _connection, clock = watched()
    lost: list[float] = []
    watching = asyncio.create_task(watch.watch(lambda: lost.append(clock.now)))
    await asyncio.sleep(0.12)
    assert lost == []
    watch.heard()
    clock.now += HEARD_WINDOW_SECS
    await asyncio.sleep(0.12)
    watch.heard()
    await asyncio.sleep(0.12)
    clock.now += HEARD_WINDOW_SECS
    await asyncio.sleep(0.12)
    watching.cancel()
    assert len(lost) == 2


async def test_a_blackout_pauses_the_eas_speech_instead_of_dropping_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    report, log = await run_call(monkeypatch, CallTransport, blackout(3, after_secs=3))
    assert log.sessions == 1
    assert report.chunks_missed <= 4, report.line()


async def test_a_rebuilt_peer_connection_keeps_the_bot_session(monkeypatch: pytest.MonkeyPatch) -> None:
    report, log = await run_call(monkeypatch, CallTransport, address_change(after_secs=3))
    assert log.sessions == 1
    assert report.chunks_missed <= 4, report.line()
    assert report.longest_gap_s < 3, report.line()


def voice_turn(tools: EaTools, said: str, *, dropped: bool = False) -> None:
    """A spoken turn as the bot reports it; `dropped` loses the call's audio partway through."""
    tools.user_turn_started()
    if dropped:
        tools.audio_lost()
    tools.user_turn(said)


def asking(fake: FakeSeti) -> tuple[EaTools, TextChat]:
    """Tools and a chat that read back a held push for the user's yes on the next turn."""
    fake.permission_requests = [held()]
    seti = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake.handle))
    tools = EaTools(seti, now=lambda: NOW)
    script = Script([[("c1", *answer())], ["Shall I?"]])
    config = settings(openai_api_key="op")
    return tools, TextChat(config, tools, Conversation(), llm=factory(script), now=lambda: NOW)


async def _yes_then(fake: FakeSeti, between: Callable[[EaTools], None]) -> ToolResult:
    tools, chat = asking(fake)
    await events_of(chat, "Let the logout agent run its push")
    between(tools)
    return await tools.call(*confirm(1))


async def test_a_spoken_yes_counts_when_the_audio_held() -> None:
    fake = FakeSeti()
    result = await _yes_then(fake, lambda tools: voice_turn(tools, "Yes"))
    assert result.ok, result.text
    assert len(fake.answered_requests) == 1


async def test_a_yes_from_before_a_drop_in_the_call_never_counts() -> None:
    fake = FakeSeti()

    def yes_then_drop(tools: EaTools) -> None:
        voice_turn(tools, "Yes")
        tools.audio_lost()

    result = await _yes_then(fake, yes_then_drop)
    assert not result.ok
    assert fake.answered_requests == []


async def test_a_yes_in_a_turn_the_audio_dropped_out_of_never_counts() -> None:
    fake = FakeSeti()
    result = await _yes_then(fake, lambda tools: voice_turn(tools, "Yes", dropped=True))
    assert not result.ok
    assert fake.answered_requests == []


async def test_a_yes_from_a_previous_call_never_counts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "to_ice_servers", no_ice_servers)
    fake = FakeSeti()
    tools, chat = asking(fake)
    await events_of(chat, "Let the logout agent run its push")
    tools.user_turn_started()
    tools.user_turn("Yes")
    ice = IceProvider(settings(), httpx.AsyncClient())
    sessions = server.Sessions(settings(), ice, tools, idle_bot, Conversation())
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    pc.addTransceiver("audio", direction="sendrecv")
    pc.createDataChannel("rtvi")
    await pc.setLocalDescription(await pc.createOffer())
    await sessions.offer(server.parse_offer({"sdp": pc.localDescription.sdp, "type": "offer"}))
    result = await tools.call(*confirm(1))
    await sessions.close()
    await pc.close()
    assert not result.ok
    assert fake.answered_requests == []
