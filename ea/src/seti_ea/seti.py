"""A small HTTP client for the Seti API, sending requests as the EA."""

from typing import Any

import httpx

SETI_HOST = "seti.localhost:3006"
SETI_HEADERS = {
    "Host": SETI_HOST,
    "Origin": f"http://{SETI_HOST}",
    "Content-Type": "application/json",
    "x-seti-via": "ea",
}


def seti_headers(token: str) -> dict[str, str]:
    """Headers for every call; the token, not the x-seti-via label, is what Seti trusts."""
    return {**SETI_HEADERS, "Authorization": f"Bearer {token}"} if token else dict(SETI_HEADERS)


class SetiError(Exception):
    """A failed Seti call with a short title and a readable detail."""

    def __init__(self, title: str, detail: str = "", status: int | None = None) -> None:
        super().__init__(title if detail in ("", title) else f"{title}: {detail}")
        self.title = title
        self.detail = detail
        self.status = status


def _error_of(response: httpx.Response) -> SetiError:
    try:
        body = response.json()
    except ValueError:
        body = None
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict):
        title = str(error.get("title") or f"Seti answered {response.status_code}")
        return SetiError(title, str(error.get("detail") or ""), response.status_code)
    return SetiError(f"Seti answered {response.status_code}", status=response.status_code)


class SetiClient:
    """Calls Seti's REST API and unwraps its {"data": ...} envelope."""

    def __init__(
        self,
        base_url: str,
        transport: httpx.AsyncBaseTransport | None = None,
        token: str = "",
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers=seti_headers(token),
            timeout=httpx.Timeout(20.0, connect=5.0),
            transport=transport,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str | int] | None = None,
        body: dict[str, Any] | None = None,
        timeout_secs: float | None = None,
    ) -> Any:
        """The response's data, or a SetiError that says what went wrong."""
        wait = httpx.USE_CLIENT_DEFAULT if timeout_secs is None else httpx.Timeout(timeout_secs, connect=5.0)
        try:
            response = await self._client.request(
                method, f"/api{path}", params=params, json=body, timeout=wait
            )
        except httpx.TimeoutException as e:
            raise SetiError("Seti did not answer in time") from e
        except httpx.HTTPError as e:
            raise SetiError("Seti is not reachable", type(e).__name__) from e
        if response.status_code >= 400:
            raise _error_of(response)
        if response.status_code == 204 or response.content == b"":
            return None
        try:
            payload = response.json()
        except ValueError as e:
            raise SetiError("Seti sent a response that is not JSON") from e
        return payload.get("data") if isinstance(payload, dict) else None

    async def get(self, path: str, params: dict[str, str | int] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(
        self, path: str, body: dict[str, Any] | None = None, timeout_secs: float | None = None
    ) -> Any:
        return await self.request(
            "POST", path, body=body if body is not None else {}, timeout_secs=timeout_secs
        )

    async def put(self, path: str, body: dict[str, Any]) -> Any:
        return await self.request("PUT", path, body=body)

    async def patch(self, path: str, body: dict[str, Any]) -> Any:
        return await self.request("PATCH", path, body=body)

    async def delete(self, path: str, params: dict[str, str | int] | None = None) -> Any:
        return await self.request("DELETE", path, params=params)
