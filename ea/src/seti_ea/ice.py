"""ICE servers for the browser and for the bot's own peer connection."""

import asyncio
import time
from collections.abc import Callable
from typing import Any, NotRequired, TypedDict

import httpx
from loguru import logger

from seti_ea.config import Settings

CLOUDFLARE_TURN_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers"
TURN_TTL_SECS = 86400
REFRESH_MARGIN_SECS = 3600
RETRY_AFTER_FAILURE_SECS = 60
GOOGLE_STUN = "stun:stun.l.google.com:19302"


class IceServerDict(TypedDict):
    """An RTCIceServer as the browser and aiortc understand it."""

    urls: list[str]
    username: NotRequired[str]
    credential: NotRequired[str]


def stun_only() -> list[IceServerDict]:
    """The fallback when no TURN credentials are available."""
    return [{"urls": [GOOGLE_STUN]}]


def _port_of(url: str) -> str:
    host_port = url.split("?", 1)[0].split(":", 1)[-1]
    return host_port.rsplit(":", 1)[-1] if ":" in host_port else ""


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def parse_cloudflare(payload: Any) -> list[IceServerDict]:
    """Normalise Cloudflare's iceServers (a list, or one object in older responses)."""
    if not isinstance(payload, dict):
        return []
    servers: list[IceServerDict] = []
    for entry in _as_list(payload.get("iceServers")):
        if not isinstance(entry, dict):
            continue
        # Browsers time out on port 53, so Cloudflare advises dropping those URLs.
        urls = [
            url
            for url in _as_list(entry.get("urls"))
            if isinstance(url, str) and url != "" and _port_of(url) != "53"
        ]
        if not urls:
            continue
        server: IceServerDict = {"urls": urls}
        username = entry.get("username")
        credential = entry.get("credential")
        if isinstance(username, str) and isinstance(credential, str):
            server["username"] = username
            server["credential"] = credential
        servers.append(server)
    return servers


def _turn_rank(url: str) -> int:
    if url.startswith("turns:"):
        return 2
    return 1 if "transport=tcp" in url else 0


def peer_servers(servers: list[IceServerDict]) -> list[IceServerDict]:
    """Reorder TURN URLs so aiortc, which uses only the first one, picks TURN over UDP."""
    ordered: list[IceServerDict] = []
    for server in servers:
        urls = sorted(server["urls"], key=lambda u: _turn_rank(u) if u.startswith("turn") else -1)
        ordered.append({**server, "urls": urls})
    return ordered


class IceProvider:
    """Fetches and caches Cloudflare TURN credentials, falling back to public STUN."""

    def __init__(
        self,
        settings: Settings,
        client: httpx.AsyncClient,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._settings = settings
        self._client = client
        self._clock = clock
        self._lock = asyncio.Lock()
        self._servers: list[IceServerDict] | None = None
        self._fresh_until = 0.0
        self._retry_at = 0.0

    async def servers(self) -> list[IceServerDict]:
        """Current ICE servers; TURN credentials are reused until close to expiry."""
        if not self._settings.turn:
            return stun_only()
        async with self._lock:
            now = self._clock()
            if self._servers is not None and now < self._fresh_until:
                return self._servers
            if now < self._retry_at:
                return self._servers or stun_only()
            fetched = await self._fetch()
            if fetched is None:
                self._retry_at = now + RETRY_AFTER_FAILURE_SECS
                return self._servers or stun_only()
            self._servers = fetched
            self._fresh_until = now + TURN_TTL_SECS - REFRESH_MARGIN_SECS
            return fetched

    async def _fetch(self) -> list[IceServerDict] | None:
        url = CLOUDFLARE_TURN_URL.format(key_id=self._settings.turn_key_id)
        try:
            response = await self._client.post(
                url,
                headers={"Authorization": f"Bearer {self._settings.turn_api_token}"},
                json={"ttl": TURN_TTL_SECS},
                timeout=10.0,
            )
        except httpx.HTTPError as e:
            logger.warning(f"Cloudflare TURN request failed: {type(e).__name__}")
            return None
        if response.status_code >= 400:
            logger.warning(f"Cloudflare TURN request answered {response.status_code}")
            return None
        try:
            servers = parse_cloudflare(response.json())
        except ValueError:
            servers = []
        if not any(s.get("username") for s in servers):
            logger.warning("Cloudflare TURN response carried no TURN credentials")
            return None
        return servers
