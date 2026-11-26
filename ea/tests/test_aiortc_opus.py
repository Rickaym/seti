import inspect

import aiortc
import aiortc.rtcrtpsender
import pytest
from aiortc.codecs.opus import OpusEncoder
from aiortc.rtcrtpparameters import RTCRtpCodecParameters
from opus_lib import frames_of, has_fec, rebuilt_share, speech_48k, speech_frames

from seti_ea import aiortc_opus
from seti_ea.aiortc_opus import VoiceOpusEncoder

OPUS = RTCRtpCodecParameters(mimeType="audio/opus", clockRate=48000, channels=2, payloadType=111)
VP8 = RTCRtpCodecParameters(mimeType="video/VP8", clockRate=90000, payloadType=96)


@pytest.fixture
def installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        aiortc.rtcrtpsender.__dict__, "get_encoder", aiortc.rtcrtpsender.__dict__["get_encoder"]
    )
    aiortc_opus.install()


def test_the_hook_matches_the_pinned_aiortc() -> None:
    # An aiortc upgrade fails here on purpose, so someone re-checks the hook against it.
    assert aiortc.__version__ == "1.15.0", "aiortc changed: re-check seti_ea/aiortc_opus.py"
    sender = inspect.getsource(aiortc.rtcrtpsender.RTCRtpSender)
    assert "self.__encoder = get_encoder(codec)" in sender
    assert "self.__encoder.encode, data, force_keyframe" in sender
    made = OpusEncoder()
    assert {"codec", "resampler"} <= set(vars(made))


@pytest.mark.usefixtures("installed")
def test_the_sender_gets_the_voice_encoder_for_opus_only() -> None:
    aiortc_opus.install()
    assert isinstance(aiortc.rtcrtpsender.__dict__["get_encoder"](OPUS), VoiceOpusEncoder)
    assert not isinstance(aiortc.rtcrtpsender.__dict__["get_encoder"](VP8), VoiceOpusEncoder)


def _encode(encoder: OpusEncoder) -> list[bytes]:
    packets: list[bytes] = []
    for frame in frames_of(speech_48k(), 480):
        payloads, _timestamp = encoder.encode(frame)
        packets += payloads
    return packets


def test_the_voice_is_mono_speech_with_fec_that_rebuilds_lost_frames() -> None:
    packets = _encode(VoiceOpusEncoder())
    speech = speech_frames(speech_48k())
    assert all(packet[0] & 0x04 == 0 for packet in packets), "every packet is mono"
    assert all(packet[0] >> 3 < 16 for packet in packets), "speech modes carry FEC, CELT does not"
    assert sum(map(has_fec, packets)) / len(packets) > 0.3
    assert rebuilt_share(packets, speech, 0.05) >= 0.8
    assert rebuilt_share(packets, speech, 0.15) >= 0.7


def test_aiortc_alone_sends_no_fec() -> None:
    packets = _encode(OpusEncoder())
    assert not any(map(has_fec, packets))
    assert rebuilt_share(packets, speech_frames(speech_48k()), 0.05) == 0
