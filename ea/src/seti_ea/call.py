"""What the browser asks for with its offer."""

from dataclasses import dataclass
from typing import cast

from seti_ea.clock import UNKNOWN_CLOCK, UserClock, parse_user_clock


@dataclass(frozen=True)
class CallRequest:
    """The user's clock, and whether Seti joined on its own when it opened rather than the user calling."""

    clock: UserClock = UNKNOWN_CLOCK
    auto: bool = False


def parse_call_request(request_data: object) -> CallRequest:
    auto = isinstance(request_data, dict) and cast(dict[str, object], request_data).get("auto") is True
    return CallRequest(parse_user_clock(request_data), auto)
