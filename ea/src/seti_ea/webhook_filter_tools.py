"""Webhook filters: code that drops or reshapes a webhook's deliveries before its subscribers."""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from seti_ea.format import clip
from seti_ea.toolkit import ToolError, ToolResult, arg_bool, arg_str, name_of

FAILURES_BEFORE_WARNING = 3
FILTER_API = (
    "export default function filter(event, { log }) gets { event, action, title, link, detail, headers, "
    "payload } and returns null or false to drop the delivery, true to keep it, or an object replacing "
    "any of event, title, link and detail. It may be async, and runs in an isolated engine with no "
    "network or files, in 32 MB and 1 s. A filter that throws, times out or returns anything else "
    "keeps the delivery unchanged."
)
FILTER_PROPS: dict[str, Any] = {
    "filter": {
        "type": "string",
        "description": "Webhooks only: the whole filter code, which turns it on; an empty string "
        f"removes it. {FILTER_API}",
    },
    "filter_enabled": {
        "type": "boolean",
        "description": "Webhooks only: false turns the webhook's filter off, true on.",
    },
}
SAMPLE = {
    "type": "string",
    "description": "Filters only: a request body to try besides the recent deliveries, as the sender "
    "sends it.",
}
OUTCOME_WORDS = {"kept": "keeps", "changed": "changes", "dropped": "drops", "failed": "fails on"}

Refusable = Callable[[Awaitable[Any], str], Awaitable[Any]]


def _filter_of(info: Mapping[str, Any]) -> dict[str, Any] | None:
    found = info.get("filter")
    return found if isinstance(found, dict) else None


def has_filter_args(args: Mapping[str, Any]) -> bool:
    return "filter" in args or "filter_enabled" in args


def filter_change(
    info: Mapping[str, Any], args: Mapping[str, Any]
) -> tuple[dict[str, Any] | None, list[str]]:
    """The filter body update_channel sends, None when it changes nothing, and the change in words."""
    if not has_filter_args(args):
        return None, []
    current = _filter_of(info)
    given = args.get("filter")
    script = given if isinstance(given, str) else (current or {}).get("script")
    if not isinstance(script, str):
        raise ToolError(f"{name_of(info)} has no filter yet: give its code with filter.", "No filter")
    if script.strip() == "":
        return ({"script": "", "enabled": False}, ["removes its filter"]) if current else (None, [])
    turned_on = True if isinstance(given, str) else bool((current or {}).get("enabled", True))
    enabled = arg_bool(args, "filter_enabled") if "filter_enabled" in args else turned_on
    if current and current.get("script") == script and current.get("enabled") == enabled:
        return None, []
    state = "on" if enabled else "off"
    if current and current.get("script") == script:
        return {"script": script, "enabled": enabled}, [f"turns its filter {state}"]
    return {"script": script, "enabled": enabled}, [f"gives it new filter code, {state}"]


def filter_code(body: Mapping[str, Any] | None) -> str:
    """The new filter code in full for the user's yes, or nothing when the code stays."""
    if body is None or not body.get("script"):
        return ""
    return f" Filter code:\n{body.get('script')}"


def filter_lines(info: Mapping[str, Any]) -> list[str]:
    """What get_channel says about a webhook's filter, with its code in full."""
    found = _filter_of(info)
    if found is None:
        return ["It has no filter: every delivery goes to its subscribers."]
    if not found.get("enabled"):
        return [f"Its filter is off, so every delivery goes on unchanged. Code:\n{found.get('script')}"]
    given = found.get("day")
    day: dict[str, Any] = given if isinstance(given, dict) else {}
    counts = ", ".join(f"{int(day.get(k) or 0)} {k}" for k in ("kept", "changed", "dropped", "failed"))
    lines = [f"Its filter is on; in the last 24 hours: {counts}."]
    failures = int(found.get("failures") or 0)
    if failures >= FAILURES_BEFORE_WARNING:
        lines.append(
            f"The filter failed its last {failures} runs, so those deliveries went on unchanged: "
            f"{found.get('last_error')}"
        )
    lines.append(f"Filter code:\n{found.get('script')}")
    return lines


def _row_words(row: Mapping[str, Any]) -> str:
    event = row.get("event") or "an event with no name"
    where = "the sample" if row.get("source") == "sample" else f"the delivery {event}"
    line = f"- It {OUTCOME_WORDS.get(str(row.get('outcome')), str(row.get('outcome')))} {where}"
    line += f': "{clip(str(row.get("title")), 80)}"'
    changed = row.get("changed")
    if isinstance(changed, dict) and changed:
        line += f"; it becomes {', '.join(f'{k} {clip(str(v), 80)}' for k, v in changed.items())}"
    if row.get("error"):
        line += f"; {row.get('error')}"
    logs = [str(n) for n in row.get("logs") or [] if isinstance(n, str)]
    if logs:
        line += f"; log: {' | '.join(clip(n, 120) for n in logs[:5])}"
    return line


async def try_filter(
    post: Callable[[str, Any], Awaitable[Any]],
    refusable: Refusable,
    info: Mapping[str, Any],
    args: Mapping[str, Any],
) -> ToolResult:
    """Runs a draft filter, or the saved one, on a webhook's recent deliveries and a sample."""
    name = name_of(info)
    script = arg_str(args, "script", required=False) or str((_filter_of(info) or {}).get("script") or "")
    if not script:
        raise ToolError(f"{name} has no filter: give the code to test as script.", "Nothing to test")
    body: dict[str, Any] = {"script": script}
    sample = arg_str(args, "sample", required=False)
    if sample:
        body["sample"] = {"headers": "", "body": sample}
    result = await refusable(post(f"/channels/{info.get('id')}/filter/test", body), "Not tested")
    found = result if isinstance(result, dict) else {}
    rows = [r for r in found.get("rows") or [] if isinstance(r, dict)]
    lines = [f"The filter on {name}, tried without storing or sending anything:"]
    if found.get("sample_error"):
        lines.append(f"The sample did not run: {found.get('sample_error')}")
    lines += [_row_words(r) for r in rows] or ["No recent delivery to try it on; give a sample."]
    return ToolResult("\n".join(lines), clip(f"Tested the filter of {name}", 70))
