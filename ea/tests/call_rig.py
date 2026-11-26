"""A whole call over loopback through a shaped network, with no real network, speech or model API.

The network drops, delays and blacks out datagrams inside aioice, so nothing on the host changes.
The bot speaks numbered tones through pipecat's real SmallWebRTC transport, and the caller is an
aiortc peer that pings and sends a microphone tone the way the browser does. Each tone's pitch
names its 200 ms chunk, so the caller can tell which parts of the speech never reached it.
"""

import asyncio
import contextlib
import fractions
import itertools
import math
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import aioice.ice
import httpx
import numpy as np
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack, MediaStreamError, MediaStreamTrack
from av import AudioFrame
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.workers.runner import WorkerRunner

CHUNK_SECS = 0.2
OUT_RATE = 24000
PITCHES = 60
PITCH_STEP = 100
PITCH_BASE = 400
SPOKEN_AHEAD_SECS = 1.0
GAP_SECS = 0.2


def pitch_of(chunk: int) -> int:
    return PITCH_BASE + PITCH_STEP * (chunk % PITCHES)


def chunk_audio(chunk: int) -> bytes:
    t = np.arange(int(OUT_RATE * CHUNK_SECS)) / OUT_RATE
    return (np.sin(2 * math.pi * pitch_of(chunk) * t) * 8000).astype(np.int16).tobytes()


def heard_pitch(samples: np.ndarray, rate: int) -> int | None:
    """The tone's pitch in a 20 ms frame, or None for silence."""
    if float(np.sqrt(np.mean(samples.astype(float) ** 2))) < 500:
        return None
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return round(float(np.argmax(spectrum)) * rate / len(samples) / PITCH_STEP) * PITCH_STEP


@dataclass
class Network:
    """Loss, jitter and blackouts for every datagram aioice sends; dead ports send nothing."""

    loss: float = 0.0
    jitter_ms: float = 0.0
    blackout_until: float = 0.0
    dead: set[int] = field(default_factory=set)
    ports: set[int] = field(default_factory=set)
    chance: random.Random = field(default_factory=lambda: random.Random(3))

    def blackout(self, seconds: float) -> None:
        self.blackout_until = time.monotonic() + seconds

    def move(self) -> None:
        """The phone changed address: every socket open now stops reaching anything."""
        self.dead |= self.ports


class ShapedTransport:
    """A datagram transport that sends through the Network's loss, jitter and blackouts."""

    def __init__(self, network: Network, inner: asyncio.DatagramTransport) -> None:
        self._network = network
        self._inner = inner
        self._port: int = inner.get_extra_info("sockname")[1]
        self._last = 0.0
        network.ports.add(self._port)

    def sendto(self, data: bytes, addr: Any = None) -> None:
        net = self._network
        now = time.monotonic()
        if now < net.blackout_until or self._port in net.dead or addr[1] in net.dead:
            return
        if net.chance.random() < net.loss:
            return
        due = max(now + net.chance.uniform(0, net.jitter_ms) / 1000, self._last)
        self._last = due
        asyncio.get_running_loop().call_later(due - now, self._send, data, addr)

    def _send(self, data: bytes, addr: Any) -> None:
        if not self._inner.is_closing():
            self._inner.sendto(data, addr)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def loopback_only(use_ipv4: bool, use_ipv6: bool) -> list[str]:
    del use_ipv4, use_ipv6
    return ["127.0.0.1"]


def no_ice_servers(_servers: object) -> list[object]:
    return []


def shape(monkeypatch: Any, network: Network) -> None:
    """Loopback candidates only, and every aioice socket sending through `network`."""
    monkeypatch.setattr(aioice.ice, "get_host_addresses", loopback_only)
    made = aioice.ice.StunProtocol.connection_made

    def connection_made(self: aioice.ice.StunProtocol, transport: asyncio.BaseTransport) -> None:
        made(self, transport)
        self.transport = ShapedTransport(network, self.transport)  # type: ignore[assignment]

    monkeypatch.setattr(aioice.ice.StunProtocol, "connection_made", connection_made)


@dataclass
class BotLog:
    """What the bot side saw: sessions started, and when the user's audio arrived."""

    sessions: int = 0
    heard_at: list[float] = field(default_factory=list)
    spoken: int = 0


class HeardAudio(FrameProcessor):
    def __init__(self, log: BotLog) -> None:
        super().__init__()
        self._log = log

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self._log.heard_at.append(time.monotonic())
        await self.push_frame(frame, direction)


