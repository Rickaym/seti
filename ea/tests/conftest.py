from collections.abc import Callable

import httpx
import pytest
from fakes import NOW, FakeSeti

from seti_ea.seti import SetiClient
from seti_ea.tools import EaTools


@pytest.fixture
def fake_seti() -> FakeSeti:
    return FakeSeti()


@pytest.fixture
def make_tools(fake_seti: FakeSeti) -> Callable[[], EaTools]:
    def build() -> EaTools:
        client = SetiClient("http://127.0.0.1:3006", transport=httpx.MockTransport(fake_seti.handle))
        return EaTools(client, now=lambda: NOW)

    return build


@pytest.fixture
def tools(make_tools: Callable[[], EaTools]) -> EaTools:
    return make_tools()
