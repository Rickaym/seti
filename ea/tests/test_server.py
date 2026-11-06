import asyncio
import json
import re
from typing import Any

import httpx
import pytest
from aiortc import RTCPeerConnection, RTCSessionDescription
from fakes import SETI_TOKEN, settings
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection

from seti_ea import server
from seti_ea.call import CallRequest
from seti_ea.clock import UNKNOWN_CLOCK
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.ice import CLOUDFLARE_TURN_URL, parse_cloudflare, peer_servers
from seti_ea.tools import EaTools

KEYS = {"deepgram_api_key": "dg", "openai_api_key": "op", "elevenlabs_api_key": "el"}
TURN = {"turn_key_id": "key-id", "turn_api_token": "turn-token"}

CLOUDFLARE_BODY = {
    "iceServers": [
        {"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]},
        {
            "urls": [
                "turns:turn.cloudflare.com:5349?transport=tcp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=udp",
            ],
            "username": "user",
            "credential": "cred",
        },
    ]
}


class Cloudflare:
    def __init__(self, status: int = 201, body: Any = None) -> None:
        self.status = status
        self.body = CLOUDFLARE_BODY if body is None else body
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)


async def idle_bot(
    _connection: SmallWebRTCConnection,
    _settings: Settings,
    _tools: EaTools,
    _call: CallRequest,
    _conversation: Conversation,
) -> None:
    await asyncio.Event().wait()


def client_for(app: Any, token: str = SETI_TOKEN) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:3007",
        headers={"Authorization": f"Bearer {token}"} if token else {},
    )


async def test_health_reports_missing_keys() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with client_for(app) as client:
        response = await client.get("/health")
    assert response.json() == {
        "ok": True,
        "configured": False,
        "missing": ["DEEPGRAM_API_KEY", "OPENAI_API_KEY", "ELEVENLABS_API_KEY"],
        "model": "gpt-6-sol",
        "text_model": "gpt-6-sol",
        "chat_missing": ["OPENAI_API_KEY"],
        "turn": False,
    }


async def test_health_when_configured() -> None:
    app = server.create_app(settings(**KEYS, **TURN), bot=idle_bot)
    async with client_for(app) as client:
        body = (await client.get("/health")).json()
    assert body == {
        "ok": True,
        "configured": True,
        "missing": [],
        "model": "gpt-6-sol",
        "text_model": "gpt-6-sol",
        "chat_missing": [],
        "turn": True,
    }


async def test_health_names_only_the_keys_still_missing() -> None:
    app = server.create_app(settings(deepgram_api_key="dg", elevenlabs_api_key="el"), bot=idle_bot)
    async with client_for(app) as client:
        body = (await client.get("/health")).json()
    assert body["configured"] is False
    assert body["missing"] == ["OPENAI_API_KEY"]


