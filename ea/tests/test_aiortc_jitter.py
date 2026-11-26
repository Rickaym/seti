import inspect
import random
from types import SimpleNamespace

import aiortc
import aiortc.rtcrtpreceiver
import pytest
from aiortc.jitterbuffer import JitterBuffer
from aiortc.rtp import RtpPacket

from seti_ea import aiortc_jitter
from seti_ea.aiortc_jitter import KEEP, AudioJitterBuffer


def packet(sequence: int) -> RtpPacket:
    made = RtpPacket(payload_type=111, sequence_number=sequence % 65536, timestamp=sequence * 960 % (1 << 32))
    made._data = (sequence % 65536).to_bytes(4, "big")  # type: ignore[attr-defined]
    return made


def released(buffer: AudioJitterBuffer | JitterBuffer, sequences: list[int]) -> list[int]:
    out: list[int] = []
    for sequence in sequences:
        _pli, frame = buffer.add(packet(sequence))
        if frame is not None:
            out.append(int.from_bytes(frame.data[:4], "big"))
    return out


@pytest.fixture
def installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        aiortc.rtcrtpreceiver.__dict__, "JitterBuffer", aiortc.rtcrtpreceiver.__dict__["JitterBuffer"]
    )
    aiortc_jitter.install()


def test_the_hook_matches_the_pinned_aiortc() -> None:
    # aiortc 1.17 rewrote its jitter buffer; once it has settled, drop this hook for it.
    assert aiortc.__version__ == "1.15.0", "aiortc changed: re-check seti_ea/aiortc_jitter.py"
    receiver = inspect.getsource(aiortc.rtcrtpreceiver.RTCRtpReceiver)
    assert "self.__jitter_buffer = JitterBuffer(capacity=16, prefetch=4)" in receiver
    assert "pli_flag, encoded_frame = self.__jitter_buffer.add(packet)" in receiver
    assert "packet._data = depayload(codec, packet.payload)" in receiver


@pytest.mark.usefixtures("installed")
def test_the_receiver_buffers_audio_with_the_audio_buffer_and_video_with_aiortc() -> None:
    aiortc_jitter.install()
    transport = SimpleNamespace(state="new")
    audio = aiortc.rtcrtpreceiver.RTCRtpReceiver("audio", transport)  # type: ignore[arg-type]
    video = aiortc.rtcrtpreceiver.RTCRtpReceiver("video", transport)  # type: ignore[arg-type]
    assert isinstance(vars(audio)["_RTCRtpReceiver__jitter_buffer"], AudioJitterBuffer)
    assert isinstance(vars(video)["_RTCRtpReceiver__jitter_buffer"], JitterBuffer)


def test_packets_leave_in_order_after_keep_more_arrive() -> None:
    assert released(AudioJitterBuffer(), list(range(10))) == list(range(10 - KEEP))


def test_a_reordered_packet_is_put_back_in_place() -> None:
    assert released(AudioJitterBuffer(), [0, 2, 1, 3, 4, 5, 6]) == [0, 1, 2, 3]


def test_a_lost_packet_is_skipped_and_nothing_that_arrived_is_dropped() -> None:
    buffer = AudioJitterBuffer()
    sequences = [s for s in range(40) if s not in (5, 17, 18)]
    assert released(buffer, sequences) == sequences[: len(sequences) - KEEP]
    assert (buffer.loss.skipped, buffer.loss.late) == (3, 0)


def test_a_packet_older_than_one_released_is_dropped_as_late() -> None:
    buffer = AudioJitterBuffer()
    assert released(buffer, [0, 1, 3, 4, 5, 6, 2, 7]) == [0, 1, 3, 4]
    assert (buffer.loss.skipped, buffer.loss.late) == (1, 1)


def test_sequence_numbers_wrap() -> None:
    sequences = list(range(65530, 65545))
    assert released(AudioJitterBuffer(), sequences) == [s % 65536 for s in sequences[: len(sequences) - KEEP]]


def test_a_sender_that_restarts_its_sequence_is_followed() -> None:
    buffer = AudioJitterBuffer()
    out = released(buffer, [*range(1000, 1010), *range(20, 30)])
    assert out[-1] == 26
    assert 20 in out


def _arrivals(loss: float, count: int = 3000) -> list[int]:
    """Sequence numbers in arrival order; one network path delays packets but keeps their order."""
    chance = random.Random(1)
    return [i for i in range(count) if chance.random() >= loss]


@pytest.mark.parametrize("loss", [0.01, 0.05, 0.15])
def test_only_what_the_network_lost_is_missing(loss: float) -> None:
    arrived = _arrivals(loss)
    kept = len(set(released(AudioJitterBuffer(), arrived)))
    aiortc_kept = len(set(released(JitterBuffer(capacity=16, prefetch=4), arrived)))
    assert kept == len(arrived) - KEEP
    assert aiortc_kept < kept - len(arrived) * loss