TransportFactory = Callable[[SmallWebRTCConnection, TransportParams], BaseTransport]


def tone_bot(log: BotLog, make_transport: TransportFactory) -> Callable[..., Awaitable[None]]:
    """A bot that speaks numbered tones about a second ahead, the way TTS outruns playback."""

    async def bot(connection: SmallWebRTCConnection, *_args: Any) -> None:
        log.sessions += 1
        transport = make_transport(connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True))
        pipeline = Pipeline([transport.input(), HeardAudio(log), transport.output()])
        worker = PipelineWorker(pipeline, params=PipelineParams(audio_out_sample_rate=OUT_RATE))

        @transport.event_handler("on_client_disconnected")
        async def on_gone(_transport: Any, _client: Any) -> None:
            await worker.cancel()

        async def speak() -> None:
            start = time.monotonic()
            while True:
                while log.spoken * CHUNK_SECS < time.monotonic() - start + SPOKEN_AHEAD_SECS:
                    audio = chunk_audio(log.spoken)
                    await worker.queue_frames([OutputAudioRawFrame(audio, OUT_RATE, 1)])
                    log.spoken += 1
                await asyncio.sleep(0.05)

        speaking = asyncio.create_task(speak())
        try:
            runner = WorkerRunner(handle_sigint=False)
            await runner.add_workers(worker)
            await runner.run()
        finally:
            speaking.cancel()

    return bot


class Microphone(AudioStreamTrack):
    """A steady 300 Hz tone in 20 ms frames, paced like a real microphone."""

    def __init__(self) -> None:
        super().__init__()
        self._sent = 0
        self._start = time.monotonic()

    async def recv(self) -> AudioFrame:
        due = self._start + self._sent * 0.02
        await asyncio.sleep(max(0.0, due - time.monotonic()))
        t = (np.arange(960) + self._sent * 960) / 48000
        samples = (np.sin(2 * math.pi * 300 * t) * 6000).astype(np.int16)
        frame = AudioFrame.from_ndarray(samples[None, :], layout="mono")
        frame.sample_rate = 48000
        frame.pts = self._sent * 960
        frame.time_base = fractions.Fraction(1, 48000)
        self._sent += 1
        return frame


@dataclass
class Heard:
    at: float
    pitch: int | None


@dataclass
class Caller:
    """The browser's side: one peer connection at a time, pings every second, and what it heard."""

    client: httpx.AsyncClient
    heard: list[Heard] = field(default_factory=list)
    pc: RTCPeerConnection | None = None
    pc_id: str | None = None
    tasks: list[asyncio.Task[None]] = field(default_factory=list)

    async def connect(self, restart: bool = False) -> None:
        old = self.pc
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.pc = pc
        connected = asyncio.Event()

        @pc.on("connectionstatechange")
        def on_state() -> None:
            if pc.connectionState == "connected":
                connected.set()

        @pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            if track.kind == "audio":
                self.tasks.append(asyncio.create_task(self._listen(track)))

        pc.addTransceiver(Microphone(), direction="sendrecv")
        pc.addTransceiver("video", direction="sendrecv")
        channel = pc.createDataChannel("rtvi")
        await pc.setLocalDescription(await pc.createOffer())
        offer: dict[str, Any] = {"sdp": pc.localDescription.sdp, "type": "offer"}
        if restart:
            offer.update(pc_id=self.pc_id, restart_pc=True)
        response = await self.client.post("/offer", json=offer)
        assert response.status_code == 200, response.text
        answer = response.json()
        self.pc_id = answer["pc_id"]
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
        async with asyncio.timeout(15):
            await connected.wait()
        if old is not None:
            self.tasks.append(asyncio.create_task(old.close()))
        self.tasks.append(asyncio.create_task(self._ping(pc, channel)))

    async def _ping(self, pc: RTCPeerConnection, channel: Any) -> None:
        while pc.connectionState != "closed":
            if channel.readyState == "open":
                channel.send(f"ping: {time.time()}")
            await asyncio.sleep(1)

    async def _listen(self, track: MediaStreamTrack) -> None:
        with contextlib.suppress(MediaStreamError):
            while True:
                frame = await track.recv()
                assert isinstance(frame, AudioFrame)
                samples = frame.to_ndarray().reshape(-1)[:: len(frame.layout.channels)]
                self.heard.append(Heard(time.monotonic(), heard_pitch(samples, frame.sample_rate)))

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        if self.pc is not None:
            await self.pc.close()


