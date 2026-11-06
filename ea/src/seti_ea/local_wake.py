"""While the EA sleeps, speech to text hangs up and the wake phrase is heard on this host.

A local hit reconnects speech to text and replays the last seconds of audio, so the phrase and
what follows it in one breath are transcribed; the transcript still has to carry the phrase to
wake the EA, so a false local hit costs a few seconds of transcription and never a reply.
"""

import asyncio
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import Executor, Future, ThreadPoolExecutor
from typing import Any, Protocol

import numpy as np
from loguru import logger
from pipecat.frames.frames import Frame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService

from seti_ea.spotter import Listener, Spotter
from seti_ea.wake import WakeStrategy

BUFFER_SECS = 3.0
REPLAY_SECS = 2.0
BATCH_SECS = 0.1
MAX_PENDING_BATCHES = 20
CONFIRM_SECS = 8.0
CONNECT_TIMEOUT_SECS = 5.0


def frame_secs(frame: InputAudioRawFrame) -> float:
    return frame.num_frames / frame.sample_rate if frame.sample_rate else 0.0


class PausableDeepgramSTT(DeepgramSTTService):
    """Deepgram that disconnects while paused and, on resume, sends the audio it missed first."""

    def __init__(self, *, paused: bool = False, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._paused = paused
        self._held: list[InputAudioRawFrame] | None = None
        self._replayed: set[int] = set()
        self._resuming: asyncio.Task[None] | None = None

    @property
    def paused(self) -> bool:
        return self._paused

    async def _connect(self) -> None:
        if not self._paused:
            await self._open()

    async def _open(self) -> None:
        await super()._connect()

    async def _do_reconnect(self) -> None:
        # New settings reach Deepgram on the next connect; paused, there is nothing to reconnect.
        if not self._paused:
            await super()._do_reconnect()

    async def process_audio_frame(self, frame: InputAudioRawFrame, direction: FrameDirection) -> None:
        if self._held is not None:
            if frame.id not in self._replayed:
                self._held.append(frame)
            return
        if self._paused:
            return
        await super().process_audio_frame(frame, direction)

    def resume_soon(self, replay: Sequence[InputAudioRawFrame] = ()) -> asyncio.Task[None] | None:
        """Holds new audio behind `replay` at once and reconnects in the background."""
        if not self._paused:
            return self._resuming
        self._paused = False
        self._held = list(replay)
        self._replayed = {frame.id for frame in replay}
        self._resuming = asyncio.get_running_loop().create_task(self._finish_resume())
        return self._resuming

    async def resume(self, replay: Sequence[InputAudioRawFrame] = ()) -> None:
        task = self.resume_soon(replay)
        if task is not None:
            await task

    async def _finish_resume(self) -> None:
        try:
            await asyncio.wait_for(self._connect(), CONNECT_TIMEOUT_SECS)
        except TimeoutError:
            logger.warning(f"{self}: speech to text did not reconnect in time; it keeps trying")
        finally:
            held = self._held or []
            while held:
                await super().process_audio_frame(held.pop(0), FrameDirection.DOWNSTREAM)
            self._held = None
            self._replayed = set()
            self._resuming = None

    async def pause(self) -> None:
        """Stops sending audio and closes the connection, so sleep costs nothing."""
        if self._resuming is not None:
            await self._resuming
        if self._paused:
            return
        self._paused = True
        await self._disconnect()


Heard = Callable[[list[InputAudioRawFrame]], None]


class LocalWake(FrameProcessor):
    """Keeps the caller's last seconds of audio and, given a listener, spots the phrase in it."""

    def __init__(self, heard: Heard, executor: Executor | None = None) -> None:
        super().__init__()
        self._heard = heard
        self._executor = executor or ThreadPoolExecutor(max_workers=1, thread_name_prefix="ea-wake")
        self._recent: deque[InputAudioRawFrame] = deque()
        self._recent_secs = 0.0
        self._listener: Listener | None = None
        self._generation = 0
        self._batch: list[bytes] = []
        self._batch_secs = 0.0
        self._pending = 0
        self._dropping = False

    @property
    def listening(self) -> bool:
        return self._listener is not None

    def listen(self, listener: Listener | None) -> None:
        """Starts spotting with this listener, or stops with None."""
        self._listener = listener
        self._generation += 1
        self._batch.clear()
        self._batch_secs = 0.0

    def recent(self, secs: float) -> list[InputAudioRawFrame]:
        """The frames that cover the last `secs` seconds, oldest first."""
        picked: list[InputAudioRawFrame] = []
        total = 0.0
        for frame in reversed(self._recent):
            if total >= secs:
                break
            picked.append(frame)
            total += frame_secs(frame)
        picked.reverse()
        return picked

    def hear(self, frame: InputAudioRawFrame) -> None:
        """Keeps the frame for a replay and, while listening, queues it for the spotter."""
        self._remember(frame)
        if self._listener is not None:
            self._spot(frame, self._listener)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.hear(frame)
        await self.push_frame(frame, direction)

    async def cleanup(self) -> None:
        await super().cleanup()
        self.listen(None)
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _remember(self, frame: InputAudioRawFrame) -> None:
        self._recent.append(frame)
        self._recent_secs += frame_secs(frame)
        while self._recent and self._recent_secs - frame_secs(self._recent[0]) >= BUFFER_SECS:
            self._recent_secs -= frame_secs(self._recent.popleft())

    def _spot(self, frame: InputAudioRawFrame, listener: Listener) -> None:
        self._batch.append(frame.audio)
        self._batch_secs += frame_secs(frame)
        if self._batch_secs < BATCH_SECS:
            return
        pcm = b"".join(self._batch)
        self._batch.clear()
        self._batch_secs = 0.0
        if self._pending >= MAX_PENDING_BATCHES:
            if not self._dropping:
                logger.warning("The local wake word spotter is falling behind; dropping audio")
            self._dropping = True
            return
        self._dropping = False
        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        generation = self._generation
        self._pending += 1
        job = self._executor.submit(listener.feed, samples, frame.sample_rate)
        loop = asyncio.get_running_loop()
        job.add_done_callback(lambda done: loop.call_soon_threadsafe(self._fed, done, generation))

    def _fed(self, job: Future[bool], generation: int) -> None:
        self._pending -= 1
        if job.cancelled() or generation != self._generation or self._listener is None:
            return
        error = job.exception()
        if error is not None:
            logger.error(f"The local wake word spotter failed: {error}")
            return
        if job.result():
            self.listen(None)
            self._heard(self.recent(REPLAY_SECS))


class SpeechToText(Protocol):
    @property
    def paused(self) -> bool: ...
    def resume_soon(self, replay: Sequence[InputAudioRawFrame] = ()) -> asyncio.Task[None] | None: ...
    async def resume(self, replay: Sequence[InputAudioRawFrame] = ()) -> None: ...
    async def pause(self) -> None: ...


class SleepControl:
    """Keeps speech to text off while the EA sleeps with a phrase the local spotter can hear."""

    def __init__(
        self,
        wake: WakeStrategy,
        stt: SpeechToText,
        spotter: Callable[[], Spotter | None],
        confirm_secs: float = CONFIRM_SECS,
    ) -> None:
        self._wake = wake
        self._stt = stt
        self._spotter = spotter
        self._confirm_secs = confirm_secs
        self._phrase: str | None = None
        self._confirm: asyncio.TimerHandle | None = None
        self.local = LocalWake(self.heard)

    @property
    def listening_locally(self) -> bool:
        """Asleep with the phrase heard on this host, or checking a local hit with speech to text."""
        return self._phrase is not None

    def _asleep(self) -> bool:
        settings = self._wake.settings
        return settings.enabled and not self._wake.awake

    async def follow(self) -> None:
        """Brings speech to text and the local spotter in line with the wake state."""
        if not self._asleep():
            self._stop_confirm()
            self._phrase = None
            self.local.listen(None)
            await self._stt.resume()
            return
        phrase = self._wake.settings.phrase
        if self._phrase == phrase and (self.local.listening or self._confirm is not None):
            return
        spotter = self._spotter()
        listener = spotter.listener(phrase) if spotter is not None else None
        if listener is None:
            self._phrase = None
            self.local.listen(None)
            await self._stt.resume()
            return
        self._stop_confirm()
        self._phrase = phrase
        self.local.listen(listener)
        await self._stt.pause()

    def heard(self, replay: list[InputAudioRawFrame]) -> None:
        """A local hit: transcribe from just before the phrase and give the transcript a moment."""
        logger.info("Local wake phrase heard; checking it with speech to text")
        self._stt.resume_soon(replay)
        self._stop_confirm()
        self._confirm = asyncio.get_running_loop().call_later(self._confirm_secs, self._unconfirmed)

    def _unconfirmed(self) -> None:
        self._confirm = None
        if self._asleep():
            self._phrase = None
            asyncio.get_running_loop().create_task(self.follow())

    def _stop_confirm(self) -> None:
        if self._confirm is not None:
            self._confirm.cancel()
            self._confirm = None
