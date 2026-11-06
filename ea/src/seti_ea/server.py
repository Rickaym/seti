"""HTTP endpoints of the EA: health, ICE servers and SmallWebRTC signalling."""

import asyncio
import contextlib
import hmac
import json
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from loguru import logger
from pipecat.transports.smallwebrtc.connection import IceServer, SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from starlette.types import ASGIApp, Receive, Scope, Send

from seti_ea.call import CallRequest, parse_call_request
from seti_ea.clock import UserClock, parse_user_clock
from seti_ea.config import Settings
from seti_ea.conversation import Conversation
from seti_ea.ice import IceProvider, IceServerDict, peer_servers
from seti_ea.inbox import InboxPump
from seti_ea.seti import SetiClient
from seti_ea.spotter import LOCAL_SPOTTER
from seti_ea.tools import EaTools

if TYPE_CHECKING:
    from seti_ea.chat import LlmFactory

BotRunner = Callable[[SmallWebRTCConnection, Settings, EaTools, CallRequest, Conversation], Awaitable[None]]

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]", "seti.localhost"})
OPEN_PATHS = frozenset({"/health"})
SESSION_END_TIMEOUT_SECS = 5.0
CHAT_TEXT_MAX = 8000


class ApiError(Exception):
    """An error answered as {"error": {"title", "detail"}}, the shape Seti uses."""

    def __init__(self, status: int, title: str, detail: str = "") -> None:
        super().__init__(title)
        self.status = status
        self.title = title
        self.detail = detail or title


def error_response(status: int, title: str, detail: str = "") -> JSONResponse:
    return JSONResponse({"error": {"title": title, "detail": detail or title}}, status_code=status)


