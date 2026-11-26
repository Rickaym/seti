"""The jitter buffer for the user's microphone audio as aiortc receives it.

aiortc 1.15 gives each audio track a 16-packet buffer that, after one lost packet, keeps evicting
packets that did arrive: at 5% loss about a fifth of the user's speech never reaches speech to
text. This buffer holds a few packets to put reordered ones back in order, gives up on a missing
packet once KEEP later ones are here, and so loses only what the network lost. `install` makes
aiortc's receiver use it for audio; video keeps aiortc's own.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import aiortc.rtcrtpreceiver
from aiortc.jitterbuffer import JitterBuffer, JitterFrame
from aiortc.rtp import RtpPacket

KEEP = 3
SEQ_SPAN = 1 << 16
# A packet this far behind, or ahead, means the sender restarted its sequence.
RESTART_DISTANCE = 100
AHEAD_LIMIT = 3000


@dataclass
class AudioLoss:
    """What the buffer saw: packets released, missing ones skipped, and late ones dropped."""

    released: int = 0
    skipped: int = 0
    late: int = 0


class AudioJitterBuffer:
    """Releases one frame per packet in sequence order, keeping KEEP packets back for reordering."""

    def __init__(self) -> None:
        self._held: dict[int, RtpPacket] = {}
        self._next: int | None = None
        self.loss = AudioLoss()

    def _extended(self, sequence: int) -> int | None:
        """The packet's position on an unwrapped sequence line, or None when it is too late."""
        if self._next is None:
            return sequence
        ahead = (sequence - self._next) % SEQ_SPAN
        if ahead < SEQ_SPAN // 2:
            if ahead > AHEAD_LIMIT:
                return self._restart(sequence)
            return self._next + ahead
        if SEQ_SPAN - ahead >= RESTART_DISTANCE:
            return self._restart(sequence)
        return None

    def _restart(self, sequence: int) -> int:
        self._held.clear()
        self._next = sequence
        return sequence

    def add(self, packet: RtpPacket) -> tuple[bool, JitterFrame | None]:
        """aiortc's contract: whether to send a PLI (never, for audio) and the frame now due."""
        position = self._extended(packet.sequence_number)
        if position is None or position in self._held:
            self.loss.late += 1
            return False, None
        if self._next is None:
            self._next = position
        self._held[position] = packet
        if len(self._held) <= KEEP:
            return False, None
        oldest = min(self._held)
        self.loss.skipped += oldest - self._next
        released = self._held.pop(oldest)
        self._next = oldest + 1
        self.loss.released += 1
        data: bytes = getattr(released, "_data", b"")
        return False, JitterFrame(data=data, timestamp=released.timestamp)


def jitter_buffers(fallback: type[JitterBuffer]) -> Callable[..., Any]:
    """A factory with aiortc's JitterBuffer signature that gives audio the AudioJitterBuffer."""

    def make(capacity: int, prefetch: int = 0, is_video: bool = False) -> JitterBuffer | AudioJitterBuffer:
        if is_video:
            return fallback(capacity, prefetch=prefetch, is_video=True)
        return AudioJitterBuffer()

    make.seti_audio = True  # type: ignore[attr-defined]
    return make


def install() -> None:
    """Makes aiortc's RTP receiver buffer audio with AudioJitterBuffer; safe to call twice."""
    scope = aiortc.rtcrtpreceiver.__dict__
    current: Any = scope["JitterBuffer"]
    if getattr(current, "seti_audio", False):
        return
    scope["JitterBuffer"] = jitter_buffers(current)
