"""Keeps the EA's voice through a short network drop, instead of throwing the rest of the reply away.

pipecat counts the caller as gone 3 s after the last data-channel ping, and its transport then
drops every queued frame of speech at once, so a short stall cut off the whole answer. Pings ride
reliable SCTP and lag behind under loss while audio still flows, yet keep the caller counted as
present for 3 s into a real drop. Here the caller counts as reachable while its microphone audio
arrives, and while it is not, the EA's speech waits, up to HOLD_SECS, and goes on where it stopped
once the link is back or rebuilt.
"""

import asyncio
import math
import time
from collections.abc import Callable

from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import (
    SmallWebRTCInputTransport,
    SmallWebRTCOutputTransport,
    SmallWebRTCTransport,
)

from seti_ea.call_audio import CallAudio

HEARD_WINDOW_SECS = 0.5
# Under pipecat's 10 s audio write timeout, which would end the call.
HOLD_SECS = 8.0
POLL_SECS = 0.05
SAMPLE_SECS = 5.0


class LinkWatch:
    """Whether the caller is reachable: the peer connection is up and its pings or audio arrive."""

    def __init__(
        self, connection: SmallWebRTCConnection, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._connection = connection
        self._clock = clock
        self._pinged = connection.is_connected
        self._heard = -math.inf
        self._down_since: float | None = None
        self.audio = CallAudio()
        connection.is_connected = self.up  # type: ignore[method-assign]

    def heard(self) -> None:
        """The caller's microphone audio just arrived."""
        self._heard = self._clock()

    def up(self) -> bool:
        """A browser sends microphone audio all call long, muted or not, so its absence is a drop."""
        if self._heard == -math.inf:
            return self._pinged()
        connected = self._connection.pc.connectionState == "connected"
        return connected and self._clock() - self._heard < HEARD_WINDOW_SECS

    async def watch(self, lost: Callable[[], None]) -> None:
        """Calls `lost` each time the caller's audio, once flowing, stops for HEARD_WINDOW_SECS."""
        reported = False
        while True:
            await asyncio.sleep(POLL_SECS)
            silent = self._heard != -math.inf and self._clock() - self._heard >= HEARD_WINDOW_SECS
            if silent and not reported:
                self.audio.drops += 1
                lost()
            reported = silent

    async def sample(self) -> None:
        """Samples the user's audio packets every SAMPLE_SECS, for the call's log line."""
        while True:
            await asyncio.sleep(SAMPLE_SECS)
            await self.audio.sample(self._connection.pc)

    async def wait(self) -> bool:
        """Waits for the link while this outage is under HOLD_SECS old; True once it is up."""
        start = self._clock()
        try:
            while not self.up():
                now = self._clock()
                self._down_since = self._down_since if self._down_since is not None else now
                if now - self._down_since >= HOLD_SECS:
                    return False
                await asyncio.sleep(POLL_SECS)
            self._down_since = None
            return True
        finally:
            self.audio.held_secs += self._clock() - start


class HeardInput(SmallWebRTCInputTransport):
    """pipecat's input, noting each frame of the caller's audio on the link watch."""

    def __init__(self, transport: "CallTransport") -> None:
        super().__init__(transport.client, transport.params, name=None)
        self._link = transport.link

    async def push_audio_frame(self, frame: InputAudioRawFrame) -> None:
        self._link.heard()
        await super().push_audio_frame(frame)


class HoldingOutput(SmallWebRTCOutputTransport):
    """pipecat's output, holding the EA's speech while the link is down rather than dropping it."""

    def __init__(self, transport: "CallTransport") -> None:
        super().__init__(transport.client, transport.params, name=None)
        self._link = transport.link

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        await self._link.wait()
        return await super().write_audio_frame(frame)


class CallTransport(SmallWebRTCTransport):
    """SmallWebRTC with a link watch: speech waits out a short drop or a peer connection rebuild."""

    def __init__(self, connection: SmallWebRTCConnection, params: TransportParams) -> None:
        super().__init__(webrtc_connection=connection, params=params)
        self.link = LinkWatch(connection)
        self.client = self._client
        self.params = params
        self._input = HeardInput(self)
        self._output = HoldingOutput(self)
