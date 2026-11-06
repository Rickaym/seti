import asyncio
from collections.abc import AsyncGenerator, Sequence
from typing import cast

import numpy as np
from pipecat.frames.frames import Frame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from test_wake import started

from seti_ea.local_wake import BUFFER_SECS, REPLAY_SECS, LocalWake, PausableDeepgramSTT, SleepControl
from seti_ea.spotter import KwsStream, Listener, Samples, Spotter
from seti_ea.wake import WakeSettings, WakeStrategy

RATE = 16000
FRAME_SAMPLES = 320
LEXICON = {"HEY": ["HH", "EY1"], "SETI": ["S", "EH1", "T", "IY2"], "OK": ["OW1", "K", "EY1"]}


def audio_frame(value: int = 0) -> InputAudioRawFrame:
    pcm = np.full(FRAME_SAMPLES, value, dtype=np.int16).tobytes()
    return InputAudioRawFrame(audio=pcm, sample_rate=RATE, num_channels=1)


class FakeStream:
    def __init__(self, keywords: str | None) -> None:
        self.keywords = keywords
        self.samples = 0
        self.ready = False

    def accept_waveform(self, sample_rate: int, waveform: Samples) -> None:
        assert sample_rate == RATE
        self.samples += len(waveform)
        self.ready = True


class FakeEngine:
    """Hears the phrase once `hit_after` samples have gone in."""

    def __init__(self, hit_after: int | None = None) -> None:
        self.hit_after = hit_after
        self.streams: list[FakeStream] = []

    def create_stream(self, keywords: str | None = None) -> FakeStream:
        stream = FakeStream(keywords)
        self.streams.append(stream)
        return stream

    def is_ready(self, stream: KwsStream, /) -> bool:
        return cast(FakeStream, stream).ready

    def decode_stream(self, stream: KwsStream, /) -> None:
        cast(FakeStream, stream).ready = False

    def get_result(self, stream: KwsStream, /) -> str:
        fake = cast(FakeStream, stream)
        if self.hit_after is not None and fake.samples >= self.hit_after:
            self.hit_after = None
            return "wake"
        return ""

    def reset_stream(self, stream: KwsStream, /) -> None:
        cast(FakeStream, stream).samples = 0


class RecordingStt(PausableDeepgramSTT):
    """Deepgram with the network replaced by counters and a list of the audio it would send."""

    def __init__(self, *, paused: bool) -> None:
        super().__init__(paused=paused, api_key="test")
        self.sent: list[bytes] = []
        self.opened = 0
        self.closed = 0
        self.gate: asyncio.Event | None = None

    async def _open(self) -> None:
        if self.gate is not None:
            await self.gate.wait()
        self.opened += 1

    async def _disconnect(self) -> None:
        self.closed += 1

    async def connect_now(self) -> None:
        await self._connect()

    async def reconnect_now(self) -> None:
        await self._do_reconnect()

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None]:
        self.sent.append(audio)
        yield None


async def test_paused_speech_to_text_sends_nothing_and_never_connects() -> None:
    stt = RecordingStt(paused=True)
    await stt.connect_now()
    await stt.process_audio_frame(audio_frame(1), FrameDirection.DOWNSTREAM)
    await stt.reconnect_now()
    assert (stt.opened, stt.closed, stt.sent) == (0, 0, [])
    await stt.pause()
    assert stt.closed == 0


async def test_resume_replays_the_buffer_first_then_what_arrived_while_connecting() -> None:
    stt = RecordingStt(paused=True)
    stt.gate = asyncio.Event()
    replay = [audio_frame(1), audio_frame(2)]
    task = stt.resume_soon(replay)
    assert task is not None
    assert not stt.paused
    for frame in [replay[1], audio_frame(3), audio_frame(4)]:
        await stt.process_audio_frame(frame, FrameDirection.DOWNSTREAM)
    assert stt.sent == []
    stt.gate.set()
    await task
    assert stt.opened == 1
    assert [np.frombuffer(pcm, dtype=np.int16)[0] for pcm in stt.sent] == [1, 2, 3, 4]
    await stt.process_audio_frame(audio_frame(5), FrameDirection.DOWNSTREAM)
    assert len(stt.sent) == 5
    await stt.resume()
    assert stt.opened == 1

    await stt.pause()
    assert stt.paused
    assert stt.closed == 1
    await stt.process_audio_frame(audio_frame(6), FrameDirection.DOWNSTREAM)
    assert len(stt.sent) == 5


async def test_pausing_waits_for_a_resume_in_flight() -> None:
    stt = RecordingStt(paused=True)
    stt.gate = asyncio.Event()
    stt.resume_soon([audio_frame(1)])
    pausing = asyncio.create_task(stt.pause())
    await asyncio.sleep(0.01)
    assert not pausing.done()
    stt.gate.set()
    await pausing
    assert (stt.opened, stt.closed, len(stt.sent), stt.paused) == (1, 1, 1, True)


async def wait_for(event: asyncio.Event) -> None:
    async with asyncio.timeout(2):
        await event.wait()