class LoopbackOnly:
    """Refuses requests whose Host is not a loopback name, which blocks DNS rebinding."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            host = dict(scope["headers"]).get(b"host", b"").decode("latin-1")
            name = host.rsplit(":", 1)[0] if not host.endswith("]") else host
            if name not in LOOPBACK_HOSTS:
                response = error_response(403, "Forbidden", "The EA only answers loopback hosts")
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class SetiOnly:
    """Answers only requests with the token Seti and the EA share, so no other process drives it."""

    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.expected = f"Bearer {token}".encode() if token else b""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] not in OPEN_PATHS:
            presented = dict(scope["headers"]).get(b"authorization", b"")
            if self.expected == b"":
                response = error_response(
                    503, "The EA is not configured", "It has no seti-api-token credential"
                )
                await response(scope, receive, send)
                return
            if not hmac.compare_digest(presented, self.expected):
                response = error_response(401, "Unauthorized", "Only Seti calls the EA")
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def to_ice_servers(servers: list[IceServerDict]) -> list[IceServer]:
    result: list[IceServer] = []
    for server in peer_servers(servers):
        if "username" in server and "credential" in server:
            result.append(
                IceServer(
                    urls=server["urls"],
                    username=server["username"],
                    credential=server["credential"],
                )
            )
        else:
            result.append(IceServer(urls=server["urls"]))
    return result


def _send_rtvi_error(connection: SmallWebRTCConnection, message: str) -> None:
    with contextlib.suppress(Exception):
        connection.send_app_message(
            {"label": "rtvi-ai", "type": "error", "data": {"error": message, "fatal": True}}
        )


@dataclass
class Session:
    connection: SmallWebRTCConnection
    task: asyncio.Task[None]


class Sessions:
    """Signalling with at most one live session; a new offer replaces the current one."""

    def __init__(
        self,
        settings: Settings,
        ice: IceProvider,
        tools: EaTools,
        bot: BotRunner,
        conversation: Conversation,
    ) -> None:
        self._settings = settings
        self._ice = ice
        self._tools = tools
        self._bot = bot
        self._conversation = conversation
        self._handler = SmallWebRTCRequestHandler()
        self._lock = asyncio.Lock()
        self.current: Session | None = None

    async def offer(self, request: SmallWebRTCRequest) -> dict[str, str]:
        async with self._lock:
            current = self.current
            renegotiating = current is not None and request.pc_id == current.connection.pc_id
            call = parse_call_request(request.request_data)
            if call.auto and current is not None and not renegotiating:
                raise ApiError(
                    409, "The EA is on a call", "Another window holds the call; Seti joins after it"
                )
            if not renegotiating:
                await self.end()
                self._handler.update_ice_servers(to_ice_servers(await self._ice.servers()))

            async def start(connection: SmallWebRTCConnection) -> None:
                await self._start(connection, call)

            answer = await self._handler.handle_web_request(request, start)
            if answer is None:
                raise ApiError(500, "No answer", "The peer connection produced no SDP answer")
            return answer

    async def patch(self, request: SmallWebRTCPatchRequest) -> None:
        await self._handler.handle_patch_request(request)

    async def _start(self, connection: SmallWebRTCConnection, call: CallRequest) -> None:
        task = asyncio.create_task(self._run(connection, call))
        self.current = Session(connection, task)
        joined = ", joined on open" if call.auto else ""
        logger.info(f"EA session started: {connection.pc_id}, user clock {call.clock.label}{joined}")

    async def _run(self, connection: SmallWebRTCConnection, call: CallRequest) -> None:
        try:
            await self._bot(connection, self._settings, self._tools, call, self._conversation)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("EA session failed")
            _send_rtvi_error(connection, "The assistant hit an error. Please reconnect.")
        finally:
            if self.current is not None and self.current.connection is connection:
                self.current = None
            logger.info(f"EA session ended: {connection.pc_id}")

    async def end(self) -> None:
        """Close the live session, if any, and wait briefly for its pipeline to stop."""
        session = self.current
        if session is None:
            return
        self.current = None
        await session.connection.disconnect()
        done, _ = await asyncio.wait({session.task}, timeout=SESSION_END_TIMEOUT_SECS)
        if not done:
            session.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await session.task

    async def close(self) -> None:
        await self.end()
        await self._handler.close()


async def _json_object(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as e:
        raise ApiError(400, "Invalid request", "The body must be JSON") from e
    if not isinstance(body, dict):
        raise ApiError(400, "Invalid request", "The body must be a JSON object")
    return body


def parse_offer(body: dict[str, Any]) -> SmallWebRTCRequest:
    """The offer as pipecat's handler takes it, accepting snake_case and camelCase fields."""
    sdp = body.get("sdp")
    kind = body.get("type")
    if not isinstance(sdp, str) or not isinstance(kind, str):
        raise ApiError(400, "Invalid offer", "sdp and type are required strings")
    pc_id = body.get("pc_id") or body.get("pcId")
    restart = body.get("restart_pc") or body.get("restartPc")
    return SmallWebRTCRequest(
        sdp=sdp,
        type=kind,
        pc_id=pc_id if isinstance(pc_id, str) else None,
        restart_pc=restart is True,
        request_data=body.get("request_data") or body.get("requestData"),
    )


def _index(value: Any) -> int:
    return value if isinstance(value, int) else 0


def parse_patch(body: dict[str, Any]) -> SmallWebRTCPatchRequest:
    """Trickled ICE candidates, accepting snake_case and camelCase fields."""
    pc_id = body.get("pc_id") or body.get("pcId")
    raw = body.get("candidates")
    if not isinstance(pc_id, str) or not isinstance(raw, list):
        raise ApiError(400, "Invalid candidates", "pc_id and candidates are required")
    candidates = [
        IceCandidate(
            candidate=str(c.get("candidate") or ""),
            sdp_mid=str(c.get("sdp_mid") or c.get("sdpMid") or ""),
            sdp_mline_index=_index(c.get("sdp_mline_index", c.get("sdpMLineIndex"))),
        )
        for c in raw
        if isinstance(c, dict)
    ]
    return SmallWebRTCPatchRequest(pc_id=pc_id, candidates=candidates)


