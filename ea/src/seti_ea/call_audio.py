"""How the user's audio reached the EA on one call, as numbers only, for one log line at its end."""

from dataclasses import dataclass, field

from aiortc import RTCPeerConnection
from aiortc.stats import RTCInboundRtpStreamStats


@dataclass
class CallAudio:
    """The user's audio packets lost on each peer connection, the drops, and the speech held."""

    drops: int = 0
    held_secs: float = 0.0
    streams: dict[int, tuple[int, int]] = field(default_factory=dict)

    async def sample(self, pc: RTCPeerConnection) -> None:
        """Notes how many of the user's audio packets this peer connection lost and received."""
        report = await pc.getStats()
        for stat in report.values():
            if isinstance(stat, RTCInboundRtpStreamStats) and stat.kind == "audio":
                self.streams[id(pc)] = (max(stat.packetsLost, 0), stat.packetsReceived)

    def line(self) -> str:
        lost = sum(lost for lost, _received in self.streams.values())
        total = lost + sum(received for _lost, received in self.streams.values())
        share = 100 * lost / total if total else 0.0
        return (
            f"EA call audio: {share:.1f}% of {total} user audio packets lost, "
            f"{len(self.streams)} peer connections, {self.drops} drops, speech held {self.held_secs:.1f} s"
        )