async def test_ice_without_turn_keys_is_google_stun() -> None:
    cloudflare = Cloudflare()
    app = server.create_app(
        settings(), bot=idle_bot, cloudflare_transport=httpx.MockTransport(cloudflare.handle)
    )
    async with client_for(app) as client:
        body = (await client.get("/ice")).json()
    assert body == {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
    assert cloudflare.requests == []


async def test_ice_from_cloudflare_is_cached() -> None:
    cloudflare = Cloudflare()
    app = server.create_app(
        settings(**TURN), bot=idle_bot, cloudflare_transport=httpx.MockTransport(cloudflare.handle)
    )
    async with client_for(app) as client:
        first = (await client.get("/ice")).json()
        second = (await client.get("/ice")).json()
    assert first == second
    assert first["iceServers"][0] == {"urls": ["stun:stun.cloudflare.com:3478"]}
    assert first["iceServers"][1]["username"] == "user"
    assert first["iceServers"][1]["credential"] == "cred"
    urls = [url for s in first["iceServers"] for url in s["urls"]]
    assert not [url for url in urls if re.search(r":53(\?|$)", url)]
    assert "turns:turn.cloudflare.com:5349?transport=tcp" in urls
    assert len(cloudflare.requests) == 1
    request = cloudflare.requests[0]
    assert str(request.url) == CLOUDFLARE_TURN_URL.format(key_id="key-id")
    assert request.method == "POST"
    assert request.headers["authorization"] == "Bearer turn-token"
    assert json.loads(request.content) == {"ttl": 86400}


@pytest.mark.parametrize(("status", "body"), [(401, {"error": "bad token"}), (201, {"iceServers": []})])
async def test_ice_falls_back_to_stun_when_cloudflare_fails(status: int, body: Any) -> None:
    cloudflare = Cloudflare(status, body)
    app = server.create_app(
        settings(**TURN), bot=idle_bot, cloudflare_transport=httpx.MockTransport(cloudflare.handle)
    )
    async with client_for(app) as client:
        response = await client.get("/ice")
        await client.get("/ice")
    assert response.json() == {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
    assert len(cloudflare.requests) == 1


def test_parse_cloudflare_accepts_the_older_single_object() -> None:
    body = {"iceServers": {"urls": ["turn:t.example:3478?transport=udp"], "username": "u", "credential": "c"}}
    assert parse_cloudflare(body) == [
        {"urls": ["turn:t.example:3478?transport=udp"], "username": "u", "credential": "c"}
    ]


def test_peer_servers_put_turn_over_udp_first() -> None:
    ordered = peer_servers(parse_cloudflare(CLOUDFLARE_BODY))
    assert ordered[1]["urls"] == [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
    ]


async def test_offer_without_keys_is_refused() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with client_for(app) as client:
        response = await client.post("/offer", json={"sdp": "v=0", "type": "offer"})
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["title"] == "The EA is not configured"
    assert "DEEPGRAM_API_KEY" in error["detail"]


async def test_bad_requests_get_the_seti_error_shape() -> None:
    app = server.create_app(settings(**KEYS), bot=idle_bot)
    async with client_for(app) as client:
        missing = await client.post("/offer", json={"type": "offer"})
        unknown_pc = await client.patch("/offer", json={"pc_id": "nope", "candidates": []})
        not_json = await client.patch("/offer", content=b"[", headers={"content-type": "application/json"})
    assert missing.status_code == 400
    assert missing.json()["error"]["title"] == "Invalid offer"
    assert unknown_pc.status_code == 404
    assert unknown_pc.json() == {
        "error": {"title": "Peer connection not found", "detail": "Peer connection not found"}
    }
    assert not_json.status_code == 400


async def test_non_loopback_hosts_are_refused() -> None:
    app = server.create_app(settings(), bot=idle_bot)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://evil.example"
    ) as client:
        response = await client.get("/health")
    assert response.status_code == 403


async def _connect(
    client: httpx.AsyncClient, request_data: object = None
) -> tuple[RTCPeerConnection, dict[str, str]]:
    """Offer like the browser client does and wait until the peer connection is connected."""
    pc = RTCPeerConnection()
    connected = asyncio.Event()

    @pc.on("connectionstatechange")
    def on_state() -> None:
        if pc.connectionState == "connected":
            connected.set()

    pc.addTransceiver("audio", direction="sendrecv")
    pc.addTransceiver("video", direction="sendrecv")
    pc.createDataChannel("rtvi")
    await pc.setLocalDescription(await pc.createOffer())
    offer = {"sdp": pc.localDescription.sdp, "type": "offer", "requestData": request_data}
    response = await client.post("/offer", json=offer)
    assert response.status_code == 200, response.text
    answer = response.json()
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
    async with asyncio.timeout(15):
        await connected.wait()
    return pc, answer


def _no_ice_servers(_servers: object) -> list[object]:
    return []


async def test_offer_connects_and_a_new_session_replaces_the_old(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "to_ice_servers", _no_ice_servers)
    runs: list[SmallWebRTCConnection] = []
    calls: list[CallRequest] = []
    finished: list[SmallWebRTCConnection] = []

    async def bot(
        connection: SmallWebRTCConnection,
        _settings: Settings,
        _tools: EaTools,
        call: CallRequest,
        _conversation: Conversation,
    ) -> None:
        runs.append(connection)
        calls.append(call)
        closed = asyncio.Event()

        @connection.event_handler("closed")
        async def on_closed(_connection: SmallWebRTCConnection) -> None:
            closed.set()

        await closed.wait()
        finished.append(connection)

    app = server.create_app(settings(**KEYS), bot=bot)
    sessions: server.Sessions = app.state.sessions
    async with client_for(app) as client:
        first, first_answer = await _connect(
            client, {"timezone": "Asia/Singapore", "localTime": "2026-09-27T22:30:00+08:00"}
        )
        assert first_answer["pc_id"] == runs[0].pc_id
        assert sessions.current is not None
        assert sessions.current.connection.pc_id == first_answer["pc_id"]

        patched = await client.patch(
            "/offer",
            json={
                "pc_id": first_answer["pc_id"],
                "candidates": [{"candidate": "", "sdpMid": "0", "sdpMLineIndex": 0}],
            },
        )
        assert patched.json() == {"status": "success"}

        second, second_answer = await _connect(client, {"timezone": 42})
        assert len(runs) == 2
        assert [call.clock.label for call in calls] == ["Asia/Singapore", "UTC"]
        assert calls[1].clock == UNKNOWN_CLOCK
        assert finished == [runs[0]]
        assert sessions.current is not None
        assert sessions.current.connection.pc_id == second_answer["pc_id"]
        assert second_answer["pc_id"] != first_answer["pc_id"]

        joined = {"sdp": "v=0", "type": "offer", "requestData": {"auto": True}}
        busy = await client.post("/offer", json=joined)
        assert busy.status_code == 409
        assert busy.json()["error"]["title"] == "The EA is on a call"
        assert len(runs) == 2

        await sessions.end()
        third, _ = await _connect(client, {"auto": True, "timezone": "Europe/Berlin"})
        assert [call.auto for call in calls] == [False, False, True]
        assert calls[2].clock.label == "Europe/Berlin"

        await sessions.close()
        await first.close()
        await second.close()
        await third.close()
    assert finished == runs


async def test_only_seti_reaches_the_endpoints() -> None:
    app = server.create_app(settings(**KEYS), bot=idle_bot)
    for token in ("", "wrong-token"):
        async with client_for(app, token) as client:
            assert (await client.get("/ice")).status_code == 401
            assert (await client.post("/chat", json={"text": "hi"})).status_code == 401
            assert (await client.post("/offer", json={"sdp": "v=0", "type": "offer"})).status_code == 401
            assert (await client.get("/health")).status_code == 200


async def test_without_a_token_the_ea_answers_only_health() -> None:
    app = server.create_app(settings(seti_api_token=""), bot=idle_bot)
    async with client_for(app, "") as client:
        assert (await client.get("/ice")).status_code == 503
        assert (await client.get("/health")).status_code == 200