async def test_the_local_listener_hands_over_the_last_seconds_when_it_hears_the_phrase() -> None:
    heard: list[list[InputAudioRawFrame]] = []
    done = asyncio.Event()

    def on_heard(replay: list[InputAudioRawFrame]) -> None:
        heard.append(replay)
        done.set()

    local = LocalWake(on_heard)
    frames = [audio_frame(i) for i in range(250)]
    for frame in frames[:200]:
        local.hear(frame)
    assert local.recent(BUFFER_SECS)[0] is frames[200 - int(BUFFER_SECS * RATE / FRAME_SAMPLES)]
    engine = FakeEngine(hit_after=RATE)
    local.listen(Listener(engine, "HH EY1 :1.5 #0.2 @wake"))
    for frame in frames[200:]:
        local.hear(frame)
    await wait_for(done)
    [replay] = heard
    assert replay == frames[-int(REPLAY_SECS * RATE / FRAME_SAMPLES) :]
    assert not local.listening


async def test_a_listener_replaced_before_its_result_arrives_is_ignored() -> None:
    heard: list[list[InputAudioRawFrame]] = []
    local = LocalWake(heard.append)
    local.listen(Listener(FakeEngine(hit_after=0), ""))
    for value in range(10):
        local.hear(audio_frame(value))
    local.listen(None)
    await asyncio.sleep(0.1)
    assert heard == []


class FakeStt:
    def __init__(self, paused: bool = False) -> None:
        self.paused = paused
        self.calls: list[str] = []
        self.replayed: list[int] = []

    def resume_soon(self, replay: Sequence[InputAudioRawFrame] = ()) -> asyncio.Task[None] | None:
        if self.paused:
            self.paused = False
            self.calls.append("resume")
            self.replayed.append(len(replay))
        return None

    async def resume(self, replay: Sequence[InputAudioRawFrame] = ()) -> None:
        self.resume_soon(replay)

    async def pause(self) -> None:
        if not self.paused:
            self.paused = True
            self.calls.append("pause")


async def test_sleep_hangs_up_speech_to_text_and_listens_locally_until_woken() -> None:
    wake = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=30))
    await started(wake)
    stt = FakeStt()
    engine = FakeEngine()
    control = SleepControl(wake, stt, lambda: Spotter(engine, LEXICON))
    await control.follow()
    assert stt.calls == ["pause"]
    assert control.listening_locally
    assert control.local.listening
    [stream] = engine.streams
    assert stream.keywords is not None
    assert stream.keywords.split("/")[:2] == [
        "HH EY1 S EH1 T IY2 :1.5 #0.2 @wake",
        "HH EY1 S EH1 D IY2 :1.5 #0.2 @wake",
    ]
    await control.follow()
    assert len(engine.streams) == 1

    assert wake.wake()
    await control.follow()
    assert stt.calls == ["pause", "resume"]
    assert not control.listening_locally
    assert not control.local.listening

    wake.sleep()
    await control.follow()
    assert stt.calls == ["pause", "resume", "pause"]
    assert len(engine.streams) == 2
    await wake.cleanup()


async def test_a_local_hit_transcribes_and_goes_back_to_sleep_unless_confirmed() -> None:
    wake = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=30))
    await started(wake)
    stt = FakeStt()
    control = SleepControl(wake, stt, lambda: Spotter(FakeEngine(), LEXICON), confirm_secs=0.05)
    await control.follow()
    control.local.listen(None)
    control.heard([audio_frame(), audio_frame()])
    assert stt.calls == ["pause", "resume"]
    assert stt.replayed == [2]
    await control.follow()
    assert stt.calls == ["pause", "resume"]
    await asyncio.sleep(0.15)
    assert stt.calls == ["pause", "resume", "pause"]
    assert control.local.listening

    control.local.listen(None)
    control.heard([audio_frame()])
    assert wake.wake()
    await control.follow()
    await asyncio.sleep(0.15)
    assert stt.calls == ["pause", "resume", "pause", "resume"]
    assert not stt.paused
    await wake.cleanup()


async def test_without_a_local_spotter_or_for_an_unknown_word_speech_to_text_stays_on() -> None:
    wake = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=30))
    await started(wake)
    stt = FakeStt(paused=True)
    control = SleepControl(wake, stt, lambda: None)
    await control.follow()
    assert stt.calls == ["resume"]
    assert not control.listening_locally

    unknown = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Zorblax", keep_awake_secs=30))
    await started(unknown)
    other = FakeStt()
    await SleepControl(unknown, other, lambda: Spotter(FakeEngine(), LEXICON)).follow()
    assert other.calls == []
    assert not other.paused
    await wake.cleanup()
    await unknown.cleanup()


async def test_a_new_phrase_gets_a_new_stream_without_a_restart() -> None:
    wake = WakeStrategy(WakeSettings(enabled=True, phrase="Hey Seti", keep_awake_secs=30))
    await started(wake)
    engine = FakeEngine()
    control = SleepControl(wake, FakeStt(), lambda: Spotter(engine, LEXICON))
    await control.follow()
    wake.configure(WakeSettings(enabled=True, phrase="OK Seti", keep_awake_secs=30))
    await control.follow()
    assert [stream.keywords.split(" :")[0] if stream.keywords else "" for stream in engine.streams] == [
        "HH EY1 S EH1 T IY2",
        "OW1 K EY1 S EH1 T IY2",
    ]
    await wake.cleanup()


def test_the_listener_feeds_the_stream_and_resets_it_after_a_hit() -> None:
    engine = FakeEngine(hit_after=640)
    listener = Listener(engine, "kw")
    silence = np.zeros(320, dtype=np.float32)
    assert not listener.feed(silence, RATE)
    assert listener.feed(silence, RATE)
    assert engine.streams[0].samples == 0
    assert not listener.feed(silence, RATE)
