import datetime
from types import SimpleNamespace
from typing import Any

from aiortc.stats import RTCInboundRtpStreamStats

from seti_ea.call_audio import CallAudio


def peer(lost: int, received: int) -> Any:
    stat = RTCInboundRtpStreamStats(
        timestamp=datetime.datetime.now(datetime.UTC),
        type="inbound-rtp",
        id="in",
        ssrc=1,
        kind="audio",
        transportId="t",
        packetsReceived=received,
        packetsLost=lost,
        jitter=0,
    )

    async def get_stats() -> dict[str, Any]:
        return {"in": stat}

    return SimpleNamespace(getStats=get_stats)


async def test_a_call_line_adds_up_every_peer_connection_and_names_no_one() -> None:
    audio = CallAudio(drops=2, held_secs=1.25)
    first, rebuilt = peer(5, 495), peer(0, 500)
    await audio.sample(first)
    await audio.sample(first)
    await audio.sample(rebuilt)
    assert audio.line() == (
        "EA call audio: 0.5% of 1000 user audio packets lost, 2 peer connections, 2 drops, speech held 1.2 s"
    )


def test_a_call_with_no_audio_says_so_in_numbers() -> None:
    assert CallAudio().line().startswith("EA call audio: 0.0% of 0 user audio packets lost")