def parse_chat(body: dict[str, Any]) -> tuple[str, UserClock]:
    """The typed message and the browser's clock from a chat request."""
    text = body.get("text")
    if not isinstance(text, str) or text.strip() == "" or len(text) > CHAT_TEXT_MAX:
        raise ApiError(400, "Invalid message", f"text must be 1 to {CHAT_TEXT_MAX} characters")
    return text.strip(), parse_user_clock(body.get("requestData") or body.get("request_data"))


async def sse(events: AsyncIterator[dict[str, Any]]) -> AsyncIterator[str]:
    """Server-sent events, one per chat event; pings become comments that keep proxies open."""
    async for event in events:
        kind = str(event.get("type"))
        if kind == "ping":
            yield ": ping\n\n"
            continue
        data = json.dumps({key: value for key, value in event.items() if key != "type"})
        yield f"event: {kind}\ndata: {data}\n\n"


def create_app(
    settings: Settings,
    *,
    bot: BotRunner | None = None,
    chat_llm: "LlmFactory | None" = None,
    cloudflare_transport: httpx.AsyncBaseTransport | None = None,
    seti_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """The EA's FastAPI app; the bot, the chat LLM and the transports are injectable for tests."""
    from seti_ea.chat import TextChat
    from seti_ea.chat import chat_llm as default_chat_llm

    http = httpx.AsyncClient(transport=cloudflare_transport)
    seti = SetiClient(settings.seti_api, transport=seti_transport, token=settings.seti_api_token)
    ice = IceProvider(settings, http)
    tools = EaTools(seti)
    conversation = Conversation()
    if bot is None:
        from seti_ea.bot import run_bot

        bot = run_bot
    sessions = Sessions(settings, ice, tools, bot, conversation)
    chat = TextChat(settings, tools, conversation, llm=chat_llm or default_chat_llm)
    follow_up = None if settings.chat_missing else chat.follow_up
    pump = InboxPump(seti, conversation, follow_up, settings.inbox_poll_secs, answer=chat.answer)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        pumping = asyncio.create_task(pump.run()) if settings.inbox_poll_secs > 0 else None
        loading = asyncio.create_task(LOCAL_SPOTTER.load())
        yield
        loading.cancel()
        if pumping is not None:
            pumping.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await pumping
        await sessions.close()
        await seti.close()
        await http.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(SetiOnly, token=settings.seti_api_token)
    app.add_middleware(LoopbackOnly)
    app.state.sessions = sessions

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.title, exc.detail)

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return error_response(exc.status_code, str(exc.detail))

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "configured": settings.configured,
            "missing": settings.missing,
            "model": settings.model,
            "text_model": settings.chat_model,
            "chat_missing": settings.chat_missing,
            "turn": settings.turn,
        }

    @app.get("/ice")
    async def ice_servers() -> dict[str, Any]:
        return {"iceServers": await ice.servers()}

    @app.post("/offer")
    async def offer(request: Request) -> dict[str, str]:
        if not settings.configured:
            raise ApiError(
                503,
                "The EA is not configured",
                f"Missing {', '.join(settings.missing)} in {settings.keys_hint}",
            )
        webrtc_request = parse_offer(await _json_object(request))
        try:
            return await sessions.offer(webrtc_request)
        except (ApiError, HTTPException):
            raise
        except Exception as e:
            logger.warning(f"Offer failed: {type(e).__name__}: {e}")
            raise ApiError(400, "Could not accept the offer", str(e) or type(e).__name__) from e

    @app.post("/chat")
    async def chat_reply(request: Request) -> StreamingResponse:
        if settings.chat_missing:
            raise ApiError(
                503,
                "The EA is not configured",
                f"Missing {', '.join(settings.chat_missing)} in {settings.keys_hint}",
            )
        text, clock = parse_chat(await _json_object(request))
        return StreamingResponse(
            sse(chat.reply(text, clock)),
            media_type="text/event-stream",
            headers={"cache-control": "no-store", "x-accel-buffering": "no"},
        )

    @app.patch("/offer")
    async def candidates(request: Request) -> dict[str, str]:
        await sessions.patch(parse_patch(await _json_object(request)))
        return {"status": "success"}

    return app