@dataclass
class Report:
    """Speech the caller missed, gaps in it, and how long the bot went without the user's audio."""

    chunks_missed: int
    gaps_over_200ms: int
    longest_gap_s: float
    longest_inbound_gap_s: float

    def line(self) -> str:
        return (
            f"missed {self.chunks_missed} chunks of speech, {self.gaps_over_200ms} gaps over 200 ms, "
            f"longest {self.longest_gap_s:.1f} s; user audio longest gap {self.longest_inbound_gap_s:.1f} s"
        )


def _gaps(times: list[float]) -> list[float]:
    return [b - a for a, b in itertools.pairwise(times)]


def report(caller: Caller, log: BotLog, since: float) -> Report:
    tones = [h for h in caller.heard if h.at >= since and h.pitch is not None]
    runs: list[tuple[int, int]] = []
    for heard in tones:
        assert heard.pitch is not None
        if runs and runs[-1][0] == heard.pitch:
            runs[-1] = (heard.pitch, runs[-1][1] + 1)
        else:
            runs.append((heard.pitch, 1))
    pitches = [pitch for pitch, frames in runs if frames > 1]
    steps = [((b - a) // PITCH_STEP) % PITCHES for a, b in itertools.pairwise(pitches)]
    missed = sum(step - 1 for step in steps if step > 1)
    gaps = _gaps([h.at for h in tones])
    inbound = _gaps([t for t in log.heard_at if t >= since])
    return Report(
        chunks_missed=missed,
        gaps_over_200ms=sum(gap > GAP_SECS for gap in gaps),
        longest_gap_s=max(gaps, default=0.0),
        longest_inbound_gap_s=max(inbound, default=0.0),
    )


Impairment = Callable[[Network, Caller], Awaitable[None]]
WARM_UP_SECS = 1.5
SILENT_BEFORE_REBUILD_SECS = 1.5


async def run_call(
    monkeypatch: Any, make_transport: TransportFactory, impair: Impairment
) -> tuple[Report, BotLog]:
    """One call: connect, settle, apply the impairment, and report from the moment it began."""
    from fakes import SETI_TOKEN, settings

    from seti_ea import server

    network = Network()
    shape(monkeypatch, network)
    monkeypatch.setattr(server, "to_ice_servers", no_ice_servers)
    log = BotLog()
    keys = {"deepgram_api_key": "dg", "openai_api_key": "op", "elevenlabs_api_key": "el"}
    app = server.create_app(settings(**keys), bot=tone_bot(log, make_transport))
    sessions: server.Sessions = app.state.sessions
    headers = {"Authorization": f"Bearer {SETI_TOKEN}"}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1:3007", headers=headers
    ) as client:
        caller = Caller(client)
        await caller.connect()
        await asyncio.sleep(WARM_UP_SECS)
        since = time.monotonic()
        try:
            await impair(network, caller)
            return report(caller, log, since), log
        finally:
            await caller.close()
            await sessions.close()


def lossy(loss: float, jitter_ms: float, seconds: float = 6.0) -> Impairment:
    async def impair(network: Network, _caller: Caller) -> None:
        network.loss, network.jitter_ms = loss, jitter_ms
        await asyncio.sleep(seconds)

    return impair


def blackout(seconds: float, after_secs: float = 5.0) -> Impairment:
    async def impair(network: Network, _caller: Caller) -> None:
        await asyncio.sleep(1)
        network.blackout(seconds)
        await asyncio.sleep(seconds + after_secs)

    return impair


async def _silent_for(caller: Caller, seconds: float, limit: float) -> bool:
    end = time.monotonic() + limit
    while time.monotonic() < end:
        last = max((h.at for h in caller.heard if h.pitch is not None), default=0.0)
        if time.monotonic() - last > seconds:
            return True
        await asyncio.sleep(0.1)
    return False


def address_change(after_secs: float = 5.0) -> Impairment:
    """The phone moves network: the old path dies and the caller rebuilds its peer connection."""

    async def impair(network: Network, caller: Caller) -> None:
        await asyncio.sleep(1)
        network.move()
        assert await _silent_for(caller, SILENT_BEFORE_REBUILD_SECS, 10)
        await caller.connect(restart=True)
        await asyncio.sleep(after_secs)

    return impair
