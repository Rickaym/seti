"""libopus as PyAV ships it, for tests that decode with FEC the way a browser does."""

import ctypes
import fractions
import functools
import random
from collections.abc import Sequence
from pathlib import Path

import av
import numpy as np
from av import AudioFrame, AudioResampler

FRAME = 960
FIXTURE = Path(__file__).parent / "fixtures" / "what-is-running.wav"


@functools.cache
def _library() -> ctypes.CDLL:
    root = Path(av.__file__).parent
    found = sorted([*root.parent.glob("av.libs/libopus*"), *root.glob(".dylibs/libopus*")])
    if not found:
        raise RuntimeError("PyAV ships no libopus beside it; the FEC tests need one")
    lib = ctypes.CDLL(str(found[0]))
    lib.opus_decoder_create.restype = ctypes.c_void_p
    lib.opus_decoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
    lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
    lib.opus_decode.argtypes = [
        ctypes.c_void_p,
        ctypes.c_char_p,
        ctypes.c_int32,
        ctypes.POINTER(ctypes.c_int16),
        ctypes.c_int,
        ctypes.c_int,
    ]
    lib.opus_packet_has_lbrr.argtypes = [ctypes.c_char_p, ctypes.c_int32]
    return lib


def speech_48k() -> np.ndarray:
    """The fixture as mono 16-bit samples at 24 kHz, the TTS rate, then at the 48 kHz Opus rate."""
    container = av.open(str(FIXTURE))
    to_tts = AudioResampler(format="s16", layout="mono", rate=24000)
    tts = [g for f in container.decode(container.streams.audio[0]) for g in to_tts.resample(f)]
    to_opus = AudioResampler(format="s16", layout="mono", rate=48000)
    out: list[np.ndarray] = []
    for frame in tts:
        out += [g.to_ndarray().reshape(-1) for g in to_opus.resample(frame)]
    return np.concatenate(out).astype(np.int16)


def frames_of(samples: np.ndarray, size: int) -> list[AudioFrame]:
    frames: list[AudioFrame] = []
    for start in range(0, len(samples) - size, size):
        frame = AudioFrame.from_ndarray(samples[None, start : start + size], layout="mono")
        frame.sample_rate = 48000
        frame.pts = start
        frame.time_base = fractions.Fraction(1, 48000)
        frames.append(frame)
    return frames


def speech_frames(samples: np.ndarray) -> list[bool]:
    """Which 20 ms frames hold speech rather than near silence."""
    chunks = [samples[i * FRAME : (i + 1) * FRAME].astype(float) for i in range(len(samples) // FRAME + 2)]
    return [len(chunk) > 0 and float(np.sqrt(np.mean(chunk**2))) > 300 for chunk in chunks]


def has_fec(packet: bytes) -> bool:
    return _library().opus_packet_has_lbrr(packet, len(packet)) == 1


def rebuilt_share(packets: Sequence[bytes], speech: Sequence[bool], loss: float, seed: int = 7) -> float:
    """The share of lost speech frames a receiver rebuilds from the next packet's FEC data."""
    lib = _library()
    chance = random.Random(seed)
    lost = [chance.random() < loss for _ in packets]
    error = ctypes.c_int()
    decoder = lib.opus_decoder_create(48000, 2, ctypes.byref(error))
    pcm = (ctypes.c_int16 * (FRAME * 2))()
    missed = rebuilt = 0
    try:
        for i, packet in enumerate(packets):
            if not lost[i]:
                lib.opus_decode(decoder, packet, len(packet), pcm, FRAME, 0)
                continue
            following = packets[i + 1] if i + 1 < len(packets) and not lost[i + 1] else None
            missed += speech[i]
            if following is not None and has_fec(following):
                lib.opus_decode(decoder, following, len(following), pcm, FRAME, 1)
                rebuilt += speech[i]
            else:
                lib.opus_decode(decoder, None, 0, pcm, FRAME, 0)
    finally:
        lib.opus_decoder_destroy(decoder)
    return rebuilt / missed if missed else 1.0
