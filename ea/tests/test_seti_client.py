import httpx

from seti_ea.seti import SetiClient


async def test_calls_carry_the_token_and_the_label() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": []})

    client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(handle), token="ea-token")
    await client.get("/tasks")
    await client.close()
    assert seen[0].headers["authorization"] == "Bearer ea-token"
    assert seen[0].headers["x-seti-via"] == "ea"
    assert seen[0].headers["host"] == "seti.localhost:3006"
