"""The EA's voice as aiortc encodes it: mono Opus for speech, with in-band FEC for lossy networks.

aiortc encodes every Opus track at 96 kbps stereo with no forward error correction, so each lost
packet is a gap the phone must conceal. With FEC and a loss hint, Opus carries a low-rate copy of
the previous frame in each packet, from which the browser rebuilds a single lost frame. aiortc has
no setting for this, so `install` swaps in this encoder where its sender creates one.
"""

from collections.abc import Callable
from typing import Any

import aiortc.rtcrtpsender
from aiortc.codecs.base import Encoder
from aiortc.codecs.opus import SAMPLE_RATE, SAMPLES_PER_FRAME, OpusEncoder
from aiortc.rtcrtpparameters import RTCRtpCodecParameters
from av import AudioResampler

VOICE_BITRATE = 48000
LOSS_HINT_PERCENT = 10
VOICE_OPTIONS = {"application": "voip", "fec": "1", "packet_loss": str(LOSS_HINT_PERCENT)}

EncoderFactory = Callable[[RTCRtpCodecParameters], Encoder]


class VoiceOpusEncoder(OpusEncoder):
    """aiortc's Opus encoder at speech settings: 48 kbps mono with in-band FEC."""

    def __init__(self) -> None:
        super().__init__()
        self.codec.bit_rate = VOICE_BITRATE
        self.codec.layout = "mono"
        self.codec.options = dict(VOICE_OPTIONS)
        self.resampler = AudioResampler(
            format="s16", layout="mono", rate=SAMPLE_RATE, frame_size=SAMPLES_PER_FRAME
        )


def voice_encoders(fallback: EncoderFactory) -> EncoderFactory:
    """An encoder factory that gives Opus the voice settings and every other codec its default."""

    def get_encoder(codec: RTCRtpCodecParameters) -> Encoder:
        if codec.mimeType.lower() == "audio/opus":
            return VoiceOpusEncoder()
        return fallback(codec)

    get_encoder.seti_voice = True  # type: ignore[attr-defined]
    return get_encoder


def install() -> None:
    """Makes aiortc's RTP sender encode Opus with the voice settings; safe to call twice."""
    scope = aiortc.rtcrtpsender.__dict__
    current: Any = scope["get_encoder"]
    if getattr(current, "seti_voice", False):
        return
    scope["get_encoder"] = voice_encoders(current)
